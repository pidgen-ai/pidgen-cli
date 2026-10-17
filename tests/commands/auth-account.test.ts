import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { configPath, loadConfig, saveConfig, type Config } from "../../src/core/config.js";
import type { RunContext } from "../../src/core/context.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";

const URL_ = "https://pidgen.example.com";
const Pidgen = { service: "pidgen", api_version: { current: "1.0", minimum: "1.0" } };
const CHECKED_AT = "2026-01-01T00:00:00.000Z";
const TOKEN_A = "pidgen_pat_fake_token_a";
const TOKEN_B = "pidgen_cli_fake_token_b";

interface Body {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  meta: Record<string, unknown>;
}

/** Two Accounts in the default profile; ACC-EXAMPLE is the default. */
function storedConfig(): Config {
  return {
    default_profile: "default",
    profiles: {
      default: {
        url: URL_,
        default_account: "ACC-EXAMPLE",
        server: { ...Pidgen, checked_at: CHECKED_AT },
        credentials: {
          "ACC-EXAMPLE": { kind: "pat", token: TOKEN_A },
          "ACC-OTHER": {
            kind: "cli",
            token: TOKEN_B,
            token_id: "tok_fake",
            expires_at: "2027-01-01T00:00:00.000Z",
          },
        },
      },
    },
  };
}

/** What `GET /me` answers for the CLI token stored for ACC-OTHER. */
const ME = {
  user: {
    user_id: "usr-example",
    email: "person@example.com",
    display_name: "Example Person",
    email_verified: true,
  },
  memberships: [
    { account_id: "ACC-OTHER", account_name: "Other Example", role: "administrator" },
    { account_id: "ACC-SERVER-ONLY", account_name: "Server Example", role: "member" },
  ],
  super_administrator: false,
  mfa: { enabled: true, required: false, recent: false, verified_at: null },
  pending_ownership_transfers: [],
  cli_token: { token_id: "tok_fake", account_id: "ACC-OTHER" },
};

interface Sent {
  url: string;
  headers: Record<string, string>;
}

/** A fake server that answers `GET /me` with `answer` and refuses any other call. */
function meServer(sent: Sent[], answer: () => Response = () => meOk()): RunContext["fetch"] {
  return (input, init) => {
    const url = String(input);
    sent.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url === `${URL_}/api/v1/me`) return Promise.resolve(answer());
    return Promise.reject(new Error(`unexpected call to ${url}`));
  };
}

function meOk(data: unknown = ME): Response {
  return jsonResponse(200, { status: "ok", data, meta: null }, { "x-request-id": "req-me" });
}

async function setup(options: { config?: Config | null; overrides?: Partial<RunContext> } = {}) {
  const calls: string[] = [];
  const ctx = await testContext({
    fetch: (input) => {
      calls.push(String(input));
      return Promise.reject(new Error("unexpected network call"));
    },
    ...options.overrides,
  });
  const config = options.config === undefined ? storedConfig() : options.config;
  if (config) await saveConfig(ctx, config);
  return { ctx, calls };
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(argv, ctx);
  return { code, body: envelope(ctx) as unknown as Body };
}

async function configExists(ctx: TestContext): Promise<boolean> {
  return stat(configPath(ctx)).then(
    () => true,
    () => false,
  );
}

describe("pidgen auth status", () => {
  it("status reports profile, url, Account, credential kind and cached server without a network call", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "auth", "status");
    expect(code).toBe(ExitCode.Ok);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({
      profile: "default",
      url: URL_,
      account: "ACC-EXAMPLE",
      default_account: "ACC-EXAMPLE",
      credential_kind: "pat",
      credential_source: "config",
      expires_at: null,
      server: { ...Pidgen, checked_at: CHECKED_AT },
      identity: null,
      identity_note:
        "The server does not describe Personal API Tokens on GET /me, so only the local profile is shown.",
    });
    expect(body.meta).toMatchObject({ profile: "default", account: "ACC-EXAMPLE" });
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain(TOKEN_A);
  });

  it("status with --account reports that Account's credential kind and expiry", async () => {
    const sent: Sent[] = [];
    const { ctx } = await setup({ overrides: { fetch: meServer(sent) } });
    const { code, body } = await run(ctx, "auth", "status", "--account", "ACC-OTHER");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({
      account: "ACC-OTHER",
      default_account: "ACC-EXAMPLE",
      credential_kind: "cli",
      expires_at: "2027-01-01T00:00:00.000Z",
    });
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain(TOKEN_B);
  });

  it("status reads me: a CLI token reports the User, Account and role from GET /me", async () => {
    const sent: Sent[] = [];
    const { ctx } = await setup({ overrides: { fetch: meServer(sent) } });
    const { code, body } = await run(ctx, "auth", "status", "--account", "ACC-OTHER");
    expect(code).toBe(ExitCode.Ok);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({
      profile: "default",
      url: URL_,
      account: "ACC-OTHER",
      default_account: "ACC-EXAMPLE",
      credential_kind: "cli",
      credential_source: "config",
      expires_at: "2027-01-01T00:00:00.000Z",
      server: { ...Pidgen, checked_at: CHECKED_AT },
      identity: {
        user: {
          user_id: "usr-example",
          email: "person@example.com",
          display_name: "Example Person",
        },
        account: "ACC-OTHER",
        account_name: "Other Example",
        role: "administrator",
        token_id: "tok_fake",
      },
      identity_note: null,
    });
    expect(body.meta).toMatchObject({
      profile: "default",
      account: "ACC-OTHER",
      request_id: "req-me",
    });
    // One GET /me, with the CLI token and without an Account: /me is not Account-scoped.
    expect(sent.map((call) => call.url)).toEqual([`${URL_}/api/v1/me`]);
    expect(sent[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN_B}`);
    expect(sent[0]?.headers["x-pidgen-account"]).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(TOKEN_B);
  });

  // pidgen_cli_ is the prefix the server issues; awes_cli_ that of CLI tokens it issued before.
  it.each(["pidgen_cli_env_fake", "awes_cli_env_fake"])(
    "status reads me: an PIDGEN_TOKEN CLI token (%s) is sent to GET /me too",
    async (token) => {
      const sent: Sent[] = [];
      const { ctx } = await setup({
        config: null,
        overrides: {
          env: {
            PIDGEN_API_URL: URL_,
            PIDGEN_TOKEN: token,
            PIDGEN_ACCOUNT: "ACC-OTHER",
          },
          fetch: meServer(sent),
        },
      });
      const { code, body } = await run(ctx, "auth", "status");
      expect(code).toBe(ExitCode.Ok);
      expect(body.data).toMatchObject({
        credential_kind: "cli",
        credential_source: "environment",
        identity: { account: "ACC-OTHER", role: "administrator" },
        identity_note: null,
      });
      expect(sent[0]?.headers["authorization"]).toBe(`Bearer ${token}`);
      expect(JSON.stringify(body)).not.toContain(token);
    },
  );

  it("status reads me: the Account is the one the CLI token is bound to, with no role when not a member", async () => {
    const sent: Sent[] = [];
    const { ctx } = await setup({
      overrides: {
        fetch: meServer(sent, () =>
          meOk({ ...ME, cli_token: { token_id: "tok_fake", account_id: "ACC-ELSEWHERE" } }),
        ),
      },
    });
    const { code, body } = await run(ctx, "auth", "status", "--account", "ACC-OTHER");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({
      account: "ACC-OTHER",
      identity: { account: "ACC-ELSEWHERE", account_name: null, role: null },
    });
  });

  it("status reads me: a refused CLI token keeps the server's code and exit code", async () => {
    const sent: Sent[] = [];
    const { ctx } = await setup({
      overrides: {
        fetch: meServer(sent, () =>
          jsonResponse(401, {
            status: "error",
            error: { code: "TOKEN_INVALID", message: "The token is revoked or expired." },
          }),
        ),
      },
    });
    const { code, body } = await run(ctx, "auth", "status", "--account", "ACC-OTHER");
    expect(code).toBe(ExitCode.Auth);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("TOKEN_INVALID");
    expect(JSON.stringify(body)).not.toContain(TOKEN_B);
  });

  it("status reads me: an answer that does not match the document is UNEXPECTED_RESPONSE", async () => {
    const sent: Sent[] = [];
    const { ctx } = await setup({
      overrides: { fetch: meServer(sent, () => meOk({ user: { user_id: 1 } })) },
    });
    const { code, body } = await run(ctx, "auth", "status", "--account", "ACC-OTHER");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("UNEXPECTED_RESPONSE");
  });

  it("status with token: a Personal API Token reports the local profile and never calls GET /me", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "auth", "status");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({
      account: "ACC-EXAMPLE",
      credential_kind: "pat",
      identity: null,
    });
    const note = (body.data as Record<string, unknown>)["identity_note"];
    expect(note).toContain("does not describe Personal API Tokens on GET /me");
    expect(calls).toHaveLength(0);
  });

  it("status with token: an PIDGEN_TOKEN Personal API Token never calls GET /me either", async () => {
    const { ctx, calls } = await setup({
      config: null,
      overrides: {
        env: {
          PIDGEN_API_URL: URL_,
          PIDGEN_TOKEN: "pidgen_pat_env_fake",
          PIDGEN_ACCOUNT: "ACC-EXAMPLE",
        },
      },
    });
    const { code, body } = await run(ctx, "auth", "status");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ credential_kind: "pat", identity: null });
    expect(calls).toHaveLength(0);
  });

  it("status reports an PIDGEN_TOKEN credential as coming from the environment", async () => {
    const { ctx, calls } = await setup({
      config: null,
      overrides: {
        env: {
          PIDGEN_API_URL: URL_,
          PIDGEN_TOKEN: "pidgen_pat_env_fake",
          PIDGEN_ACCOUNT: "ACC-EXAMPLE",
        },
      },
    });
    const { code, body } = await run(ctx, "auth", "status");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual({
      profile: "default",
      url: URL_,
      account: "ACC-EXAMPLE",
      default_account: null,
      credential_kind: "pat",
      credential_source: "environment",
      expires_at: null,
      server: null,
      identity: null,
      identity_note:
        "The server does not describe Personal API Tokens on GET /me, so only the local profile is shown.",
    });
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain("pidgen_pat_env_fake");
  });

  it("status with an unrecognised PIDGEN_TOKEN reports the local profile without calling GET /me", async () => {
    const { ctx, calls } = await setup({
      config: null,
      overrides: {
        env: { PIDGEN_API_URL: URL_, PIDGEN_TOKEN: "fake-token", PIDGEN_ACCOUNT: "ACC-EXAMPLE" },
      },
    });
    const { code, body } = await run(ctx, "auth", "status");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ credential_kind: null, identity: null });
    expect((body.data as Record<string, unknown>)["identity_note"]).toContain(
      "not a recognised CLI token",
    );
    expect(calls).toHaveLength(0);
  });

  it("status --check with a CLI token checks the server, then reads GET /me", async () => {
    const sent: Sent[] = [];
    const me = meServer(sent);
    const { ctx } = await setup({
      overrides: {
        fetch: (input, init) =>
          String(input).endsWith("/api/v1/health")
            ? Promise.resolve(jsonResponse(200, Pidgen))
            : me(input, init),
      },
    });
    const { code, body } = await run(ctx, "auth", "status", "--check", "--account", "ACC-OTHER");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({
      server: { service: "pidgen" },
      identity: { role: "administrator" },
    });
    expect(sent.map((call) => call.url)).toEqual([`${URL_}/api/v1/me`]);
  });

  it("status --check re-runs the server check without the credential", async () => {
    const headers: Record<string, string>[] = [];
    const { ctx } = await setup({
      overrides: {
        fetch: (_input, init) => {
          headers.push((init?.headers ?? {}) as Record<string, string>);
          return Promise.resolve(
            jsonResponse(200, {
              service: "pidgen",
              api_version: { current: "1.1", minimum: "1.0" },
            }),
          );
        },
      },
    });
    const { code, body } = await run(ctx, "auth", "status", "--check");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({
      server: {
        service: "pidgen",
        api_version: { current: "1.1", minimum: "1.0" },
        checked_at: new Date(0).toISOString(),
      },
    });
    expect(headers).toHaveLength(1);
    expect(headers[0]?.["authorization"]).toBeUndefined();
    expect(headers[0]?.["x-pidgen-account"]).toBeUndefined();
  });

  it("status --check refuses a server that is not Pidgen with NOT_PIDGEN (exit 1)", async () => {
    const { ctx } = await setup({
      overrides: { fetch: () => Promise.resolve(jsonResponse(200, { service: "other" })) },
    });
    const { code, body } = await run(ctx, "auth", "status", "--check");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("NOT_PIDGEN");
  });

  it("status --check refuses an incompatible API version with exit 7", async () => {
    const { ctx } = await setup({
      overrides: {
        fetch: () =>
          Promise.resolve(
            jsonResponse(200, {
              service: "pidgen",
              api_version: { current: "2.1", minimum: "2.0" },
            }),
          ),
      },
    });
    const { code, body } = await run(ctx, "auth", "status", "--check");
    expect(code).toBe(ExitCode.VersionIncompatible);
    expect(body.error?.code).toBe("API_VERSION_UNSUPPORTED");
  });

  it("status with nothing configured exits 3 with AUTH_REQUIRED", async () => {
    const { ctx, calls } = await setup({ config: null });
    const { code, body } = await run(ctx, "auth", "status");
    expect(code).toBe(ExitCode.Auth);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("AUTH_REQUIRED");
    expect(calls).toHaveLength(0);
  });

  it("status for an Account without a credential exits 3 with AUTH_REQUIRED", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "auth", "status", "--account", "ACC-MISSING");
    expect(code).toBe(ExitCode.Auth);
    expect(body.error?.code).toBe("AUTH_REQUIRED");
    expect(body.error?.details["hint"]).toContain("pidgen auth login");
    expect(calls).toHaveLength(0);
  });

  it("status usage: an unknown option or an extra argument exits 2", async () => {
    const { ctx } = await setup();
    expect((await run(ctx, "auth", "status", "--nope")).code).toBe(ExitCode.Usage);
    const { code, body } = await run(ctx, "auth", "status", "extra");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
  });
});

describe("pidgen auth logout", () => {
  it("logout removes the stored credential for the current Account and clears the default", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "auth", "logout");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual({
      profile: "default",
      account: "ACC-EXAMPLE",
      removed: true,
      revoked: false,
      default_account: null,
    });
    expect(body.meta).toMatchObject({ profile: "default", account: "ACC-EXAMPLE" });
    expect(calls).toHaveLength(0);

    const saved = (await loadConfig(ctx)).profiles["default"];
    expect(saved?.default_account).toBeUndefined();
    expect(Object.keys(saved?.credentials ?? {})).toEqual(["ACC-OTHER"]);
    expect(await readFile(configPath(ctx), "utf8")).not.toContain(TOKEN_A);
    if (process.platform !== "win32") {
      expect((await stat(configPath(ctx))).mode & 0o777).toBe(0o600);
    }
  });

  it("logout --account removes that Account's credential and keeps the default", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "auth", "logout", "--account", "ACC-OTHER");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ account: "ACC-OTHER", default_account: "ACC-EXAMPLE" });
    const saved = (await loadConfig(ctx)).profiles["default"];
    expect(saved?.default_account).toBe("ACC-EXAMPLE");
    expect(Object.keys(saved?.credentials ?? {})).toEqual(["ACC-EXAMPLE"]);
    expect(await readFile(configPath(ctx), "utf8")).not.toContain(TOKEN_B);
  });

  it("logout for an Account without a credential exits 4 with CREDENTIAL_NOT_FOUND", async () => {
    const { ctx } = await setup();
    const before = await readFile(configPath(ctx), "utf8");
    const { code, body } = await run(ctx, "auth", "logout", "--account", "ACC-MISSING");
    expect(code).toBe(ExitCode.NotFound);
    expect(body.error?.code).toBe("CREDENTIAL_NOT_FOUND");
    expect(await readFile(configPath(ctx), "utf8")).toBe(before);
  });

  it("logout with no configuration exits 4 and writes nothing", async () => {
    const { ctx } = await setup({ config: null });
    const { code, body } = await run(ctx, "auth", "logout");
    expect(code).toBe(ExitCode.NotFound);
    expect(body.error?.code).toBe("CREDENTIAL_NOT_FOUND");
    expect(await configExists(ctx)).toBe(false);
  });

  it("logout usage: an extra argument exits 2", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "auth", "logout", "ACC-EXAMPLE");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(
      Object.keys((await loadConfig(ctx)).profiles["default"]?.credentials ?? {}),
    ).toHaveLength(2);
  });
});

describe("pidgen account", () => {
  it("list local only: with a Personal API Token, lists the stored Accounts and marks the default", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "account", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual([
      {
        account: "ACC-EXAMPLE",
        account_name: null,
        role: null,
        member: null,
        default: true,
        credential_stored: true,
        credential_kind: "pat",
        expires_at: null,
      },
      {
        account: "ACC-OTHER",
        account_name: null,
        role: null,
        member: null,
        default: false,
        credential_stored: true,
        credential_kind: "cli",
        expires_at: "2027-01-01T00:00:00.000Z",
      },
    ]);
    expect(body.meta).toMatchObject({ profile: "default", account: "ACC-EXAMPLE" });
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain(TOKEN_A);
  });

  it("list local only: an PIDGEN_TOKEN Personal API Token makes no network call", async () => {
    const { ctx, calls } = await setup({
      overrides: { env: { PIDGEN_TOKEN: "pidgen_pat_env_fake" } },
    });
    const { code, body } = await run(ctx, "account", "list", "--account", "ACC-OTHER");
    expect(code).toBe(ExitCode.Ok);
    expect((body.data as unknown[]).length).toBe(2);
    expect(body.data).toMatchObject([{ member: null }, { member: null }]);
    expect(calls).toHaveLength(0);
  });

  it("list local only: marks no default and is empty when the profile has no credentials", async () => {
    const { ctx, calls } = await setup({ config: null });
    const { code, body } = await run(ctx, "--profile", "work", "account", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual([]);
    expect(body.meta).toMatchObject({ profile: "work", account: null });
    expect(calls).toHaveLength(0);
  });

  it("list merges the Accounts from GET /me with the stored credentials, marking the default", async () => {
    const sent: Sent[] = [];
    const { ctx } = await setup({ overrides: { fetch: meServer(sent) } });
    const { code, body } = await run(ctx, "account", "list", "--account", "ACC-OTHER");
    expect(code).toBe(ExitCode.Ok);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([
      // Stored, but GET /me does not list it among your Accounts.
      {
        account: "ACC-EXAMPLE",
        account_name: null,
        role: null,
        member: false,
        default: true,
        credential_stored: true,
        credential_kind: "pat",
        expires_at: null,
      },
      // A member, with a stored credential.
      {
        account: "ACC-OTHER",
        account_name: "Other Example",
        role: "administrator",
        member: true,
        default: false,
        credential_stored: true,
        credential_kind: "cli",
        expires_at: "2027-01-01T00:00:00.000Z",
      },
      // A member, with no stored credential.
      {
        account: "ACC-SERVER-ONLY",
        account_name: "Server Example",
        role: "member",
        member: true,
        default: false,
        credential_stored: false,
        credential_kind: null,
        expires_at: null,
      },
    ]);
    expect(body.meta).toMatchObject({
      profile: "default",
      account: "ACC-EXAMPLE",
      request_id: "req-me",
    });
    expect(sent.map((call) => call.url)).toEqual([`${URL_}/api/v1/me`]);
    expect(sent[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN_B}`);
    expect(sent[0]?.headers["x-pidgen-account"]).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(TOKEN_B);
    expect(JSON.stringify(body)).not.toContain(TOKEN_A);
  });

  it("list merges when the default Account holds the CLI token", async () => {
    const config = storedConfig();
    config.profiles["default"]!.default_account = "ACC-OTHER";
    const sent: Sent[] = [];
    const { ctx } = await setup({ config, overrides: { fetch: meServer(sent) } });
    const { code, body } = await run(ctx, "account", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject([
      { account: "ACC-EXAMPLE", default: false, member: false },
      { account: "ACC-OTHER", default: true, member: true, role: "administrator" },
      { account: "ACC-SERVER-ONLY", default: false, member: true, credential_stored: false },
    ]);
    expect(sent).toHaveLength(1);
  });

  it("list merges with an PIDGEN_TOKEN CLI token and no stored profile", async () => {
    const sent: Sent[] = [];
    const { ctx } = await setup({
      config: null,
      overrides: {
        env: { PIDGEN_API_URL: URL_, PIDGEN_TOKEN: "pidgen_cli_env_fake" },
        fetch: meServer(sent),
      },
    });
    const { code, body } = await run(ctx, "account", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject([
      { account: "ACC-OTHER", member: true, default: false, credential_stored: false },
      { account: "ACC-SERVER-ONLY", member: true, default: false, credential_stored: false },
    ]);
    expect(sent[0]?.headers["authorization"]).toBe("Bearer pidgen_cli_env_fake");
  });

  it("list merges: a refused CLI token keeps the server's code and exit code", async () => {
    const sent: Sent[] = [];
    const { ctx } = await setup({
      overrides: {
        fetch: meServer(sent, () =>
          jsonResponse(401, {
            status: "error",
            error: { code: "TOKEN_INVALID", message: "The token is revoked or expired." },
          }),
        ),
      },
    });
    const { code, body } = await run(ctx, "account", "list", "--account", "ACC-OTHER");
    expect(code).toBe(ExitCode.Auth);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("TOKEN_INVALID");
  });

  it("list usage: an extra argument exits 2", async () => {
    const { ctx } = await setup();
    expect((await run(ctx, "account", "list", "extra")).code).toBe(ExitCode.Usage);
  });

  it("use switches the default Account", async () => {
    const calls: Sent[] = [];
    const { ctx } = await setup({ overrides: { fetch: meServer(calls) } });
    const { code, body } = await run(ctx, "account", "use", "ACC-OTHER");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual({
      profile: "default",
      account: "ACC-OTHER",
      previous_default: "ACC-EXAMPLE",
      credential_kind: "cli",
    });
    expect(calls).toHaveLength(0);
    const saved = (await loadConfig(ctx)).profiles["default"];
    expect(saved?.default_account).toBe("ACC-OTHER");
    expect(Object.keys(saved?.credentials ?? {})).toEqual(["ACC-EXAMPLE", "ACC-OTHER"]);

    // The switch is what later commands see.
    const listed = await run(ctx, "account", "list");
    expect(listed.body.data).toMatchObject([
      { account: "ACC-EXAMPLE", default: false },
      { account: "ACC-OTHER", default: true },
      { account: "ACC-SERVER-ONLY", default: false },
    ]);
    const status = await run(ctx, "auth", "status");
    expect(status.body.data).toMatchObject({
      account: "ACC-OTHER",
      credential_kind: "cli",
      identity: { account: "ACC-OTHER", role: "administrator" },
    });
  });

  it("use without credential exits 3 with AUTH_REQUIRED and a hint to log in", async () => {
    const { ctx, calls } = await setup();
    const before = await readFile(configPath(ctx), "utf8");
    const { code, body } = await run(ctx, "account", "use", "ACC-MISSING");
    expect(code).toBe(ExitCode.Auth);
    expect(code).toBe(3);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("AUTH_REQUIRED");
    expect(body.error?.message).toContain("pidgen auth login");
    expect(body.error?.details).toMatchObject({
      profile: "default",
      account: "ACC-MISSING",
      hint: "pidgen auth login <url> --with-token --account ACC-MISSING",
    });
    expect(calls).toHaveLength(0);
    expect(await readFile(configPath(ctx), "utf8")).toBe(before);
  });

  it("use without credential in an empty configuration exits 3 and writes nothing", async () => {
    const { ctx } = await setup({ config: null });
    const { code, body } = await run(ctx, "account", "use", "ACC-EXAMPLE");
    expect(code).toBe(3);
    expect(body.error?.code).toBe("AUTH_REQUIRED");
    expect(await configExists(ctx)).toBe(false);
  });

  it("use usage: a missing Account id exits 2", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "account", "use");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect((await loadConfig(ctx)).profiles["default"]?.default_account).toBe("ACC-EXAMPLE");
  });
});
