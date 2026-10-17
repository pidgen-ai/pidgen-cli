import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { loadConfig, saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import type { WorkerRuntime } from "../../src/core/worker.js";
import { envelope, jsonResponse } from "../support/context.js";
import {
  installContext,
  releaseList,
  SERVER,
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
  /** The worker the App Service lists for this host, or none. */
  enrolled: boolean;
  /** How many `GET /workers` reads after the worker started before it reports `connected`. */
  connectAfter: number;
  /** `GET /workers` answers this instead of the list. */
  workersRefusal?: () => Response;
}

interface Harness extends InstallContext {
  state: ServerState;
  requests: Array<{ method: string; url: string; body: unknown }>;
  questions: string[];
  answers: string[];
  workerLog: () => Promise<string[][]>;
  started: { value: boolean };
  run(...argv: string[]): Promise<{ code: number; body: Body; stderr: string }>;
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

function workerResource(connected: boolean) {
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
  };
}

/** A fake `pidgen-worker`: logs each argument list, answers `doctor --json`, and exits 0. */
const WORKER_SCRIPT = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_WORKER_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "doctor") process.stdout.write(JSON.stringify({ ok: true, checks: [] }));
process.exit(0);
`;

interface HarnessOptions extends InstallContextOptions {
  state?: Partial<ServerState>;
  answers?: string[];
  /** No terminal: `ask` is null. */
  noTerminal?: boolean;
  /** Keep PIDGEN_API_URL in the environment (installContext sets it). */
  keepApiUrl?: boolean;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const base = await installContext({ commands: HARNESS_COMMANDS, ...options });
  const state: ServerState = {
    memberships: [{ account_id: "ACC-EXAMPLE", account_name: "Example", role: "administrator" }],
    approvals: ["ACC-EXAMPLE"],
    scopes: ADMIN_SCOPES,
    kind: "cli",
    enrolled: false,
    connectAfter: 1,
    ...options.state,
  };
  const requests: Harness["requests"] = [];
  const questions: string[] = [];
  const answers = [...(options.answers ?? [])];
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
  if (!options.keepApiUrl) delete ctx.env["PIDGEN_API_URL"];
  ctx.env["PIDGEN_WORKER_BIN"] = workerBin;
  ctx.env["FAKE_WORKER_LOG"] = workerLog;

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
      const connected = started.value && pollsAfterStart >= state.connectAfter;
      const listed = state.enrolled || connected;
      return ok({
        workers: listed ? [workerResource(connected)] : [],
        service_protocol: "1.0",
        accepted_protocols: ["1.0"],
      });
    }
    if (url === `${api}/workers/enrollments` && method === "POST") {
      state.enrolled = true;
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
  };
  ctx.workerRuntime = runtime;

  ctx.ask = options.noTerminal
    ? null
    : async (question: string) => {
        questions.push(question);
        const answer = answers.shift();
        if (answer === undefined) throw new Error(`unexpected question: ${question}`);
        return answer;
      };

  return {
    ...base,
    state,
    requests,
    questions,
    answers,
    started,
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
      const code = await runCli(argv, ctx);
      expect(ctx.out).toHaveLength(1);
      return { code, body: envelope(ctx) as unknown as Body, stderr: ctx.err.join("") };
    },
  };
}

const STEP_IDS = ["check", "sign-in", "runtime", "install", "enroll", "prove"];

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

function enrollments(h: Harness) {
  return h.requests.filter((request) => request.url.endsWith("/workers/enrollments"));
}

describe("pidgen setup", () => {
  // AC-13099f01c6dd: setup owns its prompts and stderr summaries in every stdout format.
  it.each([undefined, "json", "table"])(
    "retains setup commands and progress with %s output",
    async (format) => {
      const h = await harness({ answers: [""] });
      h.ctx.io.stdoutIsTTY = true;
      const flags = format ? ["--format", format] : [];
      expect(await runCli([...flags, "setup", "--url", SERVER], h.ctx)).toBe(ExitCode.Ok);
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
      expect(stderr).toContain("This machine runs a verified worker connected to Pidgen.");
      expect(h.questions).toHaveLength(1);
      expect(stderr).not.toContain(ENROLL_TOKEN);
      if (format === "json") expect(envelope(h.ctx)).toMatchObject({ ok: true });
      else expect(h.ctx.out.join("")).toContain("Setup complete.");
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
    const h = await harness({ answers: [""] });

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(body.ok).toBe(true);
    expect(body.data!.steps.map((entry) => entry.id)).toEqual(STEP_IDS);
    expect(body.data!.steps.map((entry) => entry.status)).toEqual([
      "done",
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
      `pidgen worker enroll --label ${HOST} && pidgen worker start --detach`,
    );
    expect(step(body, "prove").command).toBe("pidgen worker doctor");

    // Each command is printed before it runs, in the order of the steps.
    const positions = order(
      stderr,
      "$ pidgen doctor",
      `$ pidgen auth login ${SERVER}`,
      "$ pidgen worker install --runtime wheel",
      " tool install ",
      "$ pidgen worker verify",
      `$ pidgen worker enroll --label ${HOST}`,
      "$ pidgen worker start --detach",
      "$ pidgen worker doctor",
    );
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    // One question: the runtime, defaulting to what the machine has, with the licence notice.
    expect(h.questions).toHaveLength(1);
    expect(h.questions[0]).toMatch(/runtime/i);
    expect(h.questions[0]).toContain("[wheel]");
    const { eula } = releaseList();
    expect(stderr.indexOf(eula.notice)).toBeLessThan(stderr.indexOf("$ pidgen worker install"));
    expect(stderr).toContain(eula.name);

    // Install and verify: uv installed the verified wheel and each verification is printed.
    expect((await h.uvRuns()).filter((run) => run.args[1] === "install")).toHaveLength(1);
    expect(stderr).toMatch(/ok\s+digest/);
    expect(stderr).toMatch(/ok\s+provenance/);

    // Enroll and start: one enrollment, the worker enrolled, then started detached.
    expect(enrollments(h)).toHaveLength(1);
    expect(enrollments(h)[0]!.body).toEqual({ label: HOST });
    const worker = await h.workerLog();
    // The detached start (no subcommand) logs whenever its background process runs, which can be
    // after the doctor; the order the CLI ran them in is checked on stderr above.
    const runs = worker.map((args) => args[0]);
    expect(runs[0]).toBe("enroll");
    expect(runs).toHaveLength(3);
    expect(runs).toEqual(expect.arrayContaining(["enroll", undefined, "doctor"]));
    expect(h.started.value).toBe(true);
    expect(step(body, "enroll")["connected"]).toBe(true);

    // Prove it: the worker doctor's report, then the one next thing to do, as a command.
    expect(step(body, "prove")["next"]).toMatch(/^pidgen /);
    expect(stderr).toContain(String(step(body, "prove")["next"]));

    // Standard output carries only the envelope; the one-time token never appears.
    expect(h.ctx.out.join("")).not.toContain(ENROLL_TOKEN);
    expect(stderr).not.toContain(ENROLL_TOKEN);
  });

  // AC-eb803e163154: the Account is chosen only when the User belongs to more than one.
  it("asks no Account question when the User belongs to one Account", async () => {
    const h = await harness({ answers: [""] });

    const { code } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions.some((question) => /Account/.test(question))).toBe(false);
  });

  it("asks which Account the worker serves when the User belongs to more than one", async () => {
    const h = await harness({
      answers: ["2", ""],
      state: {
        memberships: [
          { account_id: "ACC-EXAMPLE", account_name: "Example", role: "administrator" },
          { account_id: "ACC-OTHER", account_name: "Other", role: "owner" },
        ],
        approvals: ["ACC-EXAMPLE", "ACC-OTHER"],
      },
    });

    const { code, stderr } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions).toHaveLength(2);
    expect(h.questions[0]).toContain("ACC-EXAMPLE");
    expect(h.questions[0]).toContain("ACC-OTHER");
    // ACC-OTHER has no credential yet: a second login, approved for it, then it becomes the default.
    expect(stderr.split(`$ pidgen auth login ${SERVER}`)).toHaveLength(3);
    expect(stderr).toContain("$ pidgen account use ACC-OTHER");
    const config = await loadConfig(h.ctx);
    expect(config.profiles["default"]?.default_account).toBe("ACC-OTHER");
    const enroll = enrollments(h)[0]!;
    expect(enroll).toBeDefined();
  });

  // AC-e74e7ebbce32: before enrolling, whether the credential may enroll, the roles that can, and
  // the Personal API Token path, from the role and scopes GET /me publishes.
  it("says the credential may enroll workers, from the scopes GET /me publishes", async () => {
    const h = await harness({ answers: [""] });

    const { body, stderr } = await h.run("setup", "--url", SERVER);

    const signIn = step(body, "sign-in");
    expect(signIn["enroll"]).toMatchObject({
      allowed: true,
      role: "administrator",
      roles: ["owner", "administrator"],
      scope: "workers:enroll",
    });
    expect(stderr).toMatch(/may enroll workers/);
    expect(stderr.indexOf("may enroll workers")).toBeLessThan(
      stderr.indexOf("$ pidgen worker enroll"),
    );
  });

  it("stops before enrolling when the role cannot enroll, naming the roles that can and the token path", async () => {
    const h = await harness({
      answers: [""],
      state: {
        memberships: [{ account_id: "ACC-EXAMPLE", account_name: "Example", role: "member" }],
        scopes: MEMBER_SCOPES,
      },
    });

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    const tokenPath = `pidgen auth login ${SERVER} --with-token --account ACC-EXAMPLE`;
    expect(step(body, "sign-in")["enroll"]).toMatchObject({
      allowed: false,
      role: "member",
      roles: ["owner", "administrator"],
      scope: "workers:enroll",
      token_command: tokenPath,
    });
    // Said at sign-in, before anything is installed.
    const said = stderr.indexOf("may not enroll workers");
    expect(said).toBeGreaterThanOrEqual(0);
    expect(said).toBeLessThan(stderr.indexOf("$ pidgen worker install"));
    expect(stderr).toMatch(/Owner or Administrator/);
    expect(stderr).toContain("workers:enroll");
    expect(stderr).toContain(tokenPath);

    // The enroll step fails without spending an enrollment.
    expect(code).toBe(ExitCode.Auth);
    expect(body.error).toMatchObject({
      code: "ENROLL_NOT_PERMITTED",
      details: { step: "enroll", fix: expect.stringContaining(tokenPath) },
    });
    expect(enrollments(h)).toHaveLength(0);
    expect(step(body, "enroll").status).toBe("failed");
  });

  it("uses the Personal API Token's scopes: workers:enroll may enroll whatever the role", async () => {
    const h = await harness({
      answers: [""],
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
    const h = await harness({ answers: [""], state: { connectAfter: 3 } });

    const { code, body, stderr } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    const reads = h.requests.filter((request) => request.url.endsWith("/api/v1/workers"));
    // One read to find whether this host is enrolled, then reads until it is connected.
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(step(body, "enroll")["connected"]).toBe(true);
    expect(stderr).toMatch(/connected/i);
  });

  it("fails clearly when the worker is not connected before the timeout", async () => {
    const h = await harness({ answers: [""], state: { connectAfter: Number.POSITIVE_INFINITY } });

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
    expect(body.error!.message).toMatch(/30 seconds/);
    expect(step(body, "enroll").status).toBe("failed");
    expect(() => step(body, "prove")).toThrow();
    expect(h.ctx.now() - before).toBeGreaterThanOrEqual(30_000);
  });

  // AC-753c2c51c3a6: re-running resumes, skipping what is already done.
  it("resumes: a signed-in profile, an installed worker and an enrolled, running host are skipped", async () => {
    const h = await harness({ answers: [""] });
    expect((await h.run("setup", "--url", SERVER)).code).toBe(ExitCode.Ok);
    const enrolledBefore = enrollments(h).length;
    const installsBefore = (await h.uvRuns()).length;
    const devicesBefore = h.requests.filter((r) => r.url.endsWith("/auth/device")).length;
    h.questions.length = 0;

    const { code, body, stderr } = await h.run("setup");

    expect(code).toBe(ExitCode.Ok);
    expect(body.data!.steps.map((entry) => [entry.id, entry.status])).toEqual([
      ["check", "done"],
      ["sign-in", "skipped"],
      ["runtime", "skipped"],
      ["install", "skipped"],
      ["enroll", "skipped"],
      ["prove", "done"],
    ]);
    expect(h.questions).toEqual([]);
    expect(enrollments(h).length).toBe(enrolledBefore);
    expect((await h.uvRuns()).length).toBe(installsBefore);
    expect(h.requests.filter((r) => r.url.endsWith("/auth/device")).length).toBe(devicesBefore);
    expect(stderr).not.toContain("$ pidgen auth login");
    expect(stderr).not.toContain("$ pidgen worker install");
    expect(stderr).not.toContain("$ pidgen worker enroll");
    // Skipped steps still name the command they stand for.
    expect(step(body, "install").command).toBe(
      "pidgen worker install --runtime wheel && pidgen worker verify",
    );
  });

  it("resumes with an enrolled host whose worker is not running: starts it without enrolling", async () => {
    const h = await harness({ answers: [""] });
    expect((await h.run("setup", "--url", SERVER)).code).toBe(ExitCode.Ok);
    h.started.value = false;

    const { code, body, stderr } = await h.run("setup");

    expect(code).toBe(ExitCode.Ok);
    expect(step(body, "enroll").status).toBe("done");
    expect(enrollments(h)).toHaveLength(1);
    expect(stderr).not.toContain("$ pidgen worker enroll");
    expect(stderr).toContain("$ pidgen worker start --detach");
  });

  it("a failed step stops setup with the command, its error and the fix", async () => {
    const h = await harness({ answers: [""], uvFails: true });

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
      ["runtime", "done"],
      ["install", "failed"],
    ]);
    expect(enrollments(h)).toHaveLength(0);
  });

  it("a failing check stops setup before anything is changed, with each check's fix", async () => {
    const h = await harness({ answers: [""], commands: [] });

    const { code, body } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error).toMatchObject({
      code: "DOCTOR_FAILED",
      details: { step: "check", command: "pidgen doctor" },
    });
    expect(String(body.error!.details["fix"])).toMatch(/Install .* and put it on PATH/);
    expect(body.error!.details.steps!.map((entry) => entry.status)).toEqual(["failed"]);
    expect(h.requests.some((request) => request.url.endsWith("/auth/device"))).toBe(false);
    expect(h.questions).toEqual([]);
    expect(await h.uvRuns()).toEqual([]);
  });

  it("--runtime, --version and --label answer the questions in advance", async () => {
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
    );

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions).toEqual([]);
    expect(step(body, "runtime").status).toBe("done");
    expect(step(body, "install").command).toBe(
      "pidgen worker install --runtime wheel --version 1.0.0 && pidgen worker verify",
    );
    expect(step(body, "enroll").command).toBe(
      "pidgen worker enroll --label 'build box' && pidgen worker start --detach",
    );
    expect(enrollments(h)[0]!.body).toEqual({ label: "build box" });
    expect(stderr).toContain(releaseList().eula.notice);
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
      "pidgen worker enroll --label 'build box'",
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
      `pidgen --profile work worker enroll --label ${HOST}`,
      "pidgen --profile work worker start --detach",
      "pidgen --profile work worker status",
      "pidgen --profile work worker doctor",
    ]);
  });

  // AC-746da6cb506b: data.steps reports each step's id, status and command.
  it("reports each step's id, status (done, skipped or failed) and command", async () => {
    const h = await harness({ answers: [""] });

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

  it("re-asks the runtime question on an answer it does not know", async () => {
    const h = await harness({ answers: ["rpm", "wheel"] });

    const { code, stderr } = await h.run("setup", "--url", SERVER);

    expect(code).toBe(ExitCode.Ok);
    expect(h.questions).toHaveLength(2);
    expect(stderr).toMatch(/rpm/);
  });

  it("a stored profile for the server is used and not signed in again", async () => {
    const h = await harness({ answers: [""] });
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

describe("pidgen setup documentation", () => {
  const read = (path: string) => readFile(join(import.meta.dirname, "..", "..", path), "utf8");

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
