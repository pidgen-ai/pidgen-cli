import { INITIATIVE_REFUSALS } from "./errors.js";
import { renderDetails, wrap } from "./resource-human.js";

/** Mutation surface outside auth, account, worker and setup; usable by the response audit. */
export const MUTATION_PRESENTATIONS: ReadonlySet<string> = new Set([
  "ticket act",
  "ticket retry",
  "ticket replay",
  "ticket reopen",
  "ticket cancel",
  "plan apply",
  "plan promote",
  "manifest apply",
  "ticket create",
  "ticket edit",
  "ticket owner",
  "ticket follow",
  "ticket unfollow",
  "ticket dep add",
  "ticket dep rm",
  "ticket move",
  "ticket clarify",
  "ticket template",
  "ticket contract implements",
  "ticket contract builds-against",
  "ticket contract rm",
  "epic create",
  "epic edit",
  "epic edge add",
  "epic edge rm",
  "domain create",
  "domain edit",
  "domain archive",
  "domain unarchive",
  "domain project add",
  "domain project rm",
  "domain parent add",
  "domain parent rm",
  "domain member add",
  "domain member rm",
  "domain maintainer add",
  "domain maintainer rm",
  "contract create",
  "contract revise",
  "contract accept",
  "contract publish",
  "contract propose",
  "intent submit",
  "intent respond",
  "intent withdraw",
  "request submit",
  "request reply",
  "request acknowledge",
  "request accept",
  "request close",
  "request promote",
  "session steer",
  "session edit-instruction",
  "session withdraw-instruction",
  "feedback",
  "api post",
  "api put",
  "api patch",
  "api delete",
  "plan template",
  "manifest template",
]);

type Row = Record<string, unknown>;
const PREVIEW_COMMANDS = new Set([
  "ticket act",
  "ticket retry",
  "ticket replay",
  "ticket reopen",
  "ticket cancel",
  "plan apply",
  "plan promote",
  "manifest apply",
]);
function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Presentation only: never calls the server or changes a result or acknowledgement. */
export function renderMutation(
  command: string,
  data: unknown,
  columns?: number,
  responseStatus?: number,
): string | undefined {
  if (!MUTATION_PRESENTATIONS.has(command)) return undefined;
  const row = isRecord(data) ? data : {};
  const preview = row["mode"] === "preview" && isRecord(row["preview"]) ? row["preview"] : row;
  if (isPreview(preview)) return `${command}\n${renderPreview(command, preview, columns)}\n`;

  const result = isRecord(row["result"]) ? row["result"] : row;
  const state = result["state"] ?? result["status"];
  let heading: string;
  if (
    responseStatus === 202 ||
    row["settled"] === false ||
    ["applying", "pending", "queued", "dispatched", "halting"].includes(String(state)) ||
    ((command.startsWith("session ") || command === "ticket cancel") && state === "accepted")
  ) {
    heading = "Accepted — still pending.";
  } else if (
    row["outcome"] === "needs_clarification" ||
    row["outcome"] === "still_needs_clarification"
  ) {
    heading = "Needs clarification.";
  } else if (row["settled"] === true) {
    heading = "Applied — settled.";
  } else if (command.endsWith(" template")) {
    heading = "Template created.";
  } else {
    // Direct writes, especially raw API calls, have no shared settlement contract.
    heading = "Response received.";
  }
  return `${command}\n${heading}\n${renderDetails(data, columns)}\n`;
}

interface Failure {
  code: string;
  message: string;
  details: Row;
}

/** Mutation failures retain the server's findings, recovery guidance and operation handles. */
export function renderMutationFailure(
  command: string,
  error: Failure,
  columns?: number,
): string | undefined {
  if (!MUTATION_PRESENTATIONS.has(command)) return undefined;
  const parts = [`error ${error.code}: ${error.message}`];
  const sentence = INITIATIVE_REFUSALS[error.code];
  if (sentence !== undefined)
    parts.push(wrap(sentence, columns !== undefined && columns > 0 ? Math.floor(columns) : 80));
  if (
    error.code === "TIMEOUT" &&
    (error.details["handle"] !== undefined || error.details["last"] !== undefined)
  ) {
    parts.push("Wait timed out — still pending. The operation was not cancelled.");
  }
  const preview = isRecord(error.details["preview"]) ? error.details["preview"] : error.details;
  if (isPreview(preview)) {
    if (preview !== error.details) {
      const other = Object.fromEntries(
        Object.entries(error.details).filter(([key]) => key !== "preview"),
      );
      if (Object.keys(other).length) parts.push(renderDetails(other, columns));
    }
    parts.push(renderPreview(command, preview, columns));
  } else if (Object.keys(error.details).length) {
    parts.push(renderDetails(error.details, columns));
  }
  return parts.join("\n") + "\n";
}

function isPreview(row: Row): boolean {
  return (
    row["dry_run"] === true ||
    (row["settled"] === undefined &&
      row["status"] !== "applied" &&
      row["status"] !== "applying" &&
      typeof row["preview_digest"] === "string" &&
      Array.isArray(row["required_acknowledgements"]))
  );
}

function renderPreview(command: string, preview: Row, columns?: number): string {
  const width =
    columns !== undefined && Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80;
  const prose = (text: string) => wrap(text, width);
  const parts = [
    "Preview — not applied.",
    "Proposed effects and requirements",
    renderDetails(preview, columns),
  ];
  if (hasBlocker(preview))
    parts.push(prose("Repair blockers, then preview again before applying."));
  const digest = preview["preview_digest"];
  if (PREVIEW_COMMANDS.has(command) && typeof digest === "string" && digest !== "") {
    const acknowledgements = Array.isArray(preview["required_acknowledgements"])
      ? preview["required_acknowledgements"].filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const flags = [
      "--apply",
      "--digest",
      shellValue(digest),
      ...acknowledgements.flatMap((code) => ["--ack", shellValue(code)]),
    ];
    parts.push(
      prose("To apply, review the preview and rerun with the same arguments and input, adding:"),
      "  " + flags.join(" "),
    );
    if (preview["reason_required"] === true)
      parts.push(prose("Also supply --reason with your reason for the change."));
  } else if (preview["dry_run"] === true && command.startsWith("contract ")) {
    parts.push(prose("Review the dry run before rerunning without --check."));
  } else if (command.startsWith("api ")) {
    parts.push(
      prose(
        "Review the preview, then use the matching public apply route with its required request body.",
      ),
    );
  }
  return parts.join("\n");
}

function hasBlocker(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasBlocker);
  if (!isRecord(value)) return false;
  return (
    value["committable"] === false ||
    value["passed"] === false ||
    value["blocks"] === "commit" ||
    value["blocks"] === "promotion" ||
    Object.entries(value).some(
      ([key, item]) =>
        ((key === "blockers" || key === "failing_gates") &&
          Array.isArray(item) &&
          item.length > 0) ||
        hasBlocker(item),
    )
  );
}

/** Values can be copied as shell arguments, including opaque values containing spaces or quotes. */
function shellValue(value: string): string {
  return /^[a-zA-Z0-9_:/.,=+@%-]+$/.test(value)
    ? value
    : "'" + value.replaceAll("'", "'\\''") + "'";
}
