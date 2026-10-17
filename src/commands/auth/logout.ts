import { loadConfig, saveConfig, selectProfile } from "../../core/config.js";
import { CliError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import type { CommandSpec } from "../../core/registry.js";

/**
 * `pidgen auth logout [--account <ACC-…>]`: forgets the stored credential for the current Account, or
 * the one named with `--account`, and clears the profile's default Account if it pointed there.
 * Local only: revoking the token on the server (`DELETE /me/sessions/{id}`) is planned.
 */
export const authLogout: CommandSpec = {
  path: ["auth", "logout"],
  summary: "Forget the stored credential for the current Account (or --account)",
  async run(ctx, { global }) {
    const config = await loadConfig(ctx);
    const profileName = selectProfile(ctx, config, global);
    const profile = config.profiles[profileName];
    const account =
      global.account?.trim() || ctx.env["PIDGEN_ACCOUNT"] || profile?.default_account || null;

    if (!profile || !account || !(account in profile.credentials)) {
      throw new CliError(
        "CREDENTIAL_NOT_FOUND",
        account
          ? `No credential is stored for ${account} in profile ${profileName}.`
          : `No Account is selected in profile ${profileName}; name one with --account.`,
        ExitCode.NotFound,
        { profile: profileName, account },
      );
    }

    const next = { ...profile, credentials: { ...profile.credentials } };
    delete next.credentials[account];
    if (next.default_account === account) delete next.default_account;
    config.profiles[profileName] = next;
    await saveConfig(ctx, config);

    return {
      data: {
        profile: profileName,
        account,
        removed: true,
        // The token stays valid on the server until it is revoked there.
        revoked: false,
        default_account: next.default_account ?? null,
      },
      meta: { profile: profileName, account },
    };
  },
};
