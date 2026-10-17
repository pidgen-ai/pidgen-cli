import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { defaultWorkerRuntime } from "../../src/core/worker.js";
import { envelope, testContext } from "../support/context.js";
import { committedDocumentForStaticMock, useMockServer } from "../support/mock-server.js";
import { releaseList } from "../support/worker-install.js";

// `pidgen worker status` against Prism mocking the committed contracts/openapi.json: the CLI reads the
// documented worker list and reports the App Service's view beside the local record. Its update
// check reads the published worker release list, which the published route states no example
// for: the mock answers with the test release list (tests/support/worker-install.ts).

const server = useMockServer(
  committedDocumentForStaticMock({
    "GET /api/v1/workers/releases": { status: "ok", data: releaseList(), meta: {} },
  }),
);
const RELEASES_PATH = "/api/v1/workers/releases";

interface Body {
  ok: boolean;
  data: {
    record: unknown;
    running: boolean;
    server: {
      host_id: string;
      enrolled: boolean;
      worker: Record<string, unknown> | null;
      service_protocol: string;
      accepted_protocols: string[];
    } | null;
    update: { installed: string | null; current: string | null; needed: boolean; reason: unknown };
    warnings: unknown[];
  };
}

describe("pidgen worker status against the Prism mock of the committed document", () => {
  it("reads the documented worker list", async () => {
    const sent: { method: string; url: string }[] = [];
    const ctx = await testContext({
      env: {
        PIDGEN_API_URL: server().url,
        PIDGEN_TOKEN: "pidgen_pat_fake_contract_token",
        PIDGEN_ACCOUNT: "ACC-EXAMPLE",
      },
      workerRuntime: { ...defaultWorkerRuntime, platform: "linux" },
      fetch: (input, init) => {
        sent.push({ method: init?.method ?? "GET", url: String(input) });
        return globalThis.fetch(input, init);
      },
    });

    const code = await runCli(["--timeout", "10", "worker", "status"], ctx);
    const body = envelope(ctx) as unknown as Body;

    expect(code).toBe(ExitCode.Ok);
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({ record: null, running: false, warnings: [] });
    expect(body.data.server).toMatchObject({
      host_id: "worker-host.example.com",
      service_protocol: expect.any(String),
      accepted_protocols: expect.any(Array),
    });
    expect(typeof body.data.server?.enrolled).toBe("boolean");
    expect(body.data.update).toMatchObject({ installed: null, current: "1.0" });
    expect(typeof body.data.update.needed).toBe("boolean");
    expect(sent).toEqual([
      { method: "GET", url: `${server().url}/api/v1/workers` },
      { method: "GET", url: `${server().url}${RELEASES_PATH}` },
    ]);
  });
});
