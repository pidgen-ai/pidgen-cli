import { EventEmitter } from "node:events";
import { chmod, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { FIXES, gitCheck, nodeCheck } from "../../src/commands/doctor/doctor.js";
import { configPath, saveConfig, type Config } from "../../src/core/config.js";
import type { RunContext } from "../../src/core/context.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { defaultWorkerRuntime, type WorkerRuntime } from "../../src/core/worker.js";
import {
  envelope,
  expectMutationParity,
  jsonResponse,
  testContext,
  type TestContext,
} from "../support/context.js";
import {
  installContext,
  RELEASES_URL,
  releaseList,
  seriesEntry,
  type InstallContextOptions,
  type ReleaseList,
} from "../support/worker-install.js";

const URL_ = "https://pidgen.example.com";
const HEALTH = {
  status: "ok",
  service: "pidgen",
  api_version: { current: "1.0", minimum: "1.0" },
  instance_id: "api-example",
  build_version: "1.0.0",
  deployment_tier: "production",
};
const CLI_TOKEN = "pidgen_cli_fake_doctor_token";
const PAT = "pidgen_pat_fake_doctor_token";
const BIN = "/opt/fake-bin";

interface Check {
  id: string;
  status: "ok" | "warn" | "fail" | "skip";
  summary: string;
  fix: string | null;
}

interface Body {
  ok: boolean;
  data: { checks: Check[] } | null;
  error: { code: string; message: string; details: { checks?: Check[] } } | null;
  meta: Record<string, unknown>;
}

function config(credential: { kind: "cli" | "pat"; token: string } | null): Config {
  return {
    default_profile: "default",
    profiles: {
      default: {
        url: URL_,
        default_account: "ACC-EXAMPLE",
        credentials: credential ? { "ACC-EXAMPLE": credential } : {},
      },
    },
  };
}

function me(
  role: "owner" | "administrator" | "member",
  token: { kind: "cli" | "pat"; scopes: string[] },
) {
  return {
    user: {
      user_id: "usr-example",
      email: "person@example.com",
      display_name: "Example Person",
      email_verified: true,
    },
    memberships: [{ account_id: "ACC-EXAMPLE", account_name: "Example", role }],
    super_administrator: false,
    mfa: { enabled: false, required: false, recent: false, verified_at: null },
    pending_ownership_transfers: [],
    cli_token: { token_id: "tok_fake", account_id: "ACC-EXAMPLE", ...token },
  };
}

const ADMIN_ME = me("administrator", {
  kind: "cli",
  scopes: ["tickets:read", "tickets:write", "workers:enroll"],
});

interface Answers {
  health?: () => Response | Promise<Response>;
  me?: () => Response | Promise<Response>;
  releases?: () => Response | Promise<Response>;
}

/** The harness commands the release list names (claude and codex). */
const HARNESS_COMMANDS = releaseList().harnesses.map((harness) => harness.command);

/**
 * A fake server answering `/health`, `/me` and the worker release list; it records every URL it
 * is asked for.
 */
function server(calls: string[], answers: Answers = {}): RunContext["fetch"] {
  return (input) => {
    const url = String(input);
    calls.push(url);
    if (url === `${URL_}/api/v1/health`) {
      return Promise.resolve((answers.health ?? (() => jsonResponse(200, HEALTH)))());
    }
    if (url === `${URL_}/api/v1/me`) {
      const answer =
        answers.me ??
        (() =>
          jsonResponse(
            200,
            { status: "ok", data: ADMIN_ME, meta: null },
            { "x-request-id": "req-me" },
          ));
      return Promise.resolve(answer());
    }
    if (url === RELEASES_URL) {
      const answer =
        answers.releases ?? (() => jsonResponse(200, { status: "ok", data: releaseList() }));
      return Promise.resolve(answer());
    }
    return Promise.reject(new Error(`unexpected call to ${url}`));
  };
}

/** What the fake `git --version` prints by default. */
const GIT_VERSION = "git version 2.43.0\n";

/** A child process that prints `output` on standard output and exits 0. */
function fakeChild(output: string): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  Object.defineProperty(child, "stdout", { value: stdout });
  setImmediate(() => {
    stdout.end(output);
    stdout.on("close", () => child.emit("close", 0));
    stdout.resume();
  });
  return child;
}

/**
 * A runtime on which exactly `tools` are executables in BIN, and `git` too unless `git` is null:
 * `git --version` prints `git`.
 */
function runtimeWith(
  tools: string[],
  platform: NodeJS.Platform = "linux",
  git: string | null = GIT_VERSION,
  osRelease: { text: string | null; reads: number } = { text: null, reads: 0 },
): Pick<RunContext, "workerRuntime"> & { env: Record<string, string> } {
  const present = new Set(
    [...tools, ...(git !== null ? ["git"] : [])].map((tool) => join(BIN, tool)),
  );
  const workerRuntime: WorkerRuntime = {
    ...defaultWorkerRuntime,
    platform,
    canExecute: (path) =>
      present.has(path) ? Promise.resolve() : Promise.reject(new Error(`ENOENT: ${path}`)),
    spawn: (command, args, options) =>
      command === join(BIN, "git") && git !== null
        ? fakeChild(git)
        : defaultWorkerRuntime.spawn(command, args, options),
    // Never the host's /etc/os-release: what the test gives, counting the reads.
    osRelease: () => {
      osRelease.reads += 1;
      return Promise.resolve(osRelease.text);
    },
  };
  return { workerRuntime, env: { PATH: BIN } };
}

async function setup(
  options: {
    config?: Config | null;
    tools?: string[];
    platform?: NodeJS.Platform;
    /** What `git --version` prints; `null`: git is not on PATH. */
    git?: string | null;
    /** The contents of /etc/os-release; `null` (the default): unreadable. */
    osRelease?: string | null;
    env?: Record<string, string>;
    answers?: Answers;
  } = {},
) {
  const calls: string[] = [];
  const osRelease = { text: options.osRelease ?? null, reads: 0 };
  const runtime = runtimeWith(
    options.tools ?? ["uv", "docker", "cosign", ...HARNESS_COMMANDS],
    options.platform,
    options.git === undefined ? GIT_VERSION : options.git,
    osRelease,
  );
  const ctx = await testContext({
    fetch: server(calls, options.answers),
    workerRuntime: runtime.workerRuntime,
    env: { ...runtime.env, ...options.env },
  });
  const stored =
    options.config === undefined ? config({ kind: "cli", token: CLI_TOKEN }) : options.config;
  if (stored) await saveConfig(ctx, stored);
  return { ctx, calls, osRelease };
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(["doctor", ...argv], ctx);
  expect(ctx.out).toHaveLength(1);
  return { code, body: envelope(ctx) as unknown as Body };
}

/** The checks of a report, whether the doctor passed (data) or failed (error.details). */
function checksOf(body: Body): Record<string, Check> {
  const checks = body.ok ? body.data?.checks : body.error?.details.checks;
  return Object.fromEntries((checks ?? []).map((check) => [check.id, check]));
}

describe("pidgen doctor", () => {
  // AC-991b1073fe76: the real failure path preserves report, status, requests and stderr.
  it.each([40, 80, 120])(
    "human diagnostic failures retain checks and fixes at width %s",
    async (columns) => {
      const { ctx, calls } = await setup({ tools: [] });
      ctx.io.stdoutColumns = columns;
      const json = await expectMutationParity(
        ctx,
        calls,
        ["doctor"],
        [
          "error DOCTOR_FAILED:",
          "runtime",
          "fail",
          "https://docs.astral.sh/uv/getting-started/installation/",
          "Install claude and put it on PATH",
          "Install codex and put it on PATH",
        ],
        ExitCode.Unexpected,
      );
      expect(json).toMatchObject({
        ok: false,
        error: { code: "DOCTOR_FAILED", details: { checks: expect.any(Array) } },
      });
    },
  );

  it("reports node, git, server, credential, runtime, the release list and its harnesses as ok and exits 0", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx);

    expect(code).toBe(ExitCode.Ok);
    expect(body.ok).toBe(true);
    expect(body.error).toBeNull();
    const checks = body.data?.checks ?? [];
    expect(checks.map((check) => check.id)).toEqual([
      "node",
      "git",
      "server",
      "credential",
      "runtime",
      "releases",
      "harness:claude",
      "harness:codex",
      "worker",
    ]);
    for (const check of checks) {
      expect(Object.keys(check).sort()).toEqual(["fix", "id", "status", "summary"]);
      expect(check.summary).not.toBe("");
    }
    for (const check of checks.filter((entry) => entry.id !== "worker")) {
      expect(check.status).toBe("ok");
      expect(check.fix).toBeNull();
    }
    // Nothing is installed yet: a warning that names the install command, not a failure.
    const byId = checksOf(body);
    expect(byId["worker"]).toMatchObject({ status: "warn", fix: "pidgen worker install" });
    expect(byId["node"]?.summary).toContain(process.versions.node);
    expect(byId["git"]?.summary).toContain("2.43.0");
    expect(byId["git"]?.summary).toContain(`${BIN}/git`);
    expect(byId["server"]?.summary).toContain("1.0");
    expect(byId["credential"]?.summary).toMatch(/administrator/);
    expect(byId["credential"]?.summary).toMatch(/may enroll workers/);
    expect(byId["harness:claude"]?.summary).toContain(`${BIN}/claude`);
    expect(calls).toEqual([`${URL_}/api/v1/health`, `${URL_}/api/v1/me`, RELEASES_URL]);
    expect(body.meta).toMatchObject({ profile: "default", account: "ACC-EXAMPLE" });
    expect(JSON.stringify(body)).not.toContain(CLI_TOKEN);
  });

  it("runs with nothing configured and no worker installed, checking the hosted server", async () => {
    const { ctx, calls } = await setup({ config: null, tools: [] });
    const { code, body } = await run(ctx);

    expect(code).toBe(ExitCode.Unexpected);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("DOCTOR_FAILED");
    const checks = checksOf(body);
    expect(Object.keys(checks)).toEqual([
      "node",
      "git",
      "server",
      "credential",
      "runtime",
      "releases",
      "harness",
      "worker",
    ]);
    expect(checks["node"]?.status).toBe("ok");
    expect(checks["server"]).toMatchObject({ status: "fail" });
    expect(checks["server"]?.summary).toContain("https://api.pidgen.ai");
    expect(checks["credential"]).toMatchObject({ status: "skip" });
    expect(checks["runtime"]).toMatchObject({ status: "fail" });
    expect(checks["runtime"]?.fix).toContain("uv");
    // The release list needs a server: its checks are skipped, not failed.
    for (const id of ["releases", "harness", "worker"]) {
      expect(checks[id]).toMatchObject({ status: "skip" });
    }
    expect(body.error?.message).toMatch(/server/);
    expect(body.error?.message).toMatch(/runtime/);
    // An unreachable server is retried; every attempt goes to the hosted server's health route.
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls)).toEqual(new Set(["https://api.pidgen.ai/api/v1/health"]));
  });

  it("fails the server check when the server's API version range excludes this CLI's", async () => {
    const { ctx, calls } = await setup({
      answers: {
        health: () =>
          jsonResponse(200, { ...HEALTH, api_version: { current: "2.1", minimum: "2.0" } }),
      },
    });
    const { code, body } = await run(ctx);

    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("DOCTOR_FAILED");
    const checks = checksOf(body);
    expect(checks["server"]).toMatchObject({ status: "fail", fix: FIXES.upgradeCli });
    expect(checks["server"]?.summary).toContain("2.0");
    expect(checks["credential"]).toMatchObject({ status: "skip" });
    expect(checks["releases"]).toMatchObject({ status: "skip" });
    expect(calls).toEqual([`${URL_}/api/v1/health`]);
  });

  it("fails the server check when the server is older than this CLI", async () => {
    const { ctx } = await setup({
      answers: {
        health: () =>
          jsonResponse(200, { ...HEALTH, api_version: { current: "0.9", minimum: "0.8" } }),
      },
    });
    const { body } = await run(ctx);

    expect(checksOf(body)["server"]?.status).toBe("fail");
    expect(checksOf(body)["server"]?.fix).not.toBeNull();
  });

  it("fails the server check when the URL is not a Pidgen server", async () => {
    const { ctx } = await setup({
      answers: { health: () => jsonResponse(200, { ...HEALTH, service: "other" }) },
    });
    const { body } = await run(ctx);

    expect(checksOf(body)["server"]).toMatchObject({ status: "fail" });
    expect(checksOf(body)["server"]?.fix).toContain("pidgen auth login");
  });

  it("fails the server check with the health address when the server cannot be reached", async () => {
    const { ctx } = await setup({
      answers: { health: () => Promise.reject(new TypeError("fetch failed")) },
    });
    const { code, body } = await run(ctx);

    expect(code).toBe(ExitCode.Unexpected);
    expect(checksOf(body)["server"]).toMatchObject({
      status: "fail",
      fix: `${URL_}/api/v1/health`,
    });
    expect(checksOf(body)["credential"]?.status).toBe("skip");
  });

  it("fails the credential check when the server refuses the credential", async () => {
    const { ctx } = await setup({
      answers: {
        me: () =>
          jsonResponse(401, {
            status: "error",
            error: { code: "TOKEN_INVALID", message: "The CLI token is revoked or expired." },
          }),
      },
    });
    const { code, body } = await run(ctx);

    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("DOCTOR_FAILED");
    expect(checksOf(body)["server"]?.status).toBe("ok");
    expect(checksOf(body)["credential"]).toMatchObject({
      status: "fail",
      fix: `pidgen auth login ${URL_} --account ACC-EXAMPLE`,
    });
    expect(checksOf(body)["credential"]?.summary).toContain("TOKEN_INVALID");
  });

  it("fails the credential check when no credential is stored for the Account", async () => {
    const { ctx, calls } = await setup({ config: config(null) });
    const { body } = await run(ctx);

    expect(checksOf(body)["credential"]).toMatchObject({
      status: "fail",
      fix: `pidgen auth login ${URL_} --account ACC-EXAMPLE`,
    });
    // The release list needs no credential, so it is still read.
    expect(checksOf(body)["releases"]?.status).toBe("ok");
    expect(calls).toEqual([`${URL_}/api/v1/health`, RELEASES_URL]);
  });

  it("warns, and exits 0, when the credential's role may not enroll workers", async () => {
    const { ctx } = await setup({
      answers: {
        me: () =>
          jsonResponse(200, {
            status: "ok",
            data: me("member", { kind: "cli", scopes: ["tickets:read"] }),
            meta: null,
          }),
      },
    });
    const { code, body } = await run(ctx);

    expect(code).toBe(ExitCode.Ok);
    expect(body.ok).toBe(true);
    const credential = checksOf(body)["credential"];
    expect(credential?.status).toBe("warn");
    expect(credential?.summary).toMatch(/member/);
    expect(credential?.summary).toMatch(/may not enroll workers/);
    expect(credential?.fix).not.toBeNull();
  });

  it("reads a Personal API Token's kind and scopes from GET /me", async () => {
    const { ctx } = await setup({
      config: config({ kind: "pat", token: PAT }),
      answers: {
        me: () =>
          jsonResponse(200, {
            status: "ok",
            data: me("member", { kind: "pat", scopes: ["workers:enroll"] }),
            meta: null,
          }),
      },
    });
    const { code, body } = await run(ctx);

    expect(code).toBe(ExitCode.Ok);
    const credential = checksOf(body)["credential"];
    expect(credential?.status).toBe("ok");
    expect(credential?.summary).toMatch(/Personal API Token/);
    expect(credential?.summary).toMatch(/may enroll workers/);
    expect(JSON.stringify(body)).not.toContain(PAT);
  });

  it("warns when a Personal API Token lacks workers:enroll", async () => {
    const { ctx } = await setup({
      config: config({ kind: "pat", token: PAT }),
      answers: {
        me: () =>
          jsonResponse(200, {
            status: "ok",
            data: me("owner", { kind: "pat", scopes: ["tickets:read"] }),
            meta: null,
          }),
      },
    });
    const { body } = await run(ctx);

    expect(checksOf(body)["credential"]?.status).toBe("warn");
    expect(checksOf(body)["credential"]?.summary).toMatch(/workers:enroll/);
  });

  it("is ok with only uv for the wheel runtime", async () => {
    const { ctx } = await setup({ tools: ["uv", ...HARNESS_COMMANDS] });
    const { code, body } = await run(ctx);

    expect(code).toBe(ExitCode.Ok);
    expect(checksOf(body)["runtime"]).toMatchObject({ status: "ok", fix: null });
    expect(checksOf(body)["runtime"]?.summary).toMatch(/uv/);
  });

  it("is ok with only docker and cosign for the container runtime", async () => {
    const { ctx } = await setup({ tools: ["docker", "cosign", ...HARNESS_COMMANDS] });
    const { body } = await run(ctx);

    expect(checksOf(body)["runtime"]).toMatchObject({ status: "ok", fix: null });
  });

  it("warns when uv is present and docker lacks cosign", async () => {
    const { ctx } = await setup({ tools: ["uv", "docker", ...HARNESS_COMMANDS] });
    const { code, body } = await run(ctx);

    expect(code).toBe(ExitCode.Ok);
    expect(checksOf(body)["runtime"]?.status).toBe("warn");
    expect(checksOf(body)["runtime"]?.fix).toContain("cosign");
  });

  it("fails when docker lacks cosign and uv is missing", async () => {
    const { ctx } = await setup({ tools: ["docker", ...HARNESS_COMMANDS] });
    const { code, body } = await run(ctx);

    expect(code).toBe(ExitCode.Unexpected);
    expect(checksOf(body)["runtime"]?.status).toBe("fail");
    expect(checksOf(body)["runtime"]?.summary).toMatch(/cosign/);
  });

  // c1-git: git missing or older than 2.38 fails, with the platform's fix.
  it("fails the git check when git is missing, with the generic fix on an unknown Linux", async () => {
    const { ctx } = await setup({ git: null });
    const { code, body } = await run(ctx);

    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("DOCTOR_FAILED");
    expect(body.error?.message).toMatch(/git/);
    expect(checksOf(body)["git"]).toMatchObject({
      status: "fail",
      fix: "install git 2.38 or later with your package manager: https://git-scm.com/downloads/linux",
    });
    expect(checksOf(body)["git"]?.summary).toMatch(/not on PATH/);
  });

  it("fails the git check when git is missing on macOS, with xcode-select --install", async () => {
    const { ctx, osRelease } = await setup({ git: null, platform: "darwin" });
    const { code, body } = await run(ctx);

    expect(code).toBe(ExitCode.Unexpected);
    expect(checksOf(body)["git"]?.status).toBe("fail");
    expect(checksOf(body)["git"]?.fix).toContain("`xcode-select --install`");
    // os-release is read only on Linux.
    expect(osRelease.reads).toBe(0);
  });

  it("fails the git check when git is older than 2.38", async () => {
    const { ctx } = await setup({ git: "git version 2.37.1 (Apple Git-137)\n" });
    const { code, body } = await run(ctx);

    expect(code).toBe(ExitCode.Unexpected);
    expect(checksOf(body)["git"]?.status).toBe("fail");
    expect(checksOf(body)["git"]?.summary).toMatch(/2\.37\.1.*older than 2\.38/);
  });

  // AC-7a9ce68da4fa: the JSON keeps one fix string per check, here Ubuntu's PPA for an old git.
  it("names the git-core PPA as the JSON fix for an old git on Ubuntu, and exits 1", async () => {
    const { ctx, osRelease } = await setup({
      git: "git version 2.34.1\n",
      osRelease: 'NAME="Ubuntu"\nVERSION_ID="22.04"\nID=ubuntu\nID_LIKE=debian\n',
    });
    const { code, body } = await run(ctx);

    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("DOCTOR_FAILED");
    const git = checksOf(body)["git"];
    expect(Object.keys(git!).sort()).toEqual(["fix", "id", "status", "summary"]);
    expect(git).toMatchObject({
      id: "git",
      status: "fail",
      fix: expect.stringContaining(
        "`sudo add-apt-repository ppa:git-core/ppa && sudo apt update && sudo apt install git`",
      ) as unknown,
    });
    expect(typeof git!.fix).toBe("string");
    expect(osRelease.reads).toBe(1);
  });

  it("passes the git check for git 2.38 and later, without reading os-release", async () => {
    const { ctx, osRelease } = await setup({ git: "git version 2.38.0\n" });
    const { code, body } = await run(ctx);

    expect(code).toBe(ExitCode.Ok);
    expect(checksOf(body)["git"]).toMatchObject({ status: "ok", fix: null });
    expect(osRelease.reads).toBe(0);
  });

  it("fails the runtime check on a platform the worker does not support", async () => {
    const { ctx } = await setup({ platform: "win32" });
    const { body } = await run(ctx);

    expect(checksOf(body)["runtime"]?.status).toBe("fail");
    expect(checksOf(body)["runtime"]?.summary).toMatch(/Linux and macOS/);
  });

  it("reports an unreadable configuration as a failing check, not a crash", async () => {
    const { ctx, calls } = await setup();
    await chmod(configPath(ctx), 0o644);
    const { code, body } = await run(ctx);

    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("DOCTOR_FAILED");
    expect(checksOf(body)["server"]?.status).toBe("fail");
    expect(checksOf(body)["server"]?.fix).toBe(`chmod 600 ${configPath(ctx)}`);
    expect(checksOf(body)["credential"]?.status).toBe("skip");
    expect(calls).toEqual([]);
  });

  it("uses PIDGEN_API_URL and PIDGEN_TOKEN when no profile is stored", async () => {
    const { ctx } = await setup({
      config: null,
      env: { PIDGEN_API_URL: URL_, PIDGEN_TOKEN: CLI_TOKEN, PIDGEN_ACCOUNT: "ACC-EXAMPLE" },
    });
    const { code, body } = await run(ctx);

    expect(code).toBe(ExitCode.Ok);
    expect(checksOf(body)["credential"]?.status).toBe("ok");
  });

  it("refuses an argument as a usage error", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "extra");

    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(calls).toEqual([]);
  });

  it("refuses an unknown option as a usage error", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "--bogus");

    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
  });
});

// AC-3be42bdcd484: pidgen doctor gains its harness and worker checks from the release list.
describe("pidgen doctor: the release list's harness and worker checks", () => {
  /**
   * An install context whose server also answers `/health` and `/me` and holds a credential, so
   * doctor's connection checks pass. `serve.releases` replaces the release list's answer.
   */
  async function installedDoctor(options: InstallContextOptions = {}) {
    const setup = await installContext({
      ...options,
      env: { PIDGEN_TOKEN: CLI_TOKEN, PIDGEN_ACCOUNT: "ACC-EXAMPLE", ...options.env },
    });
    const serve: { releases?: ReleaseList } = {};
    const inner = setup.ctx.fetch;
    setup.ctx.fetch = (input, init) => {
      const url = String(input);
      if (url === `${URL_}/api/v1/health`) return Promise.resolve(jsonResponse(200, HEALTH));
      if (url === `${URL_}/api/v1/me`) {
        return Promise.resolve(jsonResponse(200, { status: "ok", data: ADMIN_ME, meta: null }));
      }
      if (url === RELEASES_URL && serve.releases) {
        return Promise.resolve(jsonResponse(200, { status: "ok", data: serve.releases }));
      }
      return inner(input, init);
    };
    return { ...setup, serve };
  }

  async function install(ctx: TestContext) {
    expect(await runCli(["worker", "install"], ctx)).toBe(ExitCode.Ok);
  }

  it("checks each harness the release list names on PATH, and the installed worker against the list", async () => {
    const setup = await installedDoctor({ commands: ["claude", "codex"] });
    await install(setup.ctx);
    const callsBefore = setup.fetchCalls.length;

    const { code, body } = await run(setup.ctx);
    expect(code).toBe(ExitCode.Ok);
    const checks = checksOf(body);
    expect(Object.keys(checks).slice(5)).toEqual([
      "releases",
      "harness:claude",
      "harness:codex",
      "worker",
    ]);
    for (const id of ["releases", "harness:claude", "harness:codex", "worker"]) {
      expect(checks[id]).toMatchObject({ status: "ok", fix: null });
      expect(Object.keys(checks[id]!).sort()).toEqual(["fix", "id", "status", "summary"]);
    }
    expect(checks["harness:claude"]?.summary).toContain(`${setup.pathDir}/claude`);
    expect(checks["worker"]?.summary).toContain("1.0.0");
    expect(checks["worker"]?.summary).toMatch(/current/);
    // The release list was read without a credential.
    const read = setup.fetchCalls.slice(callsBefore);
    expect(read.map((call) => call.url)).toEqual([RELEASES_URL]);
    expect(read[0]!.headers).not.toHaveProperty("authorization");
  });

  it("takes its harnesses from the release list, not from the CLI", async () => {
    const setup = await installedDoctor({ commands: ["example-agent"] });
    await install(setup.ctx);
    const list = releaseList();
    list.harnesses = [{ kind: "pi", command: "example-agent" }];
    setup.serve.releases = list;

    const { code, body } = await run(setup.ctx);
    expect(code).toBe(ExitCode.Ok);
    expect(Object.keys(checksOf(body)).slice(5)).toEqual(["releases", "harness:pi", "worker"]);
  });

  it("warns about a missing harness while another is found", async () => {
    const setup = await installedDoctor({ commands: ["claude"] });
    await install(setup.ctx);

    const { code, body } = await run(setup.ctx);
    expect(code).toBe(ExitCode.Ok);
    const codex = checksOf(body)["harness:codex"];
    expect(codex).toMatchObject({ status: "warn" });
    expect(codex?.summary).toContain("codex is not on PATH");
    expect(codex?.fix).toContain("codex");
  });

  it("fails when no harness the release list names is on PATH, and warns that the worker is not installed", async () => {
    const setup = await installedDoctor();

    const { code, body } = await run(setup.ctx);
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("DOCTOR_FAILED");
    expect(body.error?.message).toContain("harness:claude");
    const checks = checksOf(body);
    expect(checks["harness:claude"]).toMatchObject({ status: "fail" });
    expect(checks["harness:codex"]).toMatchObject({ status: "fail" });
    expect(checks["worker"]).toMatchObject({ status: "warn", fix: "pidgen worker install" });
  });

  it("fails the worker check when the installed version is no longer accepted, and warns when it is only supported", async () => {
    const setup = await installedDoctor({ commands: ["claude"] });
    await install(setup.ctx);

    // Series 1.1 is current and 1.0, the installed 1.0.0's, only supported.
    const supported = releaseList();
    supported.current = "1.1";
    supported.releases = [seriesEntry("1.1", "current"), seriesEntry("1.0", "supported")];
    setup.serve.releases = supported;
    let result = await run(setup.ctx);
    expect(result.code).toBe(ExitCode.Ok);
    expect(checksOf(result.body)["worker"]).toMatchObject({
      status: "warn",
      fix: "pidgen worker install",
    });
    expect(checksOf(result.body)["worker"]?.summary).toContain("1.1 is current");

    // Series 1.0 is no longer accepted at all.
    const unsupported = releaseList();
    unsupported.current = "1.2";
    unsupported.releases = [seriesEntry("1.2", "current"), seriesEntry("1.1", "supported")];
    setup.serve.releases = unsupported;
    result = await run(setup.ctx);
    expect(result.code).toBe(ExitCode.Unexpected);
    expect(checksOf(result.body)["worker"]).toMatchObject({
      status: "fail",
      fix: "pidgen worker install",
    });
    expect(checksOf(result.body)["worker"]?.summary).toMatch(
      /no longer accepts pidgen-worker 1\.0\.0/,
    );
  });

  it("warns when another pidgen-worker is first on PATH, and is ok when the installed one is", async () => {
    const setup = await installedDoctor({ commands: ["claude", "codex"] });
    await install(setup.ctx);
    const onPath = join(setup.pathDir, "pidgen-worker");
    await writeFile(onPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    let result = await run(setup.ctx);
    expect(result.code).toBe(ExitCode.Ok);
    const worker = checksOf(result.body)["worker"];
    expect(worker).toMatchObject({
      status: "warn",
      fix: `export PATH="${setup.binDir}:$PATH"`,
    });
    expect(worker?.summary).toContain("is current.");
    expect(worker?.summary).toContain(`\`pidgen-worker\` on PATH is another copy, at ${onPath}`);

    // A symlink to the installed worker is the installed worker.
    await rm(onPath);
    await symlink(setup.workerBin, onPath);
    result = await run(setup.ctx);
    expect(checksOf(result.body)["worker"]).toMatchObject({ status: "ok", fix: null });
  });

  it("fails the releases check, and skips the checks that need the list, when the server refuses it", async () => {
    const { ctx } = await setup({
      answers: {
        releases: () =>
          jsonResponse(503, {
            status: "error",
            error: { code: "SERVICE_UNAVAILABLE", message: "Try again later." },
          }),
      },
    });

    const { code, body } = await run(ctx);
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("DOCTOR_FAILED");
    const checks = checksOf(body);
    expect(checks["server"]?.status).toBe("ok");
    expect(checks["releases"]).toMatchObject({ status: "fail", fix: RELEASES_URL });
    expect(checks["releases"]?.summary).toContain("SERVICE_UNAVAILABLE");
    expect(checks["harness"]).toMatchObject({ status: "skip" });
    expect(checks["worker"]).toMatchObject({ status: "skip" });
  });
});

describe("gitCheck", () => {
  const git = (version: string | null) => ({ path: "/usr/bin/git", version });

  // AC-9ca7832cf09a: 2.38 is the boundary, and versions compare numerically.
  it("fails git 2.37.x and passes 2.38.0 and later, compared numerically", () => {
    expect(gitCheck(git("2.37.9"), "linux")).toMatchObject({ id: "git", status: "fail" });
    expect(gitCheck(git("2.37.9"), "linux").summary).toBe(
      "git 2.37.9 at /usr/bin/git is older than 2.38, the oldest the worker supports.",
    );
    expect(gitCheck(git("2.38.0"), "linux")).toMatchObject({ id: "git", status: "ok", fix: null });
    expect(gitCheck(git("2.38.0"), "linux").summary).toBe(
      "git 2.38.0 at /usr/bin/git (the worker needs 2.38 or later).",
    );
    expect(gitCheck(git("2.43.0"), "darwin").status).toBe("ok");
    expect(gitCheck(git("3.0"), "linux").status).toBe("ok");
    expect(gitCheck(git("2.100.1"), "linux").status).toBe("ok");
    expect(gitCheck(git("2.4.0"), "linux").status).toBe("fail");
    expect(gitCheck(git("1.99.0"), "linux").status).toBe("fail");
    expect(gitCheck(git(null), "linux").status).toBe("fail");
  });

  // AC-17d8c120b04a: macOS fixes for missing and old git.
  it("on macOS, names the Command Line Tools or Homebrew for a missing git", () => {
    const missing = gitCheck(null, "darwin");
    expect(missing).toMatchObject({ id: "git", status: "fail" });
    expect(missing.fix).toContain("`xcode-select --install`");
    expect(missing.fix).toContain("Command Line Tools");
    expect(missing.fix).toContain("`brew install git`");
    expect(gitCheck(git(null), "darwin").fix).toBe(missing.fix);
  });

  it("on macOS, names Homebrew ahead of /usr/bin, or Software Update, for an old git", () => {
    const old = gitCheck(git("2.37.1"), "darwin");
    expect(old.status).toBe("fail");
    expect(old.fix).toContain("`brew install git`");
    expect(old.fix).toContain("https://brew.sh");
    expect(old.fix).toMatch(/Homebrew's .*before \/usr\/bin on PATH/);
    expect(old.fix).toContain("Software Update");
    expect(old.fix).not.toContain("xcode-select");
  });

  // AC-8f425dc82cee: the Linux fix follows /etc/os-release, ID first, then each ID_LIKE entry.
  const UBUNTU =
    "`sudo add-apt-repository ppa:git-core/ppa && sudo apt update && sudo apt install git`";
  const GENERIC =
    "install git 2.38 or later with your package manager: https://git-scm.com/downloads/linux";
  const distributions: {
    name: string;
    osRelease: string | null;
    missing: string;
    old: string;
    oldAlso?: string;
  }[] = [
    {
      name: "ubuntu 22.04",
      osRelease:
        'PRETTY_NAME="Ubuntu 22.04.4 LTS"\nNAME="Ubuntu"\nVERSION_ID="22.04"\nID=ubuntu\nID_LIKE=debian\n',
      missing: UBUNTU,
      old: UBUNTU,
    },
    {
      name: "linuxmint",
      osRelease: 'NAME="Linux Mint"\nID=linuxmint\nID_LIKE="ubuntu debian"\n',
      missing: UBUNTU,
      old: UBUNTU,
    },
    {
      name: "pop",
      osRelease: 'NAME="Pop!_OS"\nID=pop\nID_LIKE="ubuntu debian"\n',
      missing: UBUNTU,
      old: UBUNTU,
    },
    {
      name: "an unknown ID like ubuntu",
      osRelease: "ID=elementary\nID_LIKE='ubuntu debian'\n",
      missing: UBUNTU,
      old: UBUNTU,
    },
    {
      name: "debian",
      osRelease: 'PRETTY_NAME="Debian GNU/Linux 11 (bullseye)"\nID=debian\n',
      missing: "`sudo apt update && sudo apt install git`",
      old: "Debian 12 or later",
      oldAlso: "https://git-scm.com/downloads/linux",
    },
    {
      name: "fedora",
      osRelease: "NAME=Fedora\nID=fedora\n",
      missing: "`sudo dnf install git`",
      old: "`sudo dnf upgrade git`",
    },
    {
      name: "rocky",
      osRelease: 'NAME="Rocky Linux"\nID="rocky"\nID_LIKE="rhel centos fedora"\n',
      missing: "`sudo dnf install git`",
      old: "`sudo dnf upgrade git`",
    },
    {
      name: "amazon linux",
      osRelease: 'ID="amzn"\nID_LIKE="fedora"\n',
      missing: "`sudo dnf install git`",
      old: "`sudo dnf upgrade git`",
    },
    {
      name: "arch",
      osRelease: 'NAME="Arch Linux"\nID=arch\n',
      missing: "`sudo pacman -S git`",
      old: "`sudo pacman -S git`",
    },
    {
      name: "manjaro",
      osRelease: "ID=manjaro\nID_LIKE=arch\n",
      missing: "`sudo pacman -S git`",
      old: "`sudo pacman -S git`",
    },
    {
      name: "alpine",
      osRelease: 'NAME="Alpine Linux"\nID=alpine\n',
      missing: "`sudo apk add git`",
      old: "`sudo apk upgrade git`",
    },
    {
      name: "opensuse-leap",
      osRelease: 'NAME="openSUSE Leap"\nID="opensuse-leap"\nID_LIKE="suse opensuse"\n',
      missing: "`sudo zypper install git`",
      old: "`sudo zypper install git`",
    },
    {
      name: "sles",
      osRelease: 'ID="sles"\nID_LIKE="suse"\n',
      missing: "`sudo zypper install git`",
      old: "`sudo zypper install git`",
    },
    { name: "an unknown ID", osRelease: "ID=plan9\n", missing: GENERIC, old: GENERIC },
    { name: "a missing file", osRelease: null, missing: GENERIC, old: GENERIC },
  ];

  it.each(distributions)(
    "on Linux, $name, names its fix",
    ({ osRelease, missing, old, oldAlso }) => {
      const absent = gitCheck(null, "linux", osRelease);
      expect(absent).toMatchObject({ id: "git", status: "fail" });
      expect(absent.fix).toContain(missing);
      const tooOld = gitCheck(git("2.34.1"), "linux", osRelease);
      expect(tooOld).toMatchObject({ id: "git", status: "fail" });
      expect(tooOld.fix).toContain(old);
      if (oldAlso !== undefined) expect(tooOld.fix).toContain(oldAlso);
      // One string, one line, no trailing full stop (setup adds its own punctuation).
      for (const fix of [absent.fix, tooOld.fix]) {
        expect(fix).not.toMatch(/\n/);
        expect(fix).not.toMatch(/\.$/);
      }
    },
  );

  it("gives distinct missing and old fixes where the commands differ", () => {
    const fedora = "ID=fedora\n";
    expect(gitCheck(null, "linux", fedora).fix).not.toContain("upgrade");
    expect(gitCheck(git("2.30.0"), "linux", fedora).fix).not.toContain("dnf install");
    const alpine = "ID=alpine\n";
    expect(gitCheck(git("2.30.0"), "linux", alpine).fix).not.toContain("apk add");
    const debian = "ID=debian\n";
    expect(gitCheck(null, "linux", debian).fix).not.toContain("Debian 12");
  });

  it("is the generic fix on a Linux whose os-release is unknown, and an ok check has no fix", () => {
    expect(gitCheck(null, "linux").fix).toBe(GENERIC);
    expect(gitCheck(git("2.43.0"), "linux", "ID=ubuntu\n").fix).toBeNull();
  });
});

describe("nodeCheck", () => {
  it("passes the Node.js versions the CLI supports", () => {
    expect(nodeCheck("22.12.0")).toMatchObject({ id: "node", status: "ok", fix: null });
    expect(nodeCheck("24.1.0").status).toBe("ok");
  });

  it("fails an older Node.js with the download address", () => {
    expect(nodeCheck("22.11.0")).toMatchObject({
      id: "node",
      status: "fail",
      fix: "https://nodejs.org/en/download",
    });
    expect(nodeCheck("20.18.1").status).toBe("fail");
  });
});

describe("pidgen doctor documentation", () => {
  const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

  it("docs/commands.md documents the command, its checks and its exit, and does not mark it planned", async () => {
    const text = await read("docs/commands.md");
    const start = text.indexOf("\n## doctor\n");
    expect(start).toBeGreaterThan(-1);
    const next = text.indexOf("\n## ", start + 1);
    const section = text.slice(start, next === -1 ? undefined : next);
    expect(section).toContain("`pidgen doctor`");
    expect(section).toContain("`{id, status, summary, fix}`");
    for (const id of [
      "node",
      "git",
      "server",
      "credential",
      "runtime",
      "releases",
      "harness:<kind>",
      "worker",
    ]) {
      expect(section).toContain(`| \`${id}\` |`);
    }
    expect(section).toContain("GET /health");
    expect(section).toContain("GET /me");
    expect(section).toContain("DOCTOR_FAILED");
    expect(section).toContain("error.details");
    expect(section).toContain("pidgen worker\ndoctor");
    // The harness and worker checks come from the worker release list; none is planned.
    expect(section).toContain("GET /workers/releases");
    expect(section).not.toContain("*planned*");
    expect(text).toContain("doctor    (one command: pidgen doctor)");
  });

  it("docs/workers.md tells an engineer to run pidgen doctor before enrolling", async () => {
    const text = await read("docs/workers.md");
    const start = text.indexOf("## Check this machine");
    expect(start).toBeGreaterThan(-1);
    const section = text.slice(start, text.indexOf("\n## ", start + 1));
    expect(section).toContain("$ pidgen doctor");
    expect(section).toContain("DOCTOR_FAILED");
    expect(section).toContain("`pidgen worker doctor`");
    expect(section).not.toContain("*planned*");
  });
});
