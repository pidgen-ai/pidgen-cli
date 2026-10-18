import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
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
import { CANCEL, scriptedPrompter, type Answer, type AskedPrompt } from "../support/prompter.js";
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
  connected: boolean;
  last_seen_at: string;
  created_at: string;
  revoked_at: string | null;
  protocol: string;
  protocol_state: string;
  build_version: string;
  git_credentials: unknown[];
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
 * `enroll` writes $PIDGEN_HOME/worker.env as the real worker does (the credential, the server and
 * `--host-id`, default the host name), unless FAKE_ENROLL_NO_ENV is set.
 */
const WORKER_SCRIPT = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_WORKER_LOG, JSON.stringify(args) + "\\n");
// The worker says what it enrolls with, one-time token and all, as a careless worker might.
if (args[0] === "enroll") process.stderr.write("pidgen-worker " + args.join(" ") + "\\nenrolled\\n");
if (args[0] === "enroll" && !process.env.FAKE_ENROLL_NO_ENV) {
  const value = (flag) => { const at = args.lastIndexOf(flag); return at < 0 ? undefined : args[at + 1]; };
  const home = process.env.PIDGEN_HOME;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "worker.env"), [
    "PIDGEN_SERVICE_URL=" + value("--server"),
    "PIDGEN_NODE_TOKEN=pidgen_node_fake_credential",
    "PIDGEN_LOCALITY_DOMAIN=" + (value("--host-id") ?? process.env.FAKE_HOSTNAME),
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
      return ok({
        device_code: "fake-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: `${SERVER}/device`,
        verification_uri_complete: `${SERVER}/device?user_code=ABCD-EFGH`,
        expires_in: 600,
        interval: 5,
      });
    }
    if (url === `${api}/auth/device/token`) {
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
      const connected = started.value && pollsAfterStart >= state.connectAfter && !state.revoked;
      const listed = state.enrolled || connected;
      const hostId = (await readWorkerEnv(ctx.homeDir))?.["PIDGEN_LOCALITY_DOMAIN"] ?? HOST;
      const own = workerResource(connected, {
        host_id: hostId,
        revoked_at: state.revoked ? "2026-09-28T10:00:00Z" : null,
      });
      return ok({
        workers: [...state.others, ...(listed ? [own] : [])],
        service_protocol: "1.0",
        accepted_protocols: ["1.0"],
      });
    }
    if (url === `${api}/workers/enrollments` && method === "POST") {
      state.enrolled = true;
      state.revoked = false;
      return ok(enrollment(), 201);
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

  const scripted = scriptedPrompter(
    (text) => ctx.io.stderr(text),
    answers,
    (asked) => questions.push(asked.screen),
  );
  prompts = scripted.asked;
  ctx.prompter = options.noTerminal ? null : () => Promise.resolve(scripted.prompter);

  return {
    ...base,
    state,
    requests,
    questions,
    get prompts() {
      return prompts;
    },
    spinners: scripted.spinners,
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

describe("pidgen setup", () => {
  // AC-13099f01c6dd: setup owns its prompts and stderr summaries in every stdout format; with
  // --verbose its commands are shown under each task (without it they are in the setup log).
  it.each([undefined, "json", "table"])(
    "retains setup commands and progress with %s output",
    async (format) => {
      const h = await harness({ answers: ["", "", "", ""] });
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
      expect(h.questions).toHaveLength(4);
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
    const h = await harness({ answers: ["", "", "", ""] });

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

    // Four questions: the coding agents, each one's sessions, then the install and its licence;
    // no runtime question while setup offers only the wheel.
    expect(h.questions).toHaveLength(4);
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
    expect(enrollments(h)[0]!.body).toEqual({ label: HOST });
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
      answers: ["Other", "", "", "", ""],
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
    expect(h.questions).toHaveLength(5);
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
    const h = await harness({ answers: ["", "", "", "", "", "", ""] });
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
    const h = await harness({ answers: ["", "", "", "", "", "", ""] });
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
    await writeFile(join(h.pathDir, "git"), "#!/bin/sh\necho 'git version 2.20.1'\n");

    const { body, log } = await h.run("setup", "--url", SERVER);

    expect(body.error!.message).toContain("Check this machine");
    expect(body.error!.message).toContain("git: install git with your package manager");
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

  // c1-git: setup's check step runs the doctor's git check.
  it("stops at the check step when git is older than 2.25, with the platform's fix", async () => {
    const h = await harness({ answers: ["", "", "", ""] });
    await writeFile(join(h.pathDir, "git"), "#!/bin/sh\necho 'git version 2.20.1'\n");

    const { code, body } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error).toMatchObject({ code: "DOCTOR_FAILED", details: { step: "check" } });
    expect(String(body.error!.details["fix"])).toContain(
      "git: install git with your package manager",
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
    const h = await harness({ answers: ["", "", "", ""], uv: false });
    const uv = join(h.directory, ".local", "bin", "uv");
    await mkdir(join(uv, ".."), { recursive: true });
    await writeFile(uv, fakeUv());
    await chmod(uv, 0o755);

    const { code, stderr, log } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions).toHaveLength(4);
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
    await writeFile(join(h.pathDir, "git"), "#!/bin/sh\necho 'git version 2.20.1'\n");

    const { code, body } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error).toMatchObject({
      code: "DOCTOR_FAILED",
      details: { step: "check", command: "pidgen doctor" },
    });
    expect(String(body.error!.details["fix"])).toContain(
      "git: install git with your package manager",
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
    expect(enrollments(h)[0]!.body).toEqual({ label: "build box" });
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
  const credential = (server = SERVER, hostId = HOST) => [
    `PIDGEN_SERVICE_URL=${server}`,
    "PIDGEN_NODE_TOKEN=pidgen_node_fake_credential",
    `PIDGEN_LOCALITY_DOMAIN=${hostId}`,
  ];
  const enrollArgs = async (h: Harness) =>
    (await h.workerLog()).filter((args) => args[0] === "enroll");

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
    expect(h.prompts[4]).toMatchObject({ kind: "text", message: "Name for this worker" });
    expect(h.questions[4]).toContain(`│  ${LAPTOP}-2\n`);
    expect(stderr).toContain(`◇  Worker name · ${LAPTOP}-2\n`);
    expect(enrollments(h)).toHaveLength(1);
    expect(enrollments(h)[0]!.body).toEqual({ label: `${LAPTOP}-2` });
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

  it("enrolls when worker.env's credential is for another server", async () => {
    const h = await harness({ answers: [...ANSWERS, ""], state: { others: [otherInstall(HOST)] } });
    await writeWorkerEnv(h.ctx.homeDir, credential("https://other.example.com"));

    const { code } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(enrollments(h)).toHaveLength(1);
    expect((await enrollArgs(h))[0]!.slice(-2)).toEqual(["--host-id", `${HOST}-2`]);
  });

  it("enrolls when the server does not list worker.env's host id", async () => {
    const h = await harness({ answers: ANSWERS });
    await writeWorkerEnv(h.ctx.homeDir, credential(SERVER, "gone-box"));

    const { code } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(enrollments(h)).toHaveLength(1);
    expect((await enrollArgs(h))[0]!.slice(-2)).toEqual(["--host-id", HOST]);
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
  it("asks whether to enroll again when the server lists this home's worker as revoked", async () => {
    const h = await harness({
      answers: [...ANSWERS, ""],
      state: { enrolled: true, revoked: true },
    });
    await writeWorkerEnv(h.ctx.homeDir, credential());

    const { code, body } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions).toHaveLength(5);
    expect(h.prompts[4]).toMatchObject({
      kind: "confirm",
      message: "This machine's worker was removed from Example. Enroll it again?",
    });
    expect(h.questions[4]).toContain("│  ● Yes  ○ No");
    expect(enrollments(h)).toHaveLength(1);
    expect((await enrollArgs(h))[0]!.slice(-2)).toEqual(["--host-id", HOST]);
    expect(step(body, "enroll")).toMatchObject({ host_id: HOST, connected: true });
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
    expect(enrollments(h)[0]!.body).toEqual({ label: "studio" });
    expect((await enrollArgs(h))[0]!.slice(-2)).toEqual(["--host-id", "studio"]);
    expect(step(body, "enroll")).toMatchObject({ host_id: "studio", connected: true });
  });

  it("--label naming another install's worker stops before enrolling", async () => {
    const h = await harness({
      hostName: LAPTOP,
      answers: ANSWERS,
      state: { others: [otherInstall(LAPTOP)] },
    });

    const { code, body } = await h.run("setup", "--url", SERVER, "--label", LAPTOP);

    expect(code).toBe(ExitCode.Usage);
    expect(body.error).toMatchObject({
      // root-json: a --label that cannot be used is a usage error, as before.
      code: "CLI_USAGE",
      details: { step: "enroll", fix: expect.stringContaining(`--label ${LAPTOP}-2`) },
    });
    expect(enrollments(h)).toHaveLength(0);
    expect(h.started.value).toBe(false);
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
    // Only each agent's sessions, then the install.
    expect(h.questions).toHaveLength(3);
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
    // Codex's sign-in, each agent's sessions, and the install.
    expect(h.questions).toHaveLength(4);
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
    expect(h.questions).toHaveLength(2);
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
    expect(h.questions).toHaveLength(1);
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
    const h = await harness({ agents: { claude: { signedIn: true } }, answers: ["2", "", "4"] });
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
    ]);
    // What stays on screen is each answer's one line, not the open question.
    for (const line of [
      "│\n◇  Coding agents · Claude Code, Codex\n",
      "│\n◇  Claude Code · 1 session at a time\n",
      "│\n◇  Codex · 1 session at a time\n",
      "│\n◇  Install pidgen-worker 1.0.0 and accept its licence? · Yes\n",
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
    // The agents, the new agent's own sign-in, each one's sessions, and the install: no question
    // about installing Codex.
    expect(h.prompts.map((prompt) => prompt.message)).toEqual([
      "Which coding agents will this worker run?",
      "Codex needs you to sign in. Its own sign-in runs here; setup continues after it.",
      "Claude Code: how many sessions should run at once?",
      "Codex: how many sessions should run at once?",
      "Install pidgen-worker 1.0.0 and accept its licence?",
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
  const NODE = process.versions.node.split(".").slice(0, 2).join(".");
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
      "◇  Worker running and connected to Pidgen",
      "◇  Worker checks passed",
    ])
      expect(stderr).toContain(`│\n${line}\n`);
    expect(h.spinners).toEqual([
      "Checking this machine…",
      "Waiting for you to approve in the browser…",
      "Installing pidgen-worker 1.0.0…",
      "Verifying it was published by Pidgen's release workflow…",
      `Enrolling as ${HOST}…`,
      "Starting the worker…",
      "Waiting for Pidgen to report the worker connected…",
      "Running the worker's checks…",
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
  const ANSWERS = ["", "", "", ""];

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
    expect(h.spinners).toContain("Waiting for you to approve in the browser…");
    expect(stderr).not.toContain("Open https://pidgen.example.com/device and enter the code");
  });
});

describe("pidgen setup, one action at a time", () => {
  const LAPTOP = "sams-laptop";

  /** The whole screen of a first run on a fresh machine, as a terminal shows it. */
  const FIRST_RUN_STDERR = [
    "┌  Pidgen setup",
    "│",
    "◇  This machine is ready · Linux · Node.js 24.16 · git 2.43",
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
    `◇  Enrolled as ${LAPTOP} in Example`,
    "│",
    "◇  Worker running and connected to Pidgen",
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
    const h = await harness({ hostName: LAPTOP, answers: ["", "", "", ""] });
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
      enroll: ["capacity", "command", "connected", "host_id", "id", "status", "summary"],
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
