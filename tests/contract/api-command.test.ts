import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, testContext, type TestContext } from "../support/context.js";
import { useMockServer } from "../support/mock-server.js";

// The real command registry, whose `api` commands check paths against the bundled
// contracts/openapi.json, against Prism mocking that same committed document. Prism generates
// responses from the document's schemas, so these tests check shapes and status mapping.

const server = useMockServer();

interface Body {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  meta: Record<string, unknown>;
}

async function setup() {
  const urls: string[] = [];
  const ctx = await testContext({
    env: {
      PIDGEN_API_URL: server().url,
      PIDGEN_TOKEN: "pidgen_pat_fake_contract_token",
      PIDGEN_ACCOUNT: "ACC-EXAMPLE",
    },
    fetch: (input, init) => {
      urls.push(String(input));
      return globalThis.fetch(input, init);
    },
  });
  return { ctx, urls };
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(["--timeout", "10", ...argv], ctx);
  return { code, body: envelope(ctx) as unknown as Body };
}

const REOPEN_BODY = { preview_digest: "sha256:abc", idempotency_key: "k-1", acknowledgements: [] };

describe("pidgen api against the Prism mock of the committed document", () => {
  it("pidgen api get reaches a published list route and returns its data in the envelope", async () => {
    const { ctx, urls } = await setup();
    const { code, body } = await run(ctx, "api", "get", "/tickets", "--query", "per_page=10");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null, meta: { account: "ACC-EXAMPLE" } });
    expect(Array.isArray(body.data)).toBe(true);
    for (const ticket of body.data as unknown[]) {
      expect(ticket).toEqual(expect.objectContaining({ id: expect.any(String) }));
    }
    expect(urls).toEqual([`${server().url}/api/v1/tickets?per_page=10`]);
  });

  it("pidgen api get matches a published path template, with the /api/v1 prefix", async () => {
    const { ctx, urls } = await setup();
    const { code, body } = await run(ctx, "api", "get", "/api/v1/projects/proj-example");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(
      expect.objectContaining({ id: expect.any(String), name: expect.any(String) }),
    );
    expect(urls).toEqual([`${server().url}/api/v1/projects/proj-example`]);
  });

  it("pidgen api post sends a validated -f body to a published apply route", async () => {
    const { ctx } = await setup();
    const file = join(ctx.cwd, "reopen.json");
    await writeFile(file, JSON.stringify(REOPEN_BODY));
    const { code, body } = await run(ctx, "api", "post", "/tickets/PIDGEN-4/reopen", "-f", file);
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(
      expect.objectContaining({ status: "applied", ticket_id: expect.any(String) }),
    );
  });

  it("pidgen api reads a published route's public error (404)", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(
      ctx,
      "api",
      "get",
      "/projects/proj-missing",
      "--query",
      "__code=404",
    );
    expect(code).toBe(ExitCode.NotFound);
    expect(body.ok).toBe(false);
    expect(body.error).toMatchObject({ code: expect.any(String), details: { status: 404 } });
  });

  it("pidgen api maps a published route's 409 to a refusal", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(
      ctx,
      "api",
      "post",
      "/tickets/PIDGEN-4/reopen/preview",
      "--query",
      "__code=409",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body.error?.details).toMatchObject({ status: 409 });
  });

  it("pidgen api refuses a path not in the document and an invalid body without a request", async () => {
    const { ctx, urls } = await setup();
    const notPublic = await run(ctx, "api", "get", "/admin/users");
    expect(notPublic.code).toBe(ExitCode.Usage);
    expect(notPublic.body.error?.code).toBe("PATH_NOT_PUBLIC");

    const wrongMethod = await run(ctx, "api", "delete", "/tickets/PIDGEN-4");
    expect(wrongMethod.code).toBe(ExitCode.Usage);
    expect(wrongMethod.body.error).toMatchObject({ code: "PATH_NOT_PUBLIC" });
    // The methods come in the document's order, which a pull may change.
    expect([...(wrongMethod.body.error?.details["allowed_methods"] as string[])].sort()).toEqual([
      "GET",
      "PATCH",
    ]);

    const file = join(ctx.cwd, "bad.json");
    await writeFile(file, JSON.stringify({ preview_digest: 1 }));
    const invalid = await run(ctx, "api", "post", "/tickets/PIDGEN-4/reopen", "-f", file);
    expect(invalid.code).toBe(ExitCode.Usage);
    expect(invalid.body.error?.code).toBe("INPUT_INVALID");
    expect(urls).toHaveLength(0);
  });
});
