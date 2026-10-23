import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { loadConfig, saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { CLI_VERSION } from "../../src/core/version.js";
import type { WorkerRuntime } from "../../src/core/worker.js";
import {
  agentFiles,
  fakeAgent,
  fakeNpm,
  signIn,
  writeExecutable,
  type AgentRun,
  type FakeAgentKind,
  type FakeAgentOptions,
} from "../support/agents.js";
import { envelope, jsonResponse } from "../support/context.js";
import {
  CANCEL,
  scriptedPrompter,
  type Answer,
  type AskedPrompt,
  type ScriptedWait,
} from "../support/prompter.js";
import type { InterruptReason } from "../../src/core/prompter.js";
import {
  fakeUv,
  installContext,
  RECORDED_WHEEL,
  releaseList,
  SERVER,
  type IndexFile,
  type InstallContext,
  type InstallContextOptions,
} from "../support/worker-install.js";

/**
 * `pidgen setup` end to end, against fakes: a Pidgen server answering health, the device-code
 * login, `GET /me`, the worker release list, `GET /workers` and `POST /workers/enrollments`; PyPI
 * and a test trust root for the install (tests/support/worker-install.ts); a fake `uv`; and a fake
 * `pidgen-worker` at PIDGEN_WORKER_BIN. Questions are answered from a script.
 */

const HEALTH = { service: "pidgen", api_version: { current: "1.0", minimum: "1.0" } };
const HOST = "worker-host.example.com";
const CLI_TOKEN = "pidgen_cli_fake_setup_token";
const OTHER_TOKEN = "pidgen_cli_fake_setup_other_token";
const PAT = "pidgen_pat_fake_setup_token";
const ENROLL_TOKEN = "pidgen_enroll_fake_setup_one_time";
const HARNESS_COMMANDS = releaseList().harnesses.map((harness) => harness.command);
const ADMIN_SCOPES = ["tickets:read", "tickets:write", "workers:enroll"];
/** The running Node.js's `major.minor`, as the check step's line shows it. */
const NODE = process.versions.node.split(".").slice(0, 2).join(".");
const MEMBER_SCOPES = ["tickets:read", "tickets:write"];

type Role = "owner" | "administrator" | "member";

interface Membership {
  account_id: string;
  account_name: string;
  role: Role;
}

interface Step {
  id: string;
  status: "done" | "skipped" | "failed";
  command: string | null;
  summary: string;
  [key: string]: unknown;
}

interface Body {
  ok: boolean;
  data: { steps: Step[] } | null;
  error: {
    code: string;
    message: string;
    details: Record<string, unknown> & { steps?: Step[]; commands?: string[] };
  } | null;
  meta: Record<string, unknown>;
}

interface ServerState {
  memberships: Membership[];
  /** The Account the device-code login is approved for, per login (the last one repeats). */
  approvals: string[];
  /** The scopes `GET /me` reports for the token. */
  scopes: string[];
  kind: "cli" | "pat";
  /**
   * Whether the App Service lists this install's worker: under the host id its worker.env names
   * (PIDGEN_LOCALITY_DOMAIN), else this host's name.
   */
  enrolled: boolean;
  /** This install's worker is listed revoked, until it enrolls again. */
  revoked: boolean;
  /** Other workers the Account has, such as another install's under this host's name. */
  others: WorkerResource[];
  /** How many `GET /workers` reads after the worker started before it reports `connected`. */
  connectAfter: number;
  /** `GET /workers` answers this instead of the list. */
  workersRefusal?: () => Response;
  /**
   * Names `POST /workers/enrollments` refuses with 409 `WORKER_NAME_TAKEN` (compared
   * case-insensitively), each with the `suggested_name` the refusal carries.
   */
  takenNames?: Record<string, string>;
  /** The install id the last `POST /workers/enrollments` carried: this install's worker's. */
  installId?: string | null;
  /** `DELETE /workers/enrollments/{id}` answers this instead of the withdrawn enrollment. */
  withdrawRefusal?: () => Response;
  /** The user code of each device code issued, in order (the last one repeats). */
  userCodes?: string[];
  /**
   * What `POST /auth/device/token` answers before it approves, one per poll, in order: a response,
   * or an Error for a poll that fails on the network. Empty: the next poll is approved.
   */
  polls?: Array<Response | Error>;
  /**
   * The id the App Service mints for this install's worker, whatever host id the worker asks for:
   * the fake worker saves it as PIDGEN_LOCALITY_DOMAIN and the list names it as `host_id`. Unset,
   * the worker keeps the host id it asked for, as before minted ids.
   */
  mintedId?: string;
  /** The label (name) the last `POST /workers/enrollments` carried: the worker's `display_name`. */
  label?: string;
}

interface Harness extends InstallContext {
  state: ServerState;
  requests: Array<{ method: string; url: string; body: unknown }>;
  /** Each screen drawn while a question was open (tests/support/prompter.ts). */
  questions: string[];
  /** The same, with each prompt's kind, message and options. */
  prompts: AskedPrompt[];
  answers: Answer[];
  workerLog: () => Promise<string[][]>;
  /** What the fake coding agents and npm were run with, in order. */
  agentRuns: () => Promise<AgentRun[]>;
  started: { value: boolean };
  /** Each message a spinner showed while it ran, in order. */
  spinners: string[];
  /** Each wait setup ran (the sign-in wait), in order. */
  waits: ScriptedWait[];
  /** Ctrl-C during a spinner or a wait, or SIGTERM, as the terminal reports it. */
  interrupt(reason: InterruptReason): void;
  /**
   * Runs the CLI: the exit code, the envelope, standard error, and the setup log this run wrote
   * (`log`, empty when it wrote none) at `logPath`.
   */
  run(
    ...argv: string[]
  ): Promise<{ code: number; body: Body; stderr: string; log: string; logPath: string | null }>;
}

function ok(data: unknown, status = 200) {
  return jsonResponse(status, { status: "ok", data, meta: null });
}

function refusal(status: number, code: string, message = code) {
  return jsonResponse(status, {
    status: "error",
    error: { code, message, details: null, request_id: "req_fake" },
  });
}

function enrollment() {
  return {
    enrollment_id: "enr-example-1",
    account_id: "ACC-EXAMPLE",
    label: HOST,
    fingerprint: "abc123",
    created_by: "user-example",
    created_at: "2026-09-27T10:00:00Z",
    expires_at: "2026-09-28T10:00:00Z",
    consumed_at: null,
    consumed_host_id: null,
    revoked_at: null,
    state: "pending",
    token: ENROLL_TOKEN,
    install_commands: { wheel: "uv tool install pidgen-worker" },
    install: [
      {
        form: "wheel",
        artifact: "pidgen-worker~=1.0.0",
        install: "uv tool install pidgen-worker",
        enroll: `pidgen-worker enroll --token ${ENROLL_TOKEN}`,
        command: `uv tool install pidgen-worker && pidgen-worker enroll --token ${ENROLL_TOKEN}`,
      },
    ],
    eula: {
      name: "Pidgen Worker End-User Licence Agreement",
      location: "https://pidgen.example.com/legal/worker-eula",
      notice: "Installing pidgen-worker accepts its end-user licence agreement.",
    },
  };
}

interface WorkerResource {
  host_id: string;
  display_name?: string | null;
  connected: boolean;
  last_seen_at: string;
  created_at: string;
  revoked_at: string | null;
  protocol: string;
  protocol_state: string;
  build_version: string;
  git_credentials: unknown[];
  install_id?: string | null;
}

function workerResource(
  connected: boolean,
  overrides: Partial<WorkerResource> = {},
): WorkerResource {
  return {
    host_id: HOST,
    connected,
    last_seen_at: "2026-09-27T10:00:00Z",
    created_at: "2026-09-27T10:00:00Z",
    revoked_at: null,
    protocol: "1.0",
    protocol_state: "current",
    build_version: "1.0.0",
    git_credentials: [],
    ...overrides,
  };
}

/** The credential a worker removed from the Account kept in its worker.env. */
const REVOKED_CREDENTIAL = "pidgen_node_fake_revoked_credential";

/** The keys of this install's worker.env, or `null` when there is none. */
async function readWorkerEnv(home: string): Promise<Record<string, string> | null> {
  let text: string;
  try {
    text = await readFile(join(home, ".pidgen", "worker.env"), "utf8");
  } catch {
    return null;
  }
  const entries = text
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]);
  return Object.fromEntries(entries) as Record<string, string>;
}

/** The setup logs under this install's worker home, by name (oldest first). */
async function setupLogs(home: string): Promise<string[]> {
  try {
    return (await readdir(join(home, ".pidgen", "logs")))
      .filter((name) => /^setup-.*\.log$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

/** Writes this install's worker.env, as an earlier `pidgen-worker enroll` would have. */
async function writeWorkerEnv(home: string, lines: string[]): Promise<void> {
  await mkdir(join(home, ".pidgen"), { recursive: true });
  await writeFile(join(home, ".pidgen", "worker.env"), `${lines.join("\n")}\n`, { mode: 0o600 });
}

/**
 * A fake `pidgen-worker`: logs each argument list, answers `doctor --json`, and exits 0. `enroll`
 * prints its argument list, the one-time token among them, on standard error.
 * `capacity set` prints FAKE_CAPACITY_OUTPUT (default "saved") and exits FAKE_CAPACITY_EXIT.
 *
 * The worker's saved-credential rules. `pidgen-worker enroll --token <t> --server <s>` with a
 * worker.env holding a credential (PIDGEN_NODE_TOKEN) decides by that credential, and logs its
 * decision, `["credential", "kept" | "moved-aside" | "refused"]`, to FAKE_WORKER_LOG.credentials:
 *
 *   1. It keeps a saved credential the service accepts (for <s>, and not one the service refuses):
 *      the one-time token is not exchanged and worker.env is left as it is.
 *   2. It moves aside a saved credential the service refuses with HTTP 401 (one of
 *      FAKE_REFUSED_CREDENTIALS, comma-separated; the harness's default is REVOKED_CREDENTIAL, the
 *      removed worker's): worker.env is renamed worker.env.refused and the token is exchanged.
 *   3. It refuses a saved credential for another server (PIDGEN_SERVICE_URL is not <s>, or is
 *      missing) unless `--replace` is given: it prints the refusal, naming that server and
 *      `--replace`, exits 1 and changes nothing. With `--replace` worker.env is renamed
 *      worker.env.replaced and the token is exchanged.
 *
 * An exchange writes $PIDGEN_HOME/worker.env as the real worker does (the credential, the server and
 * the id the server answered: FAKE_MINTED_ID when set, else `--host-id`, default the host name;
 * no id at all with FAKE_ENROLL_NO_ID), unless FAKE_ENROLL_NO_ENV is set, and each `enroll` that
 * gets that far logs `["exchange", "done"]` or `["exchange", "skipped"]` to
 * FAKE_WORKER_LOG.exchanges. An exchange for a host id in FAKE_TAKEN_HOSTS (comma-separated) is
 * refused as the server refuses a taken host id: the worker prints its refusal line and exits 1,
 * writing nothing. FAKE_FAIL_ENROLL_RUN=<n> makes the n-th `enroll` (counted from 1) fail for
 * another reason, exit 1.
 */
const WORKER_SCRIPT = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_WORKER_LOG, JSON.stringify(args) + "\\n");
// The worker says what it enrolls with, one-time token and all, as a careless worker might.
if (args[0] === "enroll") process.stderr.write("pidgen-worker " + args.join(" ") + "\\nenrolled\\n");
const value = (flag) => { const at = args.lastIndexOf(flag); return at < 0 ? undefined : args[at + 1]; };
const home = process.env.PIDGEN_HOME;
const envFile = path.join(home, "worker.env");
const decide = (decision) => fs.appendFileSync(process.env.FAKE_WORKER_LOG + ".credentials", JSON.stringify(["credential", decision]) + "\\n");
// The saved credential's keys, or null when worker.env holds no PIDGEN_NODE_TOKEN.
const saved = (() => {
  let text;
  try {
    text = fs.readFileSync(envFile, "utf8");
  } catch {
    return null;
  }
  const keys = Object.fromEntries(text.split("\\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  return keys.PIDGEN_NODE_TOKEN ? keys : null;
})();
let keep = false;
if (args[0] === "enroll" && saved !== null) {
  const server = value("--server");
  const refused = (process.env.FAKE_REFUSED_CREDENTIALS ?? "").split(",").includes(saved.PIDGEN_NODE_TOKEN);
  if ((saved.PIDGEN_SERVICE_URL ?? "") !== server) {
    // Rule 3: another server's credential is refused without --replace.
    if (!args.includes("--replace")) {
      decide("refused");
      process.stderr.write("worker.env holds a credential for " + (saved.PIDGEN_SERVICE_URL || "no server") + ", not " + server + ". Re-run with --replace to move it aside and enroll with " + server + ".\\n");
      process.exit(1);
    }
    decide("moved-aside");
    fs.renameSync(envFile, envFile + ".replaced");
  } else if (refused) {
    // Rule 2: a credential the service refuses (HTTP 401) is moved aside.
    decide("moved-aside");
    process.stderr.write("saved credential refused (HTTP 401 TOKEN_INVALID); moved worker.env aside to worker.env.refused\\n");
    fs.renameSync(envFile, envFile + ".refused");
  } else {
    // Rule 1: a credential the service accepts is kept, and the one-time token is not exchanged.
    decide("kept");
    keep = true;
  }
}
if (args[0] === "enroll" && !keep) {
  const runs = fs.readFileSync(process.env.FAKE_WORKER_LOG, "utf8").split("\\n").filter((line) => line.startsWith('["enroll"')).length;
  if (String(runs) === process.env.FAKE_FAIL_ENROLL_RUN) {
    process.stderr.write("enrollment token not accepted (HTTP 401 ENROLLMENT_INVALID).\\n");
    process.exit(1);
  }
  const hostId = value("--host-id") ?? process.env.FAKE_HOSTNAME;
  if (!process.env.FAKE_MINTED_ID && (process.env.FAKE_TAKEN_HOSTS ?? "").split(",").includes(hostId)) {
    process.stderr.write("host id '" + hostId + "' is already enrolled in this Account (HTTP 409 WORKER_HOST_TAKEN).\\n");
    process.stderr.write("Re-run with a different --host-id, or remove the existing worker from the Workers page\\nfirst. Two machines must never share a host id.\\n");
    process.exit(1);
  }
}
if (args[0] === "enroll") fs.appendFileSync(process.env.FAKE_WORKER_LOG + ".exchanges", JSON.stringify(["exchange", keep ? "skipped" : "done"]) + "\\n");
if (args[0] === "enroll" && !keep && !process.env.FAKE_ENROLL_NO_ENV) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(envFile, [
    "PIDGEN_SERVICE_URL=" + value("--server"),
    "PIDGEN_NODE_TOKEN=pidgen_node_fake_credential",
    ...(process.env.FAKE_ENROLL_NO_ID ? [] : ["PIDGEN_LOCALITY_DOMAIN=" + (process.env.FAKE_MINTED_ID || value("--host-id") || process.env.FAKE_HOSTNAME)]),
  ].join("\\n") + "\\n", { mode: 0o600 });
}
if (args[0] === "doctor") process.stdout.write(JSON.stringify({ ok: true, checks: [] }));
if (args[0] === "capacity") {
  process.stdout.write((process.env.FAKE_CAPACITY_OUTPUT ?? "saved") + "\\n");
  process.exit(Number(process.env.FAKE_CAPACITY_EXIT ?? 0));
}
process.exit(0);
`;

/** The command the check step offers to install uv with. */
const UV_INSTALL = "curl -LsSf https://astral.sh/uv/install.sh | sh";

/**
 * A fake `curl` on PATH: logs its arguments and prints an "installer" that copies a fake `uv` into
 * `$HOME/.local/bin`, where uv's installer puts it, which is not on PATH.
 */
async function offerableUv(h: Harness): Promise<{ curlRuns: () => Promise<string[]> }> {
  const source = join(h.directory, "uv-source", "uv");
  const log = join(h.directory, "curl.log");
  await mkdir(join(source, ".."), { recursive: true });
  await writeFile(source, fakeUv());
  await chmod(source, 0o755);
  const curl = join(h.pathDir, "curl");
  await writeFile(
    curl,
    `#!/bin/sh\necho "$@" >> '${log}'\necho 'mkdir -p "$HOME/.local/bin" && cp "${source}" "$HOME/.local/bin/uv" && chmod 755 "$HOME/.local/bin/uv"'\n`,
  );
  await chmod(curl, 0o755);
  return {
    curlRuns: async () => {
      try {
        return (await readFile(log, "utf8")).split("\n").filter((line) => line !== "");
      } catch {
        return [];
      }
    },
  };
}

interface HarnessOptions extends InstallContextOptions {
  state?: Partial<ServerState>;
  answers?: Answer[];
  /** No terminal: `prompter` is null. */
  noTerminal?: boolean;
  /** Keep PIDGEN_API_URL in the environment (installContext sets it). */
  keepApiUrl?: boolean;
  /**
   * Fake coding agents to put on PATH (tests/support/agents.ts), signed in or not, in place of the
   * trivial `claude` and `codex` that are otherwise there and report themselves signed in.
   */
  agents?: Partial<Record<FakeAgentKind, FakeAgentOptions & { signedIn?: boolean }>>;
  /** Put a fake `npm` on PATH that installs the fake agents there. */
  npm?: boolean;
  /** This machine's host name (default HOST). */
  hostName?: string;
  /** Called as each spinner starts. */
  onSpinner?: (message: string, h: Harness) => void;
  /** Called as each wait starts. */
  onWait?: (wait: ScriptedWait, h: Harness) => void;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const base = await installContext({
    commands: options.agents ? [] : HARNESS_COMMANDS,
    ...options,
  });
  const agentState = agentFiles(base.directory);
  Object.assign(base.ctx.env, agentState.env, { FAKE_NPM_BIN: base.pathDir });
  for (const [kind, agent] of Object.entries(options.agents ?? {})) {
    await writeExecutable(join(base.pathDir, kind), fakeAgent(kind as FakeAgentKind, agent));
    if (agent.signedIn) await signIn(agentState.state, kind as FakeAgentKind);
  }
  if (options.npm) await writeExecutable(join(base.pathDir, "npm"), fakeNpm());
  const state: ServerState = {
    memberships: [{ account_id: "ACC-EXAMPLE", account_name: "Example", role: "administrator" }],
    approvals: ["ACC-EXAMPLE"],
    scopes: ADMIN_SCOPES,
    kind: "cli",
    enrolled: false,
    revoked: false,
    others: [],
    connectAfter: 1,
    ...options.state,
  };
  const requests: Harness["requests"] = [];
  const questions: string[] = [];
  const answers: Answer[] = [...(options.answers ?? [])];
  let prompts: AskedPrompt[] = [];
  const started = { value: false };
  let pollsAfterStart = 0;
  let logins = 0;
  let issued = 0;
  const tokens = new Map<string, string>();

  const workerBin = join(base.directory, "fake-worker", "pidgen-worker");
  const workerLog = join(base.directory, "fake-worker.log");
  await mkdir(join(workerBin, ".."), { recursive: true });
  await writeFile(workerBin, WORKER_SCRIPT);
  await chmod(workerBin, 0o755);

  const ctx = base.ctx;
  if (options.hostName !== undefined) ctx.hostName = options.hostName;
  if (!options.keepApiUrl) delete ctx.env["PIDGEN_API_URL"];
  ctx.env["PIDGEN_WORKER_BIN"] = workerBin;
  ctx.env["FAKE_WORKER_LOG"] = workerLog;
  ctx.env["FAKE_HOSTNAME"] = ctx.hostName;
  if (state.mintedId !== undefined) ctx.env["FAKE_MINTED_ID"] = state.mintedId;
  // The credential the service refuses with HTTP 401: the removed worker's (rule 2 of the fake).
  ctx.env["FAKE_REFUSED_CREDENTIALS"] ??= REVOKED_CREDENTIAL;

  const installFetch = ctx.fetch;
  ctx.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ method, url, body });
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const api = `${SERVER}/api/v1`;
    if (url === `${api}/health`) return ok(HEALTH);
    if (url === `${api}/auth/device`) {
      const codes = state.userCodes ?? ["ABCD-EFGH"];
      const userCode = codes[Math.min(issued++, codes.length - 1)]!;
      return ok({
        device_code: `fake-device-code-${issued}`,
        user_code: userCode,
        verification_uri: `${SERVER}/device`,
        verification_uri_complete: `${SERVER}/device?user_code=${userCode}`,
        expires_in: 600,
        interval: 5,
      });
    }
    if (url === `${api}/auth/device/token`) {
      const answer = state.polls?.shift();
      if (answer instanceof Error) throw answer;
      if (answer !== undefined) return answer;
      const account = state.approvals[Math.min(logins, state.approvals.length - 1)]!;
      const token = logins === 0 ? CLI_TOKEN : OTHER_TOKEN;
      logins++;
      tokens.set(token, account);
      return ok({
        access_token: token,
        token_type: "Bearer",
        token_id: `tok-${logins}`,
        account_id: account,
        user_id: "usr-example",
        device_label: "laptop",
        idle_expires_at: "2026-10-27T00:00:00Z",
        absolute_expires_at: "2027-09-27T00:00:00Z",
      });
    }
    if (url === `${api}/me`) {
      const token = (headers["authorization"] ?? "").replace(/^Bearer /, "");
      return ok({
        user: {
          user_id: "usr-example",
          email: "person@example.com",
          display_name: "Example Person",
        },
        memberships: state.memberships,
        super_administrator: false,
        mfa: { enabled: false, required: false, recent: false, verified_at: null },
        pending_ownership_transfers: [],
        cli_token: {
          token_id: "tok-example",
          account_id: tokens.get(token) ?? "ACC-EXAMPLE",
          kind: state.kind,
          scopes: state.scopes,
        },
      });
    }
    if (url === `${api}/workers`) {
      if (state.workersRefusal) return state.workersRefusal();
      if (started.value) pollsAfterStart++;
      const env = await readWorkerEnv(ctx.homeDir);
      // A worker that starts with a revoked credential is refused by the server: never connected.
      const live = env?.["PIDGEN_NODE_TOKEN"] !== REVOKED_CREDENTIAL;
      const connected =
        started.value && pollsAfterStart >= state.connectAfter && !state.revoked && live;
      const listed = state.enrolled || connected;
      const hostId = env?.["PIDGEN_LOCALITY_DOMAIN"] ?? state.mintedId ?? HOST;
      const own = workerResource(connected, {
        host_id: hostId,
        display_name: state.label ?? null,
        revoked_at: state.revoked ? "2026-09-28T10:00:00Z" : null,
        install_id: state.installId ?? null,
      });
      return ok({
        workers: [...state.others, ...(listed ? [own] : [])],
        service_protocol: "1.0",
        accepted_protocols: ["1.0"],
      });
    }
    if (url === `${api}/workers/enrollments` && method === "POST") {
      const label = (body as { label?: string } | undefined)?.label ?? "";
      const taken = Object.entries(state.takenNames ?? {}).find(
        ([name]) => name.toLowerCase() === label.toLowerCase(),
      );
      if (taken !== undefined) {
        return jsonResponse(409, {
          status: "error",
          error: {
            code: "WORKER_NAME_TAKEN",
            message: `A worker named ${label} already exists in this Account.`,
            details: { display_name: label, suggested_name: taken[1] },
            request_id: "req_fake_name_taken",
          },
        });
      }
      state.enrolled = true;
      state.revoked = false;
      state.label = label;
      state.installId = (body as { install_id?: string } | undefined)?.install_id ?? null;
      return ok(enrollment(), 201);
    }
    if (url.startsWith(`${api}/workers/enrollments/`) && method === "DELETE") {
      if (state.withdrawRefusal) return state.withdrawRefusal();
      // A withdrawn enrollment was never redeemed: no worker is listed for it.
      state.enrolled = false;
      // The enrollment as listed: without its token and install steps.
      const rest: Record<string, unknown> = { ...enrollment() };
      for (const key of ["token", "install_commands", "install", "eula"]) delete rest[key];
      return ok({ ...rest, state: "revoked", revoked_at: "2026-09-27T10:01:00Z" });
    }
    return installFetch(input, init);
  }) as typeof fetch;

  // The detached worker counts as running once it has been started; the fake itself exits at once.
  const inner = ctx.workerRuntime;
  const runtime: WorkerRuntime = {
    ...inner,
    spawn: (command, args, spawnOptions) => {
      if (command === workerBin && spawnOptions.detached === true) started.value = true;
      return inner.spawn(command, args, spawnOptions);
    },
    isWorkerProcess: async () => started.value,
    // A signalled worker stops (`pidgen worker update --restart` stops it before starting it again).
    kill: (pid, signal) => {
      started.value = false;
      inner.kill(pid, signal);
    },
  };
  ctx.workerRuntime = runtime;

  const self: { h?: Harness } = {};
  const scripted = scriptedPrompter((text) => ctx.io.stderr(text), answers, {
    onAsk: (asked) => {
      questions.push(asked.screen);
      // Setup asks the worker's name before every enrollment. A test that scripts no answer for it
      // presses Enter, accepting the suggestion; one that cares answers it like any other question.
      if (asked.kind === "text" && asked.message === "Worker name" && answers.length === 0) {
        answers.push("");
      }
    },
    onSpinner: (message) => options.onSpinner?.(message, self.h!),
    onWait: (wait) => options.onWait?.(wait, self.h!),
  });
  prompts = scripted.asked;
  ctx.prompter = options.noTerminal ? null : () => Promise.resolve(scripted.prompter);

  self.h = {
    ...base,
    state,
    requests,
    questions,
    get prompts() {
      return prompts;
    },
    spinners: scripted.spinners,
    waits: scripted.waits,
    interrupt: scripted.interrupt,
    answers,
    started,
    agentRuns: agentState.runs,
    workerLog: async () => {
      try {
        return (await readFile(workerLog, "utf8"))
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as string[]);
      } catch {
        return [];
      }
    },
    async run(...argv: string[]) {
      ctx.out.length = 0;
      ctx.err.length = 0;
      const before = new Set(await setupLogs(ctx.homeDir));
      const code = await runCli(argv, ctx);
      expect(ctx.out).toHaveLength(1);
      const written = (await setupLogs(ctx.homeDir)).filter((name) => !before.has(name));
      expect(written.length).toBeLessThanOrEqual(1);
      const logPath = written[0] ? join(ctx.homeDir, ".pidgen", "logs", written[0]) : null;
      return {
        code,
        body: envelope(ctx) as unknown as Body,
        stderr: ctx.err.join(""),
        log: logPath ? await readFile(logPath, "utf8") : "",
        logPath,
      };
    },
  };
  return self.h;
}

const STEP_IDS = [
  "check",
  "sign-in",
  "agents",
  "agent-login",
  "capacity",
  "runtime",
  "install",
  "enroll",
  "prove",
];

/** The eight parts of setup, as the guides name them. */
const STEP_TITLES = [
  "Step 1 of 8  Check this machine",
  "Step 2 of 8  Sign in to Pidgen",
  "Step 3 of 8  Choose coding agents",
  "Step 4 of 8  Sign in to coding agents",
  "Step 5 of 8  Size coding agent sessions",
  "Step 6 of 8  Install the worker",
  "Step 7 of 8  Enroll and start the worker",
  "Step 8 of 8  Prove the worker works",
];

function step(body: Body, id: string): Step {
  const steps = body.data?.steps ?? body.error?.details.steps ?? [];
  const found = steps.find((entry) => entry.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
}

function order(text: string, ...needles: string[]): number[] {
  return needles.map((needle) => {
    const index = text.indexOf(needle);
    expect(index, `${needle} in standard error`).toBeGreaterThanOrEqual(0);
    return index;
  });
}

/** Every file under `root`, as paths relative to it. */
async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * Setup keeps no progress of its own: what a failed run leaves in the CLI's config and the worker's
 * home is only what its finished steps' commands wrote — the profile (`pidgen auth login`), the
 * installed wheel and its record (`pidgen worker install`), and the running worker's record and log
 * (`pidgen worker start`).
 */
const OWNED_BY_STEP_COMMANDS = [
  /^\.config\/pidgen\/config\.json$/,
  /^\.pidgen\/worker\/pidgen_worker-[^/]+\.whl(\.provenance\.json)?$/,
  // The worker's own uv tool environment, which `pidgen worker install` puts in the worker home.
  /^\.pidgen\/worker\/(bin|tools)\//,
  /^\.pidgen\/run\/pidgen-(install|worker)\.json$/,
  /^\.pidgen\/logs\/worker-manager\.log$/,
  // What setup did, for the person to read: its log is not progress it resumes from.
  /^\.pidgen\/logs\/setup-[^/]+\.log$/,
  /^\.pidgen\/worker\.env$/,
  // This install's id (`pidgen worker enroll`, as setup's enroll step runs it): kept for good, the
  // same file pidgen-worker keeps, never progress.
  /^\.pidgen\/install-id$/,
];

async function expectNoProgressState(root: string): Promise<void> {
  const kept = (await filesUnder(root)).filter((file) => /^\.(config|pidgen)\//.test(file));
  expect(kept.filter((file) => !OWNED_BY_STEP_COMMANDS.some((owned) => owned.test(file)))).toEqual(
    [],
  );
  // The profile holds no setup progress: none of its keys is about setup.
  const keys: string[] = [];
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value)) {
      keys.push(key);
      walk(inner);
    }
  };
  walk(JSON.parse(await readFile(join(root, ".config", "pidgen", "config.json"), "utf8")));
  expect(keys.filter((key) => /setup|step|progress|resume/i.test(key))).toEqual([]);
}

function enrollments(h: Harness) {
  return h.requests.filter((request) => request.url.endsWith("/workers/enrollments"));
}

/** The enrollments setup withdrew: each `DELETE /workers/enrollments/{id}`, by path. */
function withdrawals(h: Harness): string[] {
  return h.requests
    .filter((request) => request.method === "DELETE")
    .map((request) => new URL(request.url).pathname);
}

/** Any install id: the body of an enrollment setup creates carries this install's. */
const ANY_INSTALL_ID = expect.stringMatching(/^[0-9a-f]{32}$/);

/** Writes this install's id, as an earlier setup or pidgen-worker would have. */
async function writeInstallId(home: string, id: string): Promise<void> {
  await mkdir(join(home, ".pidgen"), { recursive: true });
  await writeFile(join(home, ".pidgen", "install-id"), `${id}\n`);
}

describe("pidgen setup", () => {
  // AC-13099f01c6dd: setup owns its prompts and stderr summaries in every stdout format; with
  // --verbose its commands are shown under each task (without it they are in the setup log).
  it.each([undefined, "json", "table"])(
    "retains setup commands and progress with %s output",
    async (format) => {
      const h = await harness({ answers: ["", "", "", "", ""] });
      h.ctx.io.stdoutIsTTY = true;
      const flags = format ? ["--format", format] : [];
      expect(await runCli([...flags, "setup", "--url", SERVER, "--verbose"], h.ctx)).toBe(
        ExitCode.Ok,
      );
      const stderr = h.ctx.err.join("");
      for (const command of [
        "$ pidgen doctor",
        `$ pidgen auth login ${SERVER}`,
        "$ pidgen worker install",
        "$ pidgen worker verify",
        "$ pidgen worker enroll",
        "$ pidgen worker start --detach",
        "$ pidgen worker doctor",
      ])
        expect(stderr).toContain(command);
      expect(h.questions).toHaveLength(5);
      expect(stderr).not.toContain(ENROLL_TOKEN);
      // JSON: the frame ends on standard error. A terminal: it ends with the summary card.
      if (format === "json") {
        expect(envelope(h.ctx)).toMatchObject({ ok: true });
        expect(stderr).toMatch(/└ {2}Done in \d+ min \d+ s\n$/);
      } else expect(h.ctx.out.join("")).toContain("This machine is a Pidgen worker");
    },
  );

  it.each([40, 80, 120])(
    "prints scriptable actions when setup requires a terminal at width %s",
    async (columns) => {
      const h = await harness({ noTerminal: true });
      h.ctx.io.stdoutIsTTY = true;
      h.ctx.io.stdoutColumns = columns;
      expect(await runCli(["setup", "--url", SERVER], h.ctx)).toBe(ExitCode.Usage);
      for (const command of [
        "pidgen doctor",
        `pidgen auth login ${SERVER}`,
        "pidgen worker install",
        "pidgen worker enroll",
        "pidgen worker start --detach",
        "pidgen worker status",
      ])
        expect(h.ctx.out.join("")).toContain(command);
      expect(h.requests).toEqual([]);
      expect(h.questions).toEqual([]);
    },
  );

  // AC-eb803e163154: the six steps in order, each printed as the pidgen command it runs.
  it("takes a fresh machine to a connected worker, running each step's command in order", async () => {
    const h = await harness({ answers: ["", "", "", "", ""] });

    const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(body.ok).toBe(true);
    expect(body.data!.steps.map((entry) => entry.id)).toEqual(STEP_IDS);
    expect(body.data!.steps.map((entry) => entry.status)).toEqual([
      "done",
      "done",
      "done",
      "skipped",
      "done",
      "done",
      "done",
      "done",
      "done",
    ]);
    expect(step(body, "check").command).toBe("pidgen doctor");
    expect(step(body, "sign-in").command).toBe(`pidgen auth login ${SERVER}`);
    expect(step(body, "runtime").command).toBeNull();
    expect(step(body, "install").command).toBe(
      "pidgen worker install --runtime wheel && pidgen worker verify",
    );
    expect(step(body, "enroll").command).toBe(
      `pidgen worker enroll --label ${HOST} -- --host-id ${HOST} && pidgen worker start --detach`,
    );
    expect(step(body, "prove").command).toBe("pidgen worker doctor");

    // Each command is recorded in the setup log before it runs, in the order of the steps.
    const positions = order(
      log,
      "$ pidgen doctor",
      `$ pidgen auth login ${SERVER}`,
      "$ pidgen worker install --runtime wheel",
      " tool install ",
      "$ pidgen worker verify",
      `$ pidgen worker enroll --label ${HOST} -- --host-id ${HOST}`,
      "$ pidgen worker start --detach",
      "$ pidgen worker doctor",
    );
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    // Five questions: the coding agents, each one's sessions, the install and its licence, then the
    // worker's name; no runtime question while setup offers only the wheel.
    expect(h.questions).toHaveLength(5);
    expect(h.questions[0]).toMatch(/coding agents/i);
    expect(h.questions[3]).toMatch(/Install pidgen-worker 1\.0\.0 and accept its licence\?/);
    const { eula } = releaseList();
    expect(h.questions[3]).toContain(eula.name);
    expect(stderr.indexOf("accept its licence? · Yes")).toBeLessThan(
      stderr.indexOf("◇  pidgen-worker 1.0.0 installed and verified"),
    );
    expect(log.indexOf("question: Install pidgen-worker 1.0.0")).toBeLessThan(
      log.indexOf("$ pidgen worker install"),
    );

    // Install and verify: uv installed the verified wheel and each verification is logged.
    expect((await h.uvRuns()).filter((run) => run.args[1] === "install")).toHaveLength(1);
    expect(log).toMatch(/ok\s+digest/);
    expect(log).toMatch(/ok\s+provenance/);

    // Enroll and start: one enrollment, the worker enrolled, then started detached.
    expect(enrollments(h)).toHaveLength(1);
    expect(enrollments(h)[0]!.body).toEqual({ label: HOST, install_id: ANY_INSTALL_ID });
    const worker = await h.workerLog();
    // The detached start (no subcommand) logs whenever its background process runs, which can be
    // after the doctor; the order the CLI ran them in is checked in the log above.
    const runs = worker.map((args) => args[0]);
    expect(runs[0]).toBe("enroll");
    expect(runs).toHaveLength(7);
    expect(runs).toEqual(expect.arrayContaining(["enroll", undefined, "doctor"]));
    expect(h.started.value).toBe(true);
    expect(step(body, "enroll")["connected"]).toBe(true);

    // Prove it: the worker doctor's report, then the one next thing to do, as a command (the
    // summary card shows it in a terminal).
    expect(step(body, "prove")["next"]).toBe("pidgen skills install");

    // Standard output carries only the envelope; the one-time token never appears.
    expect(h.ctx.out.join("")).not.toContain(ENROLL_TOKEN);
    expect(stderr).not.toContain(ENROLL_TOKEN);
  });

  // AC-eb803e163154: the Account is chosen only when the User belongs to more than one.
  it("asks no Account question when the User belongs to one Account", async () => {
    const h = await harness({ answers: ["", "", "", ""] });

    const { code } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions.some((question) => /Account/.test(question))).toBe(false);
  });

  it("asks which Account the worker serves when the User belongs to more than one", async () => {
    const h = await harness({
      answers: ["Other", "", "", "", "", ""],
      state: {
        memberships: [
          { account_id: "ACC-EXAMPLE", account_name: "Example", role: "administrator" },
          { account_id: "ACC-OTHER", account_name: "Other", role: "owner" },
        ],
        approvals: ["ACC-EXAMPLE", "ACC-OTHER"],
      },
    });

    const { code, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions).toHaveLength(6);
    expect(h.prompts[0]).toMatchObject({
      kind: "select",
      message: "Which Account will this worker serve?",
    });
    expect(h.prompts[0]!.options.map((option) => option.value)).toEqual([
      "ACC-EXAMPLE",
      "ACC-OTHER",
    ]);
    expect(h.questions[0]).toContain("│  ● Example   Administrator");
    expect(h.questions[0]).toContain("│  ○ Other     Owner");
    expect(stderr).toContain("◇  Account · Other\n");
    // ACC-OTHER has no credential yet: a second login, approved for it, then it becomes the default.
    expect(log.split(`$ pidgen auth login ${SERVER}`)).toHaveLength(3);
    expect(log).toContain("$ pidgen account use ACC-OTHER");
    const config = await loadConfig(h.ctx);
    expect(config.profiles["default"]?.default_account).toBe("ACC-OTHER");
    const enroll = enrollments(h)[0]!;
    expect(enroll).toBeDefined();
  });

  // AC-e74e7ebbce32: before enrolling, whether the credential may enroll, the roles that can, and
  // the Personal API Token path, from the role and scopes GET /me publishes.
  it("says the credential may enroll workers, from the scopes GET /me publishes", async () => {
    const h = await harness({ answers: ["", "", "", ""] });

    const { body, stderr, log } = await h.run("setup", "--url", SERVER);

    const signIn = step(body, "sign-in");
    expect(signIn["enroll"]).toMatchObject({
      allowed: true,
      role: "administrator",
      roles: ["owner", "administrator"],
      scope: "workers:enroll",
    });
    // The screen names the role; the log says what it allows.
    expect(stderr).toContain("│\n◇  Signed in as person@example.com · Example · Administrator\n");
    expect(log).toMatch(/may enroll workers/);
    expect(log.indexOf("may enroll workers")).toBeLessThan(log.indexOf("$ pidgen worker enroll"));
  });

  it("stops at sign-in when the role cannot enroll, naming the roles that can and the token path", async () => {
    const h = await harness({
      answers: ["", "", "", ""],
      state: {
        memberships: [{ account_id: "ACC-EXAMPLE", account_name: "Example", role: "member" }],
        scopes: MEMBER_SCOPES,
      },
    });

    const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

    const tokenPath = `pidgen auth login ${SERVER} --with-token --account ACC-EXAMPLE`;
    expect(body.error!.details).toMatchObject({
      allowed: false,
      role: "member",
      roles: ["owner", "administrator"],
      scope: "workers:enroll",
      token_command: tokenPath,
    });
    // Said at sign-in, before anything is installed.
    expect(stderr).toMatch(/Owner or Administrator/);
    expect(stderr).toContain(tokenPath);
    expect(log).toContain("workers:enroll");
    expect(log).not.toContain("$ pidgen worker install");

    // Setup stops at the sign-in step without spending an enrollment.
    expect(code).toBe(ExitCode.Auth);
    expect(body.error).toMatchObject({
      code: "ENROLL_NOT_PERMITTED",
      details: { step: "sign-in", fix: expect.stringContaining(tokenPath) },
    });
    expect(enrollments(h)).toHaveLength(0);
    expect(step(body, "sign-in").status).toBe("failed");
  });

  it("uses the Personal API Token's scopes: workers:enroll may enroll whatever the role", async () => {
    const h = await harness({
      answers: ["", "", "", ""],
      keepApiUrl: true,
      env: { PIDGEN_TOKEN: PAT, PIDGEN_ACCOUNT: "ACC-EXAMPLE" },
      state: {
        memberships: [{ account_id: "ACC-EXAMPLE", account_name: "Example", role: "member" }],
        kind: "pat",
        scopes: ["workers:enroll"],
        workersRefusal: () => refusal(403, "FORBIDDEN", "No Personal API Token scope reaches it."),
      },
    });

    const { code, body } = await h.run("setup");

    expect(code).toBe(ExitCode.Ok);
    expect(step(body, "sign-in").status).toBe("skipped");
    expect(step(body, "sign-in")["enroll"]).toMatchObject({ allowed: true, kind: "pat" });
    expect(enrollments(h)).toHaveLength(1);
    // GET /workers is closed to a Personal API Token: the connection cannot be confirmed, and
    // setup says so rather than claiming it.
    expect(step(body, "enroll")["connected"]).toBeNull();
    expect(step(body, "enroll").summary).toMatch(/pidgen worker status/);
  });

  // AC-ce921d595697: waits until GET /workers reports this worker connected.
  it("waits until GET /workers reports this worker connected", async () => {
    const h = await harness({ answers: ["", "", "", ""], state: { connectAfter: 3 } });

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    const reads = h.requests.filter((request) => request.url.endsWith("/api/v1/workers"));
    // One read to find whether this host is enrolled, then reads until it is connected.
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(step(body, "enroll")["connected"]).toBe(true);
    expect(stderr).toMatch(/connected/i);
  });

  it("fails clearly when the worker is not connected before the timeout", async () => {
    const h = await harness({
      answers: ["", "", "", ""],
      state: { connectAfter: Number.POSITIVE_INFINITY },
    });

    const before = h.ctx.now();
    const { code, body } = await h.run("--timeout", "30", "setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Network);
    expect(body.error).toMatchObject({
      code: "WORKER_NOT_CONNECTED",
      details: {
        step: "enroll",
        command: expect.stringContaining("pidgen worker start --detach"),
        fix: expect.stringContaining("pidgen worker doctor"),
        host_id: HOST,
      },
    });
    // root-json: the failing command's own `log` (the worker-manager log) is kept as it was; the
    // setup log's path is added beside it, never over it.
    expect(body.error!.details["log"]).toBe(
      join(h.ctx.homeDir, ".pidgen", "logs", "worker-manager.log"),
    );
    expect(body.error!.details["setup_log"]).toMatch(/[/\\]\.pidgen[/\\]logs[/\\]setup-.+\.log$/);
    expect(body.error!.message).toMatch(/30 seconds/);
    expect(step(body, "enroll").status).toBe("failed");
    expect(() => step(body, "prove")).toThrow();
    expect(h.ctx.now() - before).toBeGreaterThanOrEqual(30_000);
  });

  // AC-753c2c51c3a6: re-running resumes, skipping what is already done.
  it("resumes: a signed-in profile, an installed worker and an enrolled, running host are skipped", async () => {
    // The first run's four questions and the worker's name, then the re-run's.
    const h = await harness({ answers: ["", "", "", "", "", "", "", ""] });
    expect((await h.run("setup", "--url", SERVER)).code).toBe(ExitCode.Ok);
    const enrolledBefore = enrollments(h).length;
    const installsBefore = (await h.uvRuns()).length;
    const devicesBefore = h.requests.filter((r) => r.url.endsWith("/auth/device")).length;
    h.questions.length = 0;

    const { code, body, log } = await h.run("setup");

    expect(code).toBe(ExitCode.Ok);
    expect(body.data!.steps.map((entry) => [entry.id, entry.status])).toEqual([
      ["check", "done"],
      ["sign-in", "skipped"],
      ["agents", "done"],
      ["agent-login", "skipped"],
      ["capacity", "done"],
      ["runtime", "skipped"],
      ["install", "skipped"],
      ["enroll", "done"],
      ["prove", "done"],
    ]);
    // Only the coding agents and their plans are asked again (`--agent` and `--plan` answer them
    // in advance); the caps are applied again, without a second enrollment.
    expect(h.questions).toHaveLength(3);
    expect(h.questions[0]).toMatch(/coding agents/i);
    expect(enrollments(h).length).toBe(enrolledBefore);
    expect((await h.uvRuns()).length).toBe(installsBefore);
    expect(h.requests.filter((r) => r.url.endsWith("/auth/device")).length).toBe(devicesBefore);
    expect(log).not.toContain("$ pidgen auth login");
    expect(log).not.toContain("$ pidgen worker install");
    expect(log).not.toContain("$ pidgen worker enroll");
    // Skipped steps still name the command they stand for.
    expect(step(body, "install").command).toBe(
      "pidgen worker install --runtime wheel && pidgen worker verify",
    );
  });

  it("resumes with an enrolled host whose worker is not running: starts it without enrolling", async () => {
    // The first run's four questions and the worker's name, then the re-run's.
    const h = await harness({ answers: ["", "", "", "", "", "", "", ""] });
    expect((await h.run("setup", "--url", SERVER)).code).toBe(ExitCode.Ok);
    h.started.value = false;

    const { code, body, log } = await h.run("setup");

    expect(code).toBe(ExitCode.Ok);
    expect(step(body, "enroll").status).toBe("done");
    expect(enrollments(h)).toHaveLength(1);
    expect(log).not.toContain("$ pidgen worker enroll");
    expect(log).toContain("$ pidgen worker start --detach");
  });

  it("a failed step stops setup with the command, its error and the fix", async () => {
    const h = await harness({ answers: ["", "", "", ""], uvFails: true });

    const { code, body } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Unexpected);
    expect(body.ok).toBe(false);
    expect(body.error).toMatchObject({
      code: "INSTALL_FAILED",
      details: {
        step: "install",
        command: "pidgen worker install --runtime wheel",
        error: { code: "INSTALL_FAILED", message: expect.any(String) },
        fix: expect.any(String),
      },
    });
    expect(body.error!.message).toContain("pidgen worker install --runtime wheel");
    expect(body.error!.details.steps!.map((entry) => [entry.id, entry.status])).toEqual([
      ["check", "done"],
      ["sign-in", "done"],
      ["agents", "done"],
      ["agent-login", "skipped"],
      ["capacity", "done"],
      ["runtime", "done"],
      ["install", "failed"],
    ]);
    expect(enrollments(h)).toHaveLength(0);
  });

  // c1-failure: the error names the step, its fix, and that re-running continues from it.
  it("a failed step's error names the step, its fix and the step a re-run continues from", async () => {
    const h = await harness({ answers: ["", "", "", ""], uvFails: true });

    const { body, stderr, log } = await h.run("setup", "--url", SERVER);

    const message = body.error!.message;
    expect(message).toContain("Install the worker");
    const fix = String(body.error!.details["fix"]);
    expect(fix).toMatch(/uv's output/);
    expect(message).toContain(fix);
    expect(fix).toMatch(/Run `pidgen setup` again to continue from here\.$/);
    expect(message).toMatch(/Run `pidgen setup` again to continue from here\.$/);
    // Nothing after the failed step.
    expect(log).not.toContain("$ pidgen worker enroll");
    expect(stderr).not.toMatch(/Done in/);
  });

  it("a failed check names step 1 and continues from step 1", async () => {
    const h = await harness({ answers: [] });
    await writeFile(join(h.pathDir, "git"), "#!/bin/sh\necho 'git version 2.37.9'\n");

    const { body, log } = await h.run("setup", "--url", SERVER);

    expect(body.error!.message).toContain("Check this machine");
    expect(body.error!.message).toContain(
      "git: install git 2.38 or later with your package manager: https://git-scm.com/downloads/linux",
    );
    expect(body.error!.message).toMatch(/Run `pidgen setup` again to continue from here\.$/);
    expect(log).not.toContain("$ pidgen auth login");
  });

  // c-setup-resume: after a failure, a re-run skips what is done and continues from the failed step.
  describe("re-running after a failed step", () => {
    /** The steps the re-run reports, as [id, status]. */
    const statuses = (body: Body) =>
      (body.data?.steps ?? body.error?.details.steps ?? []).map((entry) => [
        entry.id,
        entry.status,
      ]);

    it("after a failed install, skips the sign-in and continues from step 6", async () => {
      const h = await harness({ answers: ["", "", "", "", "", "", "", ""], uvFails: true });
      const failed = await h.run("setup", "--url", SERVER);
      expect(failed.body.error!.message).toMatch(/continue from here\.$/);
      await expectNoProgressState(h.directory);
      delete h.ctx.env["FAKE_UV_FAIL"];
      const devices = h.requests.filter((r) => r.url.endsWith("/auth/device")).length;

      const { code, body, stderr, log } = await h.run("setup");

      expect(body.error, stderr).toBeNull();
      expect(code).toBe(ExitCode.Ok);
      expect(statuses(body)).toEqual([
        ["check", "done"],
        ["sign-in", "skipped"],
        ["agents", "done"],
        ["agent-login", "skipped"],
        ["capacity", "done"],
        ["runtime", "done"],
        ["install", "done"],
        ["enroll", "done"],
        ["prove", "done"],
      ]);
      expect(log).not.toContain("$ pidgen auth login");
      expect(h.requests.filter((r) => r.url.endsWith("/auth/device")).length).toBe(devices);
      expect(log).toContain("$ pidgen worker install");
      expect(enrollments(h)).toHaveLength(1);
      await expectNoProgressState(h.directory);
    });

    it("after a failed agent sign-in, skips the Pidgen sign-in and continues from step 4", async () => {
      const h = await harness({
        agents: { codex: { loginFails: true } },
        answers: ["", "", "", "", ""],
      });
      const failed = await h.run("setup", "--url", SERVER, "--agent", "codex");
      expect(failed.body.error!.message).toMatch(/continue from here\.$/);
      expect(statuses(failed.body)).toEqual([
        ["check", "done"],
        ["sign-in", "done"],
        ["agents", "done"],
        ["agent-login", "failed"],
      ]);
      await expectNoProgressState(h.directory);
      await writeExecutable(join(h.pathDir, "codex"), fakeAgent("codex", {}));

      const { code, body, log } = await h.run("setup", "--agent", "codex");

      expect(code).toBe(ExitCode.Ok);
      expect(statuses(body).slice(0, 5)).toEqual([
        ["check", "done"],
        ["sign-in", "skipped"],
        ["agents", "done"],
        ["agent-login", "done"],
        ["capacity", "done"],
      ]);
      expect(log).not.toContain("$ pidgen auth login");
      await expectNoProgressState(h.directory);
    });

    it("after the worker did not connect, continues from step 7 without enrolling again", async () => {
      const h = await harness({
        answers: ["", "", "", "", "", "", "", ""],
        state: { connectAfter: 1_000_000 },
      });
      const failed = await h.run("setup", "--url", SERVER);
      expect(failed.body.error!.code).toBe("WORKER_NOT_CONNECTED");
      expect(failed.body.error!.message).toMatch(/continue from here\.$/);
      await expectNoProgressState(h.directory);
      h.state.connectAfter = 1;
      const installs = (await h.uvRuns()).length;

      const { code, body } = await h.run("setup");

      expect(code).toBe(ExitCode.Ok);
      expect(statuses(body)).toEqual([
        ["check", "done"],
        ["sign-in", "skipped"],
        ["agents", "done"],
        ["agent-login", "skipped"],
        ["capacity", "done"],
        ["runtime", "skipped"],
        ["install", "skipped"],
        ["enroll", "done"],
        ["prove", "done"],
      ]);
      expect(enrollments(h)).toHaveLength(1);
      expect((await h.uvRuns()).length).toBe(installs);
      await expectNoProgressState(h.directory);
    });
  });

  // c1-frame: setup ends with the time it took, then the next action.
  it("ends with the elapsed time and the next action, the envelope's steps unchanged", async () => {
    // A person takes 63 seconds to answer the install question.
    const h = await harness({
      answers: [
        "",
        "",
        "",
        async () => {
          await h.ctx.sleep(63_000);
          return "";
        },
      ],
    });

    const before = h.ctx.now();
    const { code, body, stderr } = await h.run("setup", "--url", SERVER);
    const elapsed = Math.round((h.ctx.now() - before) / 1000);

    expect(code).toBe(ExitCode.Ok);
    expect(elapsed).toBeGreaterThanOrEqual(63);
    // Each action's one line, in order, inside the frame.
    const [install, enroll] = order(
      stderr,
      "◇  pidgen-worker 1.0.0 installed and verified",
      `◇  Enrolled as ${HOST} in Example`,
    );
    expect(install).toBeLessThan(enroll!);

    // It ends with the elapsed time (in a terminal, the summary card follows it on standard output).
    expect(stderr).toMatch(
      new RegExp(`│\\n└  Done in ${Math.floor(elapsed / 60)} min ${elapsed % 60} s\\n$`),
    );
    // The envelope: the same shape, with the same step ids.
    expect(Object.keys(body.data!)).toEqual(["steps"]);
    expect(body.data!.steps.map((entry) => entry.id)).toEqual(STEP_IDS);
    expect(step(body, "capacity")).toMatchObject({
      id: "capacity",
      status: "done",
      command: null,
      caps: { claude: 1, codex: 1 },
    });
  });

  // c1-git: setup's check step runs the doctor's git check. AC-0616bcdd68cc
  it("stops at the check step when git is older than 2.38", async () => {
    const h = await harness({
      answers: ["", "", "", ""],
      osRelease: 'NAME="Ubuntu"\nVERSION_ID="22.04"\nID=ubuntu\nID_LIKE=debian\n',
    });
    await writeFile(join(h.pathDir, "git"), "#!/bin/sh\necho 'git version 2.37.9'\n");

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error).toMatchObject({ code: "DOCTOR_FAILED", details: { step: "check" } });
    expect(body.error!.message).toContain("Check this machine");
    const ppa =
      "sudo add-apt-repository ppa:git-core/ppa && sudo apt update && sudo apt install git";
    expect(String(body.error!.details["fix"])).toContain(`git: Install git from the git-core PPA`);
    expect(String(body.error!.details["fix"])).toContain(`\`${ppa}\``);
    // The screen shows the fix without the backticks.
    expect(stderr).toContain(ppa);
    expect(stderr).not.toContain(`\`${ppa}\``);
    const checks = body.error!.details["checks"] as { id: string; summary: string }[];
    expect(checks.find((entry) => entry.id === "git")?.summary).toMatch(
      /^git 2\.37\.9 at .* is older than 2\.38, the oldest the worker supports\.$/,
    );
  });

  // c1-uv: with uv missing, the check step offers to install it.
  it("offers to install uv when it is missing, and uses the installed uv for the rest of setup", async () => {
    const h = await harness({ answers: ["y", "", "", "", ""], uv: false });
    const { curlRuns } = await offerableUv(h);

    const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(h.prompts[0]).toMatchObject({
      kind: "confirm",
      message: "uv installs the worker and isn't on this machine. Install it?",
    });
    expect(h.questions[0]).toContain(`│  Runs uv's installer: ${UV_INSTALL}`);
    expect(log).toContain(`$ ${UV_INSTALL}`);
    expect(await curlRuns()).toEqual(["-LsSf https://astral.sh/uv/install.sh"]);
    // curl's output is piped to sh as two argument lists; no command string reaches a shell.
    const installer = h.spawns.filter((spawn) => ["curl", "sh"].includes(spawn.command));
    expect(installer.map((spawn) => [spawn.command, spawn.args])).toEqual([
      ["curl", ["-LsSf", "https://astral.sh/uv/install.sh"]],
      ["sh", []],
    ]);
    for (const spawn of installer) expect(spawn.options.shell).toBe(false);
    // The installed uv, in ~/.local/bin and not on PATH, installed the worker.
    const uv = join(h.directory, ".local", "bin", "uv");
    expect(log).toContain(`$ ${uv} tool install --python 3.12 --python-preference only-managed`);
    expect((await h.uvRuns()).filter((run) => run.args[1] === "install")).toHaveLength(1);
    expect(step(body, "check").status).toBe("done");
    // The offer comes before the doctor's checks, which then find uv; on screen, uv's install is
    // one line, and the installer's output only in the log.
    const [offer, doctor] = order(log, `$ ${UV_INSTALL}`, "$ pidgen doctor");
    expect(offer).toBeLessThan(doctor!);
    expect(h.spinners[0]).toBe("Installing uv…");
    const [installed, ready] = order(stderr, "│\n◇  uv installed\n", "◇  This machine is ready");
    expect(installed).toBeLessThan(ready!);
    expect(stderr).not.toContain(`$ ${UV_INSTALL}`);
  });

  it("uses a uv in ~/.local/bin that PATH does not have yet, without asking", async () => {
    const h = await harness({ answers: ["", "", "", "", ""], uv: false });
    const uv = join(h.directory, ".local", "bin", "uv");
    await mkdir(join(uv, ".."), { recursive: true });
    await writeFile(uv, fakeUv());
    await chmod(uv, 0o755);

    const { code, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions).toHaveLength(5);
    expect(h.questions[3]).toMatch(/Install pidgen-worker/);
    expect(stderr).not.toContain(UV_INSTALL);
    expect(log).toContain(`$ ${uv} tool install`);
    expect(stderr).toContain(
      "│\n▲  Using uv at ~/.local/bin/uv; it is not on PATH yet: open a new terminal, or add ~/.local/bin to PATH.\n",
    );
  });

  it("declining the uv install fails the check step with RUNTIME_UNAVAILABLE and the install command", async () => {
    const h = await harness({ answers: ["n"], uv: false });
    const { curlRuns } = await offerableUv(h);

    const { code, body } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Usage);
    expect(h.questions).toHaveLength(1);
    expect(h.questions[0]).toContain("Install it?");
    expect(body.error).toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
      details: { step: "check", fix: expect.stringContaining(UV_INSTALL) },
    });
    expect(body.error!.message).toContain(UV_INSTALL);
    expect(body.error!.message).toMatch(/continue from here\.$/);
    expect(await curlRuns()).toEqual([]);
    expect(h.requests.some((request) => request.url.endsWith("/auth/device"))).toBe(false);
    expect(await h.uvRuns()).toEqual([]);
  });

  it("a failing check stops setup before anything is changed, with each check's fix", async () => {
    const h = await harness({ answers: ["", "", "", ""] });
    await writeFile(join(h.pathDir, "git"), "#!/bin/sh\necho 'git version 2.37.9'\n");

    const { code, body } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error).toMatchObject({
      code: "DOCTOR_FAILED",
      details: { step: "check", command: "pidgen doctor" },
    });
    expect(String(body.error!.details["fix"])).toContain(
      "git: install git 2.38 or later with your package manager: https://git-scm.com/downloads/linux",
    );
    expect(body.error!.details.steps!.map((entry) => entry.status)).toEqual(["failed"]);
    expect(h.requests.some((request) => request.url.endsWith("/auth/device"))).toBe(false);
    expect(h.questions).toEqual([]);
    expect(await h.uvRuns()).toEqual([]);
  });

  it("--runtime, --version, --label, --agent and --plan answer the questions in advance", async () => {
    const h = await harness({ answers: [] });

    const { code, body, stderr } = await h.run(
      "setup",
      "--url",
      SERVER,
      "--runtime",
      "wheel",
      "--version",
      "1.0.0",
      "--label",
      "build box",
      "--agent",
      "claude",
      "--agent",
      "codex",
      "--plan",
      "claude=pro",
      "--plan",
      "codex=plus",
      "--accept-licence",
    );

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions).toEqual([]);
    expect(step(body, "runtime").status).toBe("done");
    expect(step(body, "install").command).toBe(
      "pidgen worker install --runtime wheel --version 1.0.0 && pidgen worker verify",
    );
    expect(step(body, "enroll").command).toBe(
      "pidgen worker enroll --label 'build box' -- --host-id 'build box' && pidgen worker start --detach",
    );
    expect(enrollments(h)[0]!.body).toEqual({ label: "build box", install_id: ANY_INSTALL_ID });
    // --label is the worker's host id too: pidgen-worker enroll gets it as --host-id.
    const enroll = (await h.workerLog()).find((args) => args[0] === "enroll")!;
    expect(enroll.slice(-2)).toEqual(["--host-id", "build box"]);
    expect(step(body, "enroll")).toMatchObject({ host_id: "build box", connected: true });
    expect(stderr).toContain("(from --accept-licence)");
    expect(stderr).not.toContain(releaseList().eula.notice);
  });

  // AC-746da6cb506b: without a terminal, exit 2 with the equivalent commands in order.
  it("without a terminal exits 2 with TERMINAL_REQUIRED and the equivalent commands in order", async () => {
    const h = await harness({ noTerminal: true });

    const { code, body } = await h.run("setup", "--url", SERVER, "--label", "build box");

    expect(code).toBe(ExitCode.Usage);
    expect(body.ok).toBe(false);
    expect(body.error!.code).toBe("TERMINAL_REQUIRED");
    expect(body.error!.details.commands).toEqual([
      "pidgen doctor",
      `pidgen auth login ${SERVER}`,
      "pidgen worker install",
      "pidgen worker verify",
      "pidgen worker enroll --label 'build box' -- --host-id 'build box'",
      "pidgen worker start --detach",
      "pidgen worker status",
      "pidgen worker doctor",
    ]);
    expect(h.requests).toEqual([]);
    expect(await h.uvRuns()).toEqual([]);
  });

  it("without a terminal carries --runtime, --version and the global flags into the commands", async () => {
    const h = await harness({ noTerminal: true, keepApiUrl: true });

    const { code, body } = await h.run(
      "--profile",
      "work",
      "setup",
      "--runtime",
      "wheel",
      "--version",
      "1.0.0",
    );

    expect(code).toBe(ExitCode.Usage);
    expect(body.error!.details.commands).toEqual([
      "pidgen --profile work doctor",
      `pidgen --profile work auth login ${SERVER}`,
      "pidgen --profile work worker install --runtime wheel --version 1.0.0",
      "pidgen --profile work worker verify",
      `pidgen --profile work worker enroll --label ${HOST} -- --host-id ${HOST}`,
      "pidgen --profile work worker start --detach",
      "pidgen --profile work worker status",
      "pidgen --profile work worker doctor",
    ]);
  });

  // AC-746da6cb506b: data.steps reports each step's id, status and command.
  it("reports each step's id, status (done, skipped or failed) and command", async () => {
    const h = await harness({ answers: ["", "", "", ""] });

    const { body } = await h.run("setup", "--url", SERVER);

    for (const entry of body.data!.steps) {
      expect(Object.keys(entry)).toEqual(expect.arrayContaining(["id", "status", "command"]));
      expect(["done", "skipped", "failed"]).toContain(entry.status);
    }
  });

  it("refuses usage errors before asking or sending anything", async () => {
    for (const argv of [
      ["setup", "--runtime", "container"],
      ["setup", "--runtime", "rpm"],
      ["setup", "--version", " "],
      ["setup", "--label", ""],
      ["setup", "--label", "x".repeat(101)],
      ["setup", "--url", "not a url"],
      ["setup", "extra"],
    ]) {
      const h = await harness({ answers: [] });
      const { code, body } = await h.run(...argv);
      expect(code, argv.join(" ")).toBe(ExitCode.Usage);
      expect(body.error!.code).toBe("CLI_USAGE");
      expect(h.requests).toEqual([]);
      expect(h.questions).toEqual([]);
    }
  });

  it("a stored profile for the server is used and not signed in again", async () => {
    const h = await harness({ answers: ["", "", "", ""] });
    const config: Config = {
      default_profile: "default",
      profiles: {
        default: {
          url: SERVER,
          default_account: "ACC-EXAMPLE",
          credentials: { "ACC-EXAMPLE": { kind: "cli", token: CLI_TOKEN } },
        },
      },
    };
    await saveConfig(h.ctx, config);

    const { code, body } = await h.run("setup");

    expect(code).toBe(ExitCode.Ok);
    expect(step(body, "sign-in").status).toBe("skipped");
    expect(h.requests.some((request) => request.url.endsWith("/auth/device"))).toBe(false);
  });
});

// Setup decides enrollment from this install's worker home (worker.env) and the server's list.
describe("pidgen setup enrollment state", () => {
  const ANSWERS = ["", "", "", ""];
  const LAPTOP = "sams-laptop";
  const otherInstall = (hostId: string) =>
    workerResource(true, { host_id: hostId, created_at: "2026-09-20T09:00:00Z" });
  const credential = (server = SERVER, hostId = HOST, token = "pidgen_node_fake_credential") => [
    `PIDGEN_SERVICE_URL=${server}`,
    `PIDGEN_NODE_TOKEN=${token}`,
    `PIDGEN_LOCALITY_DOMAIN=${hostId}`,
  ];
  const enrollArgs = async (h: Harness) =>
    (await h.workerLog()).filter((args) => args[0] === "enroll");
  /** What each `pidgen-worker enroll` did with the token: exchanged it, or skipped it. */
  const exchanges = async (h: Harness) =>
    (await readFile(`${h.ctx.env["FAKE_WORKER_LOG"]}.exchanges`, "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (JSON.parse(line) as string[])[1]);

  // state-adopt: another install's worker under this host name is not adopted.
  it("offers the next free name when the Account lists another install's worker under this host name", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: [...ANSWERS, ""],
      state: { others: [otherInstall(LAPTOP)] },
    });

    const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(stderr).toContain(
      `Example already has a worker named ${LAPTOP} (connected; enrolled 20 Sep).`,
    );
    expect(stderr).toContain(
      "It isn't this install: it keeps its settings in another folder on this machine.",
    );
    expect(h.questions).toHaveLength(5);
    expect(h.prompts[4]).toMatchObject({ kind: "text", message: "Worker name" });
    expect(h.questions[4]).toContain(`│  ${LAPTOP}-2\n`);
    expect(stderr).toContain(`◇  Worker name · ${LAPTOP}-2\n`);
    expect(enrollments(h)).toHaveLength(1);
    expect(enrollments(h)[0]!.body).toEqual({ label: `${LAPTOP}-2`, install_id: ANY_INSTALL_ID });
    const [enroll] = await enrollArgs(h);
    expect(enroll!.slice(-2)).toEqual(["--host-id", `${LAPTOP}-2`]);
    expect(log).toContain(`$ pidgen worker enroll --label ${LAPTOP}-2 -- --host-id ${LAPTOP}-2`);
    expect(stderr).toContain(`Enrolled as ${LAPTOP}-2 in Example`);
    expect(h.started.value).toBe(true);
    expect(step(body, "enroll")).toMatchObject({
      status: "done",
      host_id: `${LAPTOP}-2`,
      connected: true,
      command: `pidgen worker enroll --label ${LAPTOP}-2 -- --host-id ${LAPTOP}-2 && pidgen worker start --detach`,
    });
  });

  it("skips names already taken: sams-laptop-3 when -2 is listed too, and takes a typed name", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: [...ANSWERS, `${LAPTOP}-2`, "studio"],
      state: { others: [otherInstall(LAPTOP), otherInstall(`${LAPTOP}-2`)] },
    });

    const { code, stderr } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions[4]).toContain(`│  ${LAPTOP}-3\n`);
    // A taken name keeps the question open.
    expect(h.questions).toHaveLength(6);
    expect(h.questions[5]).toContain(`▲  ${LAPTOP}-2 is taken`);
    expect(stderr).toContain("◇  Worker name · studio\n");
    expect((await enrollArgs(h))[0]!.slice(-2)).toEqual(["--host-id", "studio"]);
  });

  it("does not adopt the listed worker when this home's worker.env has no PIDGEN_NODE_TOKEN", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: [...ANSWERS, ""],
      state: { others: [otherInstall(LAPTOP)] },
    });
    await writeWorkerEnv(h.ctx.homeDir, [
      `PIDGEN_SERVICE_URL=${SERVER}`,
      `PIDGEN_LOCALITY_DOMAIN=${LAPTOP}`,
    ]);

    const { code } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(enrollments(h)).toHaveLength(1);
    expect((await enrollArgs(h))[0]!.slice(-2)).toEqual(["--host-id", `${LAPTOP}-2`]);
  });

  // state-enrolled: a credential for this server whose host id the server lists, not revoked.
  it("treats the machine as enrolled when worker.env holds a credential for this server that GET /workers lists", async () => {
    const h = await harness({ answers: ANSWERS, state: { enrolled: true } });
    await writeWorkerEnv(h.ctx.homeDir, credential());

    const { code, body, log } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(enrollments(h)).toHaveLength(0);
    expect(log).not.toContain("$ pidgen worker enroll");
    expect(log).toContain("$ pidgen worker start --detach");
    expect(step(body, "enroll")).toMatchObject({ host_id: HOST, connected: true });
  });

  it("uses the host id worker.env names, not this machine's host name", async () => {
    const h = await harness({ answers: ANSWERS, state: { enrolled: true } });
    await writeWorkerEnv(h.ctx.homeDir, credential(SERVER, "build-box"));

    const { code, body } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(enrollments(h)).toHaveLength(0);
    expect(step(body, "enroll")).toMatchObject({ host_id: "build-box", connected: true });
  });

  // AC-27bdbf24464e: a credential for another server stops setup before any enrollment is created.
  it("stops before enrolling when worker.env's credential is for another server, naming the file and that server", async () => {
    const other = "https://other.example.com";
    const h = await harness({ answers: [...ANSWERS, ""], state: { others: [otherInstall(HOST)] } });
    await writeWorkerEnv(h.ctx.homeDir, credential(other));
    const envPath = join(h.ctx.homeDir, ".pidgen", "worker.env");
    const before = await readFile(envPath, "utf8");

    const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "WORKER_CREDENTIAL_PRESENT",
      details: { step: "enroll", path: envPath, server: other },
    });
    expect(body.error!.message).toContain(envPath);
    expect(body.error!.message).toContain(other);
    expect(enrollments(h)).toHaveLength(0);
    expect(await enrollArgs(h)).toEqual([]);
    expect(h.started.value).toBe(false);
    expect(await readFile(envPath, "utf8")).toBe(before);
    // One block: the headline names the file and the server it points at.
    expect(stderr).toMatch(
      /■ {2}.*worker\.env holds a worker credential for https:\/\/other\.example\.com/,
    );
    expect(stderr).not.toContain("pidgen_node_fake_credential");
    expect(log).not.toContain("pidgen_node_fake_credential");
  });

  // A credential for this server that the Account does not list is no longer live: as revoked. The
  // Account lists no removed worker by its name, so the suggestion is this host's name.
  it("asks to enroll again when the server does not list worker.env's host id, and replaces it", async () => {
    const h = await harness({ answers: [...ANSWERS, "", ""] });
    await writeWorkerEnv(h.ctx.homeDir, credential(SERVER, "gone-box", REVOKED_CREDENTIAL));

    const { code, body } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(h.prompts[4]).toMatchObject({
      kind: "confirm",
      message: "This machine's worker was removed from Example. Enroll it again?",
    });
    expect(h.prompts[5]).toMatchObject({ kind: "text", message: "Worker name" });
    expect(h.questions[5]).toContain(`│  ${HOST}\n`);
    expect(enrollments(h)).toHaveLength(1);
    expect((await enrollArgs(h))[0]!.slice(-2)).toEqual(["--host-id", HOST]);
    expect(await exchanges(h)).toEqual(["done"]);
    expect(step(body, "enroll")).toMatchObject({ host_id: HOST, connected: true });
  });

  it("with a credential that cannot read GET /workers, the local credential decides", async () => {
    const h = await harness({
      answers: ANSWERS,
      keepApiUrl: true,
      env: { PIDGEN_TOKEN: PAT, PIDGEN_ACCOUNT: "ACC-EXAMPLE" },
      state: {
        kind: "pat",
        scopes: ["workers:enroll"],
        workersRefusal: () => refusal(403, "FORBIDDEN", "No Personal API Token scope reaches it."),
      },
    });
    await writeWorkerEnv(h.ctx.homeDir, credential());

    const { code, body } = await h.run("setup");

    expect(code).toBe(ExitCode.Ok);
    expect(enrollments(h)).toHaveLength(0);
    expect(h.started.value).toBe(true);
    expect(step(body, "enroll")["connected"]).toBeNull();
  });

  // state-revoked: a revoked credential is enrolled again only after the person agrees.
  // AC-031e28814063: worker.env is moved aside before pidgen-worker enroll runs, so the worker
  // exchanges the new enrollment and starts and connects with the new credential.
  it("asks whether to enroll again when the server lists this home's worker as revoked, and replaces its credential", async () => {
    const h = await harness({
      answers: [...ANSWERS, "", ""],
      state: { enrolled: true, revoked: true },
    });
    await writeWorkerEnv(h.ctx.homeDir, credential(SERVER, HOST, REVOKED_CREDENTIAL));
    const pidgenHome = join(h.ctx.homeDir, ".pidgen");

    const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(h.questions).toHaveLength(6);
    expect(h.prompts[4]).toMatchObject({
      kind: "confirm",
      message: "This machine's worker was removed from Example. Enroll it again?",
    });
    expect(h.questions[4]).toContain("│  ● Yes  ○ No");
    expect(h.prompts[5]).toMatchObject({ kind: "text", message: "Worker name" });
    expect(h.questions[5]).toContain(`│  ${HOST}\n`);
    expect(enrollments(h)).toHaveLength(1);
    expect((await enrollArgs(h))[0]!.slice(-2)).toEqual(["--host-id", HOST]);
    // The fake pidgen-worker found no saved credential, so it redeemed the new enrollment.
    expect(await exchanges(h)).toEqual(["done"]);
    const moved = (await readdir(pidgenHome)).filter((name) =>
      /^worker\.env\.replaced-\d{8}T\d{6}Z$/.test(name),
    );
    expect(moved).toHaveLength(1);
    const movedPath = join(pidgenHome, moved[0]!);
    expect(await readFile(movedPath, "utf8")).toContain(REVOKED_CREDENTIAL);
    expect((await stat(movedPath)).mode & 0o777).toBe(0o600);
    expect((await readWorkerEnv(h.ctx.homeDir))?.["PIDGEN_NODE_TOKEN"]).toBe(
      "pidgen_node_fake_credential",
    );
    // The setup log records the move by path, and the command with the flag; never the token.
    expect(log).toContain(
      `$ pidgen worker enroll --replace-credential --label ${HOST} -- --host-id ${HOST}`,
    );
    expect(log).toContain(movedPath);
    expect(log).not.toContain(REVOKED_CREDENTIAL);
    expect(stderr).not.toContain(REVOKED_CREDENTIAL);
    expect(JSON.stringify(body)).not.toContain(REVOKED_CREDENTIAL);
    expect(h.started.value).toBe(true);
    expect(step(body, "enroll")).toMatchObject({ status: "done", host_id: HOST, connected: true });
  });

  it("declining to enroll a revoked worker again stops setup without enrolling or starting", async () => {
    const h = await harness({
      answers: [...ANSWERS, "n"],
      state: { enrolled: true, revoked: true },
    });
    await writeWorkerEnv(h.ctx.homeDir, credential());

    const { code, body } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Usage);
    // root-json: declining is the person stopping setup; no code beyond SETUP_CANCELLED is new.
    expect(body.error).toMatchObject({ code: "SETUP_CANCELLED", details: { step: "enroll" } });
    expect(enrollments(h)).toHaveLength(0);
    expect(h.started.value).toBe(false);
  });

  // state-no-start: no credential, no start.
  it("never starts a worker whose home holds no credential, and asks for a setup-defect report", async () => {
    const h = await harness({ answers: ANSWERS, env: { FAKE_ENROLL_NO_ENV: "1" } });

    const { code, body } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error).toMatchObject({
      // root-json: an enrollment that left no credential keeps the code an enroll failure had.
      code: "ENROLL_FAILED",
      details: {
        step: "enroll",
        fix: expect.stringContaining("pidgen feedback --kind not-working"),
      },
    });
    expect(body.error!.message).toContain("pidgen feedback --kind not-working");
    expect(enrollments(h)).toHaveLength(1);
    expect(h.started.value).toBe(false);
    expect((await h.workerLog()).some((args) => args[0] === undefined)).toBe(false);
  });

  // state-label: --label answers the name question in advance.
  it("--label answers the name question in advance and is the worker's host id", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: ANSWERS,
      state: { others: [otherInstall(LAPTOP)] },
    });

    const { code, body } = await h.run("setup", "--url", SERVER, "--label", "studio");

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions).toHaveLength(4);
    expect(enrollments(h)[0]!.body).toEqual({ label: "studio", install_id: ANY_INSTALL_ID });
    expect((await enrollArgs(h))[0]!.slice(-2)).toEqual(["--host-id", "studio"]);
    expect(step(body, "enroll")).toMatchObject({ host_id: "studio", connected: true });
  });

  // AC-43bd1897c9e5, AC-674ba019b050: a name the server refuses (HTTP 409 WORKER_HOST_TAKEN), which
  // the Account's list cannot show, is met with one line and the name question; setup enrolls under
  // the answer with the same enrollment and goes on to a running worker.
  it("recovers from WORKER_HOST_TAKEN: one line, the name question, then the same enrollment under the next free name", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: [...ANSWERS, "", ""],
      env: { FAKE_TAKEN_HOSTS: LAPTOP },
    });

    const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    const line = `│\n▲  ${LAPTOP} is taken in Pidgen, so this worker needs another name.\n`;
    expect(stderr).toContain(line);
    expect(stderr.split("is taken in Pidgen")).toHaveLength(2);
    expect(h.questions).toHaveLength(6);
    expect(h.prompts[4]).toMatchObject({ kind: "text", message: "Worker name" });
    expect(h.questions[4]).toContain(`│  ${LAPTOP}\n`);
    expect(h.prompts[5]).toMatchObject({ kind: "text", message: "Worker name" });
    expect(h.questions[5]).toContain(`│  ${LAPTOP}-2\n`);
    order(stderr, line, `◇  Worker name · ${LAPTOP}-2\n`, `Enrolled as ${LAPTOP}-2 in Example`);
    expect(stderr).not.toContain("ENROLL_FAILED");
    expect(stderr).not.toContain("■");
    // One enrollment: its unspent token is offered again under the new name.
    expect(enrollments(h)).toHaveLength(1);
    const runs = await enrollArgs(h);
    expect(runs.map((args) => args.slice(-2))).toEqual([
      ["--host-id", LAPTOP],
      ["--host-id", `${LAPTOP}-2`],
    ]);
    expect(runs[1]![2]).toBe(runs[0]![2]);
    expect(await exchanges(h)).toEqual(["done"]);
    expect(log).toContain(`${LAPTOP} is taken in Pidgen (HTTP 409 WORKER_HOST_TAKEN)`);
    expect(log).not.toContain(ENROLL_TOKEN);
    expect(h.started.value).toBe(true);
    expect(step(body, "enroll")).toMatchObject({
      status: "done",
      host_id: `${LAPTOP}-2`,
      connected: true,
      command: `pidgen worker enroll --label ${LAPTOP}-2 -- --host-id ${LAPTOP}-2 && pidgen worker start --detach`,
    });
  });

  it("a refused next name is refused too: the question comes again, defaulting to the one after", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: [...ANSWERS, "", "", ""],
      env: { FAKE_TAKEN_HOSTS: `${LAPTOP},${LAPTOP}-2` },
    });

    const { code, stderr } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(stderr).toContain(
      `▲  ${LAPTOP}-2 is taken in Pidgen, so this worker needs another name.`,
    );
    expect(h.questions[6]).toContain(`│  ${LAPTOP}-3\n`);
    expect(enrollments(h)).toHaveLength(1);
    expect((await enrollArgs(h)).map((args) => args.at(-1))).toEqual([
      LAPTOP,
      `${LAPTOP}-2`,
      `${LAPTOP}-3`,
    ]);
    expect(stderr).toContain(`Enrolled as ${LAPTOP}-3 in Example`);
  });

  it("the name question refuses a name the server already refused in this run", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: [...ANSWERS, "", LAPTOP, "studio"],
      env: { FAKE_TAKEN_HOSTS: LAPTOP },
    });

    const { code } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions).toHaveLength(7);
    expect(h.questions[6]).toContain(`▲  ${LAPTOP} is taken in Pidgen`);
    expect((await enrollArgs(h)).at(-1)!.at(-1)).toBe("studio");
  });

  // AC-674ba019b050: when the refused token cannot be offered again, one new enrollment is made, and
  // the log names the one left unused.
  it("when the same enrollment fails under the new name, enrolls once more with a new one and logs the unused one", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: [...ANSWERS, "", ""],
      env: { FAKE_TAKEN_HOSTS: LAPTOP, FAKE_FAIL_ENROLL_RUN: "2" },
    });

    const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(enrollments(h)).toHaveLength(2);
    expect(enrollments(h)[1]!.body).toEqual({ label: `${LAPTOP}-2`, install_id: ANY_INSTALL_ID });
    expect((await enrollArgs(h)).map((args) => args.at(-1))).toEqual([
      LAPTOP,
      `${LAPTOP}-2`,
      `${LAPTOP}-2`,
    ]);
    expect(log).toMatch(/enrollment enr-example-1 .*unused.*It was withdrawn\./i);
    // AC-b25f2e3c4fcc: the enrollment it could not use is withdrawn, not left waiting.
    expect(withdrawals(h)).toEqual(["/api/v1/workers/enrollments/enr-example-1"]);
    expect(step(body, "enroll")).toMatchObject({ host_id: `${LAPTOP}-2`, connected: true });
  });

  // AC-60239736b93c: --label answered the name question in advance, so a refusal stops setup.
  it("--label refused by the server stops at the enroll step with one block naming the next free name, and starts nothing", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: ANSWERS,
      env: { FAKE_TAKEN_HOSTS: "studio" },
    });

    const { code, body, stderr } = await h.run("setup", "--url", SERVER, "--label", "studio");

    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "WORKER_HOST_TAKEN",
      details: {
        step: "enroll",
        host_id: "studio",
        fix: expect.stringContaining("`pidgen setup --label studio-2`"),
      },
    });
    expect(h.questions).toHaveLength(4);
    expect(enrollments(h)).toHaveLength(1);
    expect(await enrollArgs(h)).toHaveLength(1);
    expect(h.started.value).toBe(false);
    expect(stderr.match(/■ {2}/g)).toHaveLength(1);
    expect(stderr).toMatch(/■ {2}studio is taken in Pidgen/);
    expect(stderr).toContain("pidgen setup --label studio-2");
    expect(stderr).not.toContain("Workers page");
    // AC-b25f2e3c4fcc: the refused enrollment is withdrawn before setup stops.
    expect(withdrawals(h)).toEqual(["/api/v1/workers/enrollments/enr-example-1"]);
  });

  // AC-4768245ea412: a removed worker is offered its own name first; only a refusal moves it on.
  it("re-enrolling a revoked worker tries its own name first and falls back only when the server refuses it", async () => {
    const h = await harness({
      answers: [...ANSWERS, "", "", ""],
      state: { enrolled: true, revoked: true },
      env: { FAKE_TAKEN_HOSTS: HOST },
    });
    await writeWorkerEnv(h.ctx.homeDir, credential(SERVER, HOST, REVOKED_CREDENTIAL));

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(h.prompts[4]).toMatchObject({ kind: "confirm" });
    expect(h.prompts[5]).toMatchObject({ kind: "text", message: "Worker name" });
    expect(h.questions[5]).toContain(`│  ${HOST}\n`);
    expect(h.prompts[6]).toMatchObject({ kind: "text", message: "Worker name" });
    expect(h.questions[6]).toContain(`│  ${HOST}-2\n`);
    expect((await enrollArgs(h)).map((args) => args.at(-1))).toEqual([HOST, `${HOST}-2`]);
    expect(enrollments(h)).toHaveLength(1);
    expect(step(body, "enroll")).toMatchObject({ host_id: `${HOST}-2`, connected: true });
  });

  // AC-c41e956cfcf0: a --label the Account already lists is taken: setup stops, exit 5, naming the
  // suggested name in its fix, and never asks.
  it("--label naming another install's worker stops before enrolling with WORKER_NAME_TAKEN, exit 5", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: ANSWERS,
      state: { others: [otherInstall(LAPTOP)] },
    });

    const { code, body } = await h.run("setup", "--url", SERVER, "--label", LAPTOP.toUpperCase());

    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "WORKER_NAME_TAKEN",
      details: {
        step: "enroll",
        display_name: LAPTOP.toUpperCase(),
        suggested_name: `${LAPTOP.toUpperCase()}-2`,
        fix: expect.stringContaining(`\`pidgen setup --label ${LAPTOP.toUpperCase()}-2\``),
      },
    });
    expect(h.questions).toHaveLength(4);
    expect(enrollments(h)).toHaveLength(0);
    expect(h.started.value).toBe(false);
  });

  // AC-315b0c1692aa: on a fresh machine the name question is asked before any enrollment exists,
  // with this host's name filled in; Enter accepts it.
  it("always asks the worker's name before enrolling, suggesting this host's name, and Enter accepts it", async () => {
    let before: number | null = null;
    const h = await harness({
      hostName: LAPTOP,
      answers: [
        ...ANSWERS,
        () => {
          before = enrollments(h).length;
          return "";
        },
      ],
    });

    const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(h.questions).toHaveLength(5);
    expect(h.prompts[4]).toMatchObject({ kind: "text", message: "Worker name" });
    expect(h.questions[4]).toContain(`│  ${LAPTOP}\n`);
    expect(before).toBe(0);
    expect(stderr).toContain(`◇  Worker name · ${LAPTOP}\n`);
    expect(stderr).not.toContain("already has a worker named");
    expect(enrollments(h)).toHaveLength(1);
    expect(enrollments(h)[0]!.body).toEqual({ label: LAPTOP, install_id: ANY_INSTALL_ID });
    expect((await enrollArgs(h))[0]!.slice(-2)).toEqual(["--host-id", LAPTOP]);
    expect(log).toContain(`Suggested worker name ${LAPTOP}: this host's name.`);
    expect(step(body, "enroll")).toMatchObject({ status: "done", host_id: LAPTOP });
  });

  // AC-315b0c1692aa: a live worker holding this host's name, in any case, makes the suggestion the
  // next free name.
  it("suggests the next free name when a live worker holds this host's name in another case", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: [...ANSWERS, ""],
      state: { others: [otherInstall(LAPTOP.toUpperCase())] },
    });

    const { code, log } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(h.prompts[4]).toMatchObject({ kind: "text", message: "Worker name" });
    expect(h.questions[4]).toContain(`│  ${LAPTOP}-2\n`);
    expect(enrollments(h)[0]!.body).toEqual({ label: `${LAPTOP}-2`, install_id: ANY_INSTALL_ID });
    expect(log).toContain(`Suggested worker name ${LAPTOP}-2:`);
  });

  // AC-315b0c1692aa: the credential names a worker the Account lists as removed: its name is the
  // suggestion, not this host's name.
  it("suggests the removed worker's own name when this machine's credential names it", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: [...ANSWERS, "", ""],
      state: { enrolled: true, revoked: true },
    });
    await writeWorkerEnv(h.ctx.homeDir, credential(SERVER, "old-box", REVOKED_CREDENTIAL));

    const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(h.prompts[4]).toMatchObject({ kind: "confirm" });
    expect(h.prompts[5]).toMatchObject({ kind: "text", message: "Worker name" });
    expect(h.questions[5]).toContain("│  old-box\n");
    expect(enrollments(h)[0]!.body).toEqual({ label: "old-box", install_id: ANY_INSTALL_ID });
    expect((await enrollArgs(h))[0]!.slice(-2)).toEqual(["--host-id", "old-box"]);
    expect(log).toContain("Suggested worker name old-box: this machine's removed worker's name.");
  });

  // AC-3be7f35ed28d: an edited name is the enrollment's label and the worker's host id.
  it("enrolls under a typed name: the enrollment's --label and the worker's --host-id", async () => {
    const h = await harness({ hostName: LAPTOP, answers: [...ANSWERS, "  studio  "] });

    const { code, body, log } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions[4]).toContain(`│  ${LAPTOP}\n`);
    expect(enrollments(h)).toHaveLength(1);
    expect(enrollments(h)[0]!.body).toEqual({ label: "studio", install_id: ANY_INSTALL_ID });
    expect((await enrollArgs(h))[0]!.slice(-2)).toEqual(["--host-id", "studio"]);
    expect(log).toContain("$ pidgen worker enroll --label studio -- --host-id studio");
    expect(step(body, "enroll")).toMatchObject({
      host_id: "studio",
      command:
        "pidgen worker enroll --label studio -- --host-id studio && pidgen worker start --detach",
    });
  });

  it("the name question refuses an empty name, one over 100 characters and a live worker's name in any case", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: [...ANSWERS, "   ", "x".repeat(101), "BUILD-BOX", "studio"],
      state: { others: [otherInstall("build-box")] },
    });

    const { code } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions).toHaveLength(8);
    expect(h.questions[5]).toContain("▲  Enter a name for this worker.");
    expect(h.questions[6]).toContain("at most 100 characters");
    expect(h.questions[7]).toContain("▲  BUILD-BOX is taken");
    expect(enrollments(h)[0]!.body).toEqual({ label: "studio", install_id: ANY_INSTALL_ID });
  });

  // AC-912e7fb02a03: the server refuses the name (409 WORKER_NAME_TAKEN): nothing was created, so
  // setup asks again with the server's suggested name filled in and enrolls under the answer.
  it("asks again with the server's suggested name when the enrollment is refused with WORKER_NAME_TAKEN", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: [...ANSWERS, "", ""],
      state: { takenNames: { [LAPTOP]: `${LAPTOP}-7` } },
    });

    const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    const line = `│\n▲  ${LAPTOP} is taken in Pidgen, so this worker needs another name.\n`;
    expect(stderr).toContain(line);
    expect(stderr).not.toContain("■");
    expect(h.questions).toHaveLength(6);
    expect(h.prompts[5]).toMatchObject({ kind: "text", message: "Worker name" });
    expect(h.questions[5]).toContain(`│  ${LAPTOP}-7\n`);
    order(stderr, line, `◇  Worker name · ${LAPTOP}-7\n`, `Enrolled as ${LAPTOP}-7 in Example`);
    expect(enrollments(h).map((request) => request.body)).toEqual([
      { label: LAPTOP, install_id: ANY_INSTALL_ID },
      { label: `${LAPTOP}-7`, install_id: ANY_INSTALL_ID },
    ]);
    // The refused name created no enrollment, so pidgen-worker ran once, under the new name.
    expect((await enrollArgs(h)).map((args) => args.at(-1))).toEqual([`${LAPTOP}-7`]);
    expect(log).toContain(
      `${LAPTOP} is taken in Pidgen (HTTP 409 WORKER_NAME_TAKEN): no enrollment was created; Pidgen suggests ${LAPTOP}-7.`,
    );
    expect(h.started.value).toBe(true);
    expect(step(body, "enroll")).toMatchObject({ status: "done", host_id: `${LAPTOP}-7` });
  });

  it("the question asked again after WORKER_NAME_TAKEN refuses the refused name", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: [...ANSWERS, "", LAPTOP.toUpperCase(), "studio"],
      state: { takenNames: { [LAPTOP]: `${LAPTOP}-7` } },
    });

    const { code } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions).toHaveLength(7);
    expect(h.questions[6]).toContain(`▲  ${LAPTOP.toUpperCase()} is taken in Pidgen`);
    expect(enrollments(h).at(-1)!.body).toEqual({ label: "studio", install_id: ANY_INSTALL_ID });
  });

  // AC-c41e956cfcf0: --label never prompts: a free one enrolls at once.
  it("a free --label never asks the name question", async () => {
    const h = await harness({ hostName: LAPTOP, answers: ANSWERS });

    const { code } = await h.run("setup", "--url", SERVER, "--label", "studio");

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions).toHaveLength(4);
    expect(h.prompts.some((prompt) => prompt.message === "Worker name")).toBe(false);
    expect(enrollments(h)[0]!.body).toEqual({ label: "studio", install_id: ANY_INSTALL_ID });
  });

  // AC-c41e956cfcf0, AC-912e7fb02a03: a --label the server refuses stops setup, exit 5, with the
  // server's suggested name in the fix; nothing is asked or started.
  it("--label refused with WORKER_NAME_TAKEN stops at the enroll step, exit 5, naming the server's suggestion", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: ANSWERS,
      state: { takenNames: { studio: "studio-4" } },
    });

    const { code, body, stderr } = await h.run("setup", "--url", SERVER, "--label", "studio");

    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "WORKER_NAME_TAKEN",
      details: {
        step: "enroll",
        display_name: "studio",
        suggested_name: "studio-4",
        fix: expect.stringContaining("`pidgen setup --label studio-4`"),
      },
    });
    expect(h.questions).toHaveLength(4);
    expect(enrollments(h)).toHaveLength(1);
    expect(await enrollArgs(h)).toEqual([]);
    expect(h.started.value).toBe(false);
    expect(stderr.match(/■ {2}/g)).toHaveLength(1);
    expect(stderr).toMatch(/■ {2}studio is taken in Pidgen/);
    expect(stderr).toContain("pidgen setup --label studio-4");
  });
});

// AC-d5cd762a88e7, AC-111e49710df5: setup recognises this install's worker by the install id it
// keeps in the worker home, even when the credential file is gone.
describe("pidgen setup and this install's id", () => {
  const ANSWERS = ["", "", "", ""];
  const LAPTOP = "sams-laptop";
  const ID = "0123456789abcdef0123456789abcdef";
  const OTHER_ID = "fedcba9876543210fedcba9876543210";
  const otherInstall = (hostId: string) =>
    workerResource(true, { host_id: hostId, created_at: "2026-09-20T09:00:00Z" });
  const workerReads = (h: Harness) =>
    h.requests.filter((request) => request.method === "GET" && request.url.endsWith("/workers"))
      .length;
  const enrollArgs = async (h: Harness) =>
    (await h.workerLog()).filter((args) => args[0] === "enroll");

  it("creates the install id on a fresh machine and sends it with the enrollment", async () => {
    const h = await harness({ hostName: LAPTOP, answers: ANSWERS });

    const { code } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    const text = await readFile(join(h.ctx.homeDir, ".pidgen", "install-id"), "utf8");
    expect(text).toMatch(/^[0-9a-f]{32}\n$/);
    expect(enrollments(h).map((request) => request.body)).toEqual([
      { label: LAPTOP, install_id: text.trim() },
    ]);
  });

  it("names this install's live worker whose credential is missing, asks to replace it, and once it is listed removed enrolls under its name", async () => {
    const mine = workerResource(true, {
      host_id: "build-box",
      install_id: ID,
      created_at: "2026-09-20T09:00:00Z",
    });
    let atQuestion: number | null = null;
    let readsAtRemoval = 0;
    const h = await harness({
      hostName: LAPTOP,
      answers: [
        ...ANSWERS,
        () => {
          atQuestion = enrollments(h).length;
          return "y";
        },
        // Not removed yet: setup reads the list again, says so, and asks again.
        "y",
        () => {
          mine.revoked_at = "2026-09-28T10:00:00Z";
          mine.connected = false;
          readsAtRemoval = workerReads(h);
          return "y";
        },
      ],
      state: { others: [mine, otherInstall(LAPTOP)] },
    });
    await writeInstallId(h.ctx.homeDir, ID);

    const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(stderr).toContain(
      "This install's worker build-box is still listed but its credential is missing.",
    );
    expect(h.prompts[4]).toMatchObject({ kind: "confirm", message: "Replace build-box?" });
    // Nothing was enrolled beside the live worker while the person decided.
    expect(atQuestion).toBe(0);
    expect(stderr).toContain("Remove build-box on the Workers page");
    expect(h.prompts[5]).toMatchObject({
      kind: "confirm",
      message: "Removed build-box on the Workers page?",
    });
    expect(stderr).toContain("build-box is still listed live in Example");
    expect(h.prompts[6]).toMatchObject({ kind: "confirm" });
    expect(workerReads(h)).toBeGreaterThan(readsAtRemoval);
    expect(h.prompts[7]).toMatchObject({ kind: "text", message: "Worker name" });
    expect(h.questions[7]).toContain("│  build-box\n");
    expect(enrollments(h).map((request) => request.body)).toEqual([
      { label: "build-box", install_id: ID },
    ]);
    expect((await enrollArgs(h))[0]!.slice(-2)).toEqual(["--host-id", "build-box"]);
    expect(log).toContain("build-box is listed as removed");
    expect(step(body, "enroll")).toMatchObject({ host_id: "build-box", connected: true });
  });

  it("declining to replace this install's live worker suggests a new name", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: [...ANSWERS, "n", ""],
      state: {
        others: [workerResource(true, { host_id: "build-box", install_id: ID })],
      },
    });
    await writeInstallId(h.ctx.homeDir, ID);

    const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(h.prompts[4]).toMatchObject({ kind: "confirm", message: "Replace build-box?" });
    expect(h.prompts[5]).toMatchObject({ kind: "text", message: "Worker name" });
    expect(h.questions[5]).toContain("│  build-box-2\n");
    expect(stderr).not.toContain("It isn't this install");
    expect(log).toContain("Suggested worker name build-box-2:");
    expect(enrollments(h).map((request) => request.body)).toEqual([
      { label: "build-box-2", install_id: ID },
    ]);
  });

  it("with this install's worker listed removed, suggests its name: the newest one's", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: [...ANSWERS, ""],
      state: {
        others: [
          workerResource(false, {
            host_id: "box-a",
            install_id: ID,
            created_at: "2026-09-01T09:00:00Z",
            revoked_at: "2026-09-02T09:00:00Z",
          }),
          workerResource(false, {
            host_id: "box-b",
            install_id: ID,
            created_at: "2026-09-20T09:00:00Z",
            revoked_at: "2026-09-21T09:00:00Z",
          }),
          workerResource(true, { host_id: "box-c", install_id: OTHER_ID }),
        ],
      },
    });
    await writeInstallId(h.ctx.homeDir, ID);

    const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(h.prompts.slice(4).filter((prompt) => prompt.kind === "confirm")).toHaveLength(0);
    expect(h.prompts[4]).toMatchObject({ kind: "text", message: "Worker name" });
    expect(h.questions[4]).toContain("│  box-b\n");
    expect(log).toContain("Suggested worker name box-b: this install's removed worker's name.");
    expect(enrollments(h).map((request) => request.body)).toEqual([
      { label: "box-b", install_id: ID },
    ]);
  });

  it("another install's worker under this host's name is still not this install's", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: [...ANSWERS, ""],
      state: { others: [workerResource(true, { host_id: LAPTOP, install_id: OTHER_ID })] },
    });
    await writeInstallId(h.ctx.homeDir, ID);

    const { code, stderr } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(stderr).toContain("It isn't this install");
    expect(h.prompts.some((prompt) => prompt.message.startsWith("Replace"))).toBe(false);
    expect(h.questions[4]).toContain(`│  ${LAPTOP}-2\n`);
  });

  it("an invalid install-id is left alone with a note, and the enrollment carries no id", async () => {
    const h = await harness({ hostName: LAPTOP, answers: ANSWERS });
    await mkdir(join(h.ctx.homeDir, ".pidgen"), { recursive: true });
    const file = join(h.ctx.homeDir, ".pidgen", "install-id");
    await writeFile(file, "not an id\n");

    const { code, log } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(await readFile(file, "utf8")).toBe("not an id\n");
    expect(log).toContain("is not an install id");
    expect(enrollments(h).map((request) => request.body)).toEqual([{ label: LAPTOP }]);
  });
});

// AC-b25f2e3c4fcc: a run that fails after creating an enrollment withdraws it before exiting.
describe("pidgen setup withdraws an enrollment it cannot use", () => {
  const ANSWERS = ["", "", "", ""];
  const WITHDRAW = "/api/v1/workers/enrollments/enr-example-1";

  it("pidgen-worker enroll fails: DELETE the enrollment, then ENROLL_FAILED, exit 1, saying it was withdrawn", async () => {
    const h = await harness({ answers: ANSWERS, env: { FAKE_FAIL_ENROLL_RUN: "1" } });

    const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error).toMatchObject({
      code: "ENROLL_FAILED",
      details: {
        step: "enroll",
        exit_code: 1,
        withdrawn: true,
        fix: expect.stringContaining("was withdrawn"),
      },
    });
    expect(enrollments(h)).toHaveLength(1);
    expect(withdrawals(h)).toEqual([WITHDRAW]);
    expect(stderr).toContain("was withdrawn");
    expect(log).toContain("Withdrew the enrollment enr-example-1");
    expect(h.started.value).toBe(false);
    expect(log).not.toContain(ENROLL_TOKEN);
  });

  it("a failed withdraw is a note: ENROLL_FAILED, exit 1, and the enrollment expires on its own", async () => {
    const h = await harness({
      answers: ANSWERS,
      env: { FAKE_FAIL_ENROLL_RUN: "1" },
      state: { withdrawRefusal: () => refusal(500, "INTERNAL_ERROR", "Something went wrong.") },
    });

    const { code, body, log } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error).toMatchObject({
      code: "ENROLL_FAILED",
      details: {
        withdrawn: false,
        withdraw_error: { code: "INTERNAL_ERROR" },
        fix: expect.stringContaining("expires on its own"),
      },
    });
    expect(withdrawals(h)).toEqual([WITHDRAW]);
    expect(log).toContain("Could not withdraw the enrollment enr-example-1");
  });

  it("a completed setup withdraws nothing", async () => {
    const h = await harness({ answers: ANSWERS });

    const { code } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(withdrawals(h)).toEqual([]);
  });
});

describe("pidgen setup and the worker it installed", () => {
  const ANSWERS = ["", "", "", ""];

  /** The installed worker is the fake worker script; nothing names it in PIDGEN_WORKER_BIN. */
  async function recordedWorker(h: Harness): Promise<void> {
    const source = join(h.directory, "worker-source");
    await writeFile(source, WORKER_SCRIPT, { mode: 0o755 });
    h.ctx.env["FAKE_UV_WORKER"] = source;
    delete h.ctx.env["PIDGEN_WORKER_BIN"];
    const inner = h.ctx.workerRuntime;
    h.ctx.workerRuntime = {
      ...inner,
      spawn: (command, args, options) => {
        if (command === h.workerBin && options.detached === true) h.started.value = true;
        return inner.spawn(command, args, options);
      },
    };
  }

  // home-lookup: setup runs the worker the install record names, not one first on PATH.
  it("runs the worker it installed, not another pidgen-worker first on PATH", async () => {
    const h = await harness({ answers: ANSWERS });
    await recordedWorker(h);
    const decoy = join(h.pathDir, "pidgen-worker");
    await writeFile(decoy, "#!/bin/sh\nexit 3\n", { mode: 0o755 });

    const { code, stderr } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    const workers = h.spawns.filter((spawn) => spawn.command.endsWith("pidgen-worker"));
    expect(workers.length).toBeGreaterThan(0);
    for (const spawn of workers) expect(spawn.command).toBe(h.workerBin);
    expect(h.started.value).toBe(true);
    expect((await h.workerLog()).map((args) => args[0])).toEqual(
      expect.arrayContaining(["enroll", "doctor"]),
    );
    expect(stderr).not.toContain("Another pidgen-worker");
  });

  // home-warn: uv's shared slot holds a pidgen-worker the install record does not name.
  it("leaves another pidgen-worker in uv's shared tool slot alone and says so in one warning line", async () => {
    const h = await harness({ answers: ANSWERS });
    await recordedWorker(h);
    const other = join(h.sharedBinDir, "pidgen-worker");
    const otherScript = "#!/bin/sh\n# installed from pidgen_worker-2.10.0-py3-none-any.whl\n";
    await mkdir(h.sharedBinDir, { recursive: true });
    await writeFile(other, otherScript, { mode: 0o755 });

    const { code, stderr } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    const warnings = stderr.split("\n").filter((line) => line.includes("Another pidgen-worker"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^▲ {2}Another pidgen-worker 2\.10\.0 is installed with uv\b.*leaves that one alone\.$/,
    );
    expect(await readFile(other, "utf8")).toBe(otherScript);
    expect((await h.uvRuns()).filter((run) => run.args[1] === "uninstall")).toEqual([]);
    const install = (await h.uvRuns()).find((run) => run.args[1] === "install")!;
    expect(install.env?.UV_TOOL_BIN_DIR).toBe(join(h.pidgenHome, "worker", "bin"));
  });
});

describe("pidgen setup coding agents", () => {
  const CLAUDE_INSTALL = "npm install -g @anthropic-ai/claude-code";
  const CODEX_INSTALL = "npm install -g @openai/codex";
  /** What the fake agents ran, without npm. */
  const agentArgs = async (h: Harness) =>
    (await h.agentRuns())
      .filter((run) => run.command !== "npm")
      .map((run) => [run.command, ...run.args].join(" "));

  // c2-choose: Claude Code and Codex offered, those on PATH pre-ticked.
  it("offers Claude Code and Codex with the ones found on PATH pre-ticked", async () => {
    const h = await harness({ agents: { claude: { signedIn: true } }, answers: ["", "", ""] });

    const { code, body } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    const question = h.questions[0]!;
    expect(question).toContain("│  ◼ Claude Code   on this machine");
    expect(question).toContain("│  ◻ Codex         not installed · setup installs it with npm");
    expect(question).not.toContain("Pi");
    expect(step(body, "agents")).toMatchObject({ status: "done", agents: ["claude"] });
    expect((await h.agentRuns()).some((run) => run.command === "npm")).toBe(false);
  });

  it("picks the coding agents by ticking them", async () => {
    const h = await harness({
      agents: { claude: { signedIn: true }, codex: { signedIn: true } },
      answers: ["codex", "", ""],
    });

    const { code, body } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions[0]).toContain("│  ◼ Claude Code   on this machine");
    expect(h.questions[0]).toContain("│  ◼ Codex         on this machine");
    expect(step(body, "agents")["agents"]).toEqual(["codex"]);
    expect(await agentArgs(h)).toEqual(["codex login status"]);
  });

  it("shows Pi when it is on PATH, disabled, and neither installs it nor signs in to it", async () => {
    const h = await harness({
      agents: { claude: { signedIn: true } },
      commands: ["pi"],
      answers: ["", "", ""],
    });

    const { code, stderr } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions[0]).toContain(
      "│  ◻ Pi            on this machine · the worker runs it; setup doesn't manage it",
    );
    expect(h.prompts[0]!.options.find((option) => option.value === "pi")).toMatchObject({
      disabled: true,
    });
    expect(stderr).not.toContain("pidgen worker login pi");
  });

  // c2-choose: --agent answers the question in advance.
  it("asks nothing about coding agents with --agent claude --agent codex", async () => {
    const h = await harness({
      agents: { claude: { signedIn: true }, codex: { signedIn: true } },
      answers: ["", "", ""],
    });

    const { code, body, stderr } = await h.run(
      "setup",
      "--url",
      SERVER,
      "--agent",
      "claude",
      "--agent",
      "codex",
    );

    expect(code).toBe(ExitCode.Ok);
    // Only each agent's sessions, the install, then the worker's name.
    expect(h.questions).toHaveLength(4);
    expect(h.questions.some((question) => /Which coding agents/.test(question))).toBe(false);
    expect(h.questions[2]).toMatch(/Install pidgen-worker/);
    expect(stderr).toContain("◇  Coding agents · Claude Code, Codex (from --agent)\n");
    expect(step(body, "agents")).toMatchObject({ status: "done", agents: ["claude", "codex"] });
  });

  it("refuses an --agent it does not know before asking anything", async () => {
    const h = await harness({ answers: [] });

    const { code, body } = await h.run("setup", "--url", SERVER, "--agent", "gemini");

    expect(code).toBe(ExitCode.Usage);
    expect(body.error!.code).toBe("CLI_USAGE");
    expect(h.requests).toEqual([]);
  });

  // c2-choose: with no coding agent on this machine nothing is ticked, and the check step passes.
  it("with no coding agent on this machine, nothing is ticked and choosing one is required", async () => {
    const h = await harness({ agents: {}, answers: ["", CANCEL] });

    const { code, body, log } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Usage);
    expect(h.questions[0]).toContain(
      "│  ◻ Claude Code   not installed · setup installs it with npm",
    );
    expect(h.questions[1]).toContain("▲  Choose at least one.");
    expect(body.error).toMatchObject({ code: "SETUP_CANCELLED", details: { step: "agents" } });
    // A machine with no coding agent passes the check step: choosing one fixes that.
    expect(step(body, "check").status).toBe("done");
    expect(log).toMatch(/choosing coding agents fixes this/);
  });

  // c2-install: a chosen agent missing from PATH is installed, then signed in.
  it("installs a chosen agent that is missing without asking again, signs in to it and reaches capacity", async () => {
    const h = await harness({ agents: {}, npm: true, answers: ["", "", ""] });

    const { code, body, stderr, log } = await h.run("setup", "--url", SERVER, "--agent", "codex");

    expect(code).toBe(ExitCode.Ok);
    expect(h.prompts.map((prompt) => prompt.message)).toEqual([
      "Codex needs you to sign in. Its own sign-in runs here; setup continues after it.",
      "Codex: how many sessions should run at once?",
      "Install pidgen-worker 1.0.0 and accept its licence?",
      "Worker name",
    ]);
    expect(log).toContain(`$ ${CODEX_INSTALL}`);
    const npm = h.spawns.filter((spawn) => spawn.command === "npm");
    expect(npm.map((spawn) => spawn.args)).toEqual([["install", "-g", "@openai/codex"]]);
    expect(npm[0]!.options.shell).toBeFalsy();
    expect(step(body, "agents")).toMatchObject({ status: "done", installed: ["codex"] });
    // The new agent is not signed in: the login runs, then the step after it is reached.
    expect(log).toContain("$ pidgen worker login codex");
    expect(stderr).toContain("◇  Codex · signing in\n");
    expect(await agentArgs(h)).toEqual([
      "codex login status",
      "codex login --device-auth",
      "codex login status",
    ]);
    expect(step(body, "agent-login")).toMatchObject({ status: "done", logins: { codex: "ready" } });
    expect(step(body, "capacity")).toBeDefined();
  });

  it("an EACCES install prints the command to run, and re-checks PATH after the person confirms", async () => {
    const h = await harness({
      agents: {},
      npm: true,
      env: { FAKE_NPM_EACCES: "1" },
      answers: [
        // The person runs the command themselves before confirming.
        async () => {
          await writeExecutable(join(h.pathDir, "claude"), fakeAgent("claude"));
          return "y";
        },
        "",
        "",
        "",
      ],
    });

    const { code, body, stderr } = await h.run("setup", "--url", SERVER, "--agent", "claude");

    expect(code).toBe(ExitCode.Ok);
    expect(stderr).toMatch(/EACCES/);
    const told = stderr.slice(stderr.indexOf("npm error code EACCES"));
    expect(told).toContain(`  ${CLAUDE_INSTALL}`);
    expect(h.prompts[0]).toMatchObject({
      kind: "confirm",
      message: `Has \`${CLAUDE_INSTALL}\` finished?`,
    });
    expect(h.spawns.filter((spawn) => spawn.command === "npm")).toHaveLength(1);
    expect(step(body, "agents")).toMatchObject({ status: "done", installed: ["claude"] });
  });

  it("an EACCES install that the person did not finish fails with the command as its fix", async () => {
    const h = await harness({
      agents: {},
      npm: true,
      env: { FAKE_NPM_EACCES: "1" },
      answers: ["n"],
    });

    const { code, body } = await h.run("setup", "--url", SERVER, "--agent", "claude");

    expect(code).toBe(ExitCode.Usage);
    expect(body.error).toMatchObject({
      code: "AGENT_NOT_FOUND",
      details: { step: "agents", fix: expect.stringContaining(CLAUDE_INSTALL) },
    });
  });

  // c2-install: an npm install that fails stops the agents step with the install command as its fix.
  it("an npm install that fails stops the agents step with the install command as its fix", async () => {
    const h = await harness({ agents: {}, npm: true, env: { FAKE_NPM_FAIL: "1" }, answers: [] });

    const { code, body } = await h.run("setup", "--url", SERVER, "--agent", "claude");

    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error).toMatchObject({
      code: "INSTALL_FAILED",
      details: { step: "agents", fix: expect.stringContaining(CLAUDE_INSTALL) },
    });
    expect(body.error!.message).toMatch(/continue from here\.$/);
  });

  // c2-login-step: status first for each chosen agent; the login only for those not ready.
  it("checks every chosen agent's status first and signs in only to those not signed in", async () => {
    const h = await harness({
      agents: { claude: { signedIn: true }, codex: {} },
      answers: ["", "", "", ""],
    });

    const { code, body, stderr, log } = await h.run(
      "setup",
      "--url",
      SERVER,
      "--agent",
      "claude",
      "--agent",
      "codex",
    );

    expect(code).toBe(ExitCode.Ok);
    expect(await agentArgs(h)).toEqual([
      "claude auth status",
      "codex login status",
      "codex login --device-auth",
      "codex login status",
    ]);
    expect(stderr).toContain("│\n◇  Claude Code signed in\n");
    expect(stderr).toContain("│\n◇  Codex signed in\n");
    expect(log).toContain("$ pidgen worker login codex");
    expect(log).not.toContain("$ pidgen worker login claude");
    expect(step(body, "agent-login")).toMatchObject({
      status: "done",
      command: "pidgen worker login claude && pidgen worker login codex",
      logins: { claude: "ready", codex: "ready" },
    });
    // Codex's sign-in, each agent's sessions, the install, and the worker's name.
    expect(h.questions).toHaveLength(5);
    expect(h.questions[0]).toBe(
      [
        "│",
        "◆  Codex needs you to sign in. Its own sign-in runs here; setup continues after it.",
        "│  Press Enter to start",
        "└",
      ].join("\n"),
    );
  });

  it("skips the agent-login step when every chosen agent is signed in", async () => {
    const h = await harness({
      agents: { claude: { signedIn: true }, codex: { signedIn: true } },
      answers: ["", "", "", ""],
    });

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(await agentArgs(h)).toEqual(["claude auth status", "codex login status"]);
    expect(stderr).toContain("│\n◇  Claude Code signed in\n");
    expect(stderr).toContain("│\n◇  Codex signed in\n");
    expect(step(body, "agent-login").status).toBe("skipped");
  });

  it("a login that does not sign the agent in fails step 4", async () => {
    const h = await harness({ agents: { codex: { loginFails: true } }, answers: [""] });

    const { code, body } = await h.run("setup", "--url", SERVER, "--agent", "codex");

    expect(code).toBe(ExitCode.Auth);
    expect(body.error).toMatchObject({
      code: "AGENT_NOT_SIGNED_IN",
      details: { step: "agent-login", command: "pidgen worker login codex" },
    });
    expect(body.error!.message).toContain("Sign in to coding agents");
    expect(body.error!.message).toMatch(/continue from here\.$/);
  });
});

describe("pidgen setup capacity", () => {
  /** The `capacity set` argument lists the fake worker was run with, in order. */
  const capacityRuns = async (h: Harness) =>
    (await h.workerLog()).filter((args) => args[0] === "capacity");

  // c3-question: each answer is the agent's concurrent-session cap, which setup prints.
  it.each([
    ["claude", "", 1],
    ["claude", "2", 2],
    ["claude", "4", 4],
    ["codex", "", 1],
    ["codex", "2", 2],
    ["codex", "3", 3],
  ] as const)("asks the %s sessions: answer %j is cap %i", async (kind, answer, cap) => {
    const h = await harness({ agents: { [kind]: { signedIn: true } }, answers: [answer, ""] });

    const { code, body, stderr } = await h.run("setup", "--url", SERVER, "--agent", kind);

    expect(code).toBe(ExitCode.Ok);
    // The sessions, the install, then the worker's name.
    expect(h.questions).toHaveLength(3);
    const name = kind === "claude" ? "Claude Code" : "Codex";
    expect(h.prompts[0]).toMatchObject({
      kind: "select",
      message: `${name}: how many sessions should run at once?`,
    });
    expect(h.questions[1]).toMatch(/Install pidgen-worker/);
    expect(stderr).toContain(`◇  ${name} · ${cap} session${cap === 1 ? "" : "s"} at a time\n`);
    expect(step(body, "capacity")).toMatchObject({ status: "done", caps: { [kind]: cap } });
  });

  it("asks each chosen agent's sessions in turn", async () => {
    const h = await harness({
      agents: { claude: { signedIn: true }, codex: { signedIn: true } },
      answers: ["", "4", "3", ""],
    });

    const { code, body } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions[1]).toMatch(/Claude Code: how many sessions/);
    expect(h.questions[2]).toMatch(/Codex: how many sessions/);
    expect(step(body, "capacity")).toMatchObject({
      status: "done",
      plans: {},
      caps: { claude: 4, codex: 3 },
    });
  });

  // c3-question: --plan answers the question in advance.
  it("--plan claude=max-5x answers the plan question without asking", async () => {
    const h = await harness({ agents: { claude: { signedIn: true } }, answers: [""] });

    const { code, body, stderr } = await h.run(
      "setup",
      "--url",
      SERVER,
      "--agent",
      "claude",
      "--plan",
      "claude=max-5x",
    );

    expect(code).toBe(ExitCode.Ok);
    // The install, then the worker's name.
    expect(h.questions).toHaveLength(2);
    expect(h.questions[0]).toMatch(/Install pidgen-worker/);
    expect(stderr).toContain("◇  Claude Code · 2 sessions at a time (from --plan)");
    expect(step(body, "capacity")).toMatchObject({
      status: "done",
      plans: { claude: "max-5x" },
      caps: { claude: 2 },
    });
  });

  it("refuses a --plan it does not know before asking anything", async () => {
    for (const plan of ["claude=plus", "gemini=pro", "claude", "codex=max-5x", "claude="]) {
      const h = await harness({ answers: [] });
      const { code, body } = await h.run("setup", "--url", SERVER, "--plan", plan);
      expect(code, plan).toBe(ExitCode.Usage);
      expect(body.error!.code).toBe("CLI_USAGE");
      expect(body.error!.message).toContain("--plan");
      expect(h.requests).toEqual([]);
      expect(h.questions).toEqual([]);
    }
  });

  // c3-apply: after enrollment, each chosen agent's cap, the others off, and the prompt pool.
  it("applies the caps after enrollment: the chosen agents, the others off, and the prompt pool", async () => {
    const h = await harness({
      agents: { claude: { signedIn: true }, codex: { signedIn: true } },
      answers: [""],
    });

    const { code, body, log } = await h.run(
      "setup",
      "--url",
      SERVER,
      "--agent",
      "claude",
      "--agent",
      "codex",
      "--plan",
      "claude=max-20x",
      "--plan",
      "codex=pro",
    );

    expect(code).toBe(ExitCode.Ok);
    const runs = (await h.workerLog()).map((args) => args.join(" "));
    const capacity = runs.filter((run) => run.startsWith("capacity "));
    expect(capacity).toEqual([
      "capacity set claude --max 4",
      "capacity set codex --max 3",
      "capacity set pi --max 0",
      "capacity set prompts --min 1 --max 7",
    ]);
    // After pidgen-worker enroll, inside the enroll step.
    expect(runs.indexOf("capacity set claude --max 4")).toBeGreaterThan(
      runs.findIndex((run) => run.startsWith("enroll ")),
    );
    const [enrollStep, command, prove] = order(
      log,
      "$ pidgen worker enroll",
      "pidgen-worker capacity set claude --max 4",
      "$ pidgen worker doctor",
    );
    expect(command).toBeGreaterThan(enrollStep!);
    expect(command).toBeLessThan(prove!);
    expect(log).toContain("pidgen-worker capacity set prompts --min 1 --max 7");
    expect(step(body, "enroll")["capacity"]).toEqual({ claude: 4, codex: 3, pi: 0, prompts: 7 });
  });

  it("switches off each known agent not chosen", async () => {
    const h = await harness({ agents: { codex: { signedIn: true } }, answers: ["", ""] });

    const { code } = await h.run("setup", "--url", SERVER, "--agent", "codex");

    expect(code).toBe(ExitCode.Ok);
    expect((await capacityRuns(h)).map((args) => args.join(" "))).toEqual([
      "capacity set codex --max 1",
      "capacity set claude --max 0",
      "capacity set pi --max 0",
      "capacity set prompts --min 1 --max 1",
    ]);
  });

  it.each([
    "saved",
    "saved, apply pending",
    "saved; worker is not running; pending",
    "saved\napplied 3f2a rev 4",
    // pidgen-worker 2.11 prints the file's path and digest before the status lines.
    "node.yaml:        /home/dev/.pidgen/config/node.yaml\nfile digest:      9c2e\nsaved\nsaved; manager not running; pending",
    // An edit that changes nothing.
    "node.yaml:        /home/dev/.pidgen/config/node.yaml\nfile digest:      9c2e\nsaved (the named values were already in node.yaml)",
  ])("counts %j from capacity set as success", async (output) => {
    const h = await harness({
      agents: { claude: { signedIn: true } },
      answers: [""],
      env: { FAKE_CAPACITY_OUTPUT: output },
    });

    const { code, body } = await h.run(
      "setup",
      "--url",
      SERVER,
      "--agent",
      "claude",
      "--plan",
      "claude=pro",
    );

    expect(code).toBe(ExitCode.Ok);
    expect(step(body, "enroll").status).toBe("done");
    expect(await capacityRuns(h)).toHaveLength(4);
  });

  // c3-apply: exit 1 fails the enroll step with the command's message.
  it("a refused capacity set fails the enroll step with the command's message", async () => {
    const h = await harness({
      agents: { claude: { signedIn: true } },
      answers: [""],
      env: {
        FAKE_CAPACITY_OUTPUT: "node.yaml: claude.max must be at most 64",
        FAKE_CAPACITY_EXIT: "1",
      },
    });

    const { code, body } = await h.run(
      "setup",
      "--url",
      SERVER,
      "--agent",
      "claude",
      "--plan",
      "claude=pro",
    );

    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error).toMatchObject({
      code: "CAPACITY_REFUSED",
      details: { step: "enroll", command: "pidgen-worker capacity set claude --max 1" },
    });
    expect(body.error!.message).toContain("node.yaml: claude.max must be at most 64");
    expect(body.error!.message).toContain("Enroll and start the worker");
    expect(body.error!.message).toMatch(/continue from here\.$/);
    expect(step(body, "enroll").status).toBe("failed");
    expect(await capacityRuns(h)).toHaveLength(1);
  });

  it("an answer capacity set does not document fails the enroll step", async () => {
    const h = await harness({
      agents: { claude: { signedIn: true } },
      answers: [""],
      env: { FAKE_CAPACITY_OUTPUT: "something else" },
    });

    const { code, body } = await h.run(
      "setup",
      "--url",
      SERVER,
      "--agent",
      "claude",
      "--plan",
      "claude=pro",
    );

    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error).toMatchObject({ code: "CAPACITY_FAILED", details: { step: "enroll" } });
    expect(body.error!.message).toContain("something else");
  });

  // c3-rerun: flags answer everything again, and the caps are applied again.
  it("re-running on an enrolled worker asks nothing the flags answer and applies the caps again", async () => {
    const h = await harness({ agents: { claude: { signedIn: true } }, answers: [""] });
    const flags = ["--agent", "claude", "--plan", "claude=max-20x"];
    expect((await h.run("setup", "--url", SERVER, ...flags)).code).toBe(ExitCode.Ok);
    expect(await capacityRuns(h)).toHaveLength(4);
    h.questions.length = 0;

    const { code, body, log } = await h.run("setup", ...flags);

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions).toEqual([]);
    expect(enrollments(h)).toHaveLength(1);
    expect(log).not.toContain("$ pidgen worker enroll");
    expect(step(body, "capacity").status).toBe("done");
    const runs = (await capacityRuns(h)).map((args) => args.join(" "));
    expect(runs).toHaveLength(8);
    expect(runs.slice(4)).toEqual(runs.slice(0, 4));
    expect(step(body, "enroll")).toMatchObject({ status: "done", capacity: { claude: 4 } });
  });

  it("re-running asks the sessions again when no --sessions or --plan answers it", async () => {
    // The first run's sessions, install and worker's name, then the re-run's sessions.
    const h = await harness({
      agents: { claude: { signedIn: true } },
      answers: ["2", "", "", "4"],
    });
    expect((await h.run("setup", "--url", SERVER, "--agent", "claude")).code).toBe(ExitCode.Ok);
    h.questions.length = 0;

    const { code } = await h.run("setup", "--agent", "claude");

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions).toHaveLength(1);
    expect(h.questions[0]).toMatch(/Claude Code: how many sessions/);
    const runs = (await capacityRuns(h)).map((args) => args.join(" "));
    expect(runs).toContain("capacity set claude --max 2");
    expect(runs.at(-4)).toBe("capacity set claude --max 4");
  });

  // c3-rerun: a re-run that stops before the capacity step does not touch the caps.
  it("a re-run that stops before the capacity step does not apply the caps again", async () => {
    const h = await harness({ agents: { claude: { signedIn: true } }, npm: true, answers: [""] });
    const first = await h.run(
      "setup",
      "--url",
      SERVER,
      "--agent",
      "claude",
      "--plan",
      "claude=pro",
      "--runtime",
      "wheel",
    );
    expect(first.code).toBe(ExitCode.Ok);
    const before = (await capacityRuns(h)).length;

    // Codex is not on this machine and npm fails to install it: setup stops at the agents.
    h.ctx.env["FAKE_NPM_FAIL"] = "1";
    const { code, body } = await h.run("setup", "--agent", "codex", "--plan", "codex=pro");

    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error!.details["step"]).toBe("agents");
    expect(() => step(body, "capacity")).toThrow();
    expect((await capacityRuns(h)).length).toBe(before);
  });

  it("without a terminal lists the capacity commands when --agent and --plan answer them", async () => {
    const h = await harness({ noTerminal: true });

    const { body } = await h.run(
      "setup",
      "--url",
      SERVER,
      "--agent",
      "claude",
      "--plan",
      "claude=max-5x",
    );

    const commands = body.error!.details.commands!;
    const enroll = commands.indexOf(`pidgen worker enroll --label ${HOST} -- --host-id ${HOST}`);
    expect(commands.slice(enroll + 1, enroll + 5)).toEqual([
      "pidgen-worker capacity set claude --max 2",
      "pidgen-worker capacity set codex --max 0",
      "pidgen-worker capacity set pi --max 0",
      "pidgen-worker capacity set prompts --min 1 --max 2",
    ]);
  });
});

// The questions are clack prompts, driven here through the scripted prompter; standard error is
// compared with the screens they draw.
describe("pidgen setup prompts", () => {
  const AGENTS_SCREEN = [
    "│",
    "◆  Which coding agents will this worker run?",
    "│  ◼ Claude Code   on this machine",
    "│  ◻ Codex         not installed · setup installs it with npm",
    "│  ◻ Pi            on this machine · the worker runs it; setup doesn't manage it",
    "│  ↑/↓ move · space select · enter confirm",
    "└",
  ].join("\n");
  const CLAUDE_SESSIONS = (initial: number) =>
    [
      "│",
      "◆  Claude Code: how many sessions should run at once?",
      `│  ${initial === 1 ? "●" : "○"} 1   Pro, or not sure`,
      `│  ${initial === 2 ? "●" : "○"} 2   Max 5x, API key, Team or Enterprise`,
      `│  ${initial === 4 ? "●" : "○"} 4   Max 20x`,
      "│  ○ Custom…",
      "│  Change it later: pidgen-worker capacity set claude --max <n>",
      "└",
    ].join("\n");
  const INSTALL_SCREEN = [
    "│",
    "◆  Install pidgen-worker 1.0.0 and accept its licence?",
    "│  The worker is proprietary software under the Pidgen Worker End-User Licence Agreement.",
    "│  Read it: https://pidgen.ai/legal/eula",
    "│  ● Yes  ○ No",
    "└",
  ].join("\n");
  const asked = (h: Harness, pattern: RegExp) =>
    h.prompts.filter((prompt) => pattern.test(prompt.message));

  // prompts-seam: setup asks through the prompter, in clack's frame, with no step headers.
  it("draws setup in clack's frame: no step headers, each answer collapsed to one ◇ line", async () => {
    const h = await harness({ answers: ["", "", "", ""] });

    const { code, stderr } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(stderr.startsWith("┌  Pidgen setup\n")).toBe(true);
    expect(stderr).not.toMatch(/^Step \d of \d/m);
    expect(stderr).not.toMatch(/^(done|failed|skipped — .*)$/m);
    expect(h.prompts.map((prompt) => prompt.kind)).toEqual([
      "multiselect",
      "select",
      "select",
      "confirm",
      "text",
    ]);
    // What stays on screen is each answer's one line, not the open question.
    for (const line of [
      "│\n◇  Coding agents · Claude Code, Codex\n",
      "│\n◇  Claude Code · 1 session at a time\n",
      "│\n◇  Codex · 1 session at a time\n",
      "│\n◇  Install pidgen-worker 1.0.0 and accept its licence? · Yes\n",
      `│\n◇  Worker name · ${HOST}\n`,
    ])
      expect(stderr).toContain(line);
    // No open question is left on screen; the one ◆ is the sign-in block's.
    expect(stderr.match(/◆.*/g)).toEqual(["◆  Sign in to Pidgen"]);
  });

  // prompts-agents: a multiselect, those on PATH pre-ticked, a missing one labelled, Pi disabled.
  it("asks for coding agents as checkboxes: found ones ticked, a missing one labelled, Pi disabled", async () => {
    const h = await harness({
      agents: { claude: { signedIn: true } },
      npm: true,
      commands: ["pi"],
      answers: ["", "", ""],
    });

    const { code, body } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    const [agents] = asked(h, /coding agents/);
    expect(agents!.kind).toBe("multiselect");
    expect(agents!.screen).toBe(AGENTS_SCREEN);
    expect(agents!.options.map((option) => [option.value, option.disabled ?? false])).toEqual([
      ["claude", false],
      ["codex", false],
      ["pi", true],
    ]);
    expect(step(body, "agents")).toMatchObject({ agents: ["claude"], installed: [] });
  });

  it("ticking a missing agent installs it with npm and asks nothing more about it", async () => {
    const h = await harness({
      agents: { claude: { signedIn: true } },
      npm: true,
      answers: ["claude codex", "", "", "", ""],
    });

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    // The agents, the new agent's own sign-in, each one's sessions, the install and the worker's
    // name: no question about installing Codex.
    expect(h.prompts.map((prompt) => prompt.message)).toEqual([
      "Which coding agents will this worker run?",
      "Codex needs you to sign in. Its own sign-in runs here; setup continues after it.",
      "Claude Code: how many sessions should run at once?",
      "Codex: how many sessions should run at once?",
      "Install pidgen-worker 1.0.0 and accept its licence?",
      "Worker name",
    ]);
    const npm = h.spawns.filter((spawn) => spawn.command === "npm");
    expect(npm.map((spawn) => spawn.args)).toEqual([["install", "-g", "@openai/codex"]]);
    expect(stderr).toContain("◇  Coding agents · Claude Code, Codex");
    expect(step(body, "agents")).toMatchObject({ installed: ["codex"] });
  });

  it('confirming no coding agent keeps the question open with "Choose at least one"', async () => {
    const h = await harness({ answers: ["none", "", "", "", ""] });

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    const agents = asked(h, /coding agents/);
    expect(agents).toHaveLength(2);
    expect(agents[1]!.screen.split("\n").at(-1)).toBe("▲  Choose at least one.");
    expect(stderr).not.toContain("Choose at least one");
    expect(step(body, "agents")["agents"]).toEqual(["claude", "codex"]);
  });

  // prompts-sessions: a select of numbers with plan hints, plus Custom.
  it("asks each agent's sessions as numbers with plan hints, defaulting to the lowest", async () => {
    const h = await harness({ answers: ["", "", "", ""] });

    const { code, body } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    const [claude, codex] = asked(h, /sessions should run at once/);
    expect(claude!.screen).toBe(CLAUDE_SESSIONS(1));
    expect(codex!.screen).toBe(
      [
        "│",
        "◆  Codex: how many sessions should run at once?",
        "│  ● 1   Plus, or not sure",
        "│  ○ 2   Business, Enterprise or API key",
        "│  ○ 3   Pro",
        "│  ○ Custom…",
        "│  Change it later: pidgen-worker capacity set codex --max <n>",
        "└",
      ].join("\n"),
    );
    expect(step(body, "capacity")).toMatchObject({ caps: { claude: 1, codex: 1 } });
  });

  it("takes a chosen number, and Custom takes a whole number from 1, kept open on a bad one", async () => {
    const h = await harness({
      agents: { claude: { signedIn: true }, codex: { signedIn: true } },
      answers: ["", "4", "custom", "0", "2.5", "6", ""],
    });

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    const custom = asked(h, /^Codex sessions at a time$/);
    expect(custom.map((prompt) => prompt.kind)).toEqual(["text", "text", "text"]);
    expect(custom[1]!.screen.split("\n").at(-1)).toBe("▲  Enter a whole number, 1 or more.");
    expect(custom[2]!.screen.split("\n").at(-1)).toBe("▲  Enter a whole number, 1 or more.");
    expect(stderr).toContain("◇  Claude Code · 4 sessions at a time\n");
    expect(stderr).toContain("◇  Codex · 6 sessions at a time\n");
    expect(step(body, "capacity")).toMatchObject({ caps: { claude: 4, codex: 6 } });
    const runs = (await h.workerLog()).map((args) => args.join(" "));
    expect(runs).toContain("capacity set claude --max 4");
    expect(runs).toContain("capacity set codex --max 6");
    expect(runs).toContain("capacity set prompts --min 1 --max 10");
  });

  it("on a re-run the sessions question starts on the worker's current cap", async () => {
    const h = await harness({ agents: { claude: { signedIn: true } }, answers: ["", ""] });
    await mkdir(join(h.pidgenHome, "config"), { recursive: true });
    await writeFile(
      join(h.pidgenHome, "config", "node.yaml"),
      "version: 2\nharnesses:\n  claude: {max: 4}\n  codex: {max: 0}\n",
    );

    const { code, body } = await h.run("setup", "--url", SERVER, "--agent", "claude");

    expect(code).toBe(ExitCode.Ok);
    expect(asked(h, /sessions should run at once/)[0]!.screen).toBe(CLAUDE_SESSIONS(4));
    expect(step(body, "capacity")).toMatchObject({ caps: { claude: 4 } });
  });

  it("--sessions <agent>=<n> answers the sessions question in advance; --plan still does", async () => {
    const h = await harness({ answers: ["", ""] });

    const { code, body, stderr } = await h.run(
      "setup",
      "--url",
      SERVER,
      "--sessions",
      "claude=6",
      "--plan",
      "codex=pro",
    );

    expect(code).toBe(ExitCode.Ok);
    expect(asked(h, /sessions/)).toEqual([]);
    expect(stderr).toContain("◇  Claude Code · 6 sessions at a time (from --sessions)\n");
    expect(stderr).toContain("◇  Codex · 3 sessions at a time (from --plan)\n");
    expect(step(body, "capacity")).toMatchObject({
      caps: { claude: 6, codex: 3 },
      plans: { codex: "pro" },
    });
  });

  it("refuses --sessions and --plan for one agent, and a --sessions it cannot read, before asking", async () => {
    for (const flags of [
      ["--sessions", "claude=2", "--plan", "claude=pro"],
      ["--sessions", "claude=0"],
      ["--sessions", "claude=1.5"],
      ["--sessions", "claude=x"],
      ["--sessions", "claude"],
      ["--sessions", "gemini=2"],
    ]) {
      const h = await harness({ answers: [] });
      const { code, body } = await h.run("setup", "--url", SERVER, ...flags);
      expect(code, flags.join(" ")).toBe(ExitCode.Usage);
      expect(body.error!.code).toBe("CLI_USAGE");
      expect(body.error!.message).toContain("--sessions");
      expect(h.requests).toEqual([]);
      expect(h.questions).toEqual([]);
    }
  });

  // prompts-install: one confirm for the install and the licence; no runtime question.
  // AC-ebdee0ee3b0a: under the question, the licence's name, then its link.
  it("asks one confirm to install the worker and accept its licence, and prints no notice", async () => {
    const h = await harness({ answers: ["", "", "", ""] });

    const { code, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    const [install] = asked(h, /^Install pidgen-worker/);
    expect(install!.kind).toBe("confirm");
    expect(install!.screen).toBe(INSTALL_SCREEN);
    expect(h.questions.some((question) => /runtime/i.test(question))).toBe(false);
    const { eula } = releaseList();
    expect(stderr).not.toContain(eula.notice);
    expect(stderr).not.toContain(eula.location);
    expect(stderr).not.toMatch(/licensed under/);
    expect(log).not.toContain(eula.notice);
    // Asked before the install runs.
    const [confirmed, ran] = order(log, "answer: true", " tool install ");
    expect(log.slice(0, confirmed)).toMatch(
      /question: Install pidgen-worker 1\.0\.0 and accept its licence\?\n {2}The worker is proprietary software under the Pidgen Worker End-User Licence Agreement\.\n {2}Read it: https:\/\/pidgen\.ai\/legal\/eula\n[^\n]*$/,
    );
    expect(confirmed).toBeLessThan(ran!);
  });

  // AC-e29a748a2d92: one answered line on screen and no link; the log records the link with it.
  it("--accept-licence answers the install question in advance", async () => {
    const h = await harness({ answers: ["", "", ""] });

    const { code, stderr, log } = await h.run("setup", "--url", SERVER, "--accept-licence");

    expect(code).toBe(ExitCode.Ok);
    expect(asked(h, /^Install pidgen-worker/)).toEqual([]);
    expect(stderr).toContain(
      "│\n◇  Install pidgen-worker 1.0.0 and accept its licence? · Yes (from --accept-licence)\n│\n",
    );
    expect(stderr).not.toContain("pidgen.ai/legal/eula");
    expect(stderr).not.toContain("Read it");
    expect(log).toContain(
      "◇  Install pidgen-worker 1.0.0 and accept its licence? · Yes (from --accept-licence)\n" +
        "  The worker is proprietary software under the Pidgen Worker End-User Licence Agreement.\n" +
        "  Read it: https://pidgen.ai/legal/eula\n",
    );
    expect(stderr).not.toContain(releaseList().eula.notice);
    expect((await h.uvRuns()).filter((run) => run.args[1] === "install")).toHaveLength(1);
  });

  it("declining the licence stops setup: the worker wasn't installed", async () => {
    const h = await harness({ answers: ["", "", "", "n"] });

    const { code, body } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Usage);
    // root-json: declining is the person stopping setup; no code beyond SETUP_CANCELLED is new.
    expect(body.error).toMatchObject({ code: "SETUP_CANCELLED", details: { step: "install" } });
    expect(body.error!.message).toContain("the worker wasn't installed");
    expect((await h.uvRuns()).filter((run) => run.args[1] === "install")).toEqual([]);
    expect(enrollments(h)).toHaveLength(0);
  });

  // prompts-cancel: Ctrl-C at any prompt stops setup, keeping what was done.
  it.each([
    ["the coding agents", [CANCEL]],
    ["a sessions question", ["", CANCEL]],
    ["the install", ["", "", "", CANCEL]],
  ] as const)("Ctrl-C at %s stops setup with SETUP_CANCELLED, exit 2", async (_at, answers) => {
    const h = await harness({ answers: [...answers] });

    const { code, body, stderr } = await h.run("--format", "json", "setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Usage);
    expect(body.ok).toBe(false);
    expect(body.error!.code).toBe("SETUP_CANCELLED");
    expect(body.error!.message).toBe("Setup cancelled. Everything before this is kept.");
    expect(stderr).toContain(
      "■  Setup cancelled. Everything before this is kept.\n└  Run pidgen setup again to continue.\n",
    );
    expect(stderr.trimEnd().endsWith("└  Run pidgen setup again to continue.")).toBe(true);
    // What was done before is kept: the sign-in.
    expect((await loadConfig(h.ctx)).profiles["default"]?.credentials).toHaveProperty(
      "ACC-EXAMPLE",
    );
    expect(enrollments(h)).toHaveLength(0);
  });

  it("Ctrl-C at the Account question stops setup with SETUP_CANCELLED", async () => {
    const h = await harness({
      answers: [CANCEL],
      state: {
        memberships: [
          { account_id: "ACC-EXAMPLE", account_name: "Example", role: "administrator" },
          { account_id: "ACC-OTHER", account_name: "Other", role: "member" },
        ],
      },
    });

    const { code, body } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Usage);
    expect(body.error!.code).toBe("SETUP_CANCELLED");
    const [account] = h.prompts;
    expect(account!.kind).toBe("select");
    expect(account!.screen).toContain("│  ● Example   Administrator");
    expect(account!.screen).toContain("│  ○ Other     Member · can't enroll workers");
  });
});

describe("pidgen setup output", () => {
  const ANSWERS = ["", "", "", ""];
  /** Standard error's lines that end with `text`. */
  const linesEnding = (stderr: string, text: string) =>
    stderr.split("\n").filter((line) => line.endsWith(text));

  // quiet-log: the log has the run's versions, server, flags, actions, commands and output.
  it("writes a 0600 setup log with the versions, server, flags, each action, every command and its output", async () => {
    const h = await harness({ answers: ANSWERS });

    const { code, log, logPath } = await h.run("setup", "--url", SERVER, "--label", "studio");

    expect(code).toBe(ExitCode.Ok);
    expect(logPath).toMatch(
      /\/\.pidgen\/logs\/setup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d+)?\.log$/,
    );
    expect((await stat(logPath!)).mode & 0o777).toBe(0o600);
    expect(log).toContain(`pidgen CLI ${CLI_VERSION}`);
    expect(log).toContain(`Node.js ${process.versions.node}`);
    expect(log).toContain(`server ${SERVER}`);
    expect(log).toMatch(/^flags .*--url \S+ .*--label studio/m);
    for (const id of STEP_IDS) {
      expect(log).toMatch(new RegExp(`^\\[[^\\]]+\\] ${id} started$`, "m"));
      expect(log).toMatch(new RegExp(`^\\[[^\\]]+\\] ${id} (done|skipped): `, "m"));
    }
    const positions = order(
      log,
      "$ pidgen doctor",
      `$ pidgen auth login ${SERVER}`,
      "$ pidgen worker install --runtime wheel",
      " tool install --python 3.12 ",
      "$ pidgen worker verify",
      "$ pidgen worker enroll --label studio -- --host-id studio",
      "$ pidgen-worker capacity set claude --max 1",
      "$ pidgen worker start --detach",
      "$ pidgen worker doctor",
    );
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // Every command's full output.
    expect(log).toContain("Resolved 45 packages in 320ms");
    expect(log).toMatch(/ok\s+digest/);
    expect(log).toContain("enrolled\n");
  });

  // quiet-log: no token, enrollment token or other credential, even one a command printed.
  it("never writes a token, enrollment token or credential to the log", async () => {
    const h = await harness({ answers: ANSWERS });

    const { code, log } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(log).toContain("$ pidgen worker enroll");
    expect(log).toContain("pidgen-worker enroll --token [redacted]");
    for (const secret of [ENROLL_TOKEN, CLI_TOKEN, "pidgen_node_fake_credential"]) {
      expect(log).not.toContain(secret);
    }
  });

  // quiet-log: an error in full.
  it("logs a failed action's error in full", async () => {
    const h = await harness({ answers: ANSWERS, uvFails: true });

    const { code, body, log } = await h.run("setup", "--url", SERVER);

    expect(code).not.toBe(ExitCode.Ok);
    const inner = body.error!.details["error"] as { code: string; message: string };
    expect(log).toMatch(new RegExp(`^\\[[^\\]]+\\] install failed: ${inner.code}`, "m"));
    expect(log).toContain(inner.message);
    expect(log).toContain("fake uv: install failed");
    expect(log).toContain('"step": "install"');
  });

  // quiet-log: setup keeps the newest ten.
  it("keeps the newest ten setup logs and nothing else in the logs folder is touched", async () => {
    const h = await harness({ answers: ANSWERS });
    const logs = join(h.pidgenHome, "logs");
    await mkdir(logs, { recursive: true });
    const old = Array.from(
      { length: 12 },
      (_, index) => `setup-1969-12-${String(index + 10)}T00-00-00.log`,
    );
    for (const name of old) await writeFile(join(logs, name), "old\n", { mode: 0o600 });
    await writeFile(join(logs, "worker-manager.log"), "worker\n");

    const { code, logPath } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(await setupLogs(h.ctx.homeDir)).toEqual([...old.slice(3), basename(logPath!)]);
    expect(await readFile(join(logs, "worker-manager.log"), "utf8")).toBe("worker\n");
  });

  // quiet-screen: no `$` line and no subprocess output; a spinner, then one ◇ line, per task.
  it("without --verbose shows no command and no subprocess output: each task is a spinner, then one ◇ line", async () => {
    const h = await harness({ answers: ANSWERS });

    const { code, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(stderr).not.toMatch(/^(│ {2})?\$ /m);
    for (const output of [/Resolved 45 packages/, /^enrolled$/m, /^saved$/m, /ok\s+digest/]) {
      expect(log).toMatch(output);
      expect(stderr).not.toMatch(output);
    }
    expect(stderr).not.toContain("pidgen-worker enroll");
    expect(stderr).toContain("│\n◇  pidgen-worker 1.0.0 installed and verified\n");
    expect(stderr).not.toMatch(/sha256:|\.whl/);
    for (const line of [
      `◇  Enrolled as ${HOST} in Example`,
      `◇  Worker running and connected to Pidgen as ${HOST}`,
      "◇  Worker checks passed",
    ])
      expect(stderr).toContain(`│\n${line}\n`);
    expect(h.spinners).toEqual([
      "Checking this machine…",
      "Installing pidgen-worker 1.0.0…",
      "Verifying it was published by Pidgen's release workflow…",
      `Enrolling as ${HOST}…`,
      "Starting the worker…",
      "Waiting for Pidgen to report the worker connected…",
      "Running the worker's checks…",
    ]);
    // The sign-in waits in its own task, which answers keys while it polls.
    expect(h.waits.map((wait) => wait.message)).toEqual([
      "Waiting for you to approve in the browser…",
    ]);
  });

  // quiet-screen: npm's and uv's installer's output stay off the screen too.
  it("installs a missing coding agent under a spinner, npm's output only in the log", async () => {
    const h = await harness({
      agents: { claude: { signedIn: true } },
      npm: true,
      answers: ["claude codex", "", "", "", "", ""],
    });

    const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(h.spinners).toContain("Installing Codex…");
    expect(stderr).toContain("│\n◇  Codex installed\n");
    expect(log).toContain("$ npm install -g @openai/codex");
    expect(log).toContain("added 3 packages in 2s");
    expect(stderr).not.toContain("added 3 packages");
    expect(stderr).not.toMatch(/^(│ {2})?\$ /m);
  });

  // quiet-verbose: each task's commands and their output, kept after success.
  it("with --verbose shows each task's commands and their output under it in a task log, kept after success", async () => {
    const h = await harness({ answers: ANSWERS });

    const { code, stderr } = await h.run("setup", "--url", SERVER, "--verbose");

    expect(code).toBe(ExitCode.Ok);
    const start = stderr.indexOf("│\n◒  Installing pidgen-worker 1.0.0…\n");
    const end = stderr.indexOf("│\n◇  pidgen-worker 1.0.0 installed and verified\n");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = stderr.slice(start, end).split("\n");
    expect(block).toContain("│  $ pidgen worker install --runtime wheel");
    expect(block.some((line) => /^│ {2}\$ \S*uv tool install --python 3\.12 /.test(line))).toBe(
      true,
    );
    expect(block).toContain("│    Resolved 45 packages in 320ms");
    expect(block).toContain("│  $ pidgen worker verify");
    expect(block.some((line) => /^│ {4}ok\s+digest/.test(line))).toBe(true);
    expect(stderr).toMatch(
      new RegExp(`◒  Enrolling as ${HOST.replace(/\./g, "\\.")}…\n│  \\$ pidgen worker enroll `),
    );
    expect(stderr).toContain("│    enrolled\n");
    expect(stderr).toContain("│  $ pidgen worker doctor\n");
    expect(stderr).not.toContain(ENROLL_TOKEN);
  });

  // quiet-tail: the last ten lines of the failing task's own output, once each.
  it("a failing task without --verbose keeps the last ten lines of its output on screen, each once", async () => {
    const h = await harness({
      answers: ANSWERS,
      uvFails: true,
      env: { FAKE_UV_FAIL_LINES: "14" },
    });

    const { code, stderr, logPath } = await h.run("setup", "--url", SERVER);

    expect(code).not.toBe(ExitCode.Ok);
    const lines = stderr.split("\n");
    const failed = lines.indexOf("■  Couldn't install pidgen-worker 1.0.0");
    expect(failed, stderr).toBeGreaterThan(0);
    expect(lines[failed - 1]).toBe("│");
    const tail = [
      ...Array.from({ length: 9 }, (_, index) => `uv output line ${index + 6}`),
      "fake uv: install failed",
    ];
    expect(lines.slice(failed + 1, failed + 11)).toEqual(tail.map((line) => `│  ${line}`));
    // Then the one fix, the setup log, and where a re-run continues.
    expect(lines[failed + 11]).toMatch(/^│ {2}Read uv's output/);
    expect(lines[failed + 12]).toBe(`│  Log: ~/.pidgen/logs/${basename(logPath!)}`);
    expect(lines[failed + 13]).toBe("└  Run pidgen setup again to continue from here.");
    for (const line of tail) expect(linesEnding(stderr, line)).toHaveLength(1);
    for (const n of [1, 5]) expect(linesEnding(stderr, `uv output line ${n}`)).toHaveLength(0);
  });

  // quiet-check: one line; what a later action fixes and the cosign warning only in the log.
  it("the machine check shows one line; checks a later action fixes and the cosign warning go only to the log", async () => {
    const h = await harness({ answers: ANSWERS, commands: [...HARNESS_COMMANDS, "docker"] });

    const { code, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(stderr.split("\n").filter((line) => line.includes("This machine is ready"))).toEqual([
      `◇  This machine is ready · Linux · Node.js ${NODE} · git 2.43`,
    ]);
    expect(stderr.startsWith(`┌  Pidgen setup\n│\n◇  This machine is ready`)).toBe(true);
    expect(stderr).not.toMatch(/cosign|fixes this|No credential is stored|warn {2}/);
    expect(log).toMatch(/warn\s+runtime\s+.*cosign/);
    expect(log).toMatch(/fail\s+credential\s+.*\(signing in fixes this\)/);
    expect(log).toMatch(/warn\s+worker\s+The worker is not installed/);
  });
});

// Setup's human output: a summary card on success, one ■ block on failure, the re-run menu, and
// the sign-in block. JSON is unchanged.
describe("pidgen setup finish", () => {
  // A first run's questions: the coding agents, each one's sessions, the install, the worker's name.
  const ANSWERS = ["", "", "", "", ""];

  /** Runs the CLI as a terminal does: standard output is a terminal, so the human rendering. */
  async function runTerminal(h: Harness, ...argv: string[]) {
    h.ctx.out.length = 0;
    h.ctx.err.length = 0;
    h.ctx.io.stdoutIsTTY = true;
    const code = await runCli(argv, h.ctx);
    h.ctx.io.stdoutIsTTY = false;
    return { code, stdout: h.ctx.out.join(""), stderr: h.ctx.err.join("") };
  }

  /** The worker's node.yaml with these caps, as a finished setup leaves it. */
  async function writeCaps(h: Harness, caps: Record<string, number>): Promise<void> {
    await mkdir(join(h.pidgenHome, "config"), { recursive: true });
    const lines = Object.entries(caps).map(([kind, max]) => `  ${kind}: {max: ${max}}`);
    await writeFile(
      join(h.pidgenHome, "config", "node.yaml"),
      `version: 2\nharnesses:\n${lines.join("\n")}\n`,
    );
  }

  /** The card after its `└  Done in` line. */
  const CARD = [
    "",
    "  This machine is a Pidgen worker",
    "",
    "  Account        Example · person@example.com",
    `  Worker         ${HOST} · pidgen-worker 1.0.0 · running`,
    "  Coding agents  Claude Code · 1 session at a time",
    "                 Codex · 1 session at a time",
    "",
    "  Manage it",
    "    pidgen worker status    what it's doing now",
    "    pidgen worker stop      stop it",
    "    pidgen setup            change coding agents or sessions",
    "",
    "  Next: install the agent skills so your coding agent can file and follow work",
    "    pidgen skills install",
    "",
  ].join("\n");

  // finish-card: └ Done in, then the card on standard output; not the generic rendering of data.
  it("ends a run in a terminal with └ Done in and the summary card on standard output", async () => {
    const h = await harness({ answers: ANSWERS });

    const { code, stdout, stderr } = await runTerminal(h, "setup", "--url", SERVER);

    expect(code, stderr).toBe(ExitCode.Ok);
    const done = /^│\n└ {2}Done in (\d+) min (\d+) s\n/.exec(stdout);
    expect(done, stdout).not.toBeNull();
    expect(Number(done![2])).toBeLessThan(60);
    expect(stdout.slice(done![0].length)).toBe(CARD);
    expect(stdout).not.toMatch(/Steps \(|displayed|Setup complete|"steps"|summary/);
    // Standard error is the frame, without the old ending lines.
    expect(stderr).not.toMatch(/Done in|Next:|This machine runs/);
    expect(stderr.trimEnd().endsWith("◇  Worker checks passed")).toBe(true);
  });

  it("with JSON on standard output, the frame ends with └ Done in and the envelope is unchanged", async () => {
    const h = await harness({ answers: ANSWERS });

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(stderr).toMatch(/│\n└ {2}Done in \d+ min \d+ s\n$/);
    expect(stderr).not.toMatch(/Next:|This machine is a Pidgen worker/);
    expect(Object.keys(body.data!)).toEqual(["steps"]);
    expect(body.data!.steps.map((entry) => entry.id)).toEqual(STEP_IDS);
    expect(step(body, "prove")["next"]).toBe("pidgen skills install");
  });

  it("the card says how to check the connection when GET /workers could not be read", async () => {
    const h = await harness({
      answers: ANSWERS,
      keepApiUrl: true,
      env: { PIDGEN_TOKEN: PAT, PIDGEN_ACCOUNT: "ACC-EXAMPLE" },
      state: {
        kind: "pat",
        scopes: ["workers:enroll"],
        workersRefusal: () => refusal(403, "FORBIDDEN", "No Personal API Token scope reaches it."),
      },
    });

    const { code, stdout } = await runTerminal(h, "setup");

    expect(code).toBe(ExitCode.Ok);
    expect(stdout).toContain(
      "  This machine is a Pidgen worker\n  Check it's connected: pidgen worker status, signed in as an Owner or Administrator.\n\n",
    );
  });

  it("the card says to open a new terminal when uv was installed off PATH", async () => {
    const h = await harness({ answers: ANSWERS, uv: false });
    const uv = join(h.directory, ".local", "bin", "uv");
    await mkdir(join(uv, ".."), { recursive: true });
    await writeFile(uv, fakeUv());
    await chmod(uv, 0o755);

    const { code, stdout } = await runTerminal(h, "setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(stdout).toContain(
      "  This machine is a Pidgen worker\n  Open a new terminal to use uv by name.\n\n",
    );
  });

  // finish-failure: one ■ block and nothing else; at most five lines after the declined question.
  it("declining uv prints one ■ block of at most five lines after the question, and nothing else", async () => {
    const h = await harness({ answers: ["n"], uv: false });
    await offerableUv(h);

    const { code, stdout, stderr } = await runTerminal(h, "setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Usage);
    expect(stdout).toBe("");
    const question = "◇  uv installs the worker and isn't on this machine. Install it? · No\n";
    const at = stderr.indexOf(question);
    expect(at, stderr).toBeGreaterThanOrEqual(0);
    const after = stderr
      .slice(at + question.length)
      .trimEnd()
      .split("\n");
    expect(after.length, after.join("\n")).toBeLessThanOrEqual(5);
    expect(after).toContain("■  Setup stopped: the worker needs uv.");
    expect(after.some((line) => line.includes(UV_INSTALL))).toBe(true);
    expect(after.some((line) => /^│ {2}Log: ~\/\.pidgen\/logs\/setup-.*\.log$/.test(line))).toBe(
      true,
    );
    expect(after.at(-1)).toMatch(/^└ {2}.*Run pidgen setup again to continue from here\.$/);
  });

  it("a failed task prints one ■ block: no Details, no repeated message, no steps", async () => {
    const h = await harness({ answers: ANSWERS, uvFails: true });

    const { code, stdout, stderr } = await runTerminal(h, "setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Unexpected);
    expect(stdout).toBe("");
    expect(stderr).not.toMatch(/Details:|error INSTALL_FAILED|"steps"|Setup stopped at/);
    const lines = stderr.trimEnd().split("\n");
    const failed = lines.indexOf("■  Couldn't install pidgen-worker 1.0.0");
    expect(failed, stderr).toBeGreaterThan(0);
    expect(lines.filter((line) => line.startsWith("■"))).toHaveLength(1);
    const block = lines.slice(failed);
    expect(block.filter((line) => /uv's output/.test(line))).toHaveLength(1);
    expect(block.at(-2)).toMatch(/^│ {2}Log: ~\/\.pidgen\/logs\/setup-.*\.log$/);
    expect(block.at(-1)).toBe("└  Run pidgen setup again to continue from here.");
    expect(block.slice(1, -1).every((line) => line.startsWith("│"))).toBe(true);
  });

  it("a failure's JSON envelope keeps every field", async () => {
    const h = await harness({ answers: ["n"], uv: false });
    await offerableUv(h);

    const { body } = await h.run("setup", "--url", SERVER);

    expect(body.error!.code).toBe("RUNTIME_UNAVAILABLE");
    expect(Object.keys(body.error!.details).sort()).toEqual(
      ["command", "error", "fix", "install", "setup_log", "step", "steps"].sort(),
    );
    expect(body.error!.message).toMatch(
      /^Setup stopped at Check this machine: .* Fix: .* Run `pidgen setup` again to continue from here\.$/,
    );
  });

  // finish-rerun: every action done shows "Already set up" and asks what to do.
  it("a re-run where every action is done shows Already set up and asks what to do", async () => {
    const h = await harness({ answers: [...ANSWERS, ""] });
    expect((await h.run("setup", "--url", SERVER)).code).toBe(ExitCode.Ok);
    await writeCaps(h, { claude: 4, codex: 0 });
    h.questions.length = 0;
    const installs = (await h.uvRuns()).length;

    const { code, stdout, stderr } = await runTerminal(h, "setup");

    expect(code, stderr).toBe(ExitCode.Ok);
    expect(stderr).toContain(
      "│\n◇  Already set up · Example · Claude Code · pidgen-worker 1.0.0 · running\n",
    );
    const menu = h.prompts.at(-1)!;
    expect(menu).toMatchObject({ kind: "select", message: "What do you want to do?" });
    expect(menu.options.map((option) => option.label)).toEqual([
      "Check everything and stop",
      "Change coding agents or sessions",
    ]);
    // Checking asks nothing more, installs and enrolls nothing, and ends with the card.
    expect(h.questions).toHaveLength(1);
    expect((await h.uvRuns()).length).toBe(installs);
    expect(enrollments(h)).toHaveLength(1);
    expect(stdout).toContain("  Coding agents  Claude Code · 4 sessions at a time\n\n");
    expect(stderr).not.toMatch(/◇ {2}Signed in as|is installed|is enrolled/);
  });

  it("the re-run menu's change answer asks the coding agents and sessions again", async () => {
    const h = await harness({ answers: [...ANSWERS, "change", "", "", ""] });
    expect((await h.run("setup", "--url", SERVER)).code).toBe(ExitCode.Ok);
    await writeCaps(h, { claude: 1, codex: 1 });
    h.questions.length = 0;

    const { code, body } = await h.run("setup");

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions).toHaveLength(4);
    expect(h.questions[1]).toMatch(/coding agents/i);
    expect(step(body, "capacity").status).toBe("done");
  });

  it("offers to update the worker only when the server's current release is newer", async () => {
    const h = await harness({ answers: [...ANSWERS, "update"] });
    expect((await h.run("setup", "--url", SERVER)).code).toBe(ExitCode.Ok);
    await writeCaps(h, { claude: 1, codex: 1 });
    // The installed worker is older than the current series' newest release.
    const recordPath = join(h.pidgenHome, "run", "pidgen-install.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    await writeFile(recordPath, JSON.stringify({ ...record, version: "0.9.0" }));
    const installs = (await h.uvRuns()).filter((run) => run.args[1] === "install").length;

    const { code, body, stderr } = await h.run("setup");

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(h.prompts.at(-1)!.options.map((option) => option.label)).toEqual([
      "Check everything and stop",
      "Change coding agents or sessions",
      "Update the worker to 1.0.0",
    ]);
    expect((await h.uvRuns()).filter((run) => run.args[1] === "install").length).toBe(installs + 1);
    expect(step(body, "install")).toMatchObject({ status: "done", version: "1.0.0" });
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toMatchObject({ version: "1.0.0" });
  });

  // AC-ce152615c765: the re-run menu chooses the update by update's rule.
  describe("on an installed pre-release", () => {
    const wheel = (version: string): IndexFile => {
      const filename = `pidgen_worker-${version}-py3-none-any.whl`;
      return {
        filename,
        url: `https://files.pythonhosted.org/packages/py3/p/pidgen-worker/${filename}`,
        digests: { sha256: "2".repeat(64) },
      };
    };

    /** The re-run menu's options, on a machine set up and then recorded as `version`. */
    async function menuOn(version: string, index: Record<string, IndexFile[]>) {
      const h = await harness({ answers: [...ANSWERS, ""], index });
      expect((await h.run("setup", "--url", SERVER)).code).toBe(ExitCode.Ok);
      await writeCaps(h, { claude: 1, codex: 1 });
      const recordPath = join(h.pidgenHome, "run", "pidgen-install.json");
      const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
      await writeFile(recordPath, JSON.stringify({ ...record, version }));
      const installs = (await h.uvRuns()).filter((run) => run.args[1] === "install").length;

      const { code, stderr } = await h.run("setup");

      expect(code, stderr).toBe(ExitCode.Ok);
      expect((await h.uvRuns()).filter((run) => run.args[1] === "install").length).toBe(installs);
      return h.prompts.at(-1)!.options.map((option) => option.label);
    }

    it("offers a newer beta of the series", async () => {
      expect(
        await menuOn("1.0.1b1", { "1.0.0": [RECORDED_WHEEL], "1.0.1b2": [wheel("1.0.1b2")] }),
      ).toEqual([
        "Check everything and stop",
        "Change coding agents or sessions",
        "Update the worker to 1.0.1b2",
      ]);
    });

    it("offers no update when only older releases are published", async () => {
      expect(
        await menuOn("1.0.1b1", {
          "1.0.0": [RECORDED_WHEEL],
          "1.0.0b1": [wheel("1.0.0b1")],
          "1.0.1a1": [wheel("1.0.1a1")],
        }),
      ).toEqual(["Check everything and stop", "Change coding agents or sessions"]);
    });

    it("on a final release, offers no newer beta", async () => {
      expect(
        await menuOn("1.0.0", { "1.0.0": [RECORDED_WHEEL], "1.0.1b1": [wheel("1.0.1b1")] }),
      ).toEqual(["Check everything and stop", "Change coding agents or sessions"]);
    });
  });

  it("a part-done machine collapses the done actions into one Already done line and continues", async () => {
    const h = await harness({
      answers: [...ANSWERS, "", "", ""],
      state: { connectAfter: 1_000_000 },
    });
    expect((await h.run("setup", "--url", SERVER)).code).toBe(ExitCode.Network);
    h.state.connectAfter = 1;

    const { code, stderr } = await h.run("setup");

    expect(code).toBe(ExitCode.Ok);
    expect(stderr).toContain(
      `│\n◇  Already done · signed in to Example · pidgen-worker 1.0.0 installed · enrolled as ${HOST} · running\n`,
    );
    expect(stderr.match(/Already done/g)).toHaveLength(1);
    expect(stderr).not.toMatch(/◇ {2}Signed in as|is installed|is enrolled|Already set up/);
    expect(h.prompts.some((prompt) => prompt.message === "What do you want to do?")).toBe(false);
  });

  // finish-signin: a credential that cannot enroll stops at sign-in, before anything is installed.
  it("a credential that cannot enroll workers stops setup at sign-in, naming the roles and the token command", async () => {
    const h = await harness({
      answers: ANSWERS,
      state: {
        memberships: [{ account_id: "ACC-EXAMPLE", account_name: "Example", role: "member" }],
        scopes: MEMBER_SCOPES,
      },
    });

    const { code, stdout, stderr } = await runTerminal(h, "setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Auth);
    expect(stdout).toBe("");
    const tokenPath = `pidgen auth login ${SERVER} --with-token --account ACC-EXAMPLE`;
    const at = stderr.indexOf("│\n◇  Signed in as person@example.com · Example · Member\n");
    expect(at, stderr).toBeGreaterThanOrEqual(0);
    const block = stderr.slice(at).trimEnd().split("\n").slice(2);
    expect(block[0]).toBe("│");
    expect(block[1]).toBe(
      "■  You can't add workers to Example: that needs an Owner or Administrator.",
    );
    expect(block).toContain(`│    ${tokenPath}`);
    expect(block.at(-1)).toMatch(/^└ {2}Nothing was installed\./);
    // Nothing was asked or installed.
    expect(h.questions).toEqual([]);
    expect(await h.uvRuns()).toEqual([]);
    expect(enrollments(h)).toHaveLength(0);
  });

  it("the stop at sign-in keeps the envelope's fields, at the sign-in step", async () => {
    const h = await harness({
      answers: ANSWERS,
      state: {
        memberships: [{ account_id: "ACC-EXAMPLE", account_name: "Example", role: "member" }],
        scopes: MEMBER_SCOPES,
      },
    });

    const { code, body } = await h.run("setup", "--url", SERVER);

    const tokenPath = `pidgen auth login ${SERVER} --with-token --account ACC-EXAMPLE`;
    expect(code).toBe(ExitCode.Auth);
    expect(body.error).toMatchObject({
      code: "ENROLL_NOT_PERMITTED",
      details: {
        step: "sign-in",
        roles: ["owner", "administrator"],
        fix: expect.stringContaining(tokenPath),
      },
    });
    expect(body.error!.details.steps!.map((entry) => [entry.id, entry.status])).toEqual([
      ["check", "done"],
      ["sign-in", "failed"],
    ]);
  });

  it("the sign-in block leads with the complete verification link, then the address and code", async () => {
    const h = await harness({ answers: ANSWERS });

    const { code, stderr } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(stderr).toContain(
      [
        "│",
        "◆  Sign in to Pidgen",
        "│  Open this link and approve the sign-in:",
        `│    ${SERVER}/device?user_code=ABCD-EFGH`,
        `│  Or go to ${SERVER}/device and enter  ABCD-EFGH`,
        "│",
        "◇  Signed in as person@example.com · Example · Administrator",
        "",
      ].join("\n"),
    );
    expect(h.waits[0]?.message).toBe("Waiting for you to approve in the browser…");
    expect(stderr).not.toContain("Open https://pidgen.example.com/device and enter the code");
  });
});

/** A fresh machine's answers: the coding agents, each one's sessions, the install and the name. */
const FIRST_RUN = ["", "", "", "", ""];

/**
 * A machine setup left installed and not enrolled, its install recorded as `recorded` (unless
 * `null`). `starts` is the recorded version each start of the detached worker ran.
 */
async function partDone(
  answers: Answer[],
  recorded: string | null = "0.9.0",
  options: HarnessOptions = {},
) {
  const h = await harness({ answers: [...FIRST_RUN, ...answers], ...options });
  const first = await h.run("setup", "--url", SERVER);
  expect(first.code, first.stderr).toBe(ExitCode.Ok);
  // Installed, not enrolled: no credential in the worker home, none listed, nothing running.
  await rm(join(h.pidgenHome, "worker.env"));
  h.state.enrolled = false;
  h.started.value = false;
  const recordPath = join(h.pidgenHome, "run", "pidgen-install.json");
  if (recorded !== null) {
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    await writeFile(recordPath, JSON.stringify({ ...record, version: recorded }));
  }
  const starts: string[] = [];
  const runtime = h.ctx.workerRuntime;
  h.ctx.workerRuntime = {
    ...runtime,
    spawn: (command, args, spawnOptions) => {
      if (spawnOptions.detached === true) {
        const record = JSON.parse(readFileSync(recordPath, "utf8")) as { version: string };
        starts.push(record.version);
      }
      return runtime.spawn(command, args, spawnOptions);
    },
  };
  const installs = async () => (await h.uvRuns()).filter((run) => run.args[1] === "install").length;
  const installsBefore = await installs();
  h.prompts.length = 0;
  return { h, starts, installs, installsBefore, recordPath };
}

// ADR-164 D5 row 9: every run that starts the worker reconciles its version first. The fake index's
// one verifiable wheel is 1.0.0, so "installed" is the install record rewritten to an older version
// (0.9.0, of a series the server still supports) and 1.0.0 is the newer release on its track.
// Each test runs setup twice, installing and verifying a wheel each time: more than the default 5 s
// under a loaded full run.
describe("pidgen setup and a newer worker release", { timeout: 20_000 }, () => {
  /** The questions a re-run asks before the update question: the agents and their sessions. */
  const AGENT_ANSWERS = ["", "", ""];
  const UPDATE = "pidgen-worker 1.0.0 is available (0.9.0 installed). Update before starting?";
  const LICENCE = "Install pidgen-worker 1.0.0 and accept its licence?";

  const beta = (version: string): IndexFile => {
    const filename = `pidgen_worker-${version}-py3-none-any.whl`;
    return {
      filename,
      url: `https://files.pythonhosted.org/packages/py3/p/pidgen-worker/${filename}`,
      digests: { sha256: "2".repeat(64) },
    };
  };

  // AC-7924bd4dc57b: yes updates (after the licence question) before enrolling and starting.
  it("asks to update before enrolling and starting; yes installs it after the licence question", async () => {
    const { h, starts, installs, installsBefore, recordPath } = await partDone([
      ...AGENT_ANSWERS,
      "",
      "",
    ]);

    const { code, body, stderr, log } = await h.run("setup");

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(stderr).toContain(
      "◇  Already done · signed in to Example · pidgen-worker 0.9.0 installed\n",
    );
    // The update, its licence, then the worker's name before the enrollment.
    expect(h.prompts.slice(-3).map((prompt) => [prompt.kind, prompt.message])).toEqual([
      ["confirm", UPDATE],
      ["confirm", LICENCE],
      ["text", "Worker name"],
    ]);
    expect(await installs()).toBe(installsBefore + 1);
    expect(step(body, "install")).toMatchObject({
      status: "done",
      command: "pidgen worker update --restart",
      version: "1.0.0",
    });
    // The update comes before the enrollment, and the worker started is the newer release.
    order(log, `question: ${UPDATE}`, "$ pidgen worker update --restart", "$ pidgen worker enroll");
    expect(step(body, "enroll").status).toBe("done");
    expect(starts).toEqual(["1.0.0"]);
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toMatchObject({ version: "1.0.0" });
  });

  // AC-7924bd4dc57b: no keeps the installed release.
  it("no keeps the installed release, starts it, and says how to update later", async () => {
    const { h, starts, installs, installsBefore } = await partDone([...AGENT_ANSWERS, "n"]);

    const { code, body, stderr } = await h.run("setup");

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    const messages = h.prompts.map((prompt) => prompt.message);
    expect(messages.slice(-2)).toEqual([UPDATE, "Worker name"]);
    expect(messages).not.toContain(LICENCE);
    expect(stderr).toContain(`◇  ${UPDATE} · No\n`);
    expect(stderr).toContain(
      "pidgen-worker 0.9.0 is installed · update it later with pidgen worker update\n",
    );
    expect(await installs()).toBe(installsBefore);
    expect(step(body, "install").status).toBe("skipped");
    expect(starts).toEqual(["0.9.0"]);
  });

  it("declining the new release's licence keeps and starts the installed release", async () => {
    const { h, starts, installs, installsBefore } = await partDone([...AGENT_ANSWERS, "", "n"]);

    const { code, body, stderr } = await h.run("setup");

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(stderr).toContain(`◇  ${LICENCE} · No\n`);
    expect(stderr).toContain(
      "pidgen-worker 0.9.0 is installed · update it later with pidgen worker update\n",
    );
    expect(await installs()).toBe(installsBefore);
    expect(starts).toEqual(["0.9.0"]);
  });

  // AC-e47f5b880ab2: --accept-licence answers both questions in advance.
  it("--accept-licence applies the update without asking the update or licence question", async () => {
    const { h, starts, installs, installsBefore } = await partDone([...AGENT_ANSWERS]);

    const { code, body, stderr } = await h.run("setup", "--accept-licence");

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(h.prompts.filter((prompt) => prompt.kind === "confirm")).toEqual([]);
    expect(stderr).toContain(`◇  ${UPDATE} · Yes (from --accept-licence)\n`);
    expect(stderr).toContain(`◇  ${LICENCE} · Yes (from --accept-licence)\n`);
    expect(await installs()).toBe(installsBefore + 1);
    expect(starts).toEqual(["1.0.0"]);
  });

  // AC-e47f5b880ab2: without a terminal nothing changes.
  it("without a terminal still exits 2 with TERMINAL_REQUIRED and installs nothing", async () => {
    const { h, starts, installs, installsBefore } = await partDone([]);
    h.ctx.prompter = null;

    const { code, body } = await h.run("setup", "--accept-licence");

    expect(code).toBe(ExitCode.Usage);
    expect(body.error!.code).toBe("TERMINAL_REQUIRED");
    expect(await installs()).toBe(installsBefore);
    expect(starts).toEqual([]);
  });

  // AC-8f36152781a7: a newer pre-release is not offered while the installed release is final.
  it("asks nothing when only newer pre-releases are published and the installed release is final", async () => {
    const index: Record<string, IndexFile[]> = { "1.0.0": [RECORDED_WHEEL] };
    const { h, starts, installs, installsBefore } = await partDone([...AGENT_ANSWERS], null, {
      index,
    });
    index["1.0.1b1"] = [beta("1.0.1b1")];
    index["1.1.0b1"] = [beta("1.1.0b1")];

    const { code, body, stderr } = await h.run("setup");

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(h.prompts.filter((prompt) => prompt.kind === "confirm")).toEqual([]);
    expect(stderr).not.toMatch(/is available/);
    expect(await installs()).toBe(installsBefore);
    expect(starts).toEqual(["1.0.0"]);
  });

  // AC-5d9b12b4f732: a check-only run reports the newer release, asking and installing nothing.
  it('"Check everything and stop" reports the newer release without asking or installing', async () => {
    const h = await harness({ answers: [...FIRST_RUN, "check"] });
    expect((await h.run("setup", "--url", SERVER)).code).toBe(ExitCode.Ok);
    await mkdir(join(h.pidgenHome, "config"), { recursive: true });
    await writeFile(
      join(h.pidgenHome, "config", "node.yaml"),
      "version: 2\nharnesses:\n  claude: {max: 1}\n",
    );
    const recordPath = join(h.pidgenHome, "run", "pidgen-install.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    await writeFile(recordPath, JSON.stringify({ ...record, version: "0.9.0" }));
    const installs = (await h.uvRuns()).filter((run) => run.args[1] === "install").length;
    h.prompts.length = 0;

    const { code, body, stderr } = await h.run("setup");

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(h.prompts.map((prompt) => prompt.message)).toEqual(["What do you want to do?"]);
    expect(stderr).toContain(
      "◇  pidgen-worker 1.0.0 is available (0.9.0 installed) · update with pidgen worker update\n",
    );
    expect((await h.uvRuns()).filter((run) => run.args[1] === "install").length).toBe(installs);
    expect(step(body, "install").status).toBe("skipped");
  });
});

describe("pidgen setup, one action at a time", () => {
  const LAPTOP = "sams-laptop";

  /** The whole screen of a first run on a fresh machine, as a terminal shows it. */
  const FIRST_RUN_STDERR = [
    "┌  Pidgen setup",
    "│",
    `◇  This machine is ready · Linux · Node.js ${NODE} · git 2.43`,
    "│",
    "◆  Sign in to Pidgen",
    "│  Open this link and approve the sign-in:",
    `│    ${SERVER}/device?user_code=ABCD-EFGH`,
    `│  Or go to ${SERVER}/device and enter  ABCD-EFGH`,
    "│",
    "◇  Signed in as person@example.com · Example · Administrator",
    "│",
    "◇  Coding agents · Claude Code, Codex",
    "│",
    "◇  Claude Code signed in",
    "│",
    "◇  Codex signed in",
    "│",
    "◇  Claude Code · 1 session at a time",
    "│",
    "◇  Codex · 1 session at a time",
    "│",
    "◇  Install pidgen-worker 1.0.0 and accept its licence? · Yes",
    "│",
    "◇  pidgen-worker 1.0.0 installed and verified",
    "│",
    `◇  Worker name · ${LAPTOP}`,
    "│",
    `◇  Enrolled as ${LAPTOP} in Example`,
    "│",
    `◇  Worker running and connected to Pidgen as ${LAPTOP}`,
    "│",
    "◇  Worker checks passed",
    "",
  ].join("\n");
  const FIRST_RUN_STDOUT = [
    "│",
    "└  Done in <m> min <s> s",
    "",
    "  This machine is a Pidgen worker",
    "",
    "  Account        Example · person@example.com",
    `  Worker         ${LAPTOP} · pidgen-worker 1.0.0 · running`,
    "  Coding agents  Claude Code · 1 session at a time",
    "                 Codex · 1 session at a time",
    "",
    "  Manage it",
    "    pidgen worker status    what it's doing now",
    "    pidgen worker stop      stop it",
    "    pidgen setup            change coding agents or sessions",
    "",
    "  Next: install the agent skills so your coding agent can file and follow work",
    "    pidgen skills install",
    "",
  ].join("\n");

  // root-fresh: a first run on a fresh machine collapses every action to one line, ends with the
  // summary card, and leaves the worker running and connected.
  it("a first run on a fresh machine matches the drawn whole-run screen", async () => {
    const h = await harness({ hostName: LAPTOP, answers: ["", "", "", "", ""] });
    h.ctx.io.stdoutIsTTY = true;

    const code = await runCli(["setup", "--url", SERVER], h.ctx);

    const stderr = h.ctx.err.join("");
    const stdout = h.ctx.out.join("");
    expect(code, stderr).toBe(ExitCode.Ok);
    expect(stderr).toBe(FIRST_RUN_STDERR);
    expect(stdout.replace(/Done in \d+ min \d+ s/, "Done in <m> min <s> s")).toBe(FIRST_RUN_STDOUT);
    // Each question and task is open only while it needs the person: none is left open but the
    // sign-in block, and nothing from uv, npm or the worker reaches the screen.
    expect(h.prompts.map((prompt) => prompt.kind)).toEqual([
      "multiselect",
      "select",
      "select",
      "confirm",
      "text",
    ]);
    expect(stderr).not.toMatch(/^\$ |Step \d|Details:|licence notice|Installing it accepts/m);
    expect(stderr).not.toContain(ENROLL_TOKEN);
    // The worker is running and connected, enrolled once under this machine's name.
    expect(h.started.value).toBe(true);
    expect(enrollments(h)).toHaveLength(1);
    const workers = h.requests.filter((request) => request.url === `${SERVER}/api/v1/workers`);
    expect(workers.length).toBeGreaterThan(0);
    expect(await readWorkerEnv(h.ctx.homeDir)).toMatchObject({
      PIDGEN_LOCALITY_DOMAIN: LAPTOP,
      PIDGEN_SERVICE_URL: SERVER,
    });
  });

  // root-json: a run whose standard output is not a terminal prints the envelope it printed before
  // this cohort: the same top-level keys, the same data.steps ids and each step's fields.
  it("without a terminal on standard output, the envelope keeps its steps and their fields", async () => {
    const h = await harness({ hostName: LAPTOP, answers: ["", "", "", ""] });

    const { code, body } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(Object.keys(body.data!)).toEqual(["steps"]);
    expect(
      Object.fromEntries(body.data!.steps.map((entry) => [entry.id, Object.keys(entry).sort()])),
    ).toEqual({
      check: ["command", "id", "status", "summary"],
      "sign-in": ["account", "command", "enroll", "id", "status", "summary"],
      agents: ["agents", "command", "id", "installed", "status", "summary"],
      "agent-login": ["command", "id", "logins", "status", "summary"],
      capacity: ["caps", "command", "id", "plans", "status", "summary"],
      runtime: ["command", "id", "runtime", "status", "summary"],
      install: ["command", "id", "status", "summary", "version"],
      enroll: [
        "capacity",
        "command",
        "connected",
        "display_name",
        "host_id",
        "id",
        "status",
        "summary",
      ],
      prove: ["command", "id", "next", "report", "status", "summary"],
    });
    expect(step(body, "enroll")).toMatchObject({ host_id: LAPTOP, connected: true });
  });

  // root-json: a failed step keeps the code, exit code and every error.details field it had before
  // this cohort, each with the value the failing command gave it; the setup log is only added.
  it("without a terminal on standard output, a failed step keeps its code and details", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: ["", "", "", ""],
      state: { connectAfter: Number.POSITIVE_INFINITY },
    });

    const { code, body, logPath } = await h.run("--timeout", "30", "setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Network);
    expect(Object.keys(body)).toEqual(expect.arrayContaining(["ok", "data", "error", "meta"]));
    expect(body.error!.code).toBe("WORKER_NOT_CONNECTED");
    expect(Object.keys(body.error!.details).sort()).toEqual([
      "command",
      "display_name",
      "error",
      "fix",
      "host_id",
      "last_error",
      "log",
      "running",
      "setup_log",
      "step",
      "steps",
      "worker",
    ]);
    const inner = body.error!.details["error"] as { details: Record<string, unknown> };
    expect(body.error!.details["log"]).toBe(inner.details["log"]);
    expect(body.error!.details["setup_log"]).toBe(logPath);
    expect(body.error!.details["steps"]).toEqual(
      expect.arrayContaining([
        {
          id: "enroll",
          command: expect.any(String),
          status: "failed",
          summary: expect.any(String),
        },
      ]),
    );
  });
});

describe("pidgen setup documentation", () => {
  const read = (path: string) => readFile(join(import.meta.dirname, "..", "..", path), "utf8");

  // AC-00f2184a38b9: the guides describe the sign-in wait's keys, the Esc question, Ctrl-C and
  // SIGTERM, and what an expired or denied code does.
  it.each(["docs/commands.md", "docs/install-worker.md"])(
    "%s describes the sign-in wait's keys, its question, Ctrl-C, SIGTERM and expiry",
    async (page) => {
      const text = await read(page);
      for (const words of [
        "Enter open in browser · n new code · Esc other options",
        "Sign-in isn't finished. What next?",
        "Wait again with a new code",
        "Sign in with a token instead",
        "Quit setup",
        "SIGTERM",
        "Ctrl-C",
        "expired",
        "denied",
        "xdg-open",
        "wslview",
      ])
        expect(text, words).toContain(words);
    },
  );

  it("docs/troubleshooting.md covers setup that seems stuck waiting for approval", async () => {
    const text = await read("docs/troubleshooting.md");
    expect(text).toMatch(/setup seems stuck waiting for approval/i);
    expect(text).toContain("poll delayed");
  });

  it("the changelog records the sign-in wait and that Ctrl-C during a spinner exits 2", async () => {
    const text = await read("CHANGELOG.md");
    // These changes shipped in 0.1.0-alpha.6: its section and anything newer.
    const alpha6 = text.slice(0, text.indexOf("\n## 0.1.0-alpha.5"));
    expect(alpha6).toMatch(/Ctrl-C during a spinner/);
    expect(alpha6).toContain("exits 2");
    expect(alpha6).toContain("SIGTERM");
    expect(alpha6).toMatch(/sign-in wait/i);
  });

  // c3-docs: the guides and the setup-worker skill describe the finished eight-step flow.
  it.each([
    "docs/install-worker.md",
    "docs/getting-started.md",
    "skills/pidgen-setup-worker/SKILL.md",
  ])(
    "%s describes the eight steps, --agent, --plan, worker login, the plan table and changing a cap",
    async (page) => {
      const text = await read(page);
      for (const title of STEP_TITLES.map((line) => line.replace(/^Step \d of 8 {2}/, ""))) {
        expect(text, title).toContain(title);
      }
      expect(text).toMatch(/eight (numbered )?steps/i);
      expect(text).toContain("--agent");
      expect(text).toContain("--plan");
      expect(text).toContain("pidgen worker login");
      for (const row of [
        /Pro\s*\|\s*1/,
        /Max 5x\s*\|\s*2/,
        /Max 20x\s*\|\s*4/,
        /API key, Team or Enterprise\s*\|\s*2/,
        /Plus\s*\|\s*1/,
        /Pro\s*\|\s*3/,
        /Business or Enterprise\s*\|\s*2/,
        /API key\s*\|\s*2/,
        /Not sure\s*\|\s*1/,
      ])
        expect(text).toMatch(row);
      expect(text).toMatch(/pidgen-worker capacity set (claude|codex) --max/);
      expect(text).toMatch(/pidgen setup [^\n]*--plan/);
    },
  );

  // AC-f8107e9f8fef: AGENTS.md and docs name setup as the one interactive command.
  it("AGENTS.md names pidgen setup as the one interactive command", async () => {
    const agents = await read("AGENTS.md");
    const rule = agents.slice(agents.indexOf("**No prompts.**"));
    const paragraph = rule.slice(0, rule.indexOf("\n- "));
    expect(paragraph).toContain("`pidgen setup`");
    expect(paragraph).toMatch(/only interactive command/);
    expect(paragraph).not.toContain("--no-install");
  });

  it("docs name pidgen setup as the one interactive command, with no planned marker", async () => {
    const commands = await read("docs/commands.md");
    expect(commands).toMatch(
      /^setup\s+\(one command: pidgen setup; the one interactive command\)/m,
    );
    const section = commands.slice(commands.indexOf("## setup"), commands.indexOf("## doctor"));
    expect(section).toContain(
      "pidgen setup [--runtime wheel] [--version <version>] [--label <label>]",
    );
    expect(section).toMatch(/only interactive command/);
    expect(section).toContain("TERMINAL_REQUIRED");
    // Setup itself is built: no line naming it is marked planned (the container runtime still is).
    for (const page of ["docs/commands.md", "docs/workers.md", "docs/README.md", "AGENTS.md"]) {
      for (const line of (await read(page)).split("\n")) {
        if (line.includes("pidgen setup")) expect(line, `${page}: ${line}`).not.toMatch(/planned/i);
      }
    }

    const workers = await read("docs/workers.md");
    expect(workers).toContain("pidgen setup");
    expect(workers).not.toMatch(/This is the CLI's only question/);

    const architecture = await read("docs/architecture.md");
    expect(architecture).toContain("pidgen setup");

    const outputs = await read("docs/output-and-exit-codes.md");
    expect(outputs).toContain("TERMINAL_REQUIRED");
    expect(outputs).toContain("WORKER_NOT_CONNECTED");
    expect(outputs).toContain("ENROLL_NOT_PERMITTED");
    expect(outputs).not.toContain("INSTALL_DECLINED");

    const readme = await read("docs/README.md");
    expect(readme).toContain("pidgen setup");
  });
});

/**
 * The state table of enrolling a machine (App Service ADR-164 D6): each state a machine can be in
 * when `pidgen setup` runs, one test per row, titled with the row's number. Each runs against the
 * fake pidgen-worker (WORKER_SCRIPT), which follows the worker's three saved-credential rules
 * written down at its definition; rows 2, 3 and 7 exercise one rule each. Row 13, a copied worker
 * home, cannot be told apart from the original by setup: docs/troubleshooting.md documents it.
 */
describe("enrollment states", { timeout: 20_000 }, () => {
  /** The coding agents, each one's sessions and the install: every question before the name. */
  const ANSWERS = ["", "", "", ""];
  /** What a re-run asks before the name: the coding agents and each one's sessions. */
  const RERUN = ["", "", ""];
  const LAPTOP = "sams-laptop";
  const OTHER_SERVER = "https://other.example.com";
  const INSTALL_ID = "0123456789abcdef0123456789abcdef";
  const OTHER_INSTALL_ID = "fedcba9876543210fedcba9876543210";
  const credential = (server = SERVER, hostId = HOST, token = "pidgen_node_fake_credential") => [
    `PIDGEN_SERVICE_URL=${server}`,
    `PIDGEN_NODE_TOKEN=${token}`,
    `PIDGEN_LOCALITY_DOMAIN=${hostId}`,
  ];
  const otherInstall = (hostId: string, overrides: Partial<WorkerResource> = {}) =>
    workerResource(true, {
      host_id: hostId,
      created_at: "2026-09-20T09:00:00Z",
      install_id: OTHER_INSTALL_ID,
      ...overrides,
    });
  const enrollArgs = async (h: Harness) =>
    (await h.workerLog()).filter((args) => args[0] === "enroll");
  const readLines = async (path: string) => {
    try {
      return (await readFile(path, "utf8"))
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as string[]);
    } catch {
      return [];
    }
  };
  /** What each `pidgen-worker enroll` did with the one-time token: `done` or `skipped`. */
  const exchanges = async (log: string) =>
    (await readLines(`${log}.exchanges`)).map((entry) => entry[1]);
  /** What each `pidgen-worker enroll` did with a saved credential: kept, moved-aside or refused. */
  const decisions = async (log: string) =>
    (await readLines(`${log}.credentials`)).map((entry) => entry[1]);
  const envPath = (h: Harness) => join(h.pidgenHome, "worker.env");

  /**
   * Runs the fake pidgen-worker by itself, as `pidgen-worker enroll --token … --server <server>
   * --no-start [extra]` would run on this machine, in a worker home of its own holding `lines` as
   * its worker.env: its exit code, standard error, the files it left in that home and its logs.
   */
  async function workerAlone(h: Harness, lines: string[], server: string, extra: string[] = []) {
    const root = join(h.directory, `alone-${Math.random().toString(16).slice(2)}`);
    const home = join(root, ".pidgen");
    await writeWorkerEnv(root, lines);
    const log = join(root, "worker.log");
    const run = spawnSync(
      h.ctx.env["PIDGEN_WORKER_BIN"]!,
      ["enroll", "--token", ENROLL_TOKEN, "--server", server, "--no-start", ...extra],
      {
        env: { ...h.ctx.env, PIDGEN_HOME: home, FAKE_WORKER_LOG: log },
        encoding: "utf8",
      },
    );
    return {
      code: run.status,
      stderr: run.stderr,
      files: (await readdir(home)).sort(),
      env: await readWorkerEnv(root),
      home,
      exchanges: await exchanges(log),
      decisions: await decisions(log),
    };
  }

  it("row 1: a fresh machine enrolls once under this host's name and connects", async () => {
    const h = await harness({ hostName: LAPTOP, answers: ANSWERS });

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    const id = (await readFile(join(h.pidgenHome, "install-id"), "utf8")).trim();
    expect(enrollments(h).map((request) => request.body)).toEqual([
      { label: LAPTOP, install_id: id },
    ]);
    expect((await enrollArgs(h)).map((args) => args.slice(-2))).toEqual([["--host-id", LAPTOP]]);
    expect(await exchanges(h.ctx.env["FAKE_WORKER_LOG"]!)).toEqual(["done"]);
    expect(await decisions(h.ctx.env["FAKE_WORKER_LOG"]!)).toEqual([]);
    expect(withdrawals(h)).toEqual([]);
    expect(step(body, "enroll")).toMatchObject({
      status: "done",
      host_id: LAPTOP,
      connected: true,
    });
  });

  // Rule 1: pidgen-worker keeps a saved credential the service accepts, so an enrollment created
  // here would never be redeemed: setup creates none and starts the worker with the saved one.
  it("row 2: a live credential for this server is kept: no enrollment, the worker started with it", async () => {
    const h = await harness({ answers: ANSWERS, state: { enrolled: true } });
    await writeWorkerEnv(h.ctx.homeDir, credential());
    const before = await readFile(envPath(h), "utf8");

    const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(enrollments(h)).toHaveLength(0);
    expect(await enrollArgs(h)).toEqual([]);
    expect(log).not.toContain("$ pidgen worker enroll");
    expect(await readFile(envPath(h), "utf8")).toBe(before);
    expect(h.started.value).toBe(true);
    expect(step(body, "enroll")).toMatchObject({ host_id: HOST, connected: true });

    const alone = await workerAlone(h, credential(), SERVER);
    expect(alone.code).toBe(0);
    expect(alone.decisions).toEqual(["kept"]);
    expect(alone.exchanges).toEqual(["skipped"]);
    expect(alone.files).toEqual(["worker.env"]);
    expect(alone.env?.["PIDGEN_NODE_TOKEN"]).toBe("pidgen_node_fake_credential");
  });

  // Rule 2: pidgen-worker moves aside a saved credential the service refuses (HTTP 401) and
  // redeems the enrollment. Setup moves it aside itself first (--replace-credential), so with
  // either the worker redeems the one enrollment setup creates.
  it("row 3: a revoked credential is moved aside, one enrollment is redeemed, and the worker connects", async () => {
    const h = await harness({
      answers: [...ANSWERS, "", ""],
      state: { enrolled: true, revoked: true },
    });
    await writeWorkerEnv(h.ctx.homeDir, credential(SERVER, HOST, REVOKED_CREDENTIAL));

    const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(h.prompts[4]).toMatchObject({
      kind: "confirm",
      message: "This machine's worker was removed from Example. Enroll it again?",
    });
    expect(enrollments(h)).toHaveLength(1);
    expect(log).toContain(
      `$ pidgen worker enroll --replace-credential --label ${HOST} -- --host-id ${HOST}`,
    );
    const moved = (await readdir(h.pidgenHome)).filter((name) =>
      /^worker\.env\.replaced-\d{8}T\d{6}Z$/.test(name),
    );
    expect(moved).toHaveLength(1);
    expect(await readFile(join(h.pidgenHome, moved[0]!), "utf8")).toContain(REVOKED_CREDENTIAL);
    expect(await exchanges(h.ctx.env["FAKE_WORKER_LOG"]!)).toEqual(["done"]);
    expect((await readWorkerEnv(h.ctx.homeDir))?.["PIDGEN_NODE_TOKEN"]).toBe(
      "pidgen_node_fake_credential",
    );
    expect(step(body, "enroll")).toMatchObject({ status: "done", host_id: HOST, connected: true });

    const alone = await workerAlone(h, credential(SERVER, HOST, REVOKED_CREDENTIAL), SERVER);
    expect(alone.code).toBe(0);
    expect(alone.stderr).toContain("HTTP 401");
    expect(alone.decisions).toEqual(["moved-aside"]);
    expect(alone.exchanges).toEqual(["done"]);
    expect(alone.files).toEqual(["worker.env", "worker.env.refused"]);
    expect(await readFile(join(alone.home, "worker.env.refused"), "utf8")).toContain(
      REVOKED_CREDENTIAL,
    );
    expect(alone.env?.["PIDGEN_NODE_TOKEN"]).toBe("pidgen_node_fake_credential");
  });

  it("row 4: a name held only by a removed worker is free: setup suggests it and enrolls under it", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: ANSWERS,
      state: {
        others: [otherInstall(LAPTOP, { connected: false, revoked_at: "2026-09-25T09:00:00Z" })],
      },
    });

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(stderr).not.toContain("already has a worker named");
    expect(h.prompts[4]).toMatchObject({ kind: "text", message: "Worker name" });
    expect(h.questions[4]).toContain(`│  ${LAPTOP}\n`);
    expect(enrollments(h).map((request) => request.body)).toEqual([
      { label: LAPTOP, install_id: ANY_INSTALL_ID },
    ]);
    expect((await enrollArgs(h)).map((args) => args.slice(-2))).toEqual([["--host-id", LAPTOP]]);
    expect(step(body, "enroll")).toMatchObject({
      status: "done",
      host_id: LAPTOP,
      connected: true,
    });
  });

  // The Account's list cannot show another Account's worker. A current server scopes names to the
  // Account and enrolls; an older one refuses the host id at the worker's exchange (HTTP 409
  // WORKER_HOST_TAKEN), and setup falls back to the next free name with the same enrollment.
  it("row 5: a name held in another Account enrolls under it on a current server", async () => {
    const h = await harness({ hostName: LAPTOP, answers: ANSWERS });

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(stderr).not.toContain("is taken in Pidgen");
    expect(enrollments(h)).toHaveLength(1);
    expect((await enrollArgs(h)).map((args) => args.at(-1))).toEqual([LAPTOP]);
    expect(step(body, "enroll")).toMatchObject({ host_id: LAPTOP, connected: true });
  });

  it("row 5: a name held in another Account falls back to the next free name on an older server's WORKER_HOST_TAKEN", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: [...ANSWERS, "", ""],
      env: { FAKE_TAKEN_HOSTS: LAPTOP },
    });

    const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(stderr).toContain(`▲  ${LAPTOP} is taken in Pidgen, so this worker needs another name.`);
    expect(h.questions[5]).toContain(`│  ${LAPTOP}-2\n`);
    expect(log).toContain(`${LAPTOP} is taken in Pidgen (HTTP 409 WORKER_HOST_TAKEN)`);
    expect(enrollments(h)).toHaveLength(1);
    expect((await enrollArgs(h)).map((args) => args.at(-1))).toEqual([LAPTOP, `${LAPTOP}-2`]);
    expect(step(body, "enroll")).toMatchObject({ host_id: `${LAPTOP}-2`, connected: true });
  });

  it("row 6: a name held by a live worker of the Account suggests the next free name", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: ANSWERS,
      state: { others: [otherInstall(LAPTOP)] },
    });

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(stderr).toContain(
      `Example already has a worker named ${LAPTOP} (connected; enrolled 20 Sep).`,
    );
    expect(h.questions[4]).toContain(`│  ${LAPTOP}-2\n`);
    expect(enrollments(h).map((request) => request.body)).toEqual([
      { label: `${LAPTOP}-2`, install_id: ANY_INSTALL_ID },
    ]);
    expect(step(body, "enroll")).toMatchObject({ host_id: `${LAPTOP}-2`, connected: true });
  });

  // Rule 3: pidgen-worker refuses another server's saved credential without --replace, so setup
  // refuses before creating an enrollment; once the person moves it aside, setup enrolls.
  it("row 7: a credential for another server is refused before any enrollment, until it is moved aside", async () => {
    const h = await harness({ answers: [...ANSWERS, ...RERUN] });
    await writeWorkerEnv(h.ctx.homeDir, credential(OTHER_SERVER));
    const before = await readFile(envPath(h), "utf8");

    const refused = await h.run("setup", "--url", SERVER);

    expect(refused.code).toBe(ExitCode.Refused);
    expect(refused.body.error).toMatchObject({
      code: "WORKER_CREDENTIAL_PRESENT",
      details: { step: "enroll", path: envPath(h), server: OTHER_SERVER },
    });
    const fix = `mv ${envPath(h)} ${envPath(h)}.old`;
    expect(refused.body.error!.details["fix"]).toContain(fix);
    expect(enrollments(h)).toHaveLength(0);
    expect(await enrollArgs(h)).toEqual([]);
    expect(h.started.value).toBe(false);
    expect(await readFile(envPath(h), "utf8")).toBe(before);

    const alone = await workerAlone(h, credential(OTHER_SERVER), SERVER);
    expect(alone.code).toBe(1);
    expect(alone.stderr).toContain(OTHER_SERVER);
    expect(alone.stderr).toContain("--replace");
    expect(alone.decisions).toEqual(["refused"]);
    expect(alone.exchanges).toEqual([]);
    expect(alone.files).toEqual(["worker.env"]);
    const replaced = await workerAlone(h, credential(OTHER_SERVER), SERVER, ["--replace"]);
    expect(replaced.code).toBe(0);
    expect(replaced.decisions).toEqual(["moved-aside"]);
    expect(replaced.exchanges).toEqual(["done"]);
    expect(replaced.env?.["PIDGEN_SERVICE_URL"]).toBe(SERVER);

    // The fix setup names: the file moved aside, a re-run enrolls this machine here.
    await rename(envPath(h), `${envPath(h)}.old`);
    const { code, body, stderr } = await h.run("setup");

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(enrollments(h)).toHaveLength(1);
    expect(await readFile(`${envPath(h)}.old`, "utf8")).toBe(before);
    expect((await readWorkerEnv(h.ctx.homeDir))?.["PIDGEN_SERVICE_URL"]).toBe(SERVER);
    expect(step(body, "enroll")).toMatchObject({ status: "done", connected: true });
  });

  it("row 8: a run failing after it created an enrollment withdraws it", async () => {
    const h = await harness({ answers: ANSWERS, env: { FAKE_FAIL_ENROLL_RUN: "1" } });

    const { code, body } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error).toMatchObject({
      code: "ENROLL_FAILED",
      details: { step: "enroll", withdrawn: true },
    });
    expect(enrollments(h)).toHaveLength(1);
    expect(withdrawals(h)).toEqual(["/api/v1/workers/enrollments/enr-example-1"]);
    expect(h.started.value).toBe(false);
  });

  it("row 9: a newer release on the track is offered before the worker starts", async () => {
    const UPDATE = "pidgen-worker 1.0.0 is available (0.9.0 installed). Update before starting?";
    const { h, starts } = await partDone([...RERUN, "n"]);

    const { code, body, stderr, log } = await h.run("setup");

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(h.prompts.map((prompt) => prompt.message).slice(-2)).toEqual([UPDATE, "Worker name"]);
    order(log, `question: ${UPDATE}`, "$ pidgen worker enroll", "$ pidgen worker start --detach");
    expect(starts).toEqual(["0.9.0"]);
  });

  it("row 10: with its credential lost and this install's worker live, setup names it and asks to replace it", async () => {
    const mine = workerResource(true, { host_id: "build-box", install_id: INSTALL_ID });
    let enrolledAtQuestion: number | null = null;
    const h = await harness({
      hostName: LAPTOP,
      answers: [
        ...ANSWERS,
        () => {
          enrolledAtQuestion = enrollments(h).length;
          return "y";
        },
        () => {
          mine.revoked_at = "2026-09-28T10:00:00Z";
          mine.connected = false;
          return "y";
        },
      ],
      state: { others: [mine] },
    });
    await writeInstallId(h.ctx.homeDir, INSTALL_ID);

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(stderr).toContain(
      "This install's worker build-box is still listed but its credential is missing.",
    );
    expect(h.prompts[4]).toMatchObject({ kind: "confirm", message: "Replace build-box?" });
    expect(enrolledAtQuestion).toBe(0);
    expect(h.questions[6]).toContain("│  build-box\n");
    expect(enrollments(h).map((request) => request.body)).toEqual([
      { label: "build-box", install_id: INSTALL_ID },
    ]);
    expect(step(body, "enroll")).toMatchObject({ host_id: "build-box", connected: true });
  });

  // Another person's pending enrollment is not in the Account's list: only the server's 409 shows it.
  it("row 11: a name held by another person's pending enrollment is refused 409 WORKER_NAME_TAKEN, and the name asked again", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: [...ANSWERS, "", ""],
      state: { takenNames: { [LAPTOP]: `${LAPTOP}-2` } },
    });

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(h.questions[4]).toContain(`│  ${LAPTOP}\n`);
    expect(stderr).toContain(`▲  ${LAPTOP} is taken in Pidgen, so this worker needs another name.`);
    expect(h.prompts[5]).toMatchObject({ kind: "text", message: "Worker name" });
    expect(h.questions[5]).toContain(`│  ${LAPTOP}-2\n`);
    expect(enrollments(h).map((request) => request.body)).toEqual([
      { label: LAPTOP, install_id: ANY_INSTALL_ID },
      { label: `${LAPTOP}-2`, install_id: ANY_INSTALL_ID },
    ]);
    expect((await enrollArgs(h)).map((args) => args.at(-1))).toEqual([`${LAPTOP}-2`]);
    expect(step(body, "enroll")).toMatchObject({ host_id: `${LAPTOP}-2`, connected: true });
  });

  it("row 12: a re-run with an edited name sends one enrollment, with the same install id", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: [...ANSWERS, "", ...RERUN, "studio"],
      env: { FAKE_FAIL_ENROLL_RUN: "1" },
    });
    const failed = await h.run("setup", "--url", SERVER);
    expect(failed.body.error).toMatchObject({ code: "ENROLL_FAILED" });
    const id = (await readFile(join(h.pidgenHome, "install-id"), "utf8")).trim();
    expect(enrollments(h).map((request) => request.body)).toEqual([
      { label: LAPTOP, install_id: id },
    ]);
    const sent = enrollments(h).length;

    const { code, body, stderr } = await h.run("setup");

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(h.questions.at(-1)).toContain(`│  ${LAPTOP}\n`);
    expect(
      enrollments(h)
        .slice(sent)
        .map((request) => request.body),
    ).toEqual([{ label: "studio", install_id: id }]);
    expect((await enrollArgs(h)).at(-1)!.slice(-2)).toEqual(["--host-id", "studio"]);
    expect(step(body, "enroll")).toMatchObject({ host_id: "studio", connected: true });
  });

  // Row 13, a copied worker home, is documented only. The rows a person can meet are explained in
  // docs/troubleshooting.md, each with the command that fixes it.
  it("row 13 is documented in docs/troubleshooting.md, with rows 3, 4, 6, 7, 10 and 11, each with its fix", async () => {
    const text = await readFile(new URL("../../docs/troubleshooting.md", import.meta.url), "utf8");
    for (const row of [3, 4, 6, 7, 10, 11, 13]) {
      const line = text.split("\n").find((entry) => entry.includes(`(row ${row})`));
      expect(line, `row ${row}`).toBeDefined();
      // Its last column, the fix, names a command to run.
      expect(line!.split(" | ").at(-1), `row ${row}`).toMatch(/`(pidgen|mv) [^`]+`/);
    }
    expect(text).toContain("row 13");
  });
});

describe("pidgen setup's sign-in wait", () => {
  /** A fresh machine's answers after sign-in: the coding agents, each one's sessions, the install. */
  const AFTER_SIGN_IN = ["", "", "", ""];
  const WAITING = "Waiting for you to approve in the browser…";
  const KEYS = "Enter open in browser · n new code · Esc other options";
  const QUESTION = "Sign-in isn't finished. What next?";
  const LINK = `${SERVER}/device?user_code=ABCD-EFGH`;
  const pending = () => refusal(400, "authorization_pending");
  const tokenPolls = (h: Harness) =>
    h.requests.filter((request) => request.url.endsWith("/auth/device/token"));
  const deviceRequests = (h: Harness) =>
    h.requests.filter((request) => request.url.endsWith("/auth/device"));
  /** The block setup draws for a device code. */
  const block = (code: string) =>
    [
      "◆  Sign in to Pidgen",
      "│  Open this link and approve the sign-in:",
      `│    ${SERVER}/device?user_code=${code}`,
      `│  Or go to ${SERVER}/device and enter  ${code}`,
    ].join("\n");

  // AC-a7746e57d065: the block, the live line and the key line.
  it("shows the live line and the keys while it polls, then ends in the signed-in line", async () => {
    const h = await harness({ answers: AFTER_SIGN_IN, state: { polls: [pending(), pending()] } });

    const { code, stderr } = await h.run("setup", "--url", SERVER);

    expect(code, stderr).toBe(ExitCode.Ok);
    expect(stderr).toContain(block("ABCD-EFGH"));
    expect(h.waits).toHaveLength(1);
    const wait = h.waits[0]!;
    expect(wait.message).toBe(WAITING);
    expect(wait.keys).toBe(KEYS);
    expect(wait.lines).toContain(`${WAITING} 5s · checked 0s ago`);
    expect(wait.lines).toContain(`${WAITING} 10s · checked 0s ago`);
    expect(wait.ended).toBe("Signed in as person@example.com · Example · Administrator");
    expect(h.spinners).not.toContain(WAITING);
    // Polls at the server's interval.
    expect(tokenPolls(h)).toHaveLength(3);
  });

  it.each([
    ["linux", {}, "xdg-open"],
    ["linux", { WSL_DISTRO_NAME: "Ubuntu" }, "wslview"],
    ["darwin", {}, "open"],
  ] as const)(
    "Enter opens the complete link with the platform's opener (%s %j: %s)",
    async (platform, env, opener) => {
      const h = await harness({
        answers: AFTER_SIGN_IN,
        state: { polls: [pending()] },
        onWait: (wait) => wait.press("enter"),
      });
      h.ctx.workerRuntime = { ...h.ctx.workerRuntime, platform };
      Object.assign(h.ctx.env, env);
      const openers = join(h.directory, "openers");
      for (const name of ["xdg-open", "wslview", "open"]) {
        await writeExecutable(join(openers, name), "#!/bin/sh\nexit 0\n");
      }
      h.ctx.env["PATH"] = `${openers}:${h.ctx.env["PATH"]}`;

      const { code, stderr, log } = await h.run("setup", "--url", SERVER);

      expect(code, stderr).toBe(ExitCode.Ok);
      const opened = h.spawns.filter((spawn) => spawn.command.startsWith(openers));
      expect(opened.map((spawn) => [basename(spawn.command), spawn.args])).toEqual([
        [opener, [LINK]],
      ]);
      expect(log).toContain(`opened the sign-in link with ${opener}`);
      // The link is never selected from the terminal: the block is drawn once, and the wait goes on.
      expect(stderr.split("◆  Sign in to Pidgen")).toHaveLength(2);
      expect(h.waits).toHaveLength(1);
    },
  );

  it("Enter without an opener checks for approval at once, never sooner than the interval", async () => {
    const h = await harness({
      answers: AFTER_SIGN_IN,
      state: { polls: [pending(), pending()] },
      onWait: (wait) => wait.press("enter"),
    });
    // No xdg-open anywhere on PATH.
    h.ctx.env["PATH"] = h.pathDir;

    const { code, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(code, stderr).toBe(ExitCode.Ok);
    expect(log).toContain("no browser opener on this machine; checking for approval now");
    expect(h.waits[0]!.lines).toContain(
      `No browser opener here: open the link yourself · checking now`,
    );
    const polls = log
      .split("\n")
      .filter((line) => / poll: /.test(line))
      .map((line) => Date.parse(/^\[([^\]]+)\]/.exec(line)![1]!));
    expect(polls).toHaveLength(3);
    for (let index = 1; index < polls.length; index++) {
      expect(polls[index]! - polls[index - 1]!).toBeGreaterThanOrEqual(5000);
    }
  });

  it("n abandons the code, asks for a new one and draws the block again", async () => {
    const h = await harness({
      answers: AFTER_SIGN_IN,
      state: { userCodes: ["ABCD-EFGH", "JKLM-NPQR"], polls: [pending()] },
      onWait: (wait, harness) => {
        if (harness.waits.length === 1) wait.press("new");
      },
    });

    const { code, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(code, stderr).toBe(ExitCode.Ok);
    expect(deviceRequests(h).map((request) => request.method)).toEqual(["POST", "POST"]);
    const [first, second] = order(stderr, block("ABCD-EFGH"), block("JKLM-NPQR"));
    expect(first).toBeLessThan(second!);
    expect(h.waits).toHaveLength(2);
    expect(h.waits[0]!.ended).toBeNull();
    expect(h.waits[1]!.ended).toBe("Signed in as person@example.com · Example · Administrator");
    expect(log).toContain("new code asked for (n)");
    // Every poll after the new code is for it.
    expect(tokenPolls(h).at(-1)?.body).toMatchObject({ device_code: "fake-device-code-2" });
  });

  // AC-d13e9485c287: Esc stops polling and asks what next.
  describe("Esc", () => {
    const escape = (wait: ScriptedWait, h: Harness) => {
      if (h.waits.length === 1) wait.press("escape");
    };

    it("asks what next; the default waits again with a new code", async () => {
      const h = await harness({
        answers: ["", ...AFTER_SIGN_IN],
        state: { userCodes: ["ABCD-EFGH", "JKLM-NPQR"] },
        onWait: escape,
      });

      const { code, stderr } = await h.run("setup", "--url", SERVER);

      expect(code, stderr).toBe(ExitCode.Ok);
      const question = h.prompts.find((prompt) => prompt.message === QUESTION)!;
      expect(question.kind).toBe("select");
      expect(question.options.map((option) => option.label)).toEqual([
        "Wait again with a new code",
        "Sign in with a token instead",
        "Quit setup",
      ]);
      expect(question.screen).toContain("● Wait again with a new code");
      expect(stderr).toContain(`◇  ${QUESTION} · Wait again with a new code`);
      expect(stderr).toContain(block("JKLM-NPQR"));
      expect(deviceRequests(h)).toHaveLength(2);
      expect(h.waits[0]!.ended).toBeNull();
    });

    it("Sign in with a token instead stops setup with the token command as the fix", async () => {
      const h = await harness({
        answers: ["Sign in with a token instead"],
        onWait: escape,
      });

      const { code, body, stderr } = await h.run("setup", "--url", SERVER);

      const command = `pidgen auth login ${SERVER} --with-token --account <ACC-…>`;
      expect(code).toBe(ExitCode.Auth);
      expect(body.error).toMatchObject({
        code: "SIGN_IN_NOT_FINISHED",
        details: { step: "sign-in", fix: expect.stringContaining(command) },
      });
      expect(stderr).toContain(`│    ${command}`);
      expect(stderr).toContain(
        "└  Run `pidgen setup` again to continue from here.".replace(/`/g, ""),
      );
      expect(step(body, "sign-in").status).toBe("failed");
    });

    it("Quit setup stops it with SETUP_CANCELLED, exit 2", async () => {
      const h = await harness({ answers: ["Quit setup"], onWait: escape });

      const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

      expect(code).toBe(ExitCode.Usage);
      expect(body.error?.code).toBe("SETUP_CANCELLED");
      expect(stderr).toMatch(
        /■ {2}Setup cancelled\. Everything before this is kept\.\n└ {2}Run pidgen setup again to continue\.\n$/,
      );
      expect(log).toContain('answer: "quit"');
    });
  });

  // AC-d187c0026816: an expired, denied or lost login asks what next instead of stopping setup.
  it.each([
    ["expired_token", "The code expired before the sign-in was approved.", "expired"],
    ["access_denied", "The sign-in was denied in the browser.", "denied"],
    ["invalid_grant", "Pidgen no longer recognises this sign-in.", "invalid"],
  ])(
    "%s says what happened and asks what next, defaulting to a new code",
    async (refused, line, outcome) => {
      const h = await harness({
        answers: ["", ...AFTER_SIGN_IN],
        state: { userCodes: ["ABCD-EFGH", "JKLM-NPQR"], polls: [pending(), refusal(400, refused)] },
      });

      const { code, stderr, log } = await h.run("setup", "--url", SERVER);

      expect(code, stderr).toBe(ExitCode.Ok);
      expect(stderr).toContain(`│\n▲  ${line}\n`);
      const question = h.prompts.find((prompt) => prompt.message === QUESTION)!;
      expect(question.screen).toContain("● Wait again with a new code");
      expect(deviceRequests(h)).toHaveLength(2);
      expect(stderr).toContain(block("JKLM-NPQR"));
      expect(log).toMatch(new RegExp(`\\] poll: ${outcome}\\n`));
    },
  );

  // AC-f5ceb49fc60f: each poll is logged with its time and outcome, never a code or the token.
  it("logs each poll's time and outcome, a delayed poll, and never a code or the token", async () => {
    const h = await harness({
      answers: AFTER_SIGN_IN,
      state: {
        polls: [
          pending(),
          jsonResponse(400, {
            status: "error",
            error: { code: "slow_down", message: "slow down", details: { interval: 10 } },
          }),
          new TypeError("fetch failed"),
          pending(),
        ],
      },
    });
    // The fourth wait is held up: three times the interval passes before the poll starts.
    const sleep = h.ctx.sleep;
    let sleeps = 0;
    h.ctx.sleep = (ms) => sleep(++sleeps === 4 ? ms * 3 : ms);

    const { code, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(code, stderr).toBe(ExitCode.Ok);
    const polls = log.split("\n").filter((entry) => / poll[: ]/.test(entry));
    expect(polls.map((entry) => entry.replace(/^\[[^\]]+\] /, ""))).toEqual([
      "poll: pending",
      "poll: slow_down; interval now 10s",
      "poll: network error (Could not reach https://pidgen.example.com.)",
      "poll delayed 30s",
      "poll: pending",
      "poll: approved",
    ]);
    for (const entry of polls) expect(entry).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] /);
    for (const secret of ["ABCD-EFGH", "fake-device-code", CLI_TOKEN]) {
      expect(log).not.toContain(secret);
    }
  });

  // AC-72059b293463: a network failure is "not yet"; the wait line says so.
  it("a poll that fails on the network shows it can't reach the server, and keeps polling", async () => {
    const h = await harness({
      answers: AFTER_SIGN_IN,
      state: { polls: [new TypeError("fetch failed"), pending()] },
    });

    const { code, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(code, stderr).toBe(ExitCode.Ok);
    expect(h.waits[0]!.lines).toContain(`Can't reach ${SERVER}; still trying · 5s`);
    expect(h.waits[0]!.lines).toContain(`${WAITING} 10s · checked 0s ago`);
    expect(log).toContain("poll: network error");
    // One request per poll: the HTTP client did not retry it.
    expect(tokenPolls(h)).toHaveLength(3);
  });

  it("invalid_grant after a network failure says the approval's answer was lost and offers a new code", async () => {
    const h = await harness({
      answers: ["", ...AFTER_SIGN_IN],
      state: {
        userCodes: ["ABCD-EFGH", "JKLM-NPQR"],
        polls: [new TypeError("fetch failed"), refusal(400, "invalid_grant")],
      },
    });

    const { code, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(code, stderr).toBe(ExitCode.Ok);
    expect(stderr).toContain(
      "▲  The approval's answer was lost on the way back, so this code can't be used again.\n",
    );
    expect(h.prompts.find((prompt) => prompt.message === QUESTION)).toBeDefined();
    expect(deviceRequests(h)).toHaveLength(2);
    expect(log).toContain("poll: invalid");
  });

  // AC-c16d531ac9ab: Ctrl-C and SIGTERM during a spinner or the wait stop setup as documented.
  const CANCELLED_LINES =
    /\n■ {2}Setup cancelled\. Everything before this is kept\.\n└ {2}Run pidgen setup again to continue\.\n$/;

  it("Ctrl-C during the wait stops setup: exit 2, the cancel lines, the log line", async () => {
    const h = await harness({
      state: { polls: [pending(), pending(), pending()] },
      onWait: (_wait, harness) => harness.interrupt("ctrl-c"),
    });

    const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Usage);
    expect(body.error).toMatchObject({ code: "SETUP_CANCELLED", details: { step: "sign-in" } });
    expect(stderr).toMatch(CANCELLED_LINES);
    expect(log).toContain("answer: cancelled (Ctrl-C)");
    expect(h.waits[0]!.ended).toBeNull();
  });

  it.each([
    ["ctrl-c", "answer: cancelled (Ctrl-C)"],
    ["sigterm", "terminated (SIGTERM)"],
  ] as const)(
    "%s during a spinner stops setup: exit 2, the cancel lines, the log line",
    async (reason, logged) => {
      const h = await harness({
        onSpinner: (message, harness) => {
          if (message === "Checking this machine…") setTimeout(() => harness.interrupt(reason), 0);
        },
      });

      const { code, body, stderr, log } = await h.run("setup", "--url", SERVER);

      expect(code).toBe(ExitCode.Usage);
      expect(body.error).toMatchObject({ code: "SETUP_CANCELLED", details: { step: "check" } });
      expect(stderr).toMatch(CANCELLED_LINES);
      expect(stderr).not.toContain("This machine isn't ready");
      expect(log).toContain(logged);
      expect(deviceRequests(h)).toHaveLength(0);
    },
  );
});

// Since the App Service mints worker ids, a new worker's host_id is `wkr_…` whatever host id it
// asked for, and the chosen name is its display_name. The worker saves the minted id in worker.env.
describe("pidgen setup and minted worker ids", () => {
  const ANSWERS = ["", "", "", ""];
  const MACHINE = "dev-laptop";
  const MAD_MAX_ID = "wkr_examplexxxxxxxxxxxxxxxxxx";
  const OTHER_ID = "wkr_otherxxxxxxxxxxxxxxxxxxxx";
  const LAPTOP = "sams-laptop";
  const INSTALL_ID = "0123456789abcdef0123456789abcdef";

  // AC-7edc22ddf8d7, AC-62387f1bd71c: setup waits for the id the worker saved, not the name.
  it("waits for the minted id worker.env names and reaches step 8 connected, naming the worker with its id", async () => {
    const h = await harness({
      hostName: MACHINE,
      answers: [...ANSWERS, "Mad-Max"],
      state: { mintedId: MAD_MAX_ID },
    });

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(enrollments(h)[0]!.body).toEqual({ label: "Mad-Max", install_id: ANY_INSTALL_ID });
    expect(await readWorkerEnv(h.ctx.homeDir)).toMatchObject({
      PIDGEN_LOCALITY_DOMAIN: MAD_MAX_ID,
    });
    expect(stderr).toContain(`Enrolled as Mad-Max (${MAD_MAX_ID}) in Example`);
    expect(stderr).toContain("Worker running and connected to Pidgen");
    expect(stderr).toContain(`connected to Pidgen as Mad-Max (${MAD_MAX_ID})`);
    expect(stderr).not.toContain("Host id");
    expect(step(body, "enroll")).toMatchObject({
      status: "done",
      host_id: MAD_MAX_ID,
      display_name: "Mad-Max",
      connected: true,
    });
  });

  it("with no id in worker.env, finds the new worker by its name among unrevoked workers", async () => {
    const removed = workerResource(false, {
      host_id: OTHER_ID,
      display_name: "mad-max",
      revoked_at: "2026-09-01T10:00:00Z",
    });
    const h = await harness({
      hostName: MACHINE,
      answers: [...ANSWERS, "Mad-Max"],
      state: { mintedId: MAD_MAX_ID, others: [removed] },
      env: { FAKE_ENROLL_NO_ID: "1" },
    });

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(await readWorkerEnv(h.ctx.homeDir)).not.toHaveProperty("PIDGEN_LOCALITY_DOMAIN");
    expect(stderr).toContain(`connected to Pidgen as Mad-Max (${MAD_MAX_ID})`);
    expect(step(body, "enroll")).toMatchObject({
      host_id: MAD_MAX_ID,
      display_name: "Mad-Max",
      connected: true,
    });
  });

  it("WORKER_NOT_CONNECTED names the worker with its id", async () => {
    const h = await harness({
      hostName: MACHINE,
      answers: [...ANSWERS, "Mad-Max"],
      state: { mintedId: MAD_MAX_ID, connectAfter: Number.POSITIVE_INFINITY },
    });

    const { code, body } = await h.run("--timeout", "30", "setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Network);
    expect(body.error!.code).toBe("WORKER_NOT_CONNECTED");
    const inner = body.error!.details["error"] as { message: string };
    expect(inner.message).toBe(
      `The App Service did not report Mad-Max (${MAD_MAX_ID}) connected within 30 seconds.`,
    );
    expect(body.error!.message).toContain(inner.message);
    expect(body.error!.details).toMatchObject({ host_id: MAD_MAX_ID, display_name: "Mad-Max" });
  });

  it("a re-run finds the enrolled worker by the id worker.env names and shows its name", async () => {
    const h = await harness({
      hostName: MACHINE,
      answers: ANSWERS,
      state: { enrolled: true, mintedId: MAD_MAX_ID, label: "Mad-Max" },
    });
    await writeWorkerEnv(h.ctx.homeDir, [
      `PIDGEN_SERVICE_URL=${SERVER}`,
      "PIDGEN_NODE_TOKEN=pidgen_node_fake_credential",
      `PIDGEN_LOCALITY_DOMAIN=${MAD_MAX_ID}`,
    ]);

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(enrollments(h)).toHaveLength(0);
    expect(stderr).toContain(`Already done · enrolled as Mad-Max (${MAD_MAX_ID})`);
    expect(stderr).toContain(`connected to Pidgen as Mad-Max (${MAD_MAX_ID})`);
    expect(step(body, "enroll")).toMatchObject({
      host_id: MAD_MAX_ID,
      display_name: "Mad-Max",
      connected: true,
    });
  });

  // AC-6065116ba041: names are compared with display_name, and host_id only when it is null.
  it("compares the chosen name with display_name, and a pre-names worker's host_id", async () => {
    const named = (hostId: string, name: string) =>
      workerResource(true, {
        host_id: hostId,
        display_name: name,
        created_at: "2026-09-20T09:00:00Z",
      });
    const h = await harness({
      hostName: LAPTOP,
      answers: [...ANSWERS, "OLD-BOX", "Sams-Laptop-2", ""],
      state: {
        mintedId: MAD_MAX_ID,
        others: [
          named(OTHER_ID, LAPTOP.toUpperCase()),
          named("wkr_secondxxxxxxxxxxxxxxxxxxx", `${LAPTOP}-2`),
          workerResource(true, { host_id: "old-box", display_name: null }),
        ],
      },
    });

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(stderr).toContain(
      `Example already has a worker named ${LAPTOP.toUpperCase()} (connected; enrolled 20 Sep).`,
    );
    expect(stderr).not.toContain(`worker named ${OTHER_ID}`);
    // The suggestion skips every listed name: sams-laptop-2 is a display_name.
    expect(h.questions[4]).toContain(`│  ${LAPTOP}-3\n`);
    // A pre-names worker's host_id is its name; a named worker's display_name, in any case.
    expect(h.questions[5]).toContain("▲  OLD-BOX is taken");
    expect(h.questions[6]).toContain("▲  Sams-Laptop-2 is taken");
    expect(enrollments(h)[0]!.body).toEqual({ label: `${LAPTOP}-3`, install_id: ANY_INSTALL_ID });
    expect(step(body, "enroll")).toMatchObject({
      host_id: MAD_MAX_ID,
      display_name: `${LAPTOP}-3`,
      connected: true,
    });
  });

  it("does not take a worker's minted id for its name", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: [...ANSWERS, ""],
      state: {
        mintedId: MAD_MAX_ID,
        others: [workerResource(true, { host_id: LAPTOP, display_name: "studio" })],
      },
    });

    const { code, stderr } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    // The worker whose host id is this host's name is named studio: the host's name is free.
    expect(stderr).not.toContain("already has a worker named");
    expect(h.questions[4]).toContain(`│  ${LAPTOP}\n`);
  });

  it("--label a listed worker's display_name holds, in any case, stops with WORKER_NAME_TAKEN", async () => {
    const h = await harness({
      hostName: MACHINE,
      answers: ANSWERS,
      state: {
        mintedId: MAD_MAX_ID,
        others: [workerResource(true, { host_id: OTHER_ID, display_name: "Mad-Max" })],
      },
    });

    const { code, body } = await h.run("setup", "--url", SERVER, "--label", "mad-max");

    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "WORKER_NAME_TAKEN",
      details: { display_name: "mad-max", suggested_name: "mad-max-2" },
    });
    expect(enrollments(h)).toHaveLength(0);
  });

  it("this install's live worker is named by its display_name when setup asks to replace it", async () => {
    const mine = workerResource(true, {
      host_id: OTHER_ID,
      display_name: "build-box",
      install_id: INSTALL_ID,
    });
    const h = await harness({
      hostName: MACHINE,
      answers: [...ANSWERS, "n", ""],
      state: { mintedId: MAD_MAX_ID, others: [mine] },
    });
    await writeInstallId(h.ctx.homeDir, INSTALL_ID);

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    expect(body.error, stderr).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(h.prompts[4]).toMatchObject({ kind: "confirm", message: "Replace build-box?" });
    expect(h.questions[5]).toContain("│  build-box-2\n");
    expect(enrollments(h)[0]!.body).toEqual({ label: "build-box-2", install_id: INSTALL_ID });
  });
});
