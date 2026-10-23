/**
 * How the CLI leaves the terminal. `pidgen setup` writes to a terminal that may stop reading (a
 * person selecting text, a paused console), so its standard error is non-blocking and output can
 * be queued in memory when the process ends: the CLI waits for it to drain, for up to two seconds,
 * before it exits. Setup stopped by Ctrl-C or SIGTERM leaves work running (a poll's timer, a
 * child process); it asks for the process to exit once its last lines are out.
 */

/** How long the CLI waits for queued output before it exits. */
export const DRAIN_TIMEOUT_MS = 2_000;

let exitRequested = false;

/** Asks for the process to exit once the command has returned and its output has drained. */
export function exitAfterOutput(): void {
  exitRequested = true;
}

/** Whether something asked for the process to exit once its output has drained. */
export function exitIsRequested(): boolean {
  return exitRequested;
}

/**
 * Resolves `true` once nothing is queued on `stream`, or `false` after `timeoutMs` with output
 * still queued.
 */
export async function drained(
  stream: { readonly writableLength: number },
  timeoutMs: number = DRAIN_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (stream.writableLength > 0) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  }
  return true;
}

/**
 * The CLI's last act: waits (up to two seconds in all) for standard error and standard output to
 * drain, then exits with `code` when an exit was asked for. Otherwise the process ends on its own.
 */
export async function finishOutput(
  code: number,
  streams: ReadonlyArray<{ readonly writableLength: number }> = [process.stderr, process.stdout],
  exit: (code: number) => void = (status) => process.exit(status),
): Promise<void> {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  for (const stream of streams) await drained(stream, Math.max(0, deadline - Date.now()));
  if (exitRequested) exit(code);
}
