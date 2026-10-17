import type { CommandSpec } from "../../core/registry.js";
import { responseMeta } from "../../core/session.js";
import {
  openUserCredential,
  parseAnswer,
  sessionListSchema,
  storedAccountFor,
  withTokenHint,
} from "../../core/user-sessions.js";

/**
 * `pidgen auth list`: your live browser sessions and CLI tokens from `GET /me/sessions`, in the
 * server's order (sessions first, each most recently used first), marking the credential in use
 * (`current`) and the Account of this profile that stores a CLI token (`stored_account`). The route is
 * not Account-scoped, so no Account is sent. A Personal API Token is refused with
 * `TOKEN_NOT_ALLOWED` (exit code 3) before any network call; tokens are managed in the web app.
 */
export const authList: CommandSpec = {
  path: ["auth", "list"],
  summary: "List your sessions and CLI tokens, marking the one in use",
  async run(ctx, { global }) {
    const credential = await openUserCredential(ctx, global, "pidgen auth list");
    const response = await withTokenHint("pidgen auth list", () =>
      credential.client.request<unknown>({ method: "GET", path: "/me/sessions" }),
    );
    const entries = parseAnswer(sessionListSchema, "/me/sessions", response.data);
    return {
      data: entries.map((entry) => ({
        id: entry.session_id,
        kind: entry.kind,
        account: entry.kind === "cli_token" ? entry.account_id : null,
        device_label: entry.device_label,
        created_at: entry.created_at,
        last_used_at: entry.last_seen_at,
        expires_at: entry.kind === "cli_token" ? entry.expires_at : null,
        current: entry.current,
        mfa_verified: entry.mfa_verified ?? false,
        stored_account:
          entry.kind === "cli_token"
            ? storedAccountFor(credential.profile, entry.session_id)
            : null,
      })),
      meta: responseMeta(credential.target, response),
    };
  },
};
