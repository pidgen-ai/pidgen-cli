import { afterEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../../src/core/config.js";
import { CliError } from "../../src/core/errors.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { anonymousClient, openSession, responseMeta } from "../../src/core/session.js";
import { jsonResponse, testContext } from "../support/context.js";

const config = {
  default_profile: "default",
  profiles: {
    default: {
      url: "https://pidgen.example.com",
      default_account: "ACC-EXAMPLE",
      credentials: { "ACC-EXAMPLE": { kind: "cli" as const, token: "pidgen_cli_example" } },
    },
  },
};

const global = { timeoutSeconds: 120 };

interface Call {
  url: string;
  headers: Record<string, string>;
}

function recordingFetch(calls: Call[], headers: Record<string, string> = {}): typeof fetch {
  return (input, init) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return Promise.resolve(jsonResponse(200, { status: "ok", data: { id: 1 } }, headers));
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openSession", () => {
  it("builds a client for the stored profile and its default Account", async () => {
    const calls: Call[] = [];
    const ctx = await testContext({ fetch: recordingFetch(calls) });
    await saveConfig(ctx, config);
    const session = await openSession(ctx, global);
    expect(session.target).toEqual({
      profile: "default",
      url: "https://pidgen.example.com",
      token: "pidgen_cli_example",
      account: "ACC-EXAMPLE",
    });
    await session.client.request({ method: "GET", path: "/me" });
    expect(calls[0]?.url).toBe("https://pidgen.example.com/api/v1/me");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer pidgen_cli_example");
    expect(calls[0]?.headers["x-pidgen-account"]).toBe("ACC-EXAMPLE");
  });

  it("environment overrides the profile: PIDGEN_API_URL, PIDGEN_TOKEN and PIDGEN_ACCOUNT", async () => {
    const calls: Call[] = [];
    const ctx = await testContext({ fetch: recordingFetch(calls) });
    await saveConfig(ctx, config);
    ctx.env["PIDGEN_API_URL"] = "https://other.example.com";
    ctx.env["PIDGEN_TOKEN"] = "pidgen_pat_fake";
    ctx.env["PIDGEN_ACCOUNT"] = "ACC-OTHER";
    const session = await openSession(ctx, global);
    expect(session.target).toEqual({
      profile: "default",
      url: "https://other.example.com",
      token: "pidgen_pat_fake",
      account: "ACC-OTHER",
    });
    await session.client.request({ method: "GET", path: "/me" });
    expect(calls[0]?.url).toBe("https://other.example.com/api/v1/me");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer pidgen_pat_fake");
    expect(calls[0]?.headers["x-pidgen-account"]).toBe("ACC-OTHER");
  });

  it("environment overrides the profile even with no config file", async () => {
    const calls: Call[] = [];
    const ctx = await testContext({ fetch: recordingFetch(calls) });
    ctx.env["PIDGEN_API_URL"] = "https://pidgen.example.com";
    ctx.env["PIDGEN_TOKEN"] = "pidgen_pat_fake";
    ctx.env["PIDGEN_ACCOUNT"] = "ACC-EXAMPLE";
    const session = await openSession(ctx, global);
    await session.client.request({ method: "GET", path: "/me" });
    expect(calls[0]?.headers["authorization"]).toBe("Bearer pidgen_pat_fake");
    expect(calls[0]?.headers["x-pidgen-account"]).toBe("ACC-EXAMPLE");
  });

  it("fails with AUTH_REQUIRED and exit code 3 when there is no credential", async () => {
    const ctx = await testContext();
    const error = await openSession(ctx, global).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: "AUTH_REQUIRED", exitCode: ExitCode.Auth });
    expect((error as CliError).exitCode).toBe(3);
  });

  it("with an optional credential and nothing configured, targets the hosted server", async () => {
    const ctx = await testContext();
    const session = await openSession(ctx, global, { credential: "optional" });
    expect(session.target).toMatchObject({ url: "https://api.pidgen.ai", token: null });
  });

  it("passes the --timeout seconds to the client as milliseconds", async () => {
    const calls: Call[] = [];
    const ctx = await testContext({ fetch: recordingFetch(calls) });
    await saveConfig(ctx, config);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const session = await openSession(ctx, { timeoutSeconds: 7 });
    await session.client.request({ method: "GET", path: "/me" });
    expect(timeout).toHaveBeenCalledWith(7000);
  });
});

describe("anonymousClient", () => {
  it("sends no credential or Account even when the environment carries them", async () => {
    const calls: Call[] = [];
    const ctx = await testContext({ fetch: recordingFetch(calls) });
    ctx.env["PIDGEN_TOKEN"] = "pidgen_pat_fake";
    ctx.env["PIDGEN_ACCOUNT"] = "ACC-EXAMPLE";
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const client = anonymousClient(ctx, "https://pidgen.example.com", { timeoutSeconds: 5 });
    await client.request({ method: "GET", path: "/health" });
    expect(calls[0]?.url).toBe("https://pidgen.example.com/api/v1/health");
    expect(calls[0]?.headers["authorization"]).toBeUndefined();
    expect(calls[0]?.headers["x-pidgen-account"]).toBeUndefined();
    expect(timeout).toHaveBeenCalledWith(5000);
  });
});

describe("envelope meta", () => {
  it("meta carries profile, account, request_id and api_version from the response", async () => {
    const calls: Call[] = [];
    const ctx = await testContext({
      fetch: recordingFetch(calls, { "x-request-id": "req-example", "pidgen-api-version": "1.2" }),
    });
    await saveConfig(ctx, config);
    const session = await openSession(ctx, { ...global, profile: "default" });
    const response = await session.client.request({ method: "GET", path: "/me" });
    expect(session.meta(response)).toEqual({
      profile: "default",
      account: "ACC-EXAMPLE",
      request_id: "req-example",
      api_version: "1.2",
    });
  });

  it("meta has null request_id and api_version without a response", () => {
    const target = {
      profile: "work",
      url: "https://pidgen.example.com",
      token: null,
      account: null,
    };
    expect(responseMeta(target)).toEqual({
      profile: "work",
      account: null,
      request_id: null,
      api_version: null,
    });
  });
});
