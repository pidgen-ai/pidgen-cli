import { Option } from "commander";
import { credentialRequired, loadConfig, resolveTarget } from "../../core/config.js";
import { readMe, targetCredentialKind, type CredentialKind, type Me } from "../../core/me.js";
import { anonymousClient, responseMeta } from "../../core/session.js";
import type { CommandSpec } from "../../core/registry.js";
import { checkServer } from "../../core/server.js";

/** Why `identity` is `null`, by credential kind. */
const IDENTITY_NOTES: Record<"pat" | "unknown", string> = {
  pat: "The server does not describe Personal API Tokens on GET /me, so only the local profile is shown.",
  unknown:
    "The credential is not a recognised CLI token, so GET /me was not called and only the local profile is shown.",
};

/**
 * `pidgen auth status [--check]`: the selected profile, server, Account and credential from the local
 * configuration, and — with a CLI token — who you are from `GET /me`: the User, the Account the
 * token is bound to and your role there. A Personal API Token is refused on `/me` by design, so for
 * one only the local profile is reported, with a note saying so, and no network call is made.
 * `--check` re-runs the server check (`GET /health`, without the credential).
 */
export const authStatus: CommandSpec = {
  path: ["auth", "status"],
  summary: "Show who you are, and the profile, Account and credential in use",
  configure(command) {
    command.addOption(
      new Option("--check", "confirm the server is Pidgen and accepts this CLI's API version"),
    );
  },
  async run(ctx, { options, global }) {
    const config = await loadConfig(ctx);
    const target = resolveTarget(ctx, config, global);
    const profile = config.profiles[target.profile];

    const fromEnvironment = ctx.env["PIDGEN_TOKEN"] !== undefined;
    const stored = target.account ? profile?.credentials[target.account] : undefined;
    if (!target.token) throw credentialRequired(target.profile, target.account);
    const kind: CredentialKind = targetCredentialKind(ctx, target, profile);

    // A cached check belongs to the profile's server; PIDGEN_API_URL may point elsewhere.
    const cached = profile?.server && profile.url === target.url ? profile.server : null;
    const server =
      options["check"] === true
        ? {
            ...(await checkServer(anonymousClient(ctx, target.url, global))),
            checked_at: new Date(ctx.now()).toISOString(),
          }
        : cached;

    // Only a CLI token can ask the server who it is; a refusal keeps its own code and exit code.
    const read = kind === "cli" ? await readMe(ctx, target.url, target.token, global) : null;

    return {
      data: {
        profile: target.profile,
        url: target.url,
        account: target.account,
        default_account: profile?.default_account ?? null,
        credential_kind: kind,
        credential_source: fromEnvironment ? "environment" : "config",
        expires_at: fromEnvironment ? null : (stored?.expires_at ?? null),
        server,
        identity: read ? identityOf(read.me, target.account) : null,
        identity_note: read ? null : IDENTITY_NOTES[kind === "pat" ? "pat" : "unknown"],
      },
      meta: responseMeta(target, read?.response),
    };
  },
};

/**
 * The User, the Account and the role from `GET /me`. The Account is the one the CLI token is bound
 * to (`cli_token.account_id`), or the selected Account when the answer does not name one; the role
 * and name come from the User's membership of it, or `null` when they are not a member.
 */
function identityOf(me: Me, selected: string | null) {
  const account = me.cli_token?.account_id ?? selected;
  const membership = me.memberships.find((entry) => entry.account_id === account);
  return {
    user: {
      user_id: me.user.user_id,
      email: me.user.email,
      display_name: me.user.display_name,
    },
    account,
    account_name: membership?.account_name ?? null,
    role: membership?.role ?? null,
    token_id: me.cli_token?.token_id ?? null,
  };
}
