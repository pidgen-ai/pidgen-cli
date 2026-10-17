import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, testContext } from "../support/context.js";
import { useMockServer } from "../support/mock-server.js";

// `pidgen worker enroll` against Prism mocking the committed contracts/openapi.json: Prism refuses a
// body the document does not accept, and answers with the documented enrollment.

const server = useMockServer();

interface Body {
  ok: boolean;
  data: Record<string, unknown> | null;
  error: { code: string; details: Record<string, unknown> } | null;
}

describe("pidgen worker enroll against the Prism mock of the committed document", () => {
  async function context(sent: { method: string; url: string }[]) {
    return testContext({
      env: {
        PIDGEN_API_URL: server().url,
        PIDGEN_TOKEN: "pidgen_pat_fake_contract_token",
        PIDGEN_ACCOUNT: "ACC-EXAMPLE",
      },
      fetch: (input, init) => {
        sent.push({ method: init?.method ?? "GET", url: String(input) });
        return globalThis.fetch(input, init);
      },
    });
  }

  it("sends a body the document accepts and reads the documented install options", async () => {
    const sent: { method: string; url: string }[] = [];
    const ctx = await context(sent);
    const bin = join(ctx.homeDir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "pidgen-worker"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "pidgen-worker"), 0o755);
    ctx.env["PATH"] = bin;

    const code = await runCli(
      ["--timeout", "10", "worker", "enroll", "--label", "build box", "--no-install"],
      ctx,
    );
    const body = envelope(ctx) as unknown as Body;

    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: { enrolled: true, installed: null } });
    expect(body.data?.["install"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ form: expect.any(String), install: expect.any(String) }),
      ]),
    );
    expect(sent).toEqual([{ method: "POST", url: `${server().url}/api/v1/workers/enrollments` }]);
  });

  it("with the worker missing and --no-install, spends no enrollment", async () => {
    const sent: { method: string; url: string }[] = [];
    const ctx = await context(sent);
    const empty = join(ctx.homeDir, "empty-bin");
    await mkdir(empty);
    ctx.env["PATH"] = empty;

    const code = await runCli(["--timeout", "10", "worker", "enroll", "--no-install"], ctx);

    expect(code).toBe(ExitCode.Usage);
    expect(envelope(ctx)).toMatchObject({ ok: false, error: { code: "WORKER_NOT_FOUND" } });
    expect(sent).toEqual([]);
  });
});
