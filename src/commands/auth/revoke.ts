import { saveConfig } from "../../core/config.js";
import { pathSegment } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import { responseMeta } from "../../core/session.js";
import {
  openUserCredential,
  parseAnswer,
  sessionRevokedSchema,
  withTokenHint,
} from "../../core/user-sessions.js";

/**
 * `pidgen auth revoke <id>`: revokes one of your browser sessions or CLI tokens, by the id
 * `pidgen auth list` shows (`DELETE /me/sessions/{session_id}`). It stops working at once. The server
 * has no preview for it, so it acts directly, as `ticket dep rm` does. When the revoked credential is
 * the one in use (`current`), every stored credential in the profile holding that token is removed,
 * and so is any stored CLI token whose `token_id` is `<id>`; the profile's default Account is cleared
 * if it pointed at a removed one. A Personal API Token is refused with `TOKEN_NOT_ALLOWED` (exit
 * code 3) before any network call.
 */
export const authRevoke: CommandSpec = {
  path: ["auth", "revoke"],
  summary: "Revoke one of your sessions or CLI tokens by id",
  configure(command) {
    command.argument("<id>", "the session or CLI token id, as pidgen auth list shows it");
  },
  async run(ctx, { args, global }) {
    const segment = pathSegment("session or token id", args[0]);
    const id = args[0]?.trim() ?? "";
    const credential = await openUserCredential(ctx, global, "pidgen auth revoke");
    const response = await withTokenHint("pidgen auth revoke", () =>
      credential.client.request<unknown>({ method: "DELETE", path: `/me/sessions/${segment}` }),
    );
    const result = parseAnswer(sessionRevokedSchema, "/me/sessions/{session_id}", response.data);

    // The revoked token no longer works: forget every stored copy of it.
    const { config, target } = credential;
    const profile = config.profiles[target.profile];
    const removed: string[] = [];
    if (profile) {
      for (const [account, stored] of Object.entries(profile.credentials)) {
        const inUse = result.current && stored.token === target.token;
        const byId = stored.kind === "cli" && stored.token_id === id;
        if (inUse || byId) removed.push(account);
      }
    }
    let defaultAccount = profile?.default_account ?? null;
    if (profile && removed.length > 0) {
      const next = { ...profile, credentials: { ...profile.credentials } };
      for (const account of removed) delete next.credentials[account];
      if (next.default_account && removed.includes(next.default_account)) {
        delete next.default_account;
      }
      config.profiles[target.profile] = next;
      await saveConfig(ctx, config);
      defaultAccount = next.default_account ?? null;
    }

    return {
      data: {
        id,
        revoked: result.revoked,
        current: result.current,
        profile: target.profile,
        removed_from_profile: removed.sort((a, b) => a.localeCompare(b)),
        default_account: defaultAccount,
      },
      meta: responseMeta(target, response),
    };
  },
};
