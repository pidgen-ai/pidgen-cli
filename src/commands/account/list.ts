import {
  loadConfig,
  resolveTarget,
  selectProfile,
  type Config,
  type Profile,
} from "../../core/config.js";
import type { GlobalOptions, RunContext } from "../../core/context.js";
import { readMe, targetCredentialKind, type Me } from "../../core/me.js";
import type { CommandSpec } from "../../core/registry.js";
import { responseMeta } from "../../core/session.js";

/** One row of `pidgen account list`. */
interface AccountEntry {
  account: string;
  account_name: string | null;
  role: string | null;
  /** Whether `GET /me` lists you as an active member; `null` when the server was not asked. */
  member: boolean | null;
  default: boolean;
  credential_stored: boolean;
  credential_kind: "cli" | "pat" | null;
  expires_at: string | null;
}

/**
 * `pidgen account list`: with a CLI token, every Account `GET /me` says you belong to, merged with the
 * Accounts the selected profile holds a credential for, marking the default and which have a stored
 * credential. Without a CLI token (a Personal API Token, which `/me` refuses by design, or no
 * credential at all) it lists the Accounts with a stored credential only, without a network call.
 */
export const accountList: CommandSpec = {
  path: ["account", "list"],
  summary: "List your Accounts and those with a stored credential, marking the default",
  async run(ctx, { global }) {
    const config = await loadConfig(ctx);
    const profileName = selectProfile(ctx, config, global);
    const profile = config.profiles[profileName];
    const defaultAccount = profile?.default_account ?? null;

    const read = await readMeWithCliToken(ctx, config, profile, global);
    const accounts = merge(profile, read?.me ?? null);
    return {
      data: accounts,
      meta: read
        ? { ...responseMeta(read.target, read.response), account: defaultAccount }
        : { profile: profileName, account: defaultAccount },
    };
  },
};

/**
 * Calls `GET /me` when the credential in use — `PIDGEN_TOKEN`, or the stored credential for the
 * selected Account — is a CLI token and a server is configured; otherwise returns `null`.
 */
async function readMeWithCliToken(
  ctx: RunContext,
  config: Config,
  profile: Profile | undefined,
  global: GlobalOptions,
) {
  const target = resolveTarget(ctx, config, global);
  if (!target.token || targetCredentialKind(ctx, target, profile) !== "cli") return null;
  const { me, response } = await readMe(ctx, target.url, target.token, global);
  return { me, response, target };
}

/** The server's memberships and the stored credentials, one row per Account, sorted by id. */
function merge(profile: Profile | undefined, me: Me | null): AccountEntry[] {
  const credentials = profile?.credentials ?? {};
  const memberships = new Map(me?.memberships.map((entry) => [entry.account_id, entry]) ?? []);
  const ids = [...new Set([...memberships.keys(), ...Object.keys(credentials)])].sort((a, b) =>
    a.localeCompare(b),
  );
  return ids.map((account) => {
    const membership = memberships.get(account);
    const credential = credentials[account];
    return {
      account,
      account_name: membership?.account_name ?? null,
      role: membership?.role ?? null,
      member: me ? membership !== undefined : null,
      default: account === profile?.default_account,
      credential_stored: credential !== undefined,
      credential_kind: credential?.kind ?? null,
      expires_at: credential?.expires_at ?? null,
    };
  });
}
