import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, testContext, type TestContext } from "../support/context.js";
import { useMockServer } from "../support/mock-server.js";

// `pidgen ticket history` against Prism mocking the committed contracts/openapi.json: Prism refuses a
// request whose query does not match the document and generates responses from its schemas, so a
// success here means the CLI sent a request the document accepts and read the shape it describes.

const server = useMockServer();

interface Body {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  meta: Record<string, unknown>;
}

const ENTRY_FIELDS = [
  "sequence",
  "occurred_at",
  "kind",
  "category",
  "actor",
  "summary",
  "reason",
  "status",
  "code",
];

/**
 * Prism cannot page: it answers the same generated page whatever `after` says. `stage` turns each
 * generated page into the next one of a three-page history, after Prism has accepted the request,
 * so the CLI's paging is driven with requests the document validated. `prefer` asks Prism for the
 * document's response with that status.
 */
async function setup(options: { stage?: boolean; prefer?: number } = {}) {
  const urls: string[] = [];
  const ctx = await testContext({
    env: {
      PIDGEN_API_URL: server().url,
      PIDGEN_TOKEN: "pidgen_pat_fake_contract_token",
      PIDGEN_ACCOUNT: "ACC-EXAMPLE",
    },
    fetch: async (input, init) => {
      urls.push(String(input));
      const headers = {
        ...(init?.headers as Record<string, string>),
        ...(options.prefer === undefined ? {} : { prefer: `code=${options.prefer}` }),
      };
      const response = await globalThis.fetch(input, { ...init, headers });
      if (!options.stage || !response.ok) return response;
      const after = Number(new URL(String(input)).searchParams.get("after") ?? 0);
      const page = (await response.json()) as {
        data: { entries: Record<string, unknown>[]; next_after: number | null };
      };
      page.data.entries = page.data.entries.map((entry) => ({ ...entry, sequence: after + 1 }));
      page.data.next_after = after + 1 < 3 ? after + 1 : null;
      return new Response(JSON.stringify(page), {
        status: response.status,
        headers: response.headers,
      });
    },
  });
  return { ctx, urls };
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(["--timeout", "10", ...argv], ctx);
  expect(ctx.out).toHaveLength(1);
  return { code, body: envelope(ctx) as unknown as Body };
}

/** A raw request to the mock, apart from the CLI's own checks. */
async function raw(path: string): Promise<number> {
  const response = await globalThis.fetch(`${server().url}${path}`, {
    headers: {
      authorization: "Bearer pidgen_pat_fake_contract_token",
      "x-pidgen-account": "ACC-EXAMPLE",
    },
  });
  return response.status;
}

describe("pidgen ticket history against the Prism mock of the committed document", () => {
  it("reads GET /tickets/{ref}/history and returns the documented page", async () => {
    const { ctx, urls } = await setup();
    const { code, body } = await run(ctx, "ticket", "history", "PIDGEN-7");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null, meta: { account: "ACC-EXAMPLE" } });
    expect(body.data).toEqual({
      ticket_id: expect.any(String),
      entries: expect.any(Array),
      next_after: expect.anything(),
    });
    const { entries } = body.data as { entries: Record<string, unknown>[] };
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      for (const field of ENTRY_FIELDS) expect(entry).toHaveProperty(field);
      expect(["people", "observations"]).toContain(entry["category"]);
    }
    expect(urls).toEqual([`${server().url}/api/v1/tickets/PIDGEN-7/history`]);
  });

  it.each(["everything", "people", "observations"])(
    "--show %s, --after and --limit are a request the document accepts",
    async (show) => {
      const { ctx, urls } = await setup();
      const { code, body } = await run(
        ctx,
        "ticket",
        "history",
        "PIDGEN-7",
        "--show",
        show,
        "--after",
        "3",
        "--limit",
        "50",
      );
      expect(code).toBe(ExitCode.Ok);
      expect(body).toMatchObject({ ok: true, error: null });
      expect(urls).toHaveLength(1);
      const sent = new URL(urls[0] ?? "");
      expect(sent.pathname).toBe("/api/v1/tickets/PIDGEN-7/history");
      expect(Object.fromEntries(sent.searchParams)).toEqual({ show, after: "3", limit: "50" });
    },
  );

  it("--all follows next_after, each page a request the document accepts, to one list", async () => {
    const { ctx, urls } = await setup({ stage: true });
    const { code, body } = await run(
      ctx,
      "ticket",
      "history",
      "PIDGEN-7",
      "--all",
      "--show",
      "people",
      "--limit",
      "1",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    expect(
      urls.map((url) => {
        const sent = new URL(url);
        return [sent.pathname, Object.fromEntries(sent.searchParams)];
      }),
    ).toEqual([
      ["/api/v1/tickets/PIDGEN-7/history", { show: "people", limit: "1" }],
      ["/api/v1/tickets/PIDGEN-7/history", { show: "people", after: "1", limit: "1" }],
      ["/api/v1/tickets/PIDGEN-7/history", { show: "people", after: "2", limit: "1" }],
    ]);
    const data = body.data as { entries: { sequence: number }[]; next_after: number | null };
    expect(data.entries.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(data.next_after).toBeNull();
  });

  it("--all of a page that never moves on is refused rather than looped over", async () => {
    // Prism answers its one generated page, whose next_after is 0, for every request.
    const { ctx, urls } = await setup();
    const { code, body } = await run(ctx, "ticket", "history", "PIDGEN-7", "--all");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body).toMatchObject({ ok: false, error: { code: "UNEXPECTED_RESPONSE" } });
    expect(urls).toHaveLength(1);
  });

  it("reports the document's 404 as not found, exit 4", async () => {
    const { ctx } = await setup({ prefer: 404 });
    const { code, body } = await run(ctx, "ticket", "history", "PIDGEN-404");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: expect.any(String), details: { status: 404 } },
    });
  });

  it("sends nothing for a usage error", async () => {
    const { ctx, urls } = await setup();
    const unknown = await run(ctx, "ticket", "history", "PIDGEN-7", "--show", "everyone");
    expect(unknown.code).toBe(ExitCode.Usage);
    expect(unknown.body).toMatchObject({ ok: false, error: { code: "CLI_USAGE" } });
    const limit = await run(ctx, "ticket", "history", "PIDGEN-7", "--limit", "201");
    expect(limit.code).toBe(ExitCode.Usage);
    expect(urls).toEqual([]);
  });

  it("the document itself refuses an unknown show, a limit outside 1 to 200 and a non-integer after", async () => {
    // Prism applies the committed schemas to a raw request, apart from the CLI's own checks.
    const history = "/api/v1/tickets/PIDGEN-7/history";
    expect(await raw(history)).toBe(200);
    expect(await raw(`${history}?show=people&after=0&limit=1`)).toBe(200);
    expect(await raw(`${history}?limit=200`)).toBe(200);
    expect(await raw(`${history}?show=everyone`)).toBe(422);
    expect(await raw(`${history}?limit=0`)).toBe(422);
    expect(await raw(`${history}?limit=201`)).toBe(422);
    expect(await raw(`${history}?after=later`)).toBe(422);
  });
});
