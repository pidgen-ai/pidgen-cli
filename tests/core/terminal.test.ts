import { describe, expect, it } from "vitest";
import {
  drained,
  exitAfterOutput,
  exitIsRequested,
  finishOutput,
} from "../../src/core/terminal.js";

/** A stream whose queued bytes drop to nothing after `ms`. */
function queued(bytes: number, ms: number): { writableLength: number } {
  const stream = { writableLength: bytes };
  setTimeout(() => (stream.writableLength = 0), ms);
  return stream;
}

// AC-2065505d2988: before setup exits it waits for standard error to drain, for up to 2 seconds.
describe("finishOutput", () => {
  it("waits for queued output to drain, and exits only when asked", async () => {
    const exits: number[] = [];
    const stream = queued(500, 50);
    const started = Date.now();
    await finishOutput(0, [stream], (code) => exits.push(code));
    expect(stream.writableLength).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(exits).toEqual([]);

    exitAfterOutput();
    expect(exitIsRequested()).toBe(true);
    const later = queued(500, 30);
    await finishOutput(2, [later], (code) => exits.push(code));
    expect(later.writableLength).toBe(0);
    expect(exits).toEqual([2]);
  });

  it("gives up on a terminal that never reads after the timeout", async () => {
    const stuck = { writableLength: 300 };
    const started = Date.now();
    expect(await drained(stuck, 100)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(await drained({ writableLength: 0 }, 100)).toBe(true);
  });
});
