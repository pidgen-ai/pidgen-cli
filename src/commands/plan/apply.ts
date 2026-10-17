import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CliError, usageError } from "../../core/errors.js";
import type { ApiClient, ApiResponse } from "../../core/http.js";
import type { RunContext } from "../../core/context.js";
import { inputInvalid, readInput, validateBody, type InputIssue } from "../../core/input.js";
import { addPreviewApplyOptions, previewApplyOptionsFrom } from "../../core/preview-options.js";
import { runPreviewApply, serverPreviewApply } from "../../core/preview.js";
import { ticketRef } from "../../core/refs.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import { PUBLIC_API_DOCUMENT } from "../api/document.js";

export const PREVIEW_TEMPLATE = "/api/v1/tickets/{ticket_id}/child-plan/preview";

/**
 * `pidgen plan apply <root> -f <plan>`: previews a complete replacement of a high-level ticket's
 * child plan (`POST /tickets/{ref}/child-plan/preview`) and, only with `--apply`, applies it
 * (`PUT /tickets/{ref}/child-plan`) with the same plan and the preview's digest, which binds the
 * ticket version and current plan digest the preview read. Follows docs/preview-and-apply.md: a
 * refusal exits 5 with its code even when the server answers it with 200.
 */
export const planApply: CommandSpec = {
  path: ["plan", "apply"],
  summary: "Preview, then with --apply replace a ticket's child plan",
  configure(command) {
    command
      .argument("<root>", "the high-level ticket, e.g. PIDGEN-12")
      .requiredOption("-f, --file <plan>", "the plan as JSON or YAML; - reads standard input");
    addPreviewApplyOptions(command);
  },
  async run(ctx, { args, options, global }) {
    const root = ticketRef(args[0], "<root>");
    const previewApply = previewApplyOptionsFrom(ctx, { options, global });
    if (!previewApply.apply && previewApply.digest !== undefined) {
      throw usageError("--digest is only meaningful with --apply.");
    }
    const input = await readInput(ctx, options["file"] as string);
    const plan = await validatePlan(ctx, input.source, input.value);

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
    const operation = serverPreviewApply(api, {
      command: "plan apply",
      target: root,
      preview: { path: `/tickets/${ref}/child-plan/preview`, body: { plan } },
      apply: { method: "PUT", path: `/tickets/${ref}/child-plan`, body: { plan } },
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

/** The most characters a brief may have, as the child-plan schema states. */
const BRIEF_MAX_CHARACTERS = 8192;
/** No UTF-8 text of at most BRIEF_MAX_CHARACTERS characters is longer than this many bytes. */
const BRIEF_MAX_BYTES = BRIEF_MAX_CHARACTERS * 4;

/**
 * The file is the plan itself (`children`, `dependencies`, `summary`); it is checked against the
 * preview request's `plan` schema, and issues are reported at their place in the file. A child's
 * `team_member_id` (the Agent to run it) is sent as written; the server judges its eligibility.
 *
 * A child may name `brief_file` instead of `context_artifacts`: the file is read here, relative to
 * the plan file, and sent as the child's one brief. Every problem is reported together, before any
 * request. The plan returned is what is sent: `brief_file` is replaced by that `context_artifacts`
 * item, and everything else is as the file wrote it.
 */
async function validatePlan(
  ctx: RunContext,
  source: string,
  plan: unknown,
): Promise<Record<string, unknown>> {
  let issues: InputIssue[] = [];
  try {
    validateBody(PUBLIC_API_DOCUMENT, "post", PREVIEW_TEMPLATE, { plan });
  } catch (error) {
    if (!(error instanceof CliError) || !Array.isArray(error.details["issues"])) throw error;
    issues = (error.details["issues"] as InputIssue[]).map((issue) => ({
      ...issue,
      path: issue.path.replace(/^\$\.plan(?=$|[.[])/, "$"),
    }));
  }
  const children = isRecord(plan) && Array.isArray(plan["children"]) ? plan["children"] : [];
  const briefs = await readBriefFiles(ctx, source, children, issues);
  if (issues.length > 0) {
    const count = issues.length === 1 ? "1 issue" : `${issues.length} issues`;
    throw inputInvalid(`Plan ${source} does not match the child-plan schema (${count})`, {
      source,
      issues,
    });
  }
  if (briefs.size === 0) return plan as Record<string, unknown>;
  return {
    ...(plan as Record<string, unknown>),
    children: children.map((child: unknown, index) => {
      const brief = briefs.get(index);
      if (brief === undefined) return child;
      const sent: Record<string, unknown> = { ...(child as Record<string, unknown>) };
      delete sent["brief_file"];
      sent["context_artifacts"] = [brief];
      return sent;
    }),
  };
}

/**
 * Reads each child's `brief_file`, relative to the plan file (or the working directory when the
 * plan came from standard input), into the brief item it stands for, by child index. A file that
 * is missing, is not a regular file, is empty or has more than 8192 characters is an issue at
 * `$.children[n].brief_file`, as is a `brief_file` that is not a non-empty string or that comes
 * with `context_artifacts`: the two forms are alternatives.
 */
async function readBriefFiles(
  ctx: RunContext,
  source: string,
  children: unknown[],
  issues: InputIssue[],
): Promise<Map<number, Record<string, string>>> {
  const base = source === "-" ? ctx.cwd : dirname(resolve(ctx.cwd, source));
  const briefs = new Map<number, Record<string, string>>();
  for (const [index, child] of children.entries()) {
    if (!isRecord(child) || !("brief_file" in child)) continue;
    const path = `$.children[${index}].brief_file`;
    const name = child["brief_file"];
    if (typeof name !== "string" || name === "") {
      issues.push({
        path,
        message: "brief_file must be the path of a file, as a non-empty string.",
      });
      continue;
    }
    if ("context_artifacts" in child) {
      issues.push({
        path,
        message:
          "Give a child either brief_file or context_artifacts, not both: brief_file is sent as the child's one brief.",
      });
      continue;
    }
    const content = await readBrief(resolve(base, name), name, source);
    if (typeof content !== "string") issues.push({ path, message: content.problem });
    else briefs.set(index, { type: "brief", tier: "stage", content });
  }
  return briefs;
}

/** The brief's text, or the problem with the file. */
async function readBrief(
  file: string,
  name: string,
  source: string,
): Promise<string | { problem: string }> {
  const tooLong = {
    problem: `brief_file ${name} is over ${BRIEF_MAX_CHARACTERS} characters, the most a brief may have. Shorten it.`,
  };
  try {
    const info = await stat(file);
    if (!info.isFile()) return { problem: `brief_file ${name} is not a file.` };
    if (info.size > BRIEF_MAX_BYTES) return tooLong;
    const text = await readFile(file, "utf8");
    if (text === "") return { problem: `brief_file ${name} is empty; a brief needs content.` };
    return [...text].length > BRIEF_MAX_CHARACTERS ? tooLong : text;
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? String(error);
    const base = source === "-" ? "the working directory" : source;
    return { problem: `Cannot read brief_file ${name}, relative to ${base}: ${reason}.` };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
