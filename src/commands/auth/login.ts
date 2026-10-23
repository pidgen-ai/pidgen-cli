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

/** The device authorization's addresses and code, for a caller that shows them itself. */
export type DeviceCodeShown = Pick<
  DeviceAuthorization,
  "user_code" | "verification_uri" | "verification_uri_complete"
>;

/** What became of one poll of `POST /auth/device/token`. */
export type PollOutcome =
  "pending" | "slow_down" | "approved" | "denied" | "expired" | "invalid" | "network";

/**
 * One poll, as the caller hears of it. It never holds the device code, the user code or the token.
 */
export interface PollReport {
  /** When the poll started (`ctx.now()`); for `expired` without a poll, when the code ran out. */
  at: number;
  outcome: PollOutcome;
  /** The interval in seconds after this poll (grown by `slow_down`). */
  interval: number;
  /**
   * Seconds since the previous poll started, when that is more than twice the interval: the poll
   * was held up. `null` otherwise, and for the first poll.
   */
  delayed: number | null;
  /** Why a `network` poll failed. */
  error?: string;
}

export interface PollOptions {
  /** Stops polling: the poll rejects with an `AbortError`. */
  signal?: AbortSignal;
  /** Hears of each poll as it ends. */
  onPoll?: (report: PollReport) => void;
}

/** A CLI token a device-code login was approved with: only `loginWithDeviceCode` reads it. */
export type DeviceToken = CliToken;

/**
 * One device code waiting to be approved: what the person is shown, and the polling. The device
 * code itself stays inside.
 */
export interface PendingDeviceLogin {
  shown: DeviceCodeShown;
  /** The server's polling interval, in seconds. */
  interval: number;
  /** Seconds until the code expires, as the server issued it. */
  expiresIn: number;
  /**
   * Polls until the login is approved (the token), denied, expired or lost (a `CliError` with
   * that code, exit code 3). A network failure is "not yet".
   */
  poll(options?: PollOptions): Promise<DeviceToken>;
  /**
   * Asks the poll to check at once instead of waiting out the interval, but never sooner than the
   * interval after the previous poll started.
   */
  checkNow(): void;
}

/**
 * How a device code is waited on. `start` issues a new code (`POST /auth/device`); the waiter
 * shows it, polls, and may start another. `pidgen auth login` prints the code and polls once;
 * `pidgen setup` draws it in its frame and answers keys.
 */
export type DeviceCodeWaiter = (start: () => Promise<PendingDeviceLogin>) => Promise<DeviceToken>;

/**
 * The device-code login. `waiter` shows each code and waits for the approval; without it the
 * address and code are printed to standard error and polled until the approval, as `pidgen auth
 * login` does. `pidgen setup` draws them in its own frame.
 */
export async function loginWithDeviceCode(
  ctx: RunContext,
  url: string,
  global: GlobalOptions,
  deviceLabel: string | undefined,
  waiter?: DeviceCodeWaiter,
): Promise<CommandResult> {
  const config = await loadConfig(ctx);
  const profileName = selectProfile(ctx, config, global);

  // Confirm the server is Pidgen and speaks our API version before sending anything else.
  const client = anonymousClient(ctx, url, global);
  const identity = await checkServer(client);

  const start = async (): Promise<PendingDeviceLogin> => {
    const request: DeviceAuthorizationRequest =
      deviceLabel !== undefined ? { device_label: deviceLabel } : {};
    const started = await client.request<unknown>({
      method: "POST",
      path: "/auth/device",
      body: request,
    });
    const authorization = parseResponse(deviceAuthorizationSchema, started.data, "/auth/device");
    return new DevicePoll(ctx, client, authorization);
  };

  const token = await (waiter ?? printedWait(ctx))(start);

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
 * `pidgen auth login`'s wait: one code, printed to standard error, polled until it is approved.
 * The user code is for the person, so it is shown even when standard error is not a terminal. It
 * never appears on standard output, and the device code is never shown.
 */
function printedWait(ctx: RunContext): DeviceCodeWaiter {
  return async (start) => {
    const pending = await start();
    ctx.io.stderr(
      `Open ${pending.shown.verification_uri} and enter the code  ${pending.shown.user_code}\n`,
    );
    if (ctx.io.interactive) ctx.io.stderr("Waiting for approval…\n");
    return pending.poll();
  };
}

/** The device-code login codes that end a poll: the login can no longer be approved. */
const ENDING_CODES: Readonly<Record<string, PollOutcome>> = {
  access_denied: "denied",
  expired_token: "expired",
  invalid_grant: "invalid",
};

/**
 * Polls `POST /auth/device/token` at the server's interval until the login is approved, denied or
 * expired. `slow_down` grows the interval; `access_denied`, `expired_token` and `invalid_grant`
 * fail with that code and exit code 3. A poll that fails on the network is not retried inside the
 * HTTP client (it may have reached the server and redeemed the code); it counts as "not yet", and
 * the next poll comes at the interval. An `invalid_grant` after such a failure says the approval's
 * answer was lost.
 */
class DevicePoll implements PendingDeviceLogin {
  readonly shown: DeviceCodeShown;
  readonly interval: number;
  readonly expiresIn: number;
  private wake: (() => void) | null = null;
  private wanted = false;

  constructor(
    private readonly ctx: RunContext,
    private readonly client: ApiClient,
    private readonly authorization: DeviceAuthorization,
  ) {
    this.shown = {
      user_code: authorization.user_code,
      verification_uri: authorization.verification_uri,
      verification_uri_complete: authorization.verification_uri_complete,
    };
    this.interval = Math.max(1, authorization.interval);
    this.expiresIn = authorization.expires_in;
  }

  checkNow(): void {
    this.wanted = true;
    this.wake?.();
  }

  async poll(options: PollOptions = {}): Promise<DeviceToken> {
    const { ctx, client, authorization } = this;
    const { signal, onPoll } = options;
    const issued = ctx.now();
    const deadline = issued + authorization.expires_in * 1000;
    let intervalSeconds = this.interval;
    let previous: number | null = null;
    // Whether the last poll failed on the network, so its answer may have been lost.
    let unanswered = false;
    const body: DeviceTokenRequest = {
      device_code: authorization.device_code,
      grant_type: DEVICE_GRANT_TYPE,
    };
    const report = (at: number, outcome: PollOutcome, error?: string) => {
      const gap = previous === null ? 0 : (at - previous) / 1000;
      onPoll?.({
        at,
        outcome,
        interval: intervalSeconds,
        delayed: previous !== null && gap > 2 * intervalSeconds ? Math.round(gap) : null,
        ...(error !== undefined ? { error } : {}),
      });
    };
    for (;;) {
      await this.pause(intervalSeconds * 1000, previous ?? issued, signal);
      const at = ctx.now();
      if (at >= deadline) {
        report(at, "expired");
        throw loginFailed("expired_token", {});
      }
      try {
        // Not marked idempotent: a poll that reached the server may have redeemed the code, and
        // repeating it blindly would then be refused with invalid_grant.
        const { data } = await client.request<unknown>({
          method: "POST",
          path: "/auth/device/token",
          body,
        });
        signal?.throwIfAborted();
        const token = parseResponse(cliTokenSchema, data, "/auth/device/token");
        report(at, "approved");
        return token;
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof CliError)) throw error;
        const code = error.code.toLowerCase();
        if (error.exitCode === ExitCode.Network) {
          report(at, "network", error.message);
          previous = at;
          unanswered = true;
          continue;
        }
        if (code === "authorization_pending") {
          report(at, "pending");
        } else if (code === "slow_down") {
          const suggested = error.details["interval"];
          intervalSeconds =
            typeof suggested === "number" && suggested > intervalSeconds
              ? suggested
              : intervalSeconds + SLOW_DOWN_STEP_SECONDS;
          report(at, "slow_down");
        } else if (ENDING_CODES[code] !== undefined) {
          report(at, ENDING_CODES[code]);
          const lost = code === "invalid_grant" && unanswered;
          throw loginFailed(
            error.code,
            lost ? { ...error.details, answer_lost: true } : error.details,
          );
        } else {
          throw error;
        }
        previous = at;
        unanswered = false;
      }
    }
  }

  /**
   * Waits `ms` before the next poll, or less when `checkNow` asks, but never less than `ms` after
   * `previous` (when the previous poll started, or the code was issued). Rejects when `signal`
   * aborts.
   */
  private async pause(ms: number, previous: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const woken = new Promise<void>((resolveWake) => {
      this.wake = resolveWake;
      if (this.wanted) resolveWake();
    });
    let onAbort: (() => void) | null = null;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal?.reason as Error);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => undefined);
    try {
      await Promise.race([this.ctx.sleep(ms), woken, aborted]);
      if (this.wanted) {
        // Asked to check at once: still never sooner than the interval after the previous poll.
        const left = previous + ms - this.ctx.now();
        if (left > 0) await Promise.race([this.ctx.sleep(left), aborted]);
      }
    } finally {
      // One listener per pause, removed with it: a long wait never piles them up on the signal.
      if (onAbort !== null) signal?.removeEventListener("abort", onAbort);
      this.wake = null;
      this.wanted = false;
    }
    signal?.throwIfAborted();
  }
}

const FAILURE_MESSAGES: Record<string, string> = {
  access_denied: "The login was denied in the web app. Nothing was stored.",
  expired_token:
    "The code expired before the login was approved. Nothing was stored; run `pidgen auth login <url>` again.",
  invalid_grant:
    "The server no longer recognises this login. Nothing was stored; run `pidgen auth login <url>` again.",
};

/** `invalid_grant` after a poll that failed on the network: that poll redeemed the code. */
const ANSWER_LOST =
  "The approval's answer was lost: a check reached the server and used the code, but its answer never arrived. Nothing was stored; run `pidgen auth login <url>` again for a new code.";

function loginFailed(code: string, details: Record<string, unknown>): CliError {
  const message =
    details["answer_lost"] === true
      ? ANSWER_LOST
      : (FAILURE_MESSAGES[code.toLowerCase()] ?? "The login failed. Nothing was stored.");
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
