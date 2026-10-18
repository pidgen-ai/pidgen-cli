import { closeSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { RunContext } from "../../core/context.js";
import { REDACTED, resolvePidgenHome } from "../../core/worker.js";

/** How many setup logs setup keeps: this run's and the nine before it. */
export const SETUP_LOGS_KEPT = 10;

/** `setup-2026-10-17T21-40-12.log`, or `setup-<time>-<n>.log` for a second run in that second. */
const LOG_NAME = /^setup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})(?:-(\d+))?\.log$/;

/**
 * Credentials as Pidgen issues them (`pidgen_cli_…`, `pidgen_pat_…`, `pidgen_enroll_…`,
 * `pidgen_node_…`, and the `awes_` forms), a token after `--token` or `Bearer`, and the value of an
 * environment line naming a token, secret, password or key.
 */
const CREDENTIALS: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:pidgen|awes)_[a-z]+_[A-Za-z0-9_-]+/g, REDACTED],
  [/(--token[= ])(?!\[redacted\])\S+/g, `$1${REDACTED}`],
  [/(\bBearer )(?!\[redacted\])\S+/gi, `$1${REDACTED}`],
  [/(\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)=)(?!\[redacted\])\S+/g, `$1${REDACTED}`],
];

/** `text` with every credential setup knows (`secrets`) or recognises replaced by `[redacted]`. */
export function redactCredentials(text: string, secrets: Iterable<string> = []): string {
  let shown = text;
  for (const secret of secrets) if (secret.length >= 8) shown = shown.split(secret).join(REDACTED);
  for (const [pattern, replacement] of CREDENTIALS) shown = shown.replace(pattern, replacement);
  return shown;
}

/**
 * The log of one `pidgen setup` run: `<worker home>/logs/setup-<start time>.log` (mode 0600), the
 * full record of what the run did, which the screen keeps short. It is written as the run goes,
 * so a run that stops leaves it whole. Nothing written to it can hold a credential: each write is
 * passed through `redactCredentials` with every secret the run has learnt.
 */
export class SetupLog {
  private readonly secrets = new Set<string>();
  private fd: number | null;

  private constructor(
    /** The log's path. */
    readonly path: string,
    fd: number,
    private readonly now: () => number,
  ) {
    this.fd = fd;
  }

  /**
   * Opens a new log for a run that started at `started`, and removes all but the newest
   * `SETUP_LOGS_KEPT` setup logs (this one among them). Nothing else in the folder is touched.
   */
  static open(ctx: Pick<RunContext, "env" | "homeDir" | "now">, started: number): SetupLog {
    const directory = join(resolvePidgenHome(ctx), "logs");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stamp = new Date(started).toISOString().slice(0, 19).replace(/:/g, "-");
    for (let attempt = 1; ; attempt++) {
      const path = join(directory, `setup-${stamp}${attempt === 1 ? "" : `-${attempt}`}.log`);
      let fd: number;
      try {
        fd = openSync(path, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      pruneSetupLogs(directory);
      return new SetupLog(path, fd, () => ctx.now());
    }
  }

  /** Remembers a secret (a token the run holds), so the log never contains it. */
  secret(value: string | null | undefined): void {
    if (value) this.secrets.add(value);
  }

  /** `text` with every credential replaced, as the log would hold it. */
  redact(text: string): string {
    return redactCredentials(text, this.secrets);
  }

  /** Appends `text` as it is, credentials replaced. */
  write(text: string): void {
    if (this.fd === null || text === "") return;
    writeSync(this.fd, redactCredentials(text, this.secrets));
  }

  /** Appends one line. */
  line(text: string): void {
    this.write(`${text}\n`);
  }

  /** Appends `[<time>] <text>`: an action's start, end or result. */
  event(text: string): void {
    this.line(`[${new Date(this.now()).toISOString()}] ${text}`);
  }

  close(): void {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
  }
}

/** Removes all but the newest `SETUP_LOGS_KEPT` setup logs in `directory`, oldest first. */
function pruneSetupLogs(directory: string): void {
  const logs = readdirSync(directory)
    .map((name) => ({ name, match: LOG_NAME.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .sort(
      (a, b) =>
        a.match[1]!.localeCompare(b.match[1]!) || Number(a.match[2] ?? 1) - Number(b.match[2] ?? 1),
    );
  for (const entry of logs.slice(0, Math.max(0, logs.length - SETUP_LOGS_KEPT))) {
    rmSync(join(directory, entry.name), { force: true });
  }
}
