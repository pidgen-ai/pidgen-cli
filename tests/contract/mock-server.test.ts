import { describe, expect, it } from "vitest";
import { type LifecycleHooks, startMockServer, useMockServer } from "../support/mock-server.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(`${url}/api/v1/projects`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

describe("mock server harness", () => {
  it("stops the mock server when asked", { timeout: 60_000 }, async () => {
    const server = await startMockServer();
    expect(await reachable(server.url)).toBe(true);
    expect(isAlive(server.pid)).toBe(true);

    await server.stop();

    expect(server.stopped).toBe(true);
    expect(isAlive(server.pid)).toBe(false);
    expect(await reachable(server.url)).toBe(false);
    await server.stop(); // idempotent
  });

  it("stops the mock server after the tests of a suite", { timeout: 60_000 }, async () => {
    const before: Array<() => Promise<void>> = [];
    const after: Array<() => Promise<void>> = [];
    const hooks: LifecycleHooks = {
      beforeAll: (fn) => void before.push(fn),
      afterAll: (fn) => void after.push(fn),
    };
    const server = useMockServer(undefined, {}, hooks);
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(() => server()).toThrow(/not running/);

    // What the runner does around the suite's tests.
    for (const fn of before) await fn();
    const running = server();
    expect(await reachable(running.url)).toBe(true);
    for (const fn of after) await fn();

    expect(running.stopped).toBe(true);
    expect(isAlive(running.pid)).toBe(false);
    expect(await reachable(running.url)).toBe(false);
  });
});
