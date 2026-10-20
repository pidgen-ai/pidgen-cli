import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";
import { useMockServer } from "../support/mock-server.js";

// `pidgen worker enroll` against Prism mocking the pending fragment
// (contracts/pending/worker-enrollments.json, AC-2fc2fc58890f): the published enrollment create
// plus install_id, and the withdraw. Prism refuses a body or a path the fragment does not accept,
// and answers with the documented enrollment.

const PENDING = fileURLToPath(
  new URL("../../contracts/pending/worker-enrollments.json", import.meta.url),
);
const server = useMockServer(PENDING);

interface Body {
  ok: boolean;
  data: Record<string, unknown> | null;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
}

interface Sent {
  method: string;
  url: string;
  body: unknown;
  status: number;
}

describe("pidgen worker enroll against the Prism mock of the pending worker enrollments fragment", () => {
  /**
   * A context whose requests go to Prism, each recorded with its answer's status; `stub` may answer
   * a request itself instead.
   */
  async function context(
    sent: Sent[],
    stub: (method: string, body: unknown) => Response | null = () => null,
  ) {
    return testContext({
      env: {
        PIDGEN_API_URL: server().url,
        PIDGEN_TOKEN: "pidgen_pat_fake_contract_token",
        PIDGEN_ACCOUNT: "ACC-EXAMPLE",
      },
      fetch: async (input, init) => {
        const method = init?.method ?? "GET";
        const body =
          typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
        const response = stub(method, body) ?? (await globalThis.fetch(input, init));
        sent.push({ method, url: String(input), body, status: response.status });
        return response;
      },
    });
  }

  /** Puts a fake pidgen-worker on PATH that exits with `status`. */
  async function worker(ctx: TestContext, status = 0): Promise<void> {
    const bin = join(ctx.homeDir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "pidgen-worker"), `#!/bin/sh\nexit ${status}\n`);
    await chmod(join(bin, "pidgen-worker"), 0o755);
    ctx.env["PATH"] = bin;
  }

  const installId = async (ctx: TestContext) =>
    (await readFile(join(ctx.homeDir, ".pidgen", "install-id"), "utf8")).trim();

  it("sends a body the fragment accepts, install_id included, and reads the documented install options", async () => {
    const sent: Sent[] = [];
    const ctx = await context(sent);
    await worker(ctx);

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
    const id = await installId(ctx);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(sent).toEqual([
      {
        method: "POST",
        url: `${server().url}/api/v1/workers/enrollments`,
        body: { label: "build box", install_id: id },
        status: 201,
      },
    ]);
    expect(body.data).toMatchObject({ install_id: id });
  });

  // AC-351ddea6a356: a server from before install ids refuses the field (a stubbed 422); the create
  // is sent once more without it, and Prism accepts that.
  it("a stubbed 422 naming install_id: two requests, the second without the field, and success", async () => {
    const sent: Sent[] = [];
    const ctx = await context(sent, (method, body) =>
      method === "POST" && typeof body === "object" && body !== null && "install_id" in body
        ? jsonResponse(422, {
            status: "error",
            error: {
              code: "INPUT_INVALID",
              message: "The request failed validation.",
              details: {
                errors: [
                  {
                    loc: ["body", "install_id"],
                    msg: "Extra inputs are not permitted",
                    type: "extra_forbidden",
                  },
                ],
              },
              request_id: "req_fake_install_id",
            },
          })
        : null,
    );
    await worker(ctx);

    const code = await runCli(["--timeout", "10", "worker", "enroll", "--no-install"], ctx);
    const body = envelope(ctx) as unknown as Body;

    expect(body.error).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(sent).toEqual([
      {
        method: "POST",
        url: `${server().url}/api/v1/workers/enrollments`,
        body: { install_id: await installId(ctx) },
        status: 422,
      },
      { method: "POST", url: `${server().url}/api/v1/workers/enrollments`, body: {}, status: 201 },
    ]);
    expect(body.data).toMatchObject({ enrolled: true, install_id: null });
  });

  // AC-b25f2e3c4fcc: the exchange fails after the enrollment was created: the withdraw is a route
  // the fragment accepts, and the failure keeps its code and exit code.
  it("a failing pidgen-worker enroll withdraws the enrollment with DELETE, which the fragment accepts", async () => {
    const sent: Sent[] = [];
    const ctx = await context(sent);
    await worker(ctx, 9);

    const code = await runCli(["--timeout", "10", "worker", "enroll", "--no-install"], ctx);
    const body = envelope(ctx) as unknown as Body;

    expect(code).toBe(ExitCode.Unexpected);
    expect(sent.map(({ method, url, status }) => ({ method, url, status }))).toEqual([
      { method: "POST", url: `${server().url}/api/v1/workers/enrollments`, status: 201 },
      {
        method: "DELETE",
        url: `${server().url}/api/v1/workers/enrollments/enr-example-1`,
        status: 200,
      },
    ]);
    expect(body).toMatchObject({
      ok: false,
      error: { code: "ENROLL_FAILED", details: { exit_code: 9, withdrawn: true } },
    });
    expect(body.error!.message).toContain("The enrollment enr-example-1 was withdrawn.");
  });

  it("with the worker missing and --no-install, spends no enrollment", async () => {
    const sent: Sent[] = [];
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
