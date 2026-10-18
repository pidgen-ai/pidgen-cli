import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope } from "../support/context.js";
import { committedDocumentForStaticMock, useMockServer } from "../support/mock-server.js";
import { publishedIssues } from "../support/published.js";
import {
  installContext,
  previousInstall,
  releaseList,
  WHEEL_SHA256,
  type InstallContext,
} from "../support/worker-install.js";

// `pidgen worker install` and `pidgen doctor` against Prism mocking the committed
// contracts/openapi.json for GET /api/v1/workers/releases. The published route states no example,
// so the mock answers with the test release list (tests/support/worker-install.ts), checked here
// against the published WorkerReleaseList; PyPI, the wheel and its provenance are the recorded
// fixtures, and uv is a fake that logs its argument lists.

const RELEASES = { status: "ok", data: releaseList(), meta: {} };
// The published HealthResponse states no example either, and `pidgen doctor` refuses a server
// whose `service` is not `pidgen`.
const HEALTH = {
  status: "ok",
  service: "pidgen",
  api_version: { current: "1.0", minimum: "1.0" },
  instance_id: "api-example",
  build_version: "0.0.0-example",
  deployment_tier: "development",
};
const server = useMockServer(
  committedDocumentForStaticMock({
    "GET /api/v1/health": HEALTH,
    "GET /api/v1/workers/releases": RELEASES,
  }),
);

async function againstPrism(options: Parameters<typeof installContext>[0] = {}) {
  const setup: InstallContext = await installContext(options);
  const fake = setup.ctx.fetch;
  const sent: { url: string; headers: Record<string, string> }[] = [];
  setup.ctx.env["PIDGEN_API_URL"] = server().url;
  setup.ctx.fetch = (input, init) => {
    const url = String(input);
    if (!url.startsWith(server().url)) return fake(input, init);
    sent.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return globalThis.fetch(input, init);
  };
  return { setup, sent };
}

describe("worker releases against the Prism mock of the published document", () => {
  it("the release list the mock answers with is the published WorkerReleaseListResponse", () => {
    expect(publishedIssues("WorkerReleaseListResponse", RELEASES)).toEqual([]);
  });

  it("the health answer the mock gives is the published HealthResponse", () => {
    expect(publishedIssues("HealthResponse", HEALTH)).toEqual([]);
  });

  it("installs the current release the documented list names, verified, with uv", async () => {
    const { setup, sent } = await againstPrism();

    const code = await runCli(["--timeout", "10", "worker", "install"], setup.ctx);

    expect(code).toBe(ExitCode.Ok);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: true,
      data: {
        form: "wheel",
        version: "1.0.0",
        artifact: "pidgen-worker==1.0.0",
        digest: `sha256:${WHEEL_SHA256}`,
        installed: true,
      },
    });
    expect(sent.map((request) => request.url)).toEqual([`${server().url}/api/v1/workers/releases`]);
    expect(sent[0]!.headers).not.toHaveProperty("authorization");
    const installs = (await setup.uvRuns()).filter((run) => run.args[1] === "install");
    expect(installs).toHaveLength(1);
    expect(installs[0]!.sha256).toBe(WHEEL_SHA256);
  });

  it("updates an earlier install to the current release the documented list names", async () => {
    const { setup, sent } = await againstPrism();
    await previousInstall(setup);

    const code = await runCli(["--timeout", "10", "worker", "update"], setup.ctx);

    expect(code).toBe(ExitCode.Ok);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: true,
      data: { version: "1.0.0", digest: `sha256:${WHEEL_SHA256}`, updated: true },
    });
    expect(sent.map((request) => request.url)).toEqual([`${server().url}/api/v1/workers/releases`]);
  });

  it("refuses a release of a series the documented list does not accept", async () => {
    const { setup } = await againstPrism();

    const code = await runCli(
      ["--timeout", "10", "worker", "install", "--version", "0.7.0"],
      setup.ctx,
    );

    expect(code).toBe(ExitCode.Refused);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: false,
      error: { code: "RELEASE_UNSUPPORTED", details: { series: "0.7", accepted: ["1.0", "0.9"] } },
    });
  });

  it("pidgen doctor takes its harness checks from the documented list", async () => {
    const { setup } = await againstPrism({ commands: ["claude", "codex"] });
    expect(await runCli(["--timeout", "10", "worker", "install"], setup.ctx)).toBe(ExitCode.Ok);
    setup.ctx.out.length = 0;

    const code = await runCli(["--timeout", "10", "doctor"], setup.ctx);

    // No Account is signed in, so the credential check is the one failure; the release, harness
    // and worker checks come from the documented list. The runtime check depends on the machine.
    expect(code).toBe(ExitCode.Unexpected);
    const body = envelope(setup.ctx);
    expect(body).toMatchObject({ ok: false, error: { code: "DOCTOR_FAILED" } });
    const { details } = body["error"] as { details: { checks: { id: string; status: string }[] } };
    const checks = details.checks;
    expect(checks.filter((check) => check.status === "fail").map((check) => check.id)).toEqual([
      "credential",
    ]);
    expect(checks.filter((check) => check.id !== "runtime" && check.id !== "credential")).toEqual([
      expect.objectContaining({ id: "node", status: "ok" }),
      expect.objectContaining({ id: "git", status: "ok" }),
      expect.objectContaining({ id: "server", status: "ok" }),
      expect.objectContaining({ id: "releases", status: "ok" }),
      expect.objectContaining({ id: "harness:claude", status: "ok" }),
      expect.objectContaining({ id: "harness:codex", status: "ok" }),
      expect.objectContaining({ id: "worker", status: "ok" }),
    ]);
  });
});
