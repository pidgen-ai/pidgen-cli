import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import {
  defaultWorkerRuntime,
  type WorkerRecord,
  type WorkerRuntime,
} from "../../src/core/worker.js";
import {
  envelope,
  expectMutationParity,
  jsonResponse,
  testContext,
  type TestContext,
} from "../support/context.js";
import { releaseList, seriesEntry, type ReleaseList } from "../support/worker-install.js";

const SERVER = "https://pidgen.example.com";
const PAT = "pidgen_pat_fake_token_for_tests";
const HOST = "worker-host.example.com";
const RUNNING_PID = 4242;

const CONFIG: Config = {
  default_profile: "default",
  profiles: {
    default: {
      url: SERVER,
      default_account: "ACC-EXAMPLE",
      credentials: { "ACC-EXAMPLE": { kind: "pat", token: PAT } },
    },
  },
};

interface Body {
  ok: boolean;
  data: Record<string, unknown> | null;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  meta: Record<string, unknown>;
}

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
}

function worker(hostId: string, overrides: Record<string, unknown> = {}) {
  return {
    host_id: hostId,
    locality_domain: "example",
    enabled: true,
    connected: true,
    created_at: "2026-09-20T08:00:00Z",
    last_seen_at: "2026-09-27T09:58:00Z",
    revoked_at: null,
    build_version: "1.4.0",
    protocol: "2.3",
    protocol_state: "current",
    git_credentials: [
      {
        project_id: "proj-example",
        remote_url: "https://git.example.com/example/app.git",
        local_credential: true,
        state: "covered",
        reported_at: "2026-09-27T09:00:00Z",
      },
      {
        project_id: "proj-example-2",
        remote_url: "https://git.example.com/example/lib.git",
        local_credential: false,
        state: "missing",
        reported_at: "2026-09-27T09:00:00Z",
      },
    ],
    ...overrides,
  };
}

function workerList(workers: unknown[]) {
  return {
    status: "ok",
    data: { service_protocol: "2.3", accepted_protocols: ["2.2", "2.3"], workers },
  };
}

function ok(body: unknown) {
  return jsonResponse(200, body, { "x-request-id": "req_fake_1", "pidgen-api-version": "1.0" });
}

const RELEASES_PATH = "/api/v1/workers/releases";

/** The update block when nothing is known to be needed. */
const NO_UPDATE = { installed: null, current: "1.0", needed: false, reason: null };
const LOCAL_UPDATE = { installed: null, current: null, needed: false, reason: null };

/** An install record as `pidgen worker install` writes it, for `version`. */
function installRecord(version: string) {
  return {
    form: "wheel",
    version,
    artifact: `pidgen-worker==${version}`,
    digest: `sha256:${"a".repeat(64)}`,
    identity: { issuer: "https://issuer.test.example", subject: "example-org" },
    verified_at: "2026-09-01T00:00:00.000Z",
    installed_at: "2026-09-01T00:00:00.000Z",
    location: "/opt/example/bin/pidgen-worker",
    file: `/opt/example/pidgen_worker-${version}-py3-none-any.whl`,
  };
}

/** A release list whose current series is `current`, with series 0.8 still supported. */
function releases(current = "1.0"): ReleaseList {
  const list = releaseList();
  list.current = current;
  list.accepted_protocols = [current, "0.8"];
  list.releases = [seriesEntry(current, "current"), seriesEntry("0.8", "supported")];
  return list;
}

const RECORD: WorkerRecord = {
  pid: RUNNING_PID,
  started_at: "2026-09-27T08:00:00.000Z",
  log: "/tmp/pidgen-example/worker-manager.log",
  command: ["/opt/example/bin/pidgen-worker"],
};

/**
 * A context with a detached worker record whose process is running, a fake process table, and a
 * fetch that records every call and answers with `respond`.
 */
async function setup(
  options: {
    config?: Config | null;
    env?: Record<string, string>;
    respond?: (call: Call) => Promise<Response>;
    /** The answer to the release list; the default lists 1.0.0 as current. */
    releases?: (call: Call) => Promise<Response>;
    record?: WorkerRecord | null;
    /** The installed version's install record, or none. */
    installed?: string | null;
  } = {},
) {
  const calls: Call[] = [];
  const runtime: WorkerRuntime = {
    ...defaultWorkerRuntime,
    platform: "linux",
    isWorkerProcess: (pid) => Promise.resolve(pid === RUNNING_PID),
  };
  const respond = options.respond ?? (() => Promise.reject(new Error("unexpected network call")));
  const answerReleases =
    options.releases ?? (() => Promise.resolve(ok({ status: "ok", data: releases() })));
  const ctx: TestContext = await testContext({
    workerRuntime: runtime,
    fetch: (input, init) => {
      const call: Call = {
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        headers: { ...(init?.headers as Record<string, string>) },
      };
      calls.push(call);
      return call.url.pathname === RELEASES_PATH ? answerReleases(call) : respond(call);
    },
  });
  ctx.env = { ...(options.env ?? {}) };
  const config = options.config === undefined ? CONFIG : options.config;
  if (config !== null) await saveConfig(ctx, config);

  const record = options.record === undefined ? RECORD : options.record;
  if (record !== null) {
    const run = join(ctx.homeDir, ".pidgen", "run");
    await mkdir(run, { recursive: true });
    await writeFile(join(run, "pidgen-worker.json"), JSON.stringify(record));
  }
  if (options.installed) {
    const run = join(ctx.homeDir, ".pidgen", "run");
    await mkdir(run, { recursive: true });
    await writeFile(
      join(run, "pidgen-install.json"),
      JSON.stringify(installRecord(options.installed)),
    );
  }
  return { ctx, calls };
}

async function status(ctx: TestContext, args: string[] = []) {
  const code = await runCli(["worker", "status", ...args], ctx);
  return { code, body: envelope(ctx) as unknown as Body };
}

describe("pidgen worker status", () => {
  describe("server view", () => {
    it("adds the App Service's record of this worker beside the local record", async () => {
      const { ctx, calls } = await setup({
        respond: () => Promise.resolve(ok(workerList([worker("other-host"), worker(HOST)]))),
      });

      const { code, body } = await status(ctx);

      expect(code).toBe(ExitCode.Ok);
      expect(body.ok).toBe(true);
      expect(body.data).toEqual({
        record: RECORD,
        running: true,
        server: {
          host_id: HOST,
          enrolled: true,
          worker: worker(HOST),
          service_protocol: "2.3",
          accepted_protocols: ["2.2", "2.3"],
        },
        update: NO_UPDATE,
        warnings: [],
      });
      expect(body.meta).toMatchObject({
        profile: "default",
        account: "ACC-EXAMPLE",
        request_id: "req_fake_1",
        api_version: "1.0",
      });
      expect(calls).toHaveLength(2);
      expect(calls[0]?.method).toBe("GET");
      expect(calls[0]?.url.toString()).toBe(`${SERVER}/api/v1/workers`);
      expect(calls[0]?.headers).toMatchObject({
        authorization: `Bearer ${PAT}`,
        "x-pidgen-account": "ACC-EXAMPLE",
      });
      // The release list is read with no credential and no Account.
      expect(calls[1]?.url.toString()).toBe(`${SERVER}${RELEASES_PATH}`);
      expect(calls[1]?.headers).not.toHaveProperty("authorization");
      expect(calls[1]?.headers).not.toHaveProperty("x-pidgen-account");
      expect(ctx.err.join("")).toBe("");
    });

    it("shows the last-seen time, protocol state and git credential coverage", async () => {
      const seen = worker(HOST, {
        last_seen_at: "2026-09-27T10:00:00Z",
        protocol: "2.2",
        protocol_state: "outdated",
        connected: false,
      });
      const { ctx } = await setup({ respond: () => Promise.resolve(ok(workerList([seen]))) });

      const { code, body } = await status(ctx);

      expect(code).toBe(ExitCode.Ok);
      const server = body.data?.["server"] as { worker: Record<string, unknown> };
      expect(server.worker).toMatchObject({
        last_seen_at: "2026-09-27T10:00:00Z",
        protocol: "2.2",
        protocol_state: "outdated",
        git_credentials: [
          { project_id: "proj-example", state: "covered", local_credential: true },
          { project_id: "proj-example-2", state: "missing", local_credential: false },
        ],
      });
    });

    it("matches the worker named by --host instead of this machine's host name", async () => {
      const { ctx } = await setup({
        respond: () =>
          Promise.resolve(ok(workerList([worker(HOST), worker("build-box", { protocol: "2.1" })]))),
      });

      const { code, body } = await status(ctx, ["--host", "build-box"]);

      expect(code).toBe(ExitCode.Ok);
      expect(body.data?.["server"]).toMatchObject({
        host_id: "build-box",
        enrolled: true,
        worker: { host_id: "build-box", protocol: "2.1" },
      });
    });

    it("prefers the unrevoked worker when the host was enrolled more than once", async () => {
      const revoked = worker(HOST, {
        created_at: "2026-09-25T08:00:00Z",
        revoked_at: "2026-09-26T08:00:00Z",
      });
      const { ctx } = await setup({
        respond: () => Promise.resolve(ok(workerList([revoked, worker(HOST)]))),
      });

      const { body } = await status(ctx);

      expect(body.data?.["server"]).toMatchObject({
        enrolled: true,
        worker: { revoked_at: null, created_at: "2026-09-20T08:00:00Z" },
      });
    });

    it("uses PIDGEN_API_URL, PIDGEN_TOKEN and PIDGEN_ACCOUNT with no stored configuration", async () => {
      const { ctx, calls } = await setup({
        config: null,
        env: {
          PIDGEN_API_URL: SERVER,
          PIDGEN_TOKEN: "pidgen_pat_fake_env_token",
          PIDGEN_ACCOUNT: "ACC-EXAMPLE",
        },
        respond: () => Promise.resolve(ok(workerList([worker(HOST)]))),
      });

      const { code, body } = await status(ctx);

      expect(code).toBe(ExitCode.Ok);
      expect(body.data?.["server"]).toMatchObject({ enrolled: true });
      expect(calls[0]?.headers["authorization"]).toBe("Bearer pidgen_pat_fake_env_token");
    });

    it("reports the server view with no local worker record", async () => {
      const { ctx } = await setup({
        record: null,
        respond: () => Promise.resolve(ok(workerList([worker(HOST)]))),
      });

      const { code, body } = await status(ctx);

      expect(code).toBe(ExitCode.Ok);
      expect(body.data).toMatchObject({
        record: null,
        running: false,
        server: { enrolled: true, worker: { host_id: HOST } },
        warnings: [],
      });
    });

    it("warns when the server's answer is not a worker list", async () => {
      const { ctx } = await setup({
        respond: () => Promise.resolve(ok({ status: "ok", data: { unexpected: true } })),
      });

      const { code, body } = await status(ctx);

      expect(code).toBe(ExitCode.Ok);
      expect(body.data).toMatchObject({
        record: RECORD,
        running: true,
        server: null,
        warnings: [{ code: "SERVER_RESPONSE_INVALID" }],
      });
    });
  });

  describe("unreachable", () => {
    // AC-e9b2af44165c: a successful local read retains its service warning and status.
    it.each([40, 80, 120])(
      "human unreachable status preserves exit and requests at width %s",
      async (columns) => {
        const { ctx, calls } = await setup({
          respond: () => Promise.reject(new TypeError("fetch failed")),
        });
        ctx.io.stdoutColumns = columns;
        const json = await expectMutationParity(
          ctx,
          calls,
          ["worker", "status"],
          ["Worker status", "NETWORK", "fetch failed", "Running: true", "Server: null"],
        );
        expect(json).toMatchObject({
          ok: true,
          data: { running: true, server: null, warnings: [{ code: "NETWORK" }] },
        });
      },
    );

    it("an unreachable server leaves the local status, adds a warning and exits 0", async () => {
      const { ctx, calls } = await setup({
        respond: () => Promise.reject(new TypeError("fetch failed")),
      });

      const { code, body } = await status(ctx);

      expect(code).toBe(ExitCode.Ok);
      expect(body.ok).toBe(true);
      expect(body.error).toBeNull();
      expect(body.data).toEqual({
        record: RECORD,
        running: true,
        server: null,
        update: LOCAL_UPDATE,
        warnings: [
          {
            code: "NETWORK",
            message: expect.stringContaining("Could not reach https://pidgen.example.com"),
            details: { cause: "fetch failed" },
          },
        ],
      });
      expect(body.meta).toMatchObject({ profile: "default", account: "ACC-EXAMPLE" });
      // GET is retried on network errors before the server is given up on.
      expect(calls.length).toBeGreaterThan(1);
      expect(ctx.out).toHaveLength(1);
      expect(ctx.err.join("")).toBe("");
    });

    it("an unreachable server that times out is a TIMEOUT warning", async () => {
      const { ctx } = await setup({
        respond: () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      });

      const { code, body } = await status(ctx);

      expect(code).toBe(ExitCode.Ok);
      expect(body.data).toMatchObject({
        record: RECORD,
        running: true,
        server: null,
        warnings: [{ code: "TIMEOUT" }],
      });
    });

    it("a server refusal is also a warning, not a failure (unreachable view)", async () => {
      const { ctx } = await setup({
        respond: () =>
          Promise.resolve(
            jsonResponse(403, {
              status: "error",
              error: {
                code: "FORBIDDEN",
                message: "Owners and Administrators only.",
                details: null,
                request_id: "req_fake_error",
              },
            }),
          ),
      });

      const { code, body } = await status(ctx);

      expect(code).toBe(ExitCode.Ok);
      expect(body.data).toMatchObject({
        record: RECORD,
        running: true,
        server: null,
        warnings: [
          {
            code: "FORBIDDEN",
            details: { status: 403, request_id: "req_fake_error" },
          },
        ],
      });
    });

    it("an unreadable configuration is a warning while the local status is shown (unreachable)", async () => {
      const { ctx, calls } = await setup({ config: null });
      const path = join(ctx.homeDir, ".config", "pidgen", "config.json");
      await mkdir(join(ctx.homeDir, ".config", "pidgen"), { recursive: true });
      await writeFile(path, "not json", { mode: 0o600 });

      const { code, body } = await status(ctx);

      expect(code).toBe(ExitCode.Ok);
      expect(body.data).toMatchObject({
        record: RECORD,
        running: true,
        server: null,
        warnings: [{ code: "CONFIG_INVALID" }],
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe("not enrolled", () => {
    it("reports no enrolled worker on the server as enrolled: false, not an error", async () => {
      const { ctx, calls } = await setup({
        respond: () => Promise.resolve(ok(workerList([worker("other-host")]))),
      });

      const { code, body } = await status(ctx);

      expect(code).toBe(ExitCode.Ok);
      expect(body.ok).toBe(true);
      expect(body.error).toBeNull();
      expect(body.data).toEqual({
        record: RECORD,
        running: true,
        server: {
          host_id: HOST,
          enrolled: false,
          worker: null,
          service_protocol: "2.3",
          accepted_protocols: ["2.2", "2.3"],
        },
        update: NO_UPDATE,
        warnings: [],
      });
      expect(calls).toHaveLength(2);
    });

    it("reports not enrolled when the Account has no workers at all", async () => {
      const { ctx } = await setup({ respond: () => Promise.resolve(ok(workerList([]))) });

      const { code, body } = await status(ctx);

      expect(code).toBe(ExitCode.Ok);
      expect(body.data?.["server"]).toMatchObject({ enrolled: false, worker: null });
    });

    it("reports not enrolled, with the revoked worker, when its credential was revoked", async () => {
      const revoked = worker(HOST, { revoked_at: "2026-09-26T08:00:00Z", connected: false });
      const { ctx } = await setup({ respond: () => Promise.resolve(ok(workerList([revoked]))) });

      const { code, body } = await status(ctx);

      expect(code).toBe(ExitCode.Ok);
      expect(body.data?.["server"]).toMatchObject({
        enrolled: false,
        worker: { host_id: HOST, revoked_at: "2026-09-26T08:00:00Z" },
      });
    });
  });

  // AC-2c44fe1c975d: `update` — installed, current, needed and reason.
  describe("update", () => {
    it.each([
      ["unsupported", "protocol_unsupported"],
      ["outdated", "protocol_outdated"],
    ])(
      "reports needed with reason %s → %s from the server's record of the worker",
      async (state, reason) => {
        const { ctx } = await setup({
          installed: "1.0.0",
          respond: () => Promise.resolve(ok(workerList([worker(HOST, { protocol_state: state })]))),
        });

        const { code, body } = await status(ctx);

        expect(code).toBe(ExitCode.Ok);
        expect(body.data?.["update"]).toEqual({
          installed: "1.0.0",
          current: "1.0",
          needed: true,
          reason,
        });
      },
    );

    it("reports newer_available when the release list's current is newer than the installed release", async () => {
      const { ctx } = await setup({
        installed: "0.8.0",
        respond: () => Promise.resolve(ok(workerList([worker(HOST)]))),
      });

      const { code, body } = await status(ctx);

      expect(code).toBe(ExitCode.Ok);
      expect(body.data?.["update"]).toEqual({
        installed: "0.8.0",
        current: "1.0",
        needed: true,
        reason: "newer_available",
      });
      expect(body.data?.["warnings"]).toEqual([]);
    });

    it("compares versions numerically, not as text", async () => {
      const { ctx } = await setup({
        installed: "1.9.0",
        releases: () => Promise.resolve(ok({ status: "ok", data: releases("1.10") })),
        respond: () => Promise.resolve(ok(workerList([worker(HOST)]))),
      });

      const { body } = await status(ctx);

      expect(body.data?.["update"]).toMatchObject({ needed: true, reason: "newer_available" });
    });

    it("prefers the protocol reason over newer_available", async () => {
      const { ctx } = await setup({
        installed: "0.8.0",
        respond: () =>
          Promise.resolve(ok(workerList([worker(HOST, { protocol_state: "unsupported" })]))),
      });

      const { body } = await status(ctx);

      expect(body.data?.["update"]).toMatchObject({ needed: true, reason: "protocol_unsupported" });
    });

    it("reports no update needed when the current release is installed and the protocol is current", async () => {
      const { ctx } = await setup({
        installed: "1.0.0",
        respond: () => Promise.resolve(ok(workerList([worker(HOST)]))),
      });

      const { body } = await status(ctx);

      expect(body.data?.["update"]).toEqual({
        installed: "1.0.0",
        current: "1.0",
        needed: false,
        reason: null,
      });
    });

    it("keeps the protocol reason and warns when the release list cannot be read", async () => {
      const { ctx } = await setup({
        installed: "1.0.0",
        respond: () =>
          Promise.resolve(ok(workerList([worker(HOST, { protocol_state: "outdated" })]))),
        releases: () =>
          Promise.resolve(
            jsonResponse(503, {
              status: "error",
              error: { code: "SERVICE_UNAVAILABLE", message: "Try again later." },
            }),
          ),
      });

      const { code, body } = await status(ctx);

      expect(code).toBe(ExitCode.Ok);
      expect(body.data).toMatchObject({
        server: { enrolled: true },
        update: { installed: "1.0.0", current: null, needed: true, reason: "protocol_outdated" },
        warnings: [{ code: "SERVICE_UNAVAILABLE" }],
      });
    });

    it("warns, and still exits 0, when the install record cannot be read", async () => {
      const { ctx } = await setup({ config: null });
      await writeFile(join(ctx.homeDir, ".pidgen", "run", "pidgen-install.json"), "not json");

      const { code, body } = await status(ctx);

      expect(code).toBe(ExitCode.Ok);
      expect(body.data).toEqual({
        record: RECORD,
        running: true,
        update: LOCAL_UPDATE,
        warnings: [expect.objectContaining({ code: "INSTALL_RECORD_INVALID" })],
      });
    });

    it("reports the installed release with no current one when there is no credential", async () => {
      const { ctx, calls } = await setup({ config: null, installed: "0.8.0" });

      const { code, body } = await status(ctx);

      expect(code).toBe(ExitCode.Ok);
      expect(body.data?.["update"]).toEqual({
        installed: "0.8.0",
        current: null,
        needed: false,
        reason: null,
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe("local only", () => {
    it("keeps the local-only status with no configuration and makes no request", async () => {
      const { ctx, calls } = await setup({ config: null });

      const { code, body } = await status(ctx);

      expect(code).toBe(ExitCode.Ok);
      expect(body.data).toEqual({ record: RECORD, running: true, update: LOCAL_UPDATE });
      expect(body.meta).toMatchObject({ profile: null, account: null, request_id: null });
      expect(calls).toHaveLength(0);
    });

    it("keeps the local-only status for a server with no stored credential", async () => {
      const { ctx, calls } = await setup({
        config: {
          default_profile: "default",
          profiles: { default: { url: SERVER, default_account: "ACC-EXAMPLE", credentials: {} } },
        },
      });

      const { code, body } = await status(ctx);

      expect(code).toBe(ExitCode.Ok);
      expect(body.data).toEqual({ record: RECORD, running: true, update: LOCAL_UPDATE });
      expect(calls).toHaveLength(0);
    });

    it("keeps the local-only status with a stale record and no credential", async () => {
      const { ctx, calls } = await setup({ config: null, record: { ...RECORD, pid: 99 } });

      const { code, body } = await status(ctx);

      expect(code).toBe(ExitCode.Ok);
      expect(body.data).toEqual({
        record: { ...RECORD, pid: 99 },
        running: false,
        update: LOCAL_UPDATE,
      });
      expect(calls).toHaveLength(0);
    });

    it("refuses an empty --host as a usage error (local only)", async () => {
      const { ctx, calls } = await setup({ config: null });

      const { code, body } = await status(ctx, ["--host", ""]);

      expect(code).toBe(ExitCode.Usage);
      expect(body).toMatchObject({ ok: false, error: { code: "CLI_USAGE" } });
      expect(calls).toHaveLength(0);
    });

    it("refuses an unsupported platform before any request (local only)", async () => {
      const { ctx, calls } = await setup({
        respond: () => Promise.resolve(ok(workerList([]))),
      });
      ctx.workerRuntime = { ...ctx.workerRuntime, platform: "win32" };

      const { code, body } = await status(ctx);

      expect(code).toBe(ExitCode.Usage);
      expect(body).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_PLATFORM" } });
      expect(calls).toHaveLength(0);
    });
  });
});
