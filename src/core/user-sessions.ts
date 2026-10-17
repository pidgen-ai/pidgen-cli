import { z } from "zod";
import {
  credentialRequired,
  loadConfig,
  resolveTarget,
  type Config,
  type Profile,
  type Target,
} from "./config.js";
import type { GlobalOptions, RunContext } from "./context.js";
import { CliError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";
import type { ApiClient } from "./http.js";
import { targetCredentialKind, type CredentialKind } from "./me.js";
import { credentialClient } from "./session.js";

/** Where a Personal API Token is managed, for the hint `TOKEN_NOT_ALLOWED` carries. */
export const TOKEN_HINT =
  "Personal API Tokens are listed and revoked in the web app. Sign in with `pidgen auth login <url>` to use a CLI token for this command.";

/** The credential `pidgen auth list` and `pidgen auth revoke` act with, and a client for `/me/sessions`. */
export interface UserCredential {
  config: Config;
  target: Target & { token: string };
  profile: Profile | undefined;
  kind: CredentialKind;
  source: "environment" | "config";
  client: ApiClient;
}

/**
 * `TOKEN_NOT_ALLOWED` (exit code 3) for `command` with a Personal API Token, which the server refuses
 * on `/me/sessions` by design; `details.hint` says tokens are managed in the web app.
 */
export function tokenNotAllowed(command: string, details: Record<string, unknown> = {}): CliError {
  return new CliError(
    "TOKEN_NOT_ALLOWED",
    `\`${command}\` needs a CLI token: a Personal API Token cannot list or revoke sessions and tokens. ${TOKEN_HINT}`,
    ExitCode.Auth,
    { ...details, credential_kind: "pat", hint: TOKEN_HINT },
  );
}

/**
 * Resolves the credential in use (flags, `PIDGEN_*` environment variables, then the profile) for a
 * `/me/sessions` route. No credential is `AUTH_REQUIRED`; a Personal API Token is refused with
 * `TOKEN_NOT_ALLOWED` before any network call. The client sends no Account: the routes are not
 * Account-scoped.
 */
export async function openUserCredential(
  ctx: RunContext,
  global: GlobalOptions,
  command: string,
): Promise<UserCredential> {
  const config = await loadConfig(ctx);
  const resolved = resolveTarget(ctx, config, global);
  const profile = config.profiles[resolved.profile];
  if (!resolved.token) throw credentialRequired(resolved.profile, resolved.account);
  const target = { ...resolved, token: resolved.token };
  const kind = targetCredentialKind(ctx, target, profile);
  if (kind === "pat")
    throw tokenNotAllowed(command, { profile: target.profile, account: target.account });
  return {
    config,
    target,
    profile,
    kind,
    source: ctx.env["PIDGEN_TOKEN"] !== undefined ? "environment" : "config",
    client: credentialClient(ctx, target.url, target.token, null, global),
  };
}

/**
 * Runs `request`, turning the server's `TOKEN_NOT_ALLOWED` (a Personal API Token the CLI did not
 * recognise, such as an `PIDGEN_TOKEN` of unknown kind) into the same refusal with the web-app hint.
 */
export async function withTokenHint<T>(command: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof CliError && error.code === "TOKEN_NOT_ALLOWED") {
      throw new CliError("TOKEN_NOT_ALLOWED", tokenNotAllowed(command).message, ExitCode.Auth, {
        ...error.details,
        hint: TOKEN_HINT,
      });
    }
    throw error;
  }
}

/** The parts of `SessionEntry` in the public API document the CLI relies on. */
const sessionEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("session"),
    session_id: z.string(),
    device_label: z.string().nullable(),
    ip_prefix: z.string().nullable().optional(),
    created_at: z.string(),
    last_seen_at: z.string(),
    current: z.boolean(),
    mfa_verified: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("cli_token"),
    session_id: z.string(),
    account_id: z.string(),
    device_label: z.string().nullable(),
    created_at: z.string(),
    last_seen_at: z.string(),
    expires_at: z.string(),
    current: z.boolean(),
    mfa_verified: z.boolean().optional(),
  }),
]);

export const sessionListSchema = z.array(sessionEntrySchema);
export type SessionEntry = z.infer<typeof sessionEntrySchema>;

/** The parts of `SessionRevoked` in the public API document the CLI relies on. */
export const sessionRevokedSchema = z.object({ revoked: z.boolean(), current: z.boolean() });

/** Validates a `/me/sessions` answer; a mismatch is `UNEXPECTED_RESPONSE` (exit code 1). */
export function parseAnswer<T>(schema: z.ZodType<T>, route: string, data: unknown): T {
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

/** The Account whose stored CLI credential in `profile` has `tokenId`, or `null`. */
export function storedAccountFor(profile: Profile | undefined, tokenId: string): string | null {
  for (const [account, credential] of Object.entries(profile?.credentials ?? {})) {
    if (credential.kind === "cli" && credential.token_id === tokenId) return account;
  }
  return null;
}
