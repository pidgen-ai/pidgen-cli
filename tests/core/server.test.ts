import { describe, expect, it, vi } from "vitest";
import { ExitCode } from "../../src/core/exit-codes.js";
import { ApiClient } from "../../src/core/http.js";
import { checkServer } from "../../src/core/server.js";
import { serverAccepts } from "../../src/core/version.js";
import { jsonResponse } from "../support/context.js";

function clientReturning(body: unknown) {
  return new ApiClient({
    baseUrl: "https://pidgen.example.com",
    token: null,
    account: null,
    fetch: vi.fn(async () => jsonResponse(200, body)),
    sleep: async () => {},
    timeoutMs: 1000,
  });
}

describe("serverAccepts", () => {
  it("accepts a version inside the server's range", () => {
    expect(serverAccepts({ current: "1.2", minimum: "1.0" }, "1.0")).toBe(true);
    expect(serverAccepts({ current: "1.2", minimum: "1.1" }, "1.0")).toBe(false);
    expect(serverAccepts({ current: "1.2", minimum: "1.1" }, "1.3")).toBe(false);
    expect(serverAccepts({ current: "2.0", minimum: "2.0" }, "1.9")).toBe(false);
  });
});

describe("checkServer", () => {
  it("accepts a Pidgen server in range", async () => {
    const identity = { service: "pidgen", api_version: { current: "1.0", minimum: "1.0" } };
    await expect(checkServer(clientReturning(identity))).resolves.toEqual(identity);
  });

  it("refuses a server that is not Pidgen", async () => {
    await expect(checkServer(clientReturning({ status: "ok" }))).rejects.toMatchObject({
      code: "NOT_PIDGEN",
    });
  });

  it("refuses an incompatible API version with exit 7", async () => {
    const identity = { service: "pidgen", api_version: { current: "2.1", minimum: "2.0" } };
    await expect(checkServer(clientReturning(identity))).rejects.toMatchObject({
      code: "API_VERSION_UNSUPPORTED",
      exitCode: ExitCode.VersionIncompatible,
    });
  });
});
