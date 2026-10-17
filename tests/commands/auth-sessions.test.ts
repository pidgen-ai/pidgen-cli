import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { loadConfig, saveConfig, type Config } from "../../src/core/config.js";
import type { RunContext } from "../../src/core/context.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";

const URL_ = "https://pidgen.example.com";
const PAT = "pidgen_pat_fake_token_a";
const CLI = "pidgen_cli_fake_token_b";
const CLI_OTHER = "pidgen_cli_fake_token_c";

interface Body {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  meta: Record<string, unknown>;
}

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/** ACC-EXAMPLE (default) holds a CLI token, ACC-OTHER another CLI token, ACC-PAT a Personal API Token. */
function storedConfig(): Config {
  return {
    default_profile: "default",
    profiles: {
      default: {
        url: URL_,
        default_account: "ACC-EXAMPLE",
        credentials: {
          "ACC-EXAMPLE": {
            kind: "cli",
            token: CLI,
            token_id: "tok-current",
            expires_at: "2027-01-01T00:00:00.000Z",
          },
          "ACC-OTHER": { kind: "cli", token: CLI_OTHER, token_id: "tok-other" },
          "ACC-PAT": { kind: "pat", token: PAT },
        },
      },
    },
  };
}

/** What `GET /me/sessions` answers: one browser session and two CLI tokens, the first current. */
const SESSIONS = [
  {
    kind: "session",
    session_id: "ses-browser",
    device_label: "Firefox on Linux",
    ip_prefix: "192.0.2.0/24",
    created_at: "2026-09-01T00:00:00Z",
    last_seen_at: "2026-09-27T00:00:00Z",
    current: false,
    mfa_verified: true,
  },
  {
    kind: "cli_token",
    session_id: "tok-current",
    account_id: "ACC-EXAMPLE",
    device_label: "laptop",
    ip_prefix: null,
    created_at: "2026-09-02T00:00:00Z",
    last_seen_at: "2026-09-28T00:00:00Z",
    expires_at: "2026-10-28T00:00:00Z",
    current: true,
    mfa_verified: false,
  },
  {
    kind: "cli_token",
    session_id: "tok-elsewhere",
    account_id: "ACC-SERVER-ONLY",
    device_label: null,
    ip_prefix: null,
    created_at: "2026-09-03T00:00:00Z",
    last_seen_at: "2026-09-03T00:00:00Z",
    expires_at: "2026-10-03T00:00:00Z",
    current: false,
    mfa_verified: false,
  },
];

function ok(data: unknown, requestId = "req-sessions"): Response {
  return jsonResponse(200, { status: "ok", data, meta: null }, { "x-request-id": requestId });
}

function refusal(status: number, code: string, message = "Refused."): Response {
  return jsonResponse(status, { status: "error", error: { code, message, details: {} } });
}

/** A fake server: `answer` decides each call's response; every call is recorded in `sent`. */
function server(sent: Sent[], answer: (call: Sent) => Response | undefined): RunContext["fetch"] {
  return (input, init) => {
    const call = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    sent.push(call);
    const response = answer(call);
    return response
      ? Promise.resolve(response)
      : Promise.reject(new Error(`unexpected call to ${call.method} ${call.url}`));
  };
}

async function setup(
  answer: (call: Sent) => Response | undefined = () => undefined,
  options: { config?: Config | null; env?: Record<string, string> } = {},
) {
  const sent: Sent[] = [];
  const ctx = await testContext({ fetch: server(sent, answer), env: options.env ?? {} });
  const config = options.config === undefined ? storedConfig() : options.config;
  if (config) await saveConfig(ctx, config);
  return { ctx, sent };
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(argv, ctx);
  return { code, body: envelope(ctx) as unknown as Body };
}

function header(call: Sent, name: string): string | undefined {
  const entry = Object.entries(call.headers).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

const listAnswer = (call: Sent) =>
  call.method === "GET" && call.url === `${URL_}/api/v1/me/sessions` ? ok(SESSIONS) : undefined;

describe("pidgen auth list", () => {
  it("list shows sessions and CLI tokens and marks the current one", async () => {
    const { ctx, sent } = await setup(listAnswer);
    const { code, body } = await run(ctx, "auth", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(body.ok).toBe(true);
    expect(body.error).toBeNull();
    expect(body.data).toEqual([
      {
        id: "ses-browser",
        kind: "session",
        account: null,
        device_label: "Firefox on Linux",
        created_at: "2026-09-01T00:00:00Z",
        last_used_at: "2026-09-27T00:00:00Z",
        expires_at: null,
        current: false,
        mfa_verified: true,
        stored_account: null,
      },
      {
        id: "tok-current",
        kind: "cli_token",
        account: "ACC-EXAMPLE",
        device_label: "laptop",
        created_at: "2026-09-02T00:00:00Z",
        last_used_at: "2026-09-28T00:00:00Z",
        expires_at: "2026-10-28T00:00:00Z",
        current: true,
        mfa_verified: false,
        stored_account: "ACC-EXAMPLE",
      },
      {
        id: "tok-elsewhere",
        kind: "cli_token",
        account: "ACC-SERVER-ONLY",
        device_label: null,
        created_at: "2026-09-03T00:00:00Z",
        last_used_at: "2026-09-03T00:00:00Z",
        expires_at: "2026-10-03T00:00:00Z",
        current: false,
        mfa_verified: false,
        stored_account: null,
      },
    ]);
    expect(body.meta).toMatchObject({
      profile: "default",
      account: "ACC-EXAMPLE",
      request_id: "req-sessions",
    });
    // One call, with the CLI token and no Account: the route is not Account-scoped.
    expect(sent).toHaveLength(1);
    expect(header(sent[0]!, "authorization")).toBe(`Bearer ${CLI}`);
    expect(header(sent[0]!, "x-pidgen-account")).toBeUndefined();
    // The token secret is never printed.
    expect(ctx.out.join("")).not.toContain(CLI);
  });

  it("list uses a CLI token from PIDGEN_TOKEN without a stored profile", async () => {
    const { ctx } = await setup(listAnswer, {
      config: null,
      env: { PIDGEN_API_URL: URL_, PIDGEN_TOKEN: CLI },
    });
    const { code, body } = await run(ctx, "auth", "list");
    expect(code).toBe(ExitCode.Ok);
    expect((body.data as Array<{ current: boolean }>).filter((e) => e.current)).toHaveLength(1);
  });

  it("list keeps a server refusal's code and exit code", async () => {
    const { ctx } = await setup(() => refusal(401, "TOKEN_INVALID", "The token is revoked."));
    const { code, body } = await run(ctx, "auth", "list");
    expect(code).toBe(ExitCode.Auth);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("TOKEN_INVALID");
  });

  it("list reports an answer that does not match the public API document", async () => {
    const { ctx } = await setup(() => ok([{ kind: "session", session_id: 7 }]));
    const { code, body } = await run(ctx, "auth", "list");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("UNEXPECTED_RESPONSE");
  });

  it("list without a credential is AUTH_REQUIRED and makes no network call", async () => {
    const { ctx, sent } = await setup(undefined, {
      config: { default_profile: "default", profiles: { default: { url: URL_, credentials: {} } } },
    });
    const { code, body } = await run(ctx, "auth", "list");
    expect(code).toBe(ExitCode.Auth);
    expect(body.error?.code).toBe("AUTH_REQUIRED");
    expect(sent).toEqual([]);
  });

  it("list rejects an unexpected argument as a usage error", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "auth", "list", "extra");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(sent).toEqual([]);
  });
});

describe("pidgen auth revoke", () => {
  const revokeAnswer =
    (current: boolean) =>
    (call: Sent): Response | undefined =>
      call.method === "DELETE" && call.url.startsWith(`${URL_}/api/v1/me/sessions/`)
        ? ok({ revoked: true, current }, "req-revoke")
        : undefined;

  it("revoke revokes a session by id and leaves the profile alone", async () => {
    const { ctx, sent } = await setup(revokeAnswer(false));
    const { code, body } = await run(ctx, "auth", "revoke", "ses-browser");
    expect(code).toBe(ExitCode.Ok);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({
      id: "ses-browser",
      revoked: true,
      current: false,
      profile: "default",
      removed_from_profile: [],
      default_account: "ACC-EXAMPLE",
    });
    expect(body.meta).toMatchObject({ request_id: "req-revoke" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("DELETE");
    expect(sent[0]!.url).toBe(`${URL_}/api/v1/me/sessions/ses-browser`);
    expect(header(sent[0]!, "authorization")).toBe(`Bearer ${CLI}`);
    expect(header(sent[0]!, "x-pidgen-account")).toBeUndefined();
    expect(await loadConfig(ctx)).toEqual(storedConfig());
  });

  it("revoke percent-encodes the id as one path segment", async () => {
    const { ctx, sent } = await setup(revokeAnswer(false));
    const { code } = await run(ctx, "auth", "revoke", "a/b c");
    expect(code).toBe(ExitCode.Ok);
    expect(sent[0]!.url).toBe(`${URL_}/api/v1/me/sessions/a%2Fb%20c`);
  });

  it("revoke of another stored CLI token removes that stored copy", async () => {
    const { ctx } = await setup(revokeAnswer(false));
    const { code, body } = await run(ctx, "auth", "revoke", "tok-other");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ current: false, removed_from_profile: ["ACC-OTHER"] });
    const config = await loadConfig(ctx);
    expect(Object.keys(config.profiles["default"]!.credentials).sort()).toEqual([
      "ACC-EXAMPLE",
      "ACC-PAT",
    ]);
    expect(config.profiles["default"]!.default_account).toBe("ACC-EXAMPLE");
  });

  it("revoke current credential removes it from the profile and clears the default", async () => {
    const { ctx } = await setup(revokeAnswer(true));
    const { code, body } = await run(ctx, "auth", "revoke", "tok-current");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual({
      id: "tok-current",
      revoked: true,
      current: true,
      profile: "default",
      removed_from_profile: ["ACC-EXAMPLE"],
      default_account: null,
    });
    const profile = (await loadConfig(ctx)).profiles["default"]!;
    expect(profile.credentials["ACC-EXAMPLE"]).toBeUndefined();
    expect(profile.default_account).toBeUndefined();
    expect(Object.keys(profile.credentials).sort()).toEqual(["ACC-OTHER", "ACC-PAT"]);
  });

  it("revoke current credential without a stored token_id still removes the credential in use", async () => {
    const config = storedConfig();
    delete config.profiles["default"]!.credentials["ACC-EXAMPLE"]!.token_id;
    const { ctx } = await setup(revokeAnswer(true), { config });
    const { code, body } = await run(ctx, "auth", "revoke", "tok-current");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ current: true, removed_from_profile: ["ACC-EXAMPLE"] });
    expect((await loadConfig(ctx)).profiles["default"]!.credentials["ACC-EXAMPLE"]).toBeUndefined();
  });

  it("revoke current credential from PIDGEN_TOKEN removes the stored copy of that token", async () => {
    const { ctx } = await setup(revokeAnswer(true), {
      env: { PIDGEN_TOKEN: CLI_OTHER, PIDGEN_ACCOUNT: "ACC-OTHER" },
    });
    const { code, body } = await run(ctx, "auth", "revoke", "tok-other");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ current: true, removed_from_profile: ["ACC-OTHER"] });
    expect((await loadConfig(ctx)).profiles["default"]!.credentials["ACC-OTHER"]).toBeUndefined();
  });

  it("revoke keeps SESSION_NOT_FOUND's code and exits 4, writing nothing", async () => {
    const { ctx } = await setup(() => refusal(404, "SESSION_NOT_FOUND", "No such session."));
    const { code, body } = await run(ctx, "auth", "revoke", "tok-missing");
    expect(code).toBe(ExitCode.NotFound);
    expect(body.error?.code).toBe("SESSION_NOT_FOUND");
    expect(await loadConfig(ctx)).toEqual(storedConfig());
  });

  it("revoke without an id is a usage error with no network call", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "auth", "revoke");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(sent).toEqual([]);
  });

  it("revoke with a blank or dot id is a usage error with no network call", async () => {
    const { ctx, sent } = await setup();
    for (const id of [" ", ".."]) {
      const { code, body } = await run(ctx, "auth", "revoke", id);
      expect(code).toBe(ExitCode.Usage);
      expect(body.error?.code).toBe("CLI_USAGE");
    }
    expect(sent).toEqual([]);
  });
});

describe("pidgen auth list and revoke with a Personal API Token", () => {
  for (const argv of [
    ["auth", "list"],
    ["auth", "revoke", "tok-current"],
  ]) {
    it(`${argv.join(" ")}: token refused with TOKEN_NOT_ALLOWED, exit 3, and a web-app hint`, async () => {
      const { ctx, sent } = await setup();
      const { code, body } = await run(ctx, ...argv, "--account", "ACC-PAT");
      expect(code).toBe(ExitCode.Auth);
      expect(body.ok).toBe(false);
      expect(body.error?.code).toBe("TOKEN_NOT_ALLOWED");
      expect(String(body.error?.details["hint"])).toContain("web app");
      expect(body.error?.message).toContain("web app");
      expect(sent).toEqual([]);
      expect(await loadConfig(ctx)).toEqual(storedConfig());
      expect(ctx.out.join("")).not.toContain(PAT);
    });

    it(`${argv.join(" ")}: token refused from PIDGEN_TOKEN without a network call`, async () => {
      const { ctx, sent } = await setup(undefined, {
        config: null,
        env: { PIDGEN_API_URL: URL_, PIDGEN_TOKEN: PAT, PIDGEN_ACCOUNT: "ACC-PAT" },
      });
      const { code, body } = await run(ctx, ...argv);
      expect(code).toBe(ExitCode.Auth);
      expect(body.error?.code).toBe("TOKEN_NOT_ALLOWED");
      expect(sent).toEqual([]);
    });

    it(`${argv.join(" ")}: token refused by the server keeps TOKEN_NOT_ALLOWED and gains the hint`, async () => {
      const { ctx, sent } = await setup(
        () => refusal(403, "TOKEN_NOT_ALLOWED", "Personal API Tokens are not accepted here."),
        { config: null, env: { PIDGEN_API_URL: URL_, PIDGEN_TOKEN: "unrecognised_fake_token" } },
      );
      const { code, body } = await run(ctx, ...argv);
      expect(code).toBe(ExitCode.Auth);
      expect(body.error?.code).toBe("TOKEN_NOT_ALLOWED");
      expect(String(body.error?.details["hint"])).toContain("web app");
      expect(sent).toHaveLength(1);
    });
  }
});
