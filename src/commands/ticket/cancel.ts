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

const DISPOSITIONS = ["cancelled", "wont_do", "superseded"] as const;
type Disposition = (typeof DISPOSITIONS)[number];

/**
 * `pidgen ticket cancel <ref>`: previews cancelling a ticket and every descendant
 * (`POST /tickets/{ref}/cancellation/preview`) — the tickets it cancels, the dependents it leaves
 * blocked, the workspace it releases — and, only with `--apply`, applies it
 * (`POST /tickets/{ref}/cancellation`) with the preview's digest, the explicit `--ack` codes, the
 * `--disposition` (and `--superseded-by`), `--reason`, and the same `retain_workspace` the preview
 * was made with (`false` with `--discard-workspace`) and the same `close_pull_request`.
 *
 * `close_pull_request` is `false` unless `--close-pr` is given, so an open, unmerged pull request is
 * left open by default; the preview digest covers it, and an apply that differs from its preview is
 * the server's `PREVIEW_STALE`. The preview's plan carries the pull request and the latest delivery
 * operation as the server answers them, and a `DELIVERY_IN_FLIGHT` or `PUBLICATION_RESULT_UNKNOWN`
 * refusal keeps its code, its exit status and its `error.details.operation`. A `202` is followed on
 * its `status_url` with `--wait`. A ticket that cannot be cancelled is the server's refusal and
 * keeps its code. See docs/commands.md, "ticket cancel", and docs/preview-and-apply.md.
 */
export const ticketCancel: CommandSpec = {
  path: ["ticket", "cancel"],
  summary: "Preview, then with --apply cancel a ticket and its descendants",
  configure(command) {
    command
      .argument("<ref>", "the ticket's key, e.g. PIDGEN-12, or its id")
      .option(
        "--disposition <kind>",
        "why the work stops: cancelled (default), wont_do or superseded",
      )
      .option("--superseded-by <ref>", "the ticket that replaces this one (implies superseded)")
      .option(
        "--discard-workspace",
        "delete the workspace branch instead of keeping its committed work",
      )
      .option(
        "--close-pr",
        "also close the ticket's open, unmerged pull request (by default it is left open)",
      );
    addPreviewApplyOptions(command);
  },
  async run(ctx, { args, options, global }) {
    const ref = ticketRef(args[0]);
    const { disposition, supersededBy } = dispositionFrom(options);
    const retainWorkspace = options["discardWorkspace"] !== true;
    const closePullRequest = options["closePr"] === true;
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
      command: "ticket cancel",
      target: ref,
      preview: {
        path: `/tickets/${segment}/cancellation/preview`,
        body: { retain_workspace: retainWorkspace, close_pull_request: closePullRequest },
      },
      apply: {
        path: `/tickets/${segment}/cancellation`,
        body: {
          retain_workspace: retainWorkspace,
          close_pull_request: closePullRequest,
          disposition,
          ...(supersededBy !== undefined ? { superseded_by: supersededBy } : {}),
        },
      },
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

/**
 * `--disposition` is `cancelled`, `wont_do` (or `wont-do`) or `superseded`; `--superseded-by`
 * names the replacing ticket and implies `superseded`. `superseded` without `--superseded-by`, or
 * `--superseded-by` with another disposition, is a usage error, so the server never sees it.
 */
function dispositionFrom(options: Record<string, unknown>): {
  disposition: Disposition;
  supersededBy?: string;
} {
  const raw = options["disposition"];
  let disposition: Disposition | undefined;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase().replaceAll("-", "_");
    if (!(DISPOSITIONS as readonly string[]).includes(normalized)) {
      throw usageError(`Not a disposition: "${raw}". Use cancelled, wont_do or superseded.`, {
        argument: "--disposition",
        value: raw,
      });
    }
    disposition = normalized as Disposition;
  }
  const rawSupersededBy = options["supersededBy"];
  if (typeof rawSupersededBy === "string") {
    const supersededBy = ticketRef(rawSupersededBy, "--superseded-by");
    if (disposition !== undefined && disposition !== "superseded") {
      throw usageError(`--superseded-by only goes with --disposition superseded.`, {
        argument: "--superseded-by",
      });
    }
    return { disposition: "superseded", supersededBy };
  }
  if (disposition === "superseded") {
    throw usageError(
      "--disposition superseded needs --superseded-by <ref>, the replacing ticket.",
      {
        argument: "--superseded-by",
      },
    );
  }
  return { disposition: disposition ?? "cancelled" };
}
