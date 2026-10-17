import { CliError, usageError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import type { ApiClient, ApiResponse } from "../../core/http.js";
import { inputInvalid, readInput, validateBody, type InputIssue } from "../../core/input.js";
import { addPreviewApplyOptions, previewApplyOptionsFrom } from "../../core/preview-options.js";
import { runPreviewApply, serverPreviewApply, type Preview } from "../../core/preview.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import { MANIFEST_DOCUMENT, MANIFEST_PREVIEW_ROUTE } from "./contract.js";

/** One finding of a manifest preview, as the manifest contract states it. */
export interface ManifestFinding {
  code: string;
  blocks: "commit" | "promotion" | "none";
  subject: string;
  path: string;
  message: string;
  detail?: Record<string, unknown>;
}

interface ManifestPreview extends Preview {
  findings: ManifestFinding[];
  committable: boolean;
  promotable: boolean;
}

/**
 * `pidgen manifest apply -f <manifest>`: previews a ticket manifest — a new high-level ticket, its
 * children, their edges and placement — with `POST /ticket-manifests/preview`, and prints every
 * finding grouped by ref with `committable`, `promotable` and the digest. A manifest that is not
 * committable exits 5 (`MANIFEST_NOT_COMMITTABLE`), and nothing is committed. With `--apply` it
 * then commits the same manifest (`POST /ticket-manifests`) with the preview's digest (or
 * `--digest`) and an idempotency key, and prints each ref's ticket key. See docs/commands.md,
 * "manifest apply".
 */
export const manifestApply: CommandSpec = {
  path: ["manifest", "apply"],
  summary: "Preview a ticket manifest, then with --apply commit it in one transaction",
  configure(command) {
    command.requiredOption(
      "-f, --file <manifest>",
      "the manifest as JSON or YAML; - reads standard input",
    );
    addPreviewApplyOptions(command);
  },
  async run(ctx, { options, global }) {
    const previewApply = previewApplyOptionsFrom(ctx, { options, global });
    if (!previewApply.apply && previewApply.digest !== undefined) {
      throw usageError("--digest is only meaningful with --apply.");
    }
    const input = await readInput(ctx, options["file"] as string);
    const manifest = validateManifest(input.source, input.value);

    const session = await openSession(ctx, global);
    let last: ApiResponse | null = null;
    const api: Pick<ApiClient, "request"> = {
      async request(request) {
        const response = await session.client.request(request);
        last = response;
        return response as never;
      },
    };
    const target = manifestTarget(manifest);
    const operation = serverPreviewApply(api, {
      command: "manifest apply",
      target,
      preview: { path: "/ticket-manifests/preview", body: { manifest } },
      apply: { method: "POST", path: "/ticket-manifests", body: { manifest } },
    });

    const preview = readManifestPreview(await operation.preview());
    const report = previewReport(preview, manifest);
    if (!preview.committable) {
      const blocking = preview.findings
        .filter((finding) => finding.blocks === "commit" || blocksPromotedCommit(finding, manifest))
        .map((finding) => finding.code);
      throw new CliError(
        "MANIFEST_NOT_COMMITTABLE",
        `The manifest cannot be committed: ${countOf(blocking.length, "finding")} ${blocking.length === 1 ? "blocks" : "block"} the commit. Fix every finding the preview reports, then preview again.`,
        ExitCode.Refused,
        { ...report, blocking },
      );
    }
    if (!previewApply.apply) return { data: report, meta: session.meta(last) };

    const result = await runPreviewApply(
      { ...operation, preview: () => Promise.resolve(preview) },
      previewApply,
    );
    if (result.mode === "preview") return { data: report, meta: session.meta(last) };
    const committed = isRecord(result.result) ? result.result : {};
    return {
      data: {
        settled: result.settled,
        preview_digest: previewApply.digest ?? preview.preview_digest,
        idempotency_key: result.idempotency_key,
        tickets: ticketKeys(committed),
        ...(typeof committed["promoted"] === "boolean" ? { promoted: committed["promoted"] } : {}),
        result: result.result,
        ...(result.handle !== undefined ? { handle: result.handle } : {}),
      },
      meta: session.meta(last),
    };
  },
};

/**
 * The file is the manifest itself; it is checked against the preview request's `manifest` schema
 * in the committed manifest contract, and issues are reported at their place in the file.
 */
function validateManifest(source: string, manifest: unknown): Record<string, unknown> {
  try {
    validateBody(MANIFEST_DOCUMENT, "post", MANIFEST_PREVIEW_ROUTE, { manifest });
  } catch (error) {
    if (!(error instanceof CliError) || !Array.isArray(error.details["issues"])) throw error;
    const issues = (error.details["issues"] as InputIssue[]).map((issue) => ({
      ...issue,
      path: issue.path.replace(/^\$\.manifest(?=$|[.[])/, "$"),
    }));
    throw inputInvalid(
      `Manifest ${source} does not match the ticket-manifest schema (${countOf(issues.length, "issue")})`,
      { source, issues },
    );
  }
  return manifest as Record<string, unknown>;
}

/** The project and root ref: part of the derived idempotency key, beside the digest. */
function manifestTarget(manifest: Record<string, unknown>): string {
  const root = isRecord(manifest["root"]) ? manifest["root"] : {};
  const ref = typeof root["ref"] === "string" ? root["ref"] : "root";
  return `${String(manifest["project_id"])}/${ref}`;
}

function readManifestPreview(preview: Preview): ManifestPreview {
  if (
    Array.isArray(preview["findings"]) &&
    preview["findings"].every(isFinding) &&
    typeof preview["committable"] === "boolean" &&
    typeof preview["promotable"] === "boolean"
  ) {
    return preview as ManifestPreview;
  }
  throw new CliError(
    "UNEXPECTED_RESPONSE",
    "The server's manifest preview did not carry findings, committable and promotable.",
    ExitCode.Unexpected,
  );
}

/**
 * What the preview prints: `committable`, `promotable`, the digest, the findings grouped by the
 * ticket ref they concern (`manifest` for the manifest as a whole; a criterion's finding goes
 * under its ticket), and the server's resolved plan.
 */
function previewReport(preview: ManifestPreview, manifest: Record<string, unknown>) {
  return {
    committable: preview.committable,
    promotable: preview.promotable,
    preview_digest: preview.preview_digest,
    required_acknowledgements: preview.required_acknowledgements,
    finding_count: preview.findings.length,
    findings: groupFindings(preview.findings, manifestRefs(manifest)),
    ...(preview["plan"] !== undefined ? { plan: preview["plan"] } : {}),
  };
}

/** `manifest`, the root's ref, then each child's ref, in manifest order. */
function manifestRefs(manifest: Record<string, unknown>): string[] {
  const root = isRecord(manifest["root"]) ? manifest["root"] : {};
  const children = Array.isArray(manifest["children"]) ? manifest["children"] : [];
  return [
    "manifest",
    typeof root["ref"] === "string" ? root["ref"] : "root",
    ...children.flatMap((child: unknown) =>
      isRecord(child) && typeof child["ref"] === "string" ? [child["ref"]] : [],
    ),
  ];
}

/** Findings by ticket ref, in `order` first, then any other subject in the order first seen. */
export function groupFindings(
  findings: ManifestFinding[],
  order: string[],
): Record<string, ManifestFinding[]> {
  const groups = new Map<string, ManifestFinding[]>();
  for (const finding of findings) {
    const ref = finding.subject.split("/")[0] || "manifest";
    groups.set(ref, [...(groups.get(ref) ?? []), finding]);
  }
  const keys = [
    ...order.filter((ref) => groups.has(ref)),
    ...[...groups.keys()].filter((ref) => !order.includes(ref)),
  ];
  return Object.fromEntries(keys.map((ref) => [ref, groups.get(ref) as ManifestFinding[]]));
}

/** With `promote: true`, a finding that blocks promotion blocks the commit too. */
function blocksPromotedCommit(finding: ManifestFinding, manifest: Record<string, unknown>) {
  return manifest["promote"] === true && finding.blocks === "promotion";
}

/** Each committed ref's ticket key, root first, from the commit result. */
function ticketKeys(result: Record<string, unknown>): Record<string, string> {
  const children = Array.isArray(result["children"]) ? result["children"] : [];
  const keys: Record<string, string> = {};
  for (const ticket of [result["root"], ...children]) {
    if (isRecord(ticket) && typeof ticket["ref"] === "string") {
      if (typeof ticket["ticket_key"] === "string") keys[ticket["ref"]] = ticket["ticket_key"];
    }
  }
  return keys;
}

function isFinding(value: unknown): value is ManifestFinding {
  return (
    isRecord(value) &&
    typeof value["code"] === "string" &&
    typeof value["subject"] === "string" &&
    (value["blocks"] === "commit" || value["blocks"] === "promotion" || value["blocks"] === "none")
  );
}

function countOf(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
