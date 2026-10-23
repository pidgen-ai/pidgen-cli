import { spawn, spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { delimiter, join } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../support/temp.js";
import { releaseList } from "../support/worker-install.js";

/**
 * `pidgen setup` on a pseudo-terminal, as a person runs it: the built CLI, against a stub Pidgen
 * server, driven by `harness.py` (Python's `pty` module), which can stop reading the terminal for
 * a while as a terminal does while text is selected, type Ctrl-C (byte 0x03), or send SIGTERM.
 * Skipped where python3 is missing.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const HARNESS = join(import.meta.dirname, "harness.py");
const PYTHON = spawnSync("python3", ["--version"]).status === 0;
const runs = describe.skipIf(!PYTHON || process.platform === "win32");

/** The server's polling interval, in seconds. */
const INTERVAL = 5;
const USER_CODE = "ABCD-EFGH";
const DEVICE_CODE = "fake-device-code-tty";
const CLI_TOKEN = "pidgen_cli_fake_tty_token";
const HEALTH = { service: "pidgen", api_version: { current: "1.0", minimum: "1.0" } };

const CANCELLED = "■  Setup cancelled. Everything before this is kept.";
const CONTINUE = "└  Run pidgen setup again to continue.";

/** A stub Pidgen server: health, the release list, the device-code login, `/me`, `/workers`. */
class StubServer {
  /** When each `POST /auth/device/token` arrived (ms since the epoch). */
  readonly polls: number[] = [];
  approvedAt: number | null = null;
  redeemedAt: number | null = null;
  private server: Server | null = null;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((request, response) => void this.answer(request, response));
    await new Promise<void>((resolveListen) =>
      this.server!.listen(0, "127.0.0.1", () => resolveListen()),
    );
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolveClose) => this.server?.close(() => resolveClose()));
  }

  approve(): void {
    this.approvedAt = Date.now();
  }

  private async answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    for await (const chunk of request) void chunk;
    const path = new URL(request.url ?? "/", this.url).pathname.replace(/^\/api\/v1/, "");
    const ok = (data: unknown) => send(200, { status: "ok", data, meta: null });
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const refuse = (status: number, code: string) =>
      send(status, { status: "error", error: { code, message: code, details: null } });
    switch (`${request.method} ${path}`) {
      case "GET /health":
        return ok(HEALTH);
      case "GET /workers/releases":
        return ok(releaseList());
      case "POST /auth/device":
        return ok({
          device_code: DEVICE_CODE,
          user_code: USER_CODE,
          verification_uri: `${this.url}/device`,
          verification_uri_complete: `${this.url}/device?user_code=${USER_CODE}`,
          expires_in: 600,
          interval: INTERVAL,
        });
      case "POST /auth/device/token":
        this.polls.push(Date.now());
        if (this.approvedAt === null) return refuse(400, "authorization_pending");
        if (this.redeemedAt !== null) return refuse(400, "invalid_grant");
        this.redeemedAt = Date.now();
        return ok({
          access_token: CLI_TOKEN,
          token_type: "Bearer",
          token_id: "tok-tty",
          account_id: "ACC-EXAMPLE",
          user_id: "usr-example",
          device_label: "tty",
          idle_expires_at: "2099-10-27T00:00:00Z",
          absolute_expires_at: "2099-10-27T00:00:00Z",
        });
      case "GET /me":
        return ok({
          user: { user_id: "usr-example", email: "person@example.com", display_name: "Person" },
          memberships: [
            { account_id: "ACC-EXAMPLE", account_name: "Example", role: "administrator" },
          ],
          super_administrator: false,
          mfa: { enabled: false, required: false, recent: false, verified_at: null },
          pending_ownership_transfers: [],
          cli_token: {
            token_id: "tok-tty",
            account_id: "ACC-EXAMPLE",
            kind: "cli",
            scopes: ["tickets:read", "tickets:write", "workers:enroll"],
          },
        });
      case "GET /workers":
        return ok({ workers: [], service_protocol: "1.0", accepted_protocols: ["1.0"] });
      default:
        return refuse(404, "NOT_FOUND");
    }
  }
}

interface Result {
  exit_code: number | null;
  signal: number | null;
  output: string;
  timed_out: string[];
}

type Step =
  | { read_until: string; timeout?: number }
  | { read_for: number }
  | { pause: number }
  | { send: string }
  | { signal: "TERM" }
  | { wait_exit: number }
  | { kill: true };

let cli = "";
let server: StubServer;

runs("pidgen setup on a terminal", () => {
  beforeAll(async () => {
    // The CLI as tsup builds it: one ESM bundle, packages left as imports (resolved from the
    // repository's node_modules, beside which it is written).
    const outdir = join(ROOT, "node_modules", ".cache", "pidgen-setup-tty");
    await mkdir(outdir, { recursive: true });
    cli = join(outdir, `pidgen-${process.pid}.mjs`);
    await build({
      entryPoints: [join(ROOT, "src", "bin", "pidgen.ts")],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      packages: "external",
      define: { __PIDGEN_VERSION__: JSON.stringify("0.0.0-test") },
      outfile: cli,
      logLevel: "silent",
    });
    server = new StubServer();
    await server.start();
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    if (cli !== "") await rm(cli, { force: true });
  });

  /**
   * Runs `pidgen setup --url <stub>` on a pseudo-terminal through `steps`, in a fresh home with a
   * fake uv and git on PATH. `onEvent` hears each harness event as it happens. Returns the result,
   * the setup log, and the most output the CLI ever had queued for the terminal.
   */
  async function setupOnTerminal(
    steps: Step[],
    options: { gitSleep?: number; onEvent?: (name: string, at: number) => void } = {},
  ): Promise<{ result: Result; log: string; peakQueued: number }> {
    const home = await tempDir("pidgen-setup-tty-");
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "uv"), "#!/bin/sh\necho 'uv 0.9.0'\n", { mode: 0o755 });
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\nsleep ${options.gitSleep ?? 0}\necho 'git version 2.43.0'\n`,
      { mode: 0o755 },
    );
    // Watches the CLI's own queue of output for the terminal: the most it ever held.
    const peakFile = join(home, "peak-queued");
    const preload = join(home, "peak.mjs");
    await writeFile(
      preload,
      [
        `import { writeFileSync } from "node:fs";`,
        `let peak = 0;`,
        `writeFileSync(${JSON.stringify(peakFile)}, "0");`,
        `setInterval(() => {`,
        `  const queued = process.stderr.writableLength;`,
        `  if (queued > peak) { peak = queued; writeFileSync(${JSON.stringify(peakFile)}, String(peak)); }`,
        `}, 20).unref();`,
      ].join("\n"),
    );
    const events = join(home, "events.jsonl");
    const resultFile = join(home, "result.json");
    const spec = join(home, "spec.json");
    await writeFile(
      spec,
      JSON.stringify({
        argv: [process.execPath, "--import", preload, cli, "setup", "--url", server.url],
        env: {
          HOME: home,
          PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
          TERM: "xterm-256color",
          LANG: "C.UTF-8",
        },
        cwd: home,
        result: resultFile,
        events,
        steps,
      }),
    );
    const python = spawn("python3", [HARNESS, spec], { stdio: ["ignore", "pipe", "pipe"] });
    let errors = "";
    python.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
    // Hear the harness's events while it runs, each once, and the last ones when it ends.
    let heard = 0;
    let reading = false;
    const hear = async () => {
      if (reading) return;
      reading = true;
      try {
        const text = await readFile(events, "utf8").catch(() => "");
        const lines = text.split("\n").filter((line) => line !== "");
        for (const line of lines.slice(heard)) {
          const entry = JSON.parse(line) as { event: string; at: number };
          options.onEvent?.(entry.event, entry.at * 1000);
        }
        heard = Math.max(heard, lines.length);
      } finally {
        reading = false;
      }
    };
    const watcher = setInterval(() => void hear(), 50);
    const code = await new Promise<number | null>((resolveExit) =>
      python.once("close", resolveExit),
    );
    clearInterval(watcher);
    while (reading) await new Promise((resolveTick) => setTimeout(resolveTick, 10));
    await hear();
    expect(code, errors).toBe(0);
    const result = JSON.parse(await readFile(resultFile, "utf8")) as Result;
    const logs = (await readdir(join(home, ".pidgen", "logs"))).filter((name) =>
      name.startsWith("setup-"),
    );
    const log = logs[0] ? await readFile(join(home, ".pidgen", "logs", logs[0]), "utf8") : "";
    const peakQueued = Number(await readFile(peakFile, "utf8").catch(() => "0"));
    return { result, log, peakQueued };
  }

  // AC-2065505d2988: a terminal that stops reading never holds up the sign-in wait's polling.
  it("keeps polling at the server's interval while the terminal stops reading for 40 s", async () => {
    server.polls.length = 0;
    server.approvedAt = null;
    server.redeemedAt = null;
    let pauseStart = 0;
    let pauseEnd = 0;
    let approval: NodeJS.Timeout | undefined;
    const { result, peakQueued } = await setupOnTerminal(
      [
        { read_until: "Enter open in browser", timeout: 60 },
        { read_for: 2 },
        { pause: 40 },
        { read_until: "Signed in as person@example.com", timeout: 20 },
        { kill: true },
      ],
      {
        onEvent: (name, at) => {
          if (name === "pause-start") {
            pauseStart = at;
            // The person approves in the browser while the terminal is not being read.
            approval = setTimeout(() => server.approve(), 30_000 - (Date.now() - at));
          }
          if (name === "pause-end") pauseEnd = at;
        },
      },
    );
    clearTimeout(approval);

    expect(result.timed_out, result.output).toEqual([]);
    expect(pauseStart).toBeGreaterThan(0);
    expect(pauseEnd - pauseStart).toBeGreaterThanOrEqual(40_000);
    expect(server.approvedAt).not.toBeNull();
    // Polls kept arriving at the interval from the start of the pause until the approval was
    // redeemed (it stalled for 2 min 35 s in the observed run).
    const during = server.polls.filter((at) => at >= pauseStart - INTERVAL * 1000);
    expect(during.length).toBeGreaterThanOrEqual(6);
    for (let index = 1; index < during.length; index++) {
      expect(during[index]! - during[index - 1]!).toBeLessThanOrEqual(INTERVAL * 1000 + 1500);
    }
    // The approval made during the pause was redeemed within one interval, still in the pause.
    expect(server.redeemedAt).not.toBeNull();
    expect(server.redeemedAt! - server.approvedAt!).toBeLessThanOrEqual(INTERVAL * 1000 + 1000);
    expect(server.redeemedAt!).toBeLessThan(pauseEnd);
    // The CLI's queue of output for the terminal stayed small: frames were skipped, not queued.
    // (Queuing every frame instead holds about 60 KB after 40 s; skipping them, under 1 KB.)
    expect(peakQueued).toBeLessThan(64 * 1024);
    expect(peakQueued).toBeLessThan(16 * 1024);
    expect(result.output).toContain("Signed in as person@example.com");
  }, 120_000);

  // AC-c16d531ac9ab: Ctrl-C and SIGTERM stop setup as documented, exit 2.
  it("Ctrl-C (byte 0x03) during a spinner stops setup with exit 2, the cancel lines and the log line", async () => {
    const { result, log } = await setupOnTerminal(
      [
        { read_until: "Checking this machine", timeout: 60 },
        { read_for: 0.5 },
        { send: "\u0003" },
        { wait_exit: 15 },
      ],
      { gitSleep: 30 },
    );
    expect(result.timed_out, result.output).toEqual([]);
    expect(result.exit_code, result.output).toBe(2);
    expect(result.output).toContain(CANCELLED);
    expect(result.output).toContain(CONTINUE);
    expect(log).toContain("answer: cancelled (Ctrl-C)");
    expect(log).toContain("check cancelled (Ctrl-C)");
  }, 60_000);

  it("Ctrl-C (byte 0x03) during the sign-in wait stops setup with exit 2, the cancel lines and the log line", async () => {
    server.approvedAt = null;
    server.redeemedAt = null;
    const { result, log } = await setupOnTerminal([
      { read_until: "Enter open in browser", timeout: 60 },
      { read_for: 0.5 },
      { send: "\u0003" },
      { wait_exit: 15 },
    ]);
    expect(result.timed_out, result.output).toEqual([]);
    expect(result.exit_code, result.output).toBe(2);
    expect(result.output).toContain(CANCELLED);
    expect(result.output).toContain(CONTINUE);
    expect(log).toContain("answer: cancelled (Ctrl-C)");
    expect(log).toContain("sign-in cancelled (Ctrl-C)");
    // The code is for the person: the log never holds it, nor the device code.
    expect(log).not.toContain(USER_CODE);
    expect(log).not.toContain(DEVICE_CODE);
  }, 60_000);

  it("SIGTERM during a spinner stops setup with exit 2, the cancel lines and the log line", async () => {
    const { result, log } = await setupOnTerminal(
      [
        { read_until: "Checking this machine", timeout: 60 },
        { read_for: 0.5 },
        { signal: "TERM" },
        { wait_exit: 15 },
      ],
      { gitSleep: 30 },
    );
    expect(result.timed_out, result.output).toEqual([]);
    expect(result.exit_code, result.output).toBe(2);
    expect(result.output).toContain(CANCELLED);
    expect(result.output).toContain(CONTINUE);
    expect(log).toContain("terminated (SIGTERM)");
    expect(log).toContain("check terminated (SIGTERM)");
  }, 60_000);
});
