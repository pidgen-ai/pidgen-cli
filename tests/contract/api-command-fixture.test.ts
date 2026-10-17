import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import type { OpenApiDocument } from "../../src/core/input.js";
import { envelope, testContext, type TestContext } from "../support/context.js";
import { FIXTURE_DOCUMENT, useMockServer } from "../support/mock-server.js";

// The committed contracts/openapi.json carries no response examples, so Prism cannot answer it
// with a particular error code. These tests bind the `api` commands to the fixture document, whose
// examples do, to check that server codes pass through with their exit codes. Everything else is
// covered against the committed document in api-command.test.ts.
vi.mock("../../src/commands/index.js", async () => {
  const { readFileSync } = await import("node:fs");
  const { apiCommands } = await import("../../src/commands/api/call.js");
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/openapi.fixture.json", import.meta.url), "utf8"),
  ) as OpenApiDocument;
  return { commands: apiCommands(fixture) };
});

const server = useMockServer(FIXTURE_DOCUMENT);

interface Body {
  ok: boolean;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
}

async function setup(): Promise<TestContext> {
  return testContext({
    env: {
      PIDGEN_API_URL: server().url,
      PIDGEN_TOKEN: "pidgen_pat_fake_contract_token",
      PIDGEN_ACCOUNT: "ACC-EXAMPLE",
    },
    fetch: (input, init) => globalThis.fetch(input, init),
  });
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(["--timeout", "10", ...argv], ctx);
  return { code, body: envelope(ctx) as unknown as Body };
}

describe("pidgen api against the Prism mock of the fixture document", () => {
  it("passes through a server error code (404 PROJECT_NOT_FOUND)", async () => {
    const ctx = await setup();
    const { code, body } = await run(
      ctx,
      "api",
      "get",
      "/projects/proj-missing",
      "--query",
      "__code=404",
    );
    expect(code).toBe(ExitCode.NotFound);
    expect(body.error).toMatchObject({
      code: "PROJECT_NOT_FOUND",
      message: "No project proj-missing.",
      details: { status: 404 },
    });
  });

  it("passes through a server refusal code with its exit code (409 PREVIEW_STALE)", async () => {
    const ctx = await setup();
    const file = join(ctx.cwd, "apply.json");
    await writeFile(
      file,
      JSON.stringify({
        preview_digest: "sha256:abc",
        idempotency_key: "k-1",
        acknowledgements: [],
      }),
    );
    const { code, body } = await run(
      ctx,
      "api",
      "post",
      "/tickets/PIDGEN-4/retry/apply",
      "--query",
      "__code=409",
      "-f",
      file,
    );
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body.error?.code).toBe("PREVIEW_STALE");
  });
});
