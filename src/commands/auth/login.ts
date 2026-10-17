import { Option } from "commander";
import { z } from "zod";
import {
  DEFAULT_SERVER_URL,
  loadConfig,
  resolveTarget,
  saveConfig,
  selectProfile,
  storeCredential,
} from "../../core/config.js";
import type { GlobalOptions, RunContext } from "../../core/context.js";
import { CliError, usageError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import type { ApiClient } from "../../core/http.js";
import type { CommandResult, CommandSpec } from "../../core/registry.js";
import { checkServer } from "../../core/server.js";
import { anonymousClient, credentialClient } from "../../core/session.js";
import type { components } from "../../generated/api.js";

type DeviceAuthorization = components["schemas"]["DeviceAuthorizationIssued"];
type DeviceAuthorizationRequest = components["schemas"]["DeviceAuthorizationRequest"];
type DeviceTokenRequest = components["schemas"]["DeviceTokenRequest"];
type CliToken = components["schemas"]["CliTokenIssued"];

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** RFC 8628: without a new interval from the server, `slow_down` adds five seconds. */
const SLOW_DOWN_STEP_SECONDS = 5;

const deviceAuthorizationSchema: z.ZodType<DeviceAuthorization> = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  verification_uri_complete: z.string(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().nonnegative(),
});

const cliTokenSchema: z.ZodType<CliToken> = z.object({
  access_token: z.string().min(1),
  token_type: z.literal("Bearer").default("Bearer"),
  token_id: z.string().min(1),
  account_id: z.string().min(1),
  user_id: z.string(),
  device_label: z.string(),
  idle_expires_at: z.string(),
  absolute_expires_at: z.string(),
});

/**
 * `pidgen auth login <url>`: device-code login (docs/authentication.md). Checks the server, starts a
 * device-code login, shows the verification address and user code on standard error, polls until
 * the person approves in the web app, verifies the CLI token with `GET /me`, and stores it for the
 * approved Account.
 *
 * `pidgen auth login <url> --with-token --account <ACC-…>` instead verifies a Personal API Token read
 * from standard input with `GET /projects` in that Account, and stores it as the profile's credential
 * for the Account. A credential the server refuses is never stored.
 */
export const authLogin: CommandSpec = {
  path: ["auth", "login"],
  summary:
    "Sign in with a device code (--with-token reads a Personal API Token from standard input)",
  configure(command) {
    command
      .argument(
        "[url]",
        `the Pidgen server (default: PIDGEN_API_URL, then the profile's, then ${DEFAULT_SERVER_URL})`,
      )
      .addOption(new Option("--with-token", "read a Personal API Token from standard input"))
      .addOption(
        new Option(
          "--device-label <name>",
          "a name for this device, shown when approving and among your signed-in devices",
        ),
      );
  },
  async run(ctx, { args, options, global }) {
    const url = parseServerUrl(args[0] ?? (await configuredServer(ctx, global)));
    if (options["withToken"] === true) return loginWithToken(ctx, url, global);

    if (global.account !== undefined) {
      throw usageError(
        "--account is only for --with-token: with a device code you choose the Account when you approve the login.",
      );
    }
    const label = options["deviceLabel"];
    if (typeof label === "string" && (label.trim() === "" || label.length > 200)) {
      throw usageError("--device-label must be 1–200 characters.");
    }
    return loginWithDeviceCode(ctx, url, global, typeof label === "string" ? label : undefined);
  },
};

/** The server to sign in to when none is given: `PIDGEN_API_URL`, the profile's, or the hosted one. */
async function configuredServer(ctx: RunContext, global: GlobalOptions): Promise<string> {
  return resolveTarget(ctx, await loadConfig(ctx), global).url;
}

async function loginWithDeviceCode(
  ctx: RunContext,
  url: string,
  global: GlobalOptions,
  deviceLabel: string | undefined,
): Promise<CommandResult> {
  const config = await loadConfig(ctx);
  const profileName = selectProfile(ctx, config, global);

  // Confirm the server is Pidgen and speaks our API version before sending anything else.
  const client = anonymousClient(ctx, url, global);
  const identity = await checkServer(client);

  const request: DeviceAuthorizationRequest =
    deviceLabel !== undefined ? { device_label: deviceLabel } : {};
  const started = await client.request<unknown>({
    method: "POST",
    path: "/auth/device",
    body: request,
  });
  const authorization = parseResponse(deviceAuthorizationSchema, started.data, "/auth/device");

  // The user code is for the person, so it is shown even when standard error is not a terminal.
  // It never appears on standard output, and the device code is never shown.
  ctx.io.stderr(
    `Open ${authorization.verification_uri} and enter the code  ${authorization.user_code}\n`,
  );
  if (ctx.io.interactive) ctx.io.stderr("Waiting for approval…\n");

  const token = await pollForToken(ctx, client, authorization);

  // Never store a token the server does not accept: it must answer `GET /me` with 200.
  await verifyCliToken(ctx, url, global, token);

  const expiresAt = earlier(token.idle_expires_at, token.absolute_expires_at);
  const server = { ...identity, checked_at: new Date(ctx.now()).toISOString() };
  storeCredential(config, profileName, url, server, token.account_id, {
    kind: "cli",
    token: token.access_token,
    token_id: token.token_id,
    expires_at: expiresAt,
  });
  await saveConfig(ctx, config);

  return {
    data: {
      profile: profileName,
      url,
      account: token.account_id,
      credential_kind: "cli",
      token_id: token.token_id,
      device_label: token.device_label,
      expires_at: expiresAt,
      absolute_expires_at: token.absolute_expires_at,
      verified: true,
      server: identity,
    },
    meta: { profile: profileName, account: token.account_id },
  };
}

/**
 * Polls `POST /auth/device/token` at the server's interval until the login is approved, denied or
 * expired. `slow_down` grows the interval; `access_denied`, `expired_token` and `invalid_grant`
 * fail with that code and exit code 3.
 */
async function pollForToken(
  ctx: RunContext,
  client: ApiClient,
  authorization: DeviceAuthorization,
): Promise<CliToken> {
  const deadline = ctx.now() + authorization.expires_in * 1000;
  let intervalSeconds = Math.max(1, authorization.interval);
  const body: DeviceTokenRequest = {
    device_code: authorization.device_code,
    grant_type: DEVICE_GRANT_TYPE,
  };
  for (;;) {
    await ctx.sleep(intervalSeconds * 1000);
    if (ctx.now() >= deadline) throw loginFailed("expired_token", {});
    try {
      // Polling is safe to repeat, so a network failure is retried like a GET.
      const { data } = await client.request<unknown>({
        method: "POST",
        path: "/auth/device/token",
        body,
        idempotent: true,
      });
      return parseResponse(cliTokenSchema, data, "/auth/device/token");
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      switch (error.code.toLowerCase()) {
        case "authorization_pending":
          continue;
        case "slow_down": {
          const suggested = error.details["interval"];
          intervalSeconds =
            typeof suggested === "number" && suggested > intervalSeconds
              ? suggested
              : intervalSeconds + SLOW_DOWN_STEP_SECONDS;
          continue;
        }
        case "access_denied":
        case "expired_token":
        case "invalid_grant":
          throw loginFailed(error.code, error.details);
        default:
          throw error;
      }
    }
  }
}

const FAILURE_MESSAGES: Record<string, string> = {
  access_denied: "The login was denied in the web app. Nothing was stored.",
  expired_token:
    "The code expired before the login was approved. Nothing was stored; run `pidgen auth login <url>` again.",
  invalid_grant:
    "The server no longer recognises this login. Nothing was stored; run `pidgen auth login <url>` again.",
};

function loginFailed(code: string, details: Record<string, unknown>): CliError {
  const message = FAILURE_MESSAGES[code.toLowerCase()] ?? "The login failed. Nothing was stored.";
  return new CliError(code, message, ExitCode.Auth, details);
}

/** Validates a response body without ever echoing it: it may hold a secret. */
function parseResponse<T>(schema: z.ZodType<T>, data: unknown, route: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new CliError(
      "UNEXPECTED_RESPONSE",
      `The server's answer to ${route} does not match the public API document.`,
      ExitCode.Unexpected,
      { route, fields: parsed.error.issues.map((issue) => issue.path.join(".")) },
    );
  }
  return parsed.data;
}

/** The sooner of two timestamps, as given; the first when either does not parse. */
function earlier(a: string, b: string): string {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isNaN(ta) || Number.isNaN(tb) || ta <= tb ? a : b;
}

async function loginWithToken(
  ctx: RunContext,
  url: string,
  global: GlobalOptions,
): Promise<CommandResult> {
  const account = global.account?.trim();
  if (!account) {
    throw usageError(
      "--account <ACC-…> is required with --with-token: a token is bound to one Account.",
    );
  }
  const token = (await ctx.readStdin()).trim();
  if (!token) throw usageError("No token on standard input.");

  const config = await loadConfig(ctx);
  const profileName = selectProfile(ctx, config, global);

  // Confirm the server is Pidgen and speaks our API version before the token goes anywhere.
  const identity = await checkServer(anonymousClient(ctx, url, global));

  // Never store a token the server does not accept for this Account.
  const verification = await verifyPersonalToken(ctx, url, global, token, account);

  const server = { ...identity, checked_at: new Date(ctx.now()).toISOString() };
  storeCredential(config, profileName, url, server, account, { kind: "pat", token });
  await saveConfig(ctx, config);

  return {
    data: {
      profile: profileName,
      url,
      account,
      credential_kind: "pat",
      verified: true,
      scope_limitation: verification.scopeLimitation,
      server: identity,
    },
    meta: { profile: profileName, account },
  };
}

const meSchema = z.object({
  cli_token: z.object({ token_id: z.string(), account_id: z.string() }).nullable().optional(),
});

/**
 * Verifies a device-login CLI token before it is stored: `GET /me` with the token must answer 200.
 * `/me` is not Account-scoped, so no Account is sent. When the answer names the calling CLI token,
 * its Account must be the one the login approved. Any refusal fails the login and nothing is stored.
 */
async function verifyCliToken(
  ctx: RunContext,
  url: string,
  global: GlobalOptions,
  token: CliToken,
): Promise<void> {
  const client = credentialClient(ctx, url, token.access_token, null, global);
  let data: unknown;
  try {
    ({ data } = await client.request<unknown>({ method: "GET", path: "/me" }));
  } catch (error) {
    throw verificationFailed(error, "/me", "cli", token.account_id);
  }
  const me = parseResponse(meSchema, data, "/me");
  const bound = me.cli_token?.account_id;
  if (bound !== undefined && bound !== token.account_id) {
    throw new CliError(
      "ACCOUNT_MISMATCH",
      `The server says this CLI token is bound to ${bound}, not ${token.account_id}. Nothing was stored.`,
      ExitCode.Auth,
      { route: "/me", account: token.account_id, token_account: bound, stored: false },
    );
  }
}

/** What a Personal API Token cannot do, as far as its verification showed. */
interface ScopeLimitation {
  code: string;
  missing_scope: string;
  message: string;
}

/** The scope `GET /projects` needs; a token without it is refused `TOKEN_SCOPE_NOT_GRANTED`. */
const PROJECTS_SCOPE = "tickets:read";

/**
 * Verifies a Personal API Token before it is stored. `/me*` refuses Personal API Tokens by design,
 * so the token is tried on `GET /projects` with `X-PIDGEN-Account` set to `--account`. 200 means valid,
 * and so does 403 `TOKEN_SCOPE_NOT_GRANTED`: the token is good but lacks `tickets:read`, which is
 * reported as its scope limitation. Anything else — `TOKEN_INVALID`, `ACCOUNT_MISMATCH`, or any
 * other refusal or failure — fails the login and nothing is stored.
 */
async function verifyPersonalToken(
  ctx: RunContext,
  url: string,
  global: GlobalOptions,
  token: string,
  account: string,
): Promise<{ scopeLimitation: ScopeLimitation | null }> {
  const client = credentialClient(ctx, url, token, account, global);
  try {
    await client.request<unknown>({ method: "GET", path: "/projects" });
    return { scopeLimitation: null };
  } catch (error) {
    if (
      error instanceof CliError &&
      error.code === "TOKEN_SCOPE_NOT_GRANTED" &&
      error.details["status"] === 403
    ) {
      const named = [error.details["missing_scope"], error.details["required_scope"]].find(
        (value): value is string => typeof value === "string" && value !== "",
      );
      return {
        scopeLimitation: {
          code: error.code,
          missing_scope: named ?? PROJECTS_SCOPE,
          message: error.message,
        },
      };
    }
    throw verificationFailed(error, "/projects", "pat", account);
  }
}

const VERIFICATION_MESSAGES: Record<string, (account: string) => string> = {
  TOKEN_INVALID: () =>
    "The server does not accept this token: it is wrong, revoked or expired. Nothing was stored.",
  ACCOUNT_MISMATCH: (account) =>
    `This token is bound to a different Account than ${account}. Nothing was stored.`,
};

/**
 * Turns a refusal met while verifying a credential into the login's failure. `TOKEN_INVALID` and
 * `ACCOUNT_MISMATCH` always exit 3; any other failure keeps its own code and exit code. Every one
 * says nothing was stored. The token itself is never included.
 */
function verificationFailed(
  error: unknown,
  route: string,
  kind: "cli" | "pat",
  account: string,
): CliError {
  if (!(error instanceof CliError)) return toVerificationError(error);
  const known = VERIFICATION_MESSAGES[error.code];
  const message = known
    ? known(account)
    : `The server refused the ${kind === "pat" ? "token" : "CLI token"} while verifying it (${error.message}). Nothing was stored.`;
  const exitCode = known ? ExitCode.Auth : error.exitCode;
  return new CliError(error.code, message, exitCode, {
    ...error.details,
    route,
    account,
    stored: false,
  });
}

function toVerificationError(error: unknown): CliError {
  return new CliError(
    "CLI_INTERNAL",
    `Verifying the credential failed: ${error instanceof Error ? error.message : String(error)}. Nothing was stored.`,
    ExitCode.Unexpected,
    { stored: false },
  );
}

/** An `http(s)` origin with no trailing slash; the API lives under `/api/v1` on it. */
export function parseServerUrl(value: string | undefined): string {
  let parsed: URL;
  try {
    parsed = new URL(value ?? "");
  } catch {
    throw usageError(`Not a server URL: ${value ?? ""}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw usageError(`Not an http(s) server URL: ${value ?? ""}`);
  }
  return parsed.origin;
}
