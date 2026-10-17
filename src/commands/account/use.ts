import { credentialRequired, loadConfig, saveConfig, selectProfile } from "../../core/config.js";
import { usageError } from "../../core/errors.js";
import type { CommandSpec } from "../../core/registry.js";

/**
 * `pidgen account use <ACC-…>`: makes an Account the selected profile's default. The Account must
 * already have a stored credential; otherwise it fails with `AUTH_REQUIRED` (exit code 3) and a hint
 * to log in. Starting a device-code login instead is planned.
 */
export const accountUse: CommandSpec = {
  path: ["account", "use"],
  summary: "Make an Account with a stored credential the profile's default",
  configure(command) {
    command.argument("<account>", "the Account id, e.g. ACC-EXAMPLE");
  },
  async run(ctx, { args, global }) {
    const account = args[0]?.trim();
    if (!account) throw usageError("An Account id is required: pidgen account use <ACC-…>.");

    const config = await loadConfig(ctx);
    const profileName = selectProfile(ctx, config, global);
    const profile = config.profiles[profileName];
    const credential = profile?.credentials[account];
    if (!profile || !credential) throw credentialRequired(profileName, account);

    const previous = profile.default_account ?? null;
    config.profiles[profileName] = { ...profile, default_account: account };
    await saveConfig(ctx, config);

    return {
      data: {
        profile: profileName,
        account,
        previous_default: previous,
        credential_kind: credential.kind,
      },
      meta: { profile: profileName, account },
    };
  },
};
