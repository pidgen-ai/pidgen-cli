import { CliError, usageError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import type { ApiClient, ApiResponse } from "../../core/http.js";
import { addPreviewApplyOptions, previewApplyOptionsFrom } from "../../core/preview-options.js";
import {
  runPreviewApply,
  serverPreviewApply,
  type Preview,
  type PreviewApplyOperation,
} from "../../core/preview.js";
import { ticketRef } from "../../core/refs.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";

/** One admission gate of a promotion preview. */
interface PromotionGate {
  gate: string;
  passed: boolean;
  reason: string;
  repair_target: string | null;
}

/**
 * `pidgen plan promote <root>`: previews promoting a high-level Backlog ticket, with the cohort of
 * children its plan covers, into execution (`POST /tickets/{ref}/promotion/preview`) and, only
 * with `--apply`, applies it (`POST /tickets/{ref}/promotion`) with the preview's digest, following
 * a `202` on its `status_url`. The preview lists every gate and each failing one; failing gates are
 * part of the preview, not a refusal. `--apply` without `--digest` applies nothing when the fresh
 * preview has a failing gate (`PROMOTION_GATE_FAILED`, exit 5), as the server would refuse it.
 * See docs/commands.md, "plan promote", and docs/preview-and-apply.md.
 */
export const planPromote: CommandSpec = {
  path: ["plan", "promote"],
  summary: "Preview, then with --apply promote a ticket and its plan into execution",
  configure(command) {
    command.argument("<root>", "the high-level ticket, e.g. PIDGEN-12");
    addPreviewApplyOptions(command);
  },
  async run(ctx, { args, options, global }) {
    const root = ticketRef(args[0], "<root>");
    const previewApply = previewApplyOptionsFrom(ctx, { options, global });
    if (!previewApply.apply && previewApply.digest !== undefined) {
      throw usageError("--digest is only meaningful with --apply.");
    }

    const session = await openSession(ctx, global);
    let last: ApiResponse | null = null;
    const api: Pick<ApiClient, "request"> = {
      async request(request) {
        const response = await session.client.request(request);
        last = response;
        return response as never;
      },
    };
    const ref = encodeURIComponent(root);
    const server = serverPreviewApply(api, {
      command: "plan promote",
      target: root,
      preview: { path: `/tickets/${ref}/promotion/preview` },
      apply: { path: `/tickets/${ref}/promotion` },
    });
    const operation: PreviewApplyOperation = {
      ...server,
      async preview() {
        const preview = readPromotionPreview(await server.preview(), last);
        if (previewApply.apply && previewApply.digest === undefined) refuseFailingGates(preview);
        return preview;
      },
    };

    const result = await runPreviewApply(operation, previewApply);
    const meta = session.meta(last);
    if (result.mode === "preview") {
      if (ctx.io.interactive) reportGates(ctx.io.stderr, result.preview);
      return { data: result.preview, meta };
    }
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

/** A promotion preview must say whether it passed and list its gates and its failing gates. */
function readPromotionPreview(preview: Preview, response: ApiResponse | null): Preview {
  if (
    typeof preview["passed"] === "boolean" &&
    Array.isArray(preview["gate_results"]) &&
    Array.isArray(preview["failing_gates"]) &&
    preview["failing_gates"].every(isGate)
  ) {
    return preview;
  }
  throw new CliError(
    "UNEXPECTED_RESPONSE",
    "The server's promotion preview did not carry passed, gate_results and failing_gates.",
    ExitCode.Unexpected,
    { request_id: response?.requestId ?? null },
  );
}

/**
 * `--apply` without `--digest` applies the fresh preview's digest; when that preview has a failing
 * gate the server would refuse it, so nothing is sent and the gates to repair are reported.
 */
function refuseFailingGates(preview: Preview): void {
  const failing = preview["failing_gates"] as PromotionGate[];
  if (preview["passed"] === true && failing.length === 0) return;
  const names = failing.map((gate) => gate.gate);
  const count = failing.length === 1 ? "1 gate fails" : `${failing.length} gates fail`;
  throw new CliError(
    "PROMOTION_GATE_FAILED",
    `The promotion cannot be applied: ${count}${names.length > 0 ? ` (${names.join(", ")})` : ""}. Repair each failing gate, then preview again.`,
    ExitCode.Refused,
    { failing_gates: failing, preview },
  );
}

/** Terminal-only summary of the failing gates; standard output still carries only the envelope. */
function reportGates(write: (text: string) => void, preview: Preview): void {
  const failing = preview["failing_gates"] as PromotionGate[];
  if (failing.length === 0) {
    write("Every promotion gate passed.\n");
    return;
  }
  write(`${failing.length} failing promotion gate${failing.length === 1 ? "" : "s"}:\n`);
  for (const gate of failing) {
    const repair = gate.repair_target !== null ? ` (repair ${gate.repair_target})` : "";
    write(`  ${gate.gate}: ${gate.reason}${repair}\n`);
  }
}

function isGate(value: unknown): value is PromotionGate {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)["gate"] === "string" &&
    typeof (value as Record<string, unknown>)["passed"] === "boolean" &&
    typeof (value as Record<string, unknown>)["reason"] === "string"
  );
}
