import { usageError } from "../../core/errors.js";
import type { ApiClient, ApiResponse } from "../../core/http.js";
import { addPreviewApplyOptions, previewApplyOptionsFrom } from "../../core/preview-options.js";
import {
  normalizeAcknowledgements,
  runPreviewApply,
  serverPreviewApply,
} from "../../core/preview.js";
import { ticketRef } from "../../core/refs.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";

/**
 * `pidgen ticket reopen <ref>`: previews reopening a completed ticket whose completion cannot be
 * proven (`POST /tickets/{ref}/reopen/preview`) — the invariants it violates and the delivery record
 * it supersedes — and, only with `--apply`, applies it (`POST /tickets/{ref}/reopen`) with the
 * preview's digest, returning the ticket to `awaiting_review`. A ticket that cannot be reopened is
 * the server's refusal and keeps its code. See docs/commands.md, "ticket reopen", and
 * docs/preview-and-apply.md.
 */
export const ticketReopen: CommandSpec = {
  path: ["ticket", "reopen"],
  summary: "Preview, then with --apply reopen a completed ticket whose delivery cannot be proven",
  configure(command) {
    command.argument("<ref>", "the ticket's key, e.g. PIDGEN-12, or its id");
    addPreviewApplyOptions(command);
  },
  async run(ctx, { args, options, global }) {
    const ref = ticketRef(args[0]);
    const previewApply = previewApplyOptionsFrom(ctx, { options, global });
    if (!previewApply.apply && previewApply.digest !== undefined) {
      throw usageError("--digest is only meaningful with --apply.");
    }
    normalizeAcknowledgements(previewApply.acknowledgements);

    const session = await openSession(ctx, global);
    let last: ApiResponse | null = null;
    const api: Pick<ApiClient, "request"> = {
      async request(request) {
        const response = await session.client.request(request);
        last = response;
        return response as never;
      },
    };
    const segment = encodeURIComponent(ref);
    const operation = serverPreviewApply(api, {
      command: "ticket reopen",
      target: ref,
      preview: { path: `/tickets/${segment}/reopen/preview` },
      apply: { path: `/tickets/${segment}/reopen` },
    });

    const result = await runPreviewApply(operation, previewApply);
    const meta = session.meta(last);
    if (result.mode === "preview") return { data: result.preview, meta };
    return {
      data: {
        settled: result.settled,
        result: result.result,
        idempotency_key: result.idempotency_key,
        ...(result.handle !== undefined ? { handle: result.handle } : {}),
      },
      meta,
    };
  },
};
