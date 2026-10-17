import { z } from "zod";
import type { Profile, Target } from "./config.js";
import type { GlobalOptions, RunContext } from "./context.js";
import { CliError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";
import type { ApiResponse } from "./http.js";
import { credentialClient } from "./session.js";

/** The kind of a credential: a CLI token, a Personal API Token, or `null` when unrecognised. */
export type CredentialKind = "cli" | "pat" | null;

/**
 * The kind of a token given in `PIDGEN_TOKEN`, from its prefix: `pidgen_cli_` and `pidgen_pat_`,
 * the prefixes the server issues, or `awes_cli_` and `awes_pat_`, those of tokens it issued before.
 * `null` when unrecognised.
 */
export function kindOfToken(token: string): CredentialKind {
  if (token.startsWith("pidgen_cli_") || token.startsWith("awes_cli_")) return "cli";
  if (token.startsWith("pidgen_pat_") || token.startsWith("awes_pat_")) return "pat";
  return null;
}

/**
 * The kind of the credential `target` carries: from its prefix when it came from `PIDGEN_TOKEN`,
 * otherwise as stored in the profile. `null` when there is no credential or its kind is unknown.
 */
export function targetCredentialKind(
  ctx: RunContext,
  target: Target,
  profile: Profile | undefined,
): CredentialKind {
  if (!target.token) return null;
  const fromEnvironment = ctx.env["PIDGEN_TOKEN"];
  if (fromEnvironment !== undefined) return kindOfToken(fromEnvironment);
  return (target.account ? profile?.credentials[target.account]?.kind : undefined) ?? null;
}

/** The parts of `GET /me` (`Me` in the public API document) the CLI relies on. */
const meSchema = z.object({
  user: z.object({
    user_id: z.string(),
    email: z.string(),
    display_name: z.string(),
  }),
  memberships: z.array(
    z.object({
      account_id: z.string(),
      account_name: z.string(),
      role: z.string(),
    }),
  ),
  // `kind` and `scopes` are optional so an answer from a server that does not publish them yet
  // still parses; callers fall back to the role when they are absent.
  cli_token: z
    .object({
      token_id: z.string(),
      account_id: z.string(),
      kind: z.enum(["cli", "pat"]).optional(),
      scopes: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
});

export type Me = z.infer<typeof meSchema>;

/**
 * Reads the signed-in User with `GET /me` using a CLI token or Personal API Token, with the token's
 * kind and scopes when the server reports them. `/me` is not Account-scoped, so no
 * Account is sent. A refusal keeps the server's `error.code` and exit code; an answer that does not
 * match the public API document is `UNEXPECTED_RESPONSE` (exit code 1). The token is never echoed.
 */
export async function readMe(
  ctx: RunContext,
  url: string,
  token: string,
  global: Pick<GlobalOptions, "timeoutSeconds">,
): Promise<{ me: Me; response: ApiResponse }> {
  const client = credentialClient(ctx, url, token, null, global);
  const response = await client.request<unknown>({ method: "GET", path: "/me" });
  const parsed = meSchema.safeParse(response.data);
  if (!parsed.success) {
    throw new CliError(
      "UNEXPECTED_RESPONSE",
      "The server's answer to /me does not match the public API document.",
      ExitCode.Unexpected,
      { route: "/me", fields: parsed.error.issues.map((issue) => issue.path.join(".")) },
    );
  }
  return { me: parsed.data, response };
}

/** The scope that lets a token create a worker enrollment. */
export const ENROLL_SCOPE = "workers:enroll";

/** The Account roles that may enroll workers; a CLI token acts with its User's role. */
export const ENROLL_ROLES: readonly string[] = ["owner", "administrator"];

/** Whether a credential may enroll workers, as `GET /me` shows it. */
export interface EnrollPermission {
  allowed: boolean;
  /** The Account the credential acts in: the token's, else the selected one. */
  account: string | null;
  kind: CredentialKind;
  /** The User's role in that Account, or `null` without a membership. */
  role: string | null;
  /** The scopes `GET /me` reports for the token, or `null` when it reports none. */
  scopes: string[] | null;
}

/**
 * Whether the credential behind a `GET /me` answer may enroll workers: the token's scopes include
 * `workers:enroll`. A server that reports no scopes leaves the role to decide for a CLI token.
 */
export function enrollPermission(
  me: Me,
  selected: string | null,
  localKind: CredentialKind,
): EnrollPermission {
  const token = me.cli_token ?? null;
  const account = token?.account_id ?? selected;
  const role = me.memberships.find((entry) => entry.account_id === account)?.role ?? null;
  const kind = token?.kind ?? localKind;
  const scopes = token?.scopes ?? null;
  const allowed =
    scopes !== null
      ? scopes.includes(ENROLL_SCOPE)
      : kind === "cli" && role !== null && ENROLL_ROLES.includes(role);
  return { allowed, account, kind, role, scopes };
}
