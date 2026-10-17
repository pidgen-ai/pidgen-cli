import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, testContext, type TestContext } from "../support/context.js";
import { committedDocumentForStaticMock, useMockServer } from "../support/mock-server.js";

// Filing a Domain Epic and reading a domain's Epics against Prism mocking the committed
// contracts/openapi.json. Prism checks each request (path, query, credential and body, including
// domain_id) against the published document and generates the answer from the route's schema,
// which the Epics read validates against the same document. The mock serves the document without
// the Ticket title and objective defaults ("" under minLength 1) it would otherwise answer with.

const server = useMockServer(committedDocumentForStaticMock());

interface Body {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  meta: Record<string, unknown>;
}

interface Sent {
  method: string;
  url: string;
  body: unknown;
}

async function setup() {
  const sent: Sent[] = [];
  const ctx = await testContext({
    env: {
      PIDGEN_API_URL: server().url,
      PIDGEN_TOKEN: "pidgen_pat_fake_contract_token",
      PIDGEN_ACCOUNT: "ACC-EXAMPLE",
    },
    fetch: (input, init) => {
      const text = init?.body;
      sent.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: typeof text === "string" ? (JSON.parse(text) as unknown) : undefined,
      });
      return globalThis.fetch(input, init);
    },
  });
  return { ctx, sent };
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(["--timeout", "10", ...argv], ctx);
  expect(ctx.out).toHaveLength(1);
  return { code, body: envelope(ctx) as unknown as Body };
}

const EPIC = {
  title: "Checkout across payments and cards",
  description: "One checkout across the payment and card projects.",
};

describe("Domain Epic commands against the Prism mock of the published document", () => {
  it.each([
    [["ticket", "create", "--domain", "PAY", "-f"]],
    [["ticket", "create", "--kind", "epic", "--domain", "PAY", "-f"]],
    [["epic", "create", "--domain", "PAY", "-f"]],
  ])("pidgen %j sends the documented create with domain_id", async (argv) => {
    const { ctx, sent } = await setup();
    await writeFile(join(ctx.cwd, "epic.json"), JSON.stringify(EPIC));
    const { code, body } = await run(ctx, ...argv, "epic.json");
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(body).toMatchObject({
      ok: true,
      error: null,
      data: { id: expect.any(String) as unknown, ticket_key: expect.any(String) as unknown },
    });
    expect(sent).toEqual([
      {
        method: "POST",
        url: `${server().url}/api/v1/tickets`,
        body: { ...EPIC, kind: "epic", domain_id: "PAY" },
      },
    ]);
  });

  it.each([
    [[], ""],
    [
      ["--state", "finished", "--page", "2", "--per-page", "50", "--no-subdomains"],
      "?state=finished&page=2&per_page=50&subdomains=false",
    ],
  ])("pidgen domain epics PAY %j reads the documented board", async (extra, query) => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "domain", "epics", "PAY", ...extra);
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    const data = body.data as {
      epics: Array<{ epic: unknown; projects: unknown[]; hidden: number }>;
      tickets: unknown[];
    };
    expect(data.epics.length).toBeGreaterThan(0);
    for (const entry of data.epics) {
      expect(entry).toMatchObject({
        epic: { kind: expect.any(String) as unknown },
        domain_id: expect.any(String) as unknown,
        hidden: expect.any(Number) as unknown,
      });
      expect(entry.projects.length).toBeGreaterThan(0);
    }
    expect(sent).toEqual([
      { method: "GET", url: `${server().url}/api/v1/domains/PAY/epics${query}`, body: undefined },
    ]);
  });
});
