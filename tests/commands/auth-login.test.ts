import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { configPath, loadConfig, saveConfig } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";

const URL_ = "https://pidgen.example.com";
const TOKEN = "pidgen_pat_fake_token";
const Pidgen = { service: "pidgen", api_version: { current: "1.0", minimum: "1.0" } };

interface Call {
  url: string;
  headers: Record<string, string>;
}

function publicError(status: number, code: string, details: Record<string, unknown> = {}) {
  return jsonResponse(status, {
    status: "error",
    error: { code, message: code, details, request_id: null },
  });
}

const PROJECTS_OK = () => jsonResponse(200, { status: "ok", data: [], meta: null });

/**
 * A fake server: `GET /health` answers `health` with `status`; `GET /projects` (the Personal API
 * Token check) answers `projects`.
 */
async function loginContext(
  health: unknown,
  stdin = `${TOKEN}\n`,
  status = 200,
  projects: () => Response = PROJECTS_OK,
) {
  const calls: Call[] = [];
  const reads: number[] = [];
  const ctx = await testContext({
    fetch: (input, init) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.endsWith("/api/v1/health")) return Promise.resolve(jsonResponse(status, health));
      if (url.endsWith("/api/v1/projects")) return Promise.resolve(projects());
      return Promise.reject(new Error(`unexpected call to ${url}`));
    },
    readStdin: () => {
      reads.push(1);
      return Promise.resolve(stdin);
    },
  });
  return { ctx, calls, reads };
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(argv, ctx);
  return { code, body: envelope(ctx) as unknown as Body };
}

interface Body {
  ok: boolean;
  data: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  meta: Record<string, unknown>;
}

async function configExists(ctx: TestContext): Promise<boolean> {
  return stat(configPath(ctx)).then(
    () => true,
    () => false,
  );
}

describe("pidgen auth login --with-token", () => {
  it("stores the token for the Account in a 0600 config file", async () => {
    const { ctx, calls } = await loginContext({ status: "ok", data: Pidgen });
    const { code, body } = await run(
      ctx,
      "auth",
      "login",
      URL_,
      "--with-token",
      "--account",
      "ACC-EXAMPLE",
    );

    expect(code).toBe(ExitCode.Ok);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({
      profile: "default",
      url: URL_,
      account: "ACC-EXAMPLE",
      credential_kind: "pat",
      verified: true,
      scope_limitation: null,
      server: Pidgen,
    });
    expect(body.meta).toMatchObject({ profile: "default", account: "ACC-EXAMPLE" });
    expect(JSON.stringify(body)).not.toContain(TOKEN);

    // The server check is made first, without any credential; then the token is verified with
    // GET /projects in the named Account.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(`${URL_}/api/v1/health`);
    expect(calls[0]?.headers["authorization"]).toBeUndefined();
    expect(calls[0]?.headers["x-pidgen-account"]).toBeUndefined();
    expect(calls[1]?.url).toBe(`${URL_}/api/v1/projects`);
    expect(calls[1]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(calls[1]?.headers["x-pidgen-account"]).toBe("ACC-EXAMPLE");

    const path = configPath(ctx);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    const saved = await loadConfig(ctx);
    expect(saved.profiles["default"]).toMatchObject({
      url: URL_,
      default_account: "ACC-EXAMPLE",
      server: { ...Pidgen, checked_at: new Date(0).toISOString() },
      credentials: { "ACC-EXAMPLE": { kind: "pat", token: TOKEN } },
    });
    expect(await readFile(path, "utf8")).toContain(TOKEN);
  });

  it("stores the token under --profile and keeps the profile's default Account", async () => {
    const { ctx } = await loginContext(Pidgen, "  pidgen_pat_second  \n");
    await saveConfig(ctx, {
      default_profile: "default",
      profiles: {
        work: {
          url: URL_,
          default_account: "ACC-FIRST",
          credentials: { "ACC-FIRST": { kind: "pat", token: "pidgen_pat_first" } },
        },
      },
    });
    const { code, body } = await run(
      ctx,
      "--profile",
      "work",
      "auth",
      "login",
      `${URL_}/`,
      "--with-token",
      "--account",
      "ACC-SECOND",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ profile: "work", url: URL_, account: "ACC-SECOND" });
    const saved = (await loadConfig(ctx)).profiles["work"];
    expect(saved?.default_account).toBe("ACC-FIRST");
    expect(saved?.credentials).toEqual({
      "ACC-FIRST": { kind: "pat", token: "pidgen_pat_first" },
      "ACC-SECOND": { kind: "pat", token: "pidgen_pat_second" },
    });
  });

  it("stores the token for a new server without keeping the old server's credentials", async () => {
    const { ctx } = await loginContext(Pidgen);
    await saveConfig(ctx, {
      default_profile: "default",
      profiles: {
        default: {
          url: "https://old.example.com",
          default_account: "ACC-OLD",
          credentials: { "ACC-OLD": { kind: "pat", token: "pidgen_pat_old" } },
        },
      },
    });
    const { code } = await run(ctx, "auth", "login", URL_, "--with-token", "--account", "ACC-NEW");
    expect(code).toBe(ExitCode.Ok);
    const saved = (await loadConfig(ctx)).profiles["default"];
    expect(saved?.url).toBe(URL_);
    expect(saved?.default_account).toBe("ACC-NEW");
    expect(Object.keys(saved?.credentials ?? {})).toEqual(["ACC-NEW"]);
  });

  it("invalid token: TOKEN_INVALID from GET /projects exits 3 and writes nothing", async () => {
    const { ctx, calls } = await loginContext(Pidgen, `${TOKEN}\n`, 200, () =>
      publicError(401, "TOKEN_INVALID"),
    );
    const { code, body } = await run(
      ctx,
      "auth",
      "login",
      URL_,
      "--with-token",
      "--account",
      "ACC-EXAMPLE",
    );
    expect(code).toBe(ExitCode.Auth);
    expect(code).toBe(3);
    expect(body.ok).toBe(false);
    expect(body.data).toBeNull();
    expect(body.error?.code).toBe("TOKEN_INVALID");
    expect(body.error?.message).toContain("Nothing was stored");
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/v1/health",
      "/api/v1/projects",
    ]);
    expect(await configExists(ctx)).toBe(false);
  });

  it("invalid token: an existing profile is left exactly as it was", async () => {
    const { ctx } = await loginContext(Pidgen, `${TOKEN}\n`, 200, () =>
      publicError(401, "TOKEN_INVALID"),
    );
    const before = {
      default_profile: "default",
      profiles: {
        default: {
          url: "https://old.example.com",
          default_account: "ACC-OLD",
          credentials: { "ACC-OLD": { kind: "pat" as const, token: "pidgen_pat_old" } },
        },
      },
    };
    await saveConfig(ctx, before);
    const { code } = await run(ctx, "auth", "login", URL_, "--with-token", "--account", "ACC-NEW");
    expect(code).toBe(3);
    expect(await loadConfig(ctx)).toEqual(before);
  });

  it("account mismatch: ACCOUNT_MISMATCH from GET /projects exits 3 and writes nothing", async () => {
    const { ctx, calls } = await loginContext(Pidgen, `${TOKEN}\n`, 200, () =>
      publicError(403, "ACCOUNT_MISMATCH"),
    );
    const { code, body } = await run(
      ctx,
      "auth",
      "login",
      URL_,
      "--with-token",
      "--account",
      "ACC-OTHER",
    );
    expect(code).toBe(ExitCode.Auth);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("ACCOUNT_MISMATCH");
    expect(body.error?.message).toContain("ACC-OTHER");
    expect(body.error?.message).toContain("Nothing was stored");
    expect(calls[1]?.headers["x-pidgen-account"]).toBe("ACC-OTHER");
    expect(await configExists(ctx)).toBe(false);
  });

  it("scope not granted: a valid token without tickets:read is stored with its limitation", async () => {
    const { ctx } = await loginContext(Pidgen, `${TOKEN}\n`, 200, () =>
      publicError(403, "TOKEN_SCOPE_NOT_GRANTED"),
    );
    const { code, body } = await run(
      ctx,
      "auth",
      "login",
      URL_,
      "--with-token",
      "--account",
      "ACC-EXAMPLE",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      account: "ACC-EXAMPLE",
      credential_kind: "pat",
      verified: true,
      scope_limitation: {
        code: "TOKEN_SCOPE_NOT_GRANTED",
        missing_scope: "tickets:read",
        message: "TOKEN_SCOPE_NOT_GRANTED",
      },
    });
    const saved = await loadConfig(ctx);
    expect(saved.profiles["default"]?.credentials).toEqual({
      "ACC-EXAMPLE": { kind: "pat", token: TOKEN },
    });
  });

  it("scope not granted: reports the scope the server names", async () => {
    const { ctx } = await loginContext(Pidgen, `${TOKEN}\n`, 200, () =>
      publicError(403, "TOKEN_SCOPE_NOT_GRANTED", { required_scope: "projects:read" }),
    );
    const { code, body } = await run(
      ctx,
      "auth",
      "login",
      URL_,
      "--with-token",
      "--account",
      "ACC-X",
    );
    expect(code).toBe(0);
    expect(body.data?.["scope_limitation"]).toMatchObject({ missing_scope: "projects:read" });
  });

  it("any other refusal while verifying keeps its code and exit code and writes nothing", async () => {
    const { ctx } = await loginContext(Pidgen, `${TOKEN}\n`, 200, () =>
      publicError(403, "ACCOUNT_LOCKED"),
    );
    const { code, body } = await run(
      ctx,
      "auth",
      "login",
      URL_,
      "--with-token",
      "--account",
      "ACC-X",
    );
    expect(code).toBe(3);
    expect(body.error?.code).toBe("ACCOUNT_LOCKED");
    expect(await configExists(ctx)).toBe(false);

    const failing = await loginContext(Pidgen, `${TOKEN}\n`, 200, () =>
      jsonResponse(500, { status: "error", error: { code: "INTERNAL", message: "boom" } }),
    );
    const second = await run(
      failing.ctx,
      "auth",
      "login",
      URL_,
      "--with-token",
      "--account",
      "ACC-X",
    );
    expect(second.code).toBe(ExitCode.Unexpected);
    expect(await configExists(failing.ctx)).toBe(false);
  });

  it("refuses a server that is not Pidgen with NOT_PIDGEN and writes nothing", async () => {
    const { ctx, calls } = await loginContext({ status: "ok", data: { service: "other" } });
    const { code, body } = await run(
      ctx,
      "auth",
      "login",
      URL_,
      "--with-token",
      "--account",
      "ACC-EXAMPLE",
    );
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("NOT_PIDGEN");
    expect(code).toBe(ExitCode.Unexpected);
    expect(calls[0]?.headers["authorization"]).toBeUndefined();
    expect(await configExists(ctx)).toBe(false);
  });

  it("refuses an incompatible API version with exit 7 and writes nothing", async () => {
    const { ctx } = await loginContext({
      service: "pidgen",
      api_version: { current: "2.1", minimum: "2.0" },
    });
    const { code, body } = await run(
      ctx,
      "auth",
      "login",
      URL_,
      "--with-token",
      "--account",
      "ACC-EXAMPLE",
    );
    expect(code).toBe(ExitCode.VersionIncompatible);
    expect(code).toBe(7);
    expect(body.error?.code).toBe("API_VERSION_UNSUPPORTED");
    expect(await configExists(ctx)).toBe(false);
  });

  it("refuses an incompatible API version reported as HTTP 426 with exit 7", async () => {
    const { ctx } = await loginContext(
      { detail: { code: "API_VERSION_UNSUPPORTED", message: "Upgrade pidgen." } },
      TOKEN,
      426,
    );
    const { code } = await run(ctx, "auth", "login", URL_, "--with-token", "--account", "ACC-X");
    expect(code).toBe(7);
    expect(await configExists(ctx)).toBe(false);
  });

  it("usage: a missing --account exits 2 without reading the token or calling the server", async () => {
    const { ctx, calls, reads } = await loginContext(Pidgen);
    const { code, body } = await run(ctx, "auth", "login", URL_, "--with-token");
    expect(code).toBe(ExitCode.Usage);
    expect(code).toBe(2);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(reads).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(await configExists(ctx)).toBe(false);
  });

  it("usage: an empty token exits 2 without calling the server", async () => {
    const { ctx, calls } = await loginContext(Pidgen, "  \n\t\n");
    const { code, body } = await run(
      ctx,
      "auth",
      "login",
      URL_,
      "--with-token",
      "--account",
      "ACC-EXAMPLE",
    );
    expect(code).toBe(2);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(calls).toHaveLength(0);
    expect(await configExists(ctx)).toBe(false);
  });

  it("without a URL signs in to PIDGEN_API_URL, else the hosted server", async () => {
    const hosted = await loginContext(Pidgen);
    const signIn = ["auth", "login", "--with-token", "--account", "ACC-EXAMPLE"];
    const { code, body } = await run(hosted.ctx, ...signIn);
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ url: "https://api.pidgen.ai" });
    expect(hosted.calls[0]?.url).toBe("https://api.pidgen.ai/api/v1/health");
    expect((await loadConfig(hosted.ctx)).profiles["default"]?.url).toBe("https://api.pidgen.ai");

    const named = await loginContext(Pidgen);
    named.ctx.env["PIDGEN_API_URL"] = URL_;
    expect((await run(named.ctx, ...signIn)).body.data).toMatchObject({ url: URL_ });
    expect(named.calls[0]?.url).toBe(`${URL_}/api/v1/health`);
  });

  it("usage: a URL that is not http(s) exits 2", async () => {
    const { ctx, calls } = await loginContext(Pidgen);
    expect(
      (await run(ctx, "auth", "login", "not a url", "--with-token", "--account", "ACC-X")).code,
    ).toBe(2);
    expect(
      (
        await run(
          ctx,
          "auth",
          "login",
          "ftp://pidgen.example.com",
          "--with-token",
          "--account",
          "ACC-X",
        )
      ).code,
    ).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

const DEVICE_CODE = "fake-device-code-0000";
const USER_CODE = "ABCD-EFGH";
const CLI_TOKEN = "pidgen_cli_fake_token";
const ISSUED = {
  device_code: DEVICE_CODE,
  user_code: USER_CODE,
  verification_uri: `${URL_}/device`,
  verification_uri_complete: `${URL_}/device?user_code=${USER_CODE}`,
  expires_in: 600,
  interval: 5,
};
const TOKEN_ISSUED = {
  access_token: CLI_TOKEN,
  token_type: "Bearer",
  token_id: "tok-example",
  account_id: "ACC-EXAMPLE",
  user_id: "usr-example",
  device_label: "laptop",
  idle_expires_at: "2026-10-27T00:00:00Z",
  absolute_expires_at: "2027-09-27T00:00:00Z",
};

function deviceError(code: string, details: Record<string, unknown> = {}) {
  return jsonResponse(400, {
    status: "error",
    error: { code, message: code, details, request_id: null },
  });
}

interface DeviceCall {
  url: string;
  at: number;
  headers: Record<string, string>;
  body: unknown;
}

const ME = {
  user: { user_id: "usr-example" },
  memberships: [],
  super_administrator: false,
  mfa: {},
  pending_ownership_transfers: [],
  cli_token: { token_id: "tok-example", account_id: "ACC-EXAMPLE" },
};

function meOk(): Response {
  return jsonResponse(200, { status: "ok", data: ME, meta: null });
}

/**
 * A fake server: the health check, then `POST /auth/device`, then one poll answer per poll, then
 * `GET /me` for the verification.
 */
async function deviceContext(
  polls: Response[],
  issued: unknown = ISSUED,
  interactive = false,
  me: () => Response = meOk,
) {
  const calls: DeviceCall[] = [];
  let clock = 0;
  const ctx = await testContext({
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
    fetch: (input, init) => {
      const url = String(input);
      calls.push({
        url,
        at: clock,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (url.endsWith("/api/v1/health")) {
        return Promise.resolve(jsonResponse(200, { status: "ok", data: Pidgen }));
      }
      if (url.endsWith("/api/v1/auth/device")) {
        return Promise.resolve(jsonResponse(200, { status: "ok", data: issued }));
      }
      if (url.endsWith("/api/v1/auth/device/token")) {
        const next = polls.shift();
        if (!next) return Promise.reject(new Error("no more poll answers"));
        return Promise.resolve(next);
      }
      if (url.endsWith("/api/v1/me")) return Promise.resolve(me());
      return Promise.reject(new Error(`unexpected call to ${url}`));
    },
  });
  ctx.io.interactive = interactive;
  const polled = () => calls.filter((call) => call.url.endsWith("/auth/device/token"));
  return { ctx, calls, polled };
}

const tokenOk = () => jsonResponse(200, { status: "ok", data: TOKEN_ISSUED });

describe("pidgen auth login (device code)", () => {
  // AC-13099f01c6dd: stdout selection does not change authentication instructions/progress.
  it.each([undefined, "json", "table"])(
    "keeps verification instructions on stderr with %s output",
    async (format) => {
      const { ctx } = await deviceContext([tokenOk()], ISSUED, true);
      ctx.io.stdoutIsTTY = true;
      const flags = format ? ["--format", format] : [];
      expect(await runCli([...flags, "auth", "login", URL_], ctx)).toBe(ExitCode.Ok);
      expect(ctx.err.join("")).toContain(`Open ${URL_}/device`);
      expect(ctx.err.join("")).toContain(USER_CODE);
      expect(ctx.err.join("")).toContain("Waiting for approval");
      expect(ctx.out.join("")).not.toContain(USER_CODE);
      expect(ctx.out.join("")).not.toContain(DEVICE_CODE);
      expect(ctx.out.join("")).not.toContain(CLI_TOKEN);
      if (format === "json")
        expect(envelope(ctx)).toMatchObject({ ok: true, data: { verified: true } });
      else expect(ctx.out.join("")).toContain("Signed in.");
    },
  );

  it("device code: stores the CLI token for the approved Account and shows the code only on standard error", async () => {
    const { ctx, calls, polled } = await deviceContext([
      deviceError("authorization_pending"),
      deviceError("authorization_pending"),
      tokenOk(),
    ]);
    const { code, body } = await run(ctx, "auth", "login", URL_);

    expect(code).toBe(ExitCode.Ok);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({
      profile: "default",
      url: URL_,
      account: "ACC-EXAMPLE",
      credential_kind: "cli",
      token_id: "tok-example",
      device_label: "laptop",
      expires_at: "2026-10-27T00:00:00Z",
      absolute_expires_at: "2027-09-27T00:00:00Z",
      verified: true,
      server: Pidgen,
    });
    expect(body.meta).toMatchObject({ profile: "default", account: "ACC-EXAMPLE" });

    // Standard output carries only the envelope: no token, no user code, no device code.
    const stdout = ctx.out.join("");
    expect(stdout).not.toContain(CLI_TOKEN);
    expect(stdout).not.toContain(USER_CODE);
    expect(stdout).not.toContain(DEVICE_CODE);
    // Standard error shows the address and user code (even when not a terminal), never secrets.
    const stderr = ctx.err.join("");
    expect(stderr).toContain(USER_CODE);
    expect(stderr).toContain(`${URL_}/device`);
    expect(stderr).not.toContain(DEVICE_CODE);
    expect(stderr).not.toContain(CLI_TOKEN);
    expect(stderr).not.toContain("Waiting");

    // Server check first, then the device request, then polls at the server's interval, then the
    // new token is verified with GET /me.
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/v1/health",
      "/api/v1/auth/device",
      "/api/v1/auth/device/token",
      "/api/v1/auth/device/token",
      "/api/v1/auth/device/token",
      "/api/v1/me",
    ]);
    const verification = calls.at(-1);
    expect(verification?.headers["authorization"]).toBe(`Bearer ${CLI_TOKEN}`);
    expect(verification?.headers["x-pidgen-account"]).toBeUndefined();
    for (const call of calls.slice(0, -1)) {
      expect(call.headers["authorization"]).toBeUndefined();
      expect(call.headers["x-pidgen-account"]).toBeUndefined();
    }
    expect(calls[1]?.body).toEqual({});
    expect(polled()[0]?.body).toEqual({
      device_code: DEVICE_CODE,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    expect(polled().map((call) => call.at)).toEqual([5000, 10000, 15000]);

    const path = configPath(ctx);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    const saved = await loadConfig(ctx);
    expect(saved.profiles["default"]).toEqual({
      url: URL_,
      default_account: "ACC-EXAMPLE",
      server: { ...Pidgen, checked_at: new Date(15000).toISOString() },
      credentials: {
        "ACC-EXAMPLE": {
          kind: "cli",
          token: CLI_TOKEN,
          token_id: "tok-example",
          expires_at: "2026-10-27T00:00:00Z",
        },
      },
    });
  });

  it("verifies with me: the CLI token is checked with GET /me before it is stored", async () => {
    const order: string[] = [];
    const { ctx, calls } = await deviceContext([tokenOk()], ISSUED, false, () => {
      order.push("me");
      return meOk();
    });
    const saved = ctx.fetch;
    ctx.fetch = async (input, init) => {
      const response = await saved(input, init);
      if (order.length === 1) order.push(`config ${String(await configExists(ctx))}`);
      return response;
    };
    const { code, body } = await run(ctx, "auth", "login", URL_);
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ verified: true, credential_kind: "cli" });
    // GET /me answered while nothing had been written yet; the token was stored afterwards.
    expect(order).toEqual(["me", "config false"]);
    expect(calls.filter((call) => call.url.endsWith("/api/v1/me"))).toHaveLength(1);
    expect(await configExists(ctx)).toBe(true);
  });

  it("verifies with me: TOKEN_INVALID from GET /me exits 3 and stores nothing", async () => {
    const { ctx } = await deviceContext([tokenOk()], ISSUED, false, () =>
      deviceError("TOKEN_INVALID"),
    );
    // deviceError answers 400; the refusal still exits 3 because TOKEN_INVALID is an auth failure.
    const { code, body } = await run(ctx, "auth", "login", URL_);
    expect(code).toBe(3);
    expect(body.error?.code).toBe("TOKEN_INVALID");
    expect(body.error?.message).toContain("Nothing was stored");
    expect(ctx.out.join("")).not.toContain(CLI_TOKEN);
    expect(await configExists(ctx)).toBe(false);
  });

  it("verifies with me: a 401 or 403 from GET /me stores nothing", async () => {
    const unauthorised = await deviceContext([tokenOk()], ISSUED, false, () =>
      jsonResponse(401, {
        status: "error",
        error: { code: "TOKEN_INVALID", message: "revoked", details: null, request_id: null },
      }),
    );
    expect((await run(unauthorised.ctx, "auth", "login", URL_)).code).toBe(3);
    expect(await configExists(unauthorised.ctx)).toBe(false);

    const locked = await deviceContext([tokenOk()], ISSUED, false, () =>
      jsonResponse(403, {
        status: "error",
        error: { code: "ACCOUNT_LOCKED", message: "locked", details: null, request_id: null },
      }),
    );
    const { code, body } = await run(locked.ctx, "auth", "login", URL_);
    expect(code).toBe(3);
    expect(body.error?.code).toBe("ACCOUNT_LOCKED");
    expect(await configExists(locked.ctx)).toBe(false);
  });

  it("verifies with me: a token GET /me binds to another Account is ACCOUNT_MISMATCH", async () => {
    const { ctx } = await deviceContext([tokenOk()], ISSUED, false, () =>
      jsonResponse(200, {
        status: "ok",
        data: { ...ME, cli_token: { token_id: "tok-example", account_id: "ACC-OTHER" } },
        meta: null,
      }),
    );
    const { code, body } = await run(ctx, "auth", "login", URL_);
    expect(code).toBe(3);
    expect(body.error?.code).toBe("ACCOUNT_MISMATCH");
    expect(await configExists(ctx)).toBe(false);
  });

  it("device code: says it is waiting only on a terminal, and sends --device-label", async () => {
    const { ctx, calls } = await deviceContext([tokenOk()], ISSUED, true);
    const { code } = await run(ctx, "auth", "login", URL_, "--device-label", "laptop");
    expect(code).toBe(ExitCode.Ok);
    expect(ctx.err.join("")).toContain("Waiting for approval");
    expect(calls[1]?.body).toEqual({ device_label: "laptop" });
  });

  it("device code: stores the token under --profile beside the profile's other Accounts", async () => {
    const { ctx } = await deviceContext([tokenOk()]);
    await saveConfig(ctx, {
      default_profile: "default",
      profiles: {
        work: {
          url: URL_,
          default_account: "ACC-FIRST",
          credentials: { "ACC-FIRST": { kind: "pat", token: "pidgen_pat_first" } },
        },
      },
    });
    const { code, body } = await run(ctx, "--profile", "work", "auth", "login", URL_);
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ profile: "work", account: "ACC-EXAMPLE" });
    const saved = (await loadConfig(ctx)).profiles["work"];
    expect(saved?.default_account).toBe("ACC-FIRST");
    expect(Object.keys(saved?.credentials ?? {}).sort()).toEqual(["ACC-EXAMPLE", "ACC-FIRST"]);
  });

  it("slow_down increases the polling interval", async () => {
    const { ctx, polled } = await deviceContext([
      deviceError("authorization_pending"),
      deviceError("slow_down"),
      deviceError("authorization_pending"),
      deviceError("slow_down", { interval: 30 }),
      tokenOk(),
    ]);
    const { code } = await run(ctx, "auth", "login", URL_);
    expect(code).toBe(ExitCode.Ok);
    const times = polled().map((call) => call.at);
    const gaps = times.map((time, index) => time - (times[index - 1] ?? 0));
    // 5 s, then 5 s more on slow_down without a hint, then the server's 30 s.
    expect(gaps).toEqual([5000, 5000, 10000, 10000, 30000]);
  });

  it("access_denied exits 3 and stores nothing", async () => {
    const { ctx } = await deviceContext([
      deviceError("authorization_pending"),
      deviceError("access_denied"),
    ]);
    const { code, body } = await run(ctx, "auth", "login", URL_);
    expect(code).toBe(ExitCode.Auth);
    expect(code).toBe(3);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("access_denied");
    expect(ctx.out.join("")).not.toContain(USER_CODE);
    expect(await configExists(ctx)).toBe(false);
  });

  it("expired_token exits 3 and stores nothing", async () => {
    const { ctx } = await deviceContext([deviceError("expired_token")]);
    const { code, body } = await run(ctx, "auth", "login", URL_);
    expect(code).toBe(3);
    expect(body.error?.code).toBe("expired_token");
    expect(await configExists(ctx)).toBe(false);
  });

  it("expired_token: gives up at expires_in without polling past it, and stores nothing", async () => {
    const pending = Array.from({ length: 10 }, () => deviceError("authorization_pending"));
    const { ctx, polled } = await deviceContext(pending, { ...ISSUED, expires_in: 12 });
    const { code, body } = await run(ctx, "auth", "login", URL_);
    expect(code).toBe(3);
    expect(body.error?.code).toBe("expired_token");
    expect(polled()).toHaveLength(2);
    expect(await configExists(ctx)).toBe(false);
  });

  it("invalid_grant exits 3 and stores nothing", async () => {
    const { ctx } = await deviceContext([deviceError("invalid_grant")]);
    const { code, body } = await run(ctx, "auth", "login", URL_);
    expect(code).toBe(3);
    expect(body.error?.code).toBe("invalid_grant");
    expect(await configExists(ctx)).toBe(false);
  });

  it("refuses a server that is not Pidgen before requesting a device code", async () => {
    const { ctx, calls } = await loginContext({ status: "ok", data: { service: "other" } });
    const { code, body } = await run(ctx, "auth", "login", URL_);
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("NOT_PIDGEN");
    expect(calls).toHaveLength(1);
    expect(await configExists(ctx)).toBe(false);
  });

  it("a malformed token answer is UNEXPECTED_RESPONSE and never echoes the token", async () => {
    const { ctx } = await deviceContext([
      jsonResponse(200, { status: "ok", data: { access_token: CLI_TOKEN } }),
    ]);
    const { code, body } = await run(ctx, "auth", "login", URL_);
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("UNEXPECTED_RESPONSE");
    expect(ctx.out.join("")).not.toContain(CLI_TOKEN);
    expect(await configExists(ctx)).toBe(false);
  });

  it("usage: --account without --with-token exits 2 without calling the server", async () => {
    const { ctx, calls } = await deviceContext([]);
    const { code, body } = await run(ctx, "auth", "login", URL_, "--account", "ACC-EXAMPLE");
    expect(code).toBe(2);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(calls).toHaveLength(0);
  });

  it("usage: an empty --device-label or a URL that is not http(s) exits 2", async () => {
    const { ctx, calls } = await deviceContext([]);
    expect((await run(ctx, "auth", "login", URL_, "--device-label", "  ")).code).toBe(2);
    expect((await run(ctx, "auth", "login", "ftp://pidgen.example.com")).code).toBe(2);
    expect(calls).toHaveLength(0);
  });
});
