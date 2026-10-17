import { PUBLIC_API_DOCUMENT } from "../commands/api/document.js";
import type { components } from "../generated/api.js";
import { CliError, usageError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";
import type { ApiClient, ApiResponse } from "./http.js";
import { validateBody } from "./input.js";
import {
  confirmationGuidance,
  normalizeAcknowledgements,
  runPreviewApply,
  serverPreviewApply,
  type Preview,
  type PreviewApplyOperation,
  type PreviewApplyOptions,
} from "./preview.js";
import type { CommandResult } from "./registry.js";

/**
 * The Ticket actions interface: which actions a Ticket, its runs, their nodes and its declared
 * dependencies allow, why a blocked one is blocked, which one is recommended, and what each would
 * do. `GET /tickets/{ref}/actions` lists the
 * decisions; `POST /tickets/{ref}/actions/preview` previews one `{action, target}`; and
 * `POST /tickets/{ref}/actions/execute` executes it with the preview's digest on the shared
 * preview/apply convention. Shared by `pidgen ticket actions`, `pidgen ticket act`, `pidgen ticket retry`,
 * `pidgen ticket replay` and `pidgen review attention`. See docs/commands.md, "ticket actions and act".
 */

export type ActionDecision = components["schemas"]["ActionDecision"];
export type ActionKind = components["schemas"]["ActionKind"];
export type ActionFamily = components["schemas"]["ActionFamily"];
export type ActionTarget = components["schemas"]["ActionTarget"];
export type ActionFollowUp = components["schemas"]["FollowUpChoices"];
export type ActionException = components["schemas"]["ExceptionChoice"];
export type ActionCriterionOverride = components["schemas"]["CriterionOverrideChoice"];
export type ActionPlanCorrection = components["schemas"]["PlanCorrection"];
export type PlanCorrectionAnswer = components["schemas"]["PlanAnswer"];
export type ActionRefusal = components["schemas"]["Refusal"];
export type TicketActions = components["schemas"]["TicketActionList"];

/**
 * Every action kind and family the public API document publishes: the `ActionKind` and
 * `ActionFamily` enums of `contracts/openapi.json`, so a kind the server adds is accepted once the
 * committed document is updated, with no list to keep in step here.
 */
export const ACTION_KINDS: readonly ActionKind[] = contractEnum<ActionKind>("ActionKind");
export const ACTION_FAMILIES: readonly ActionFamily[] = contractEnum<ActionFamily>("ActionFamily");

function contractEnum<T extends string>(schema: "ActionKind" | "ActionFamily"): readonly T[] {
  const components = PUBLIC_API_DOCUMENT["components"];
  const schemas = isRecord(components) ? components["schemas"] : undefined;
  const found = isRecord(schemas) ? schemas[schema] : undefined;
  const values = isRecord(found) ? found["enum"] : undefined;
  if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) {
    throw new Error(`The public API document does not publish the ${schema} enum.`);
  }
  return values as unknown as readonly T[];
}

/**
 * The most characters the actions route's `run_id`, `node_id` and `prerequisite_id` filters
 * accept. A fan-out key has no published bound; the CLI keeps one so a typo cannot be unbounded.
 */
export const MAX_RUN_ID = 128;
export const MAX_NODE_ID = 256;
export const MAX_PREREQUISITE_ID = 128;
const MAX_FAN_OUT_KEY = 200;
/**
 * A decision key is opaque and has no published bound; the CLI keeps one so a typo cannot be
 * unbounded. `--delegate-to` takes a user id, bounded the same way.
 */
export const MAX_DECISION_KEY = 256;
export const MAX_USER_ID = 128;
/**
 * The most characters an exception's or a criterion override's `reason` takes, and the most
 * answers a plan correction carries, as the contract's `ExceptionChoice`, `CriterionOverrideChoice`
 * and `PlanCorrection` publish them.
 */
export const MAX_CHOICE_REASON = 2000;
export const MAX_PLAN_ANSWERS = 50;

/** The execute route's path template, whose request schema the execute body is checked against. */
const EXECUTE_TEMPLATE = "/api/v1/tickets/{ticket_id}/actions/execute";

/** An action named on the command line, accepted as `retry_run` or `retry-run`. */
export function actionKind(value: string | undefined): ActionKind {
  const normalized = (value ?? "").trim().toLowerCase().replaceAll("-", "_");
  if (!(ACTION_KINDS as readonly string[]).includes(normalized)) {
    throw usageError(
      value === undefined || value.trim() === ""
        ? `Missing <action>. Use one of ${ACTION_KINDS.join(", ")}.`
        : `Not an action: "${value}". Use one of ${ACTION_KINDS.join(", ")}.`,
      { argument: "<action>", ...(value !== undefined ? { value } : {}) },
    );
  }
  return normalized as ActionKind;
}

/**
 * An optional id flag (`--run`, `--node`, `--fan-out-key`, `--prerequisite`): trimmed, non-empty
 * and bounded.
 */
export function optionalId(value: unknown, option: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  const id = typeof value === "string" ? value.trim() : "";
  if (id === "") throw usageError(`${option} needs a value.`, { option });
  if (id.length > max) {
    throw usageError(`${option} is longer than ${max} characters.`, { option, value: id });
  }
  return id;
}

/**
 * The decision follow-up actions that take `--until`, and the one that takes `--delegate-to`: the
 * choices the contract's `FollowUpChoices` describes. Every other action takes neither.
 */
const UNTIL_ACTIONS: readonly ActionKind[] = ["snooze_reminders", "defer_decision", "keep_holding"];
const DELEGATE_ACTIONS: readonly ActionKind[] = ["delegate_decision"];

/**
 * An ISO 8601 date-time with an offset: `2026-10-12T09:00:00Z` or `2026-10-12T09:00:00+02:00`,
 * seconds optional, a fraction of a second allowed.
 */
const DATE_TIME =
  /^(?<date>(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2}))[Tt](?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2})(?<fraction>\.\d+)?)?(?<zone>[Zz]|[+-](?<zoneHour>\d{2}):(?<zoneMinute>\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Checks `--until` and returns it as the RFC 3339 date-time the contract's `until` takes (upper-case
 * `T` and `Z`, seconds present), or throws a usage error: a date with no time, a time with no
 * offset, or a value that is no calendar time at all (a 30th of February, an hour 25).
 */
export function untilFrom(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") throw usageError("--until needs a value.", { option: "--until" });
  const parts = DATE_TIME.exec(text)?.groups;
  const part = (name: string): number => Number(parts?.[name] ?? "0");
  const calendar =
    part("month") >= 1 &&
    part("month") <= 12 &&
    part("day") >= 1 &&
    part("day") <= daysInMonth(part("year"), part("month")) &&
    part("hour") <= 23 &&
    part("minute") <= 59 &&
    part("second") <= 59 &&
    part("zoneHour") <= 23 &&
    part("zoneMinute") <= 59;
  if (parts === undefined || !calendar) {
    throw usageError(
      `--until "${text}" is not an ISO 8601 date-time with an offset, e.g. 2026-10-12T09:00:00Z or 2026-10-12T09:00:00+02:00.`,
      { option: "--until", value: text },
    );
  }
  const { date = "", hour = "", minute = "", second = "00", fraction = "", zone = "" } = parts;
  return `${date}T${hour}:${minute}:${second}${fraction}${zone.toUpperCase()}`;
}

/**
 * Reads `--until` and `--delegate-to`, the follow-up choices, for `action`. They are sent as
 * `followup` on both the preview and the execute, so the same choices reach both. `--until` is
 * accepted only with snooze_reminders, defer_decision and keep_holding, and `--delegate-to` only
 * with delegate_decision; given with any other action it is a usage error (exit 2) and nothing is
 * sent. Returns undefined when neither was given, so no `followup` is sent at all; otherwise both
 * choices, null for the one not given.
 */
export function followUpFrom(
  action: ActionKind,
  options: Record<string, unknown>,
): ActionFollowUp | undefined {
  const until = options["until"];
  const delegateTo = options["delegateTo"];
  if (until !== undefined && !UNTIL_ACTIONS.includes(action)) {
    throw usageError(`--until is taken only by ${UNTIL_ACTIONS.join(", ")}, not ${action}.`, {
      option: "--until",
      action,
    });
  }
  if (delegateTo !== undefined && !DELEGATE_ACTIONS.includes(action)) {
    throw usageError(
      `--delegate-to is taken only by ${DELEGATE_ACTIONS.join(", ")}, not ${action}.`,
      { option: "--delegate-to", action },
    );
  }
  const untilValue = until !== undefined ? untilFrom(until) : undefined;
  const delegate = optionalId(delegateTo, "--delegate-to", MAX_USER_ID);
  if (untilValue === undefined && delegate === undefined) return undefined;
  // The contract's shape: both choices, null for the one this action does not take.
  return { until: untilValue ?? null, delegate_to: delegate ?? null };
}

/**
 * The choices the plan, start, approve and override actions take, each beside `action` and `target`
 * on the preview and on the execute alike: `exception` (approve_with_exception), `criterion_override`
 * (override_acceptance_criterion) and `plan_correction` (correct_plan_decision).
 */
export interface ActionChoices {
  exception?: ActionException;
  criterion_override?: ActionCriterionOverride;
  plan_correction?: ActionPlanCorrection;
}

const EXCEPTION_ACTIONS: readonly ActionKind[] = ["approve_with_exception"];
const OVERRIDE_ACTIONS: readonly ActionKind[] = ["override_acceptance_criterion"];
const CORRECTION_ACTIONS: readonly ActionKind[] = ["correct_plan_decision"];
/** The actions whose execute needs a `note`: what should change. */
const NOTE_ACTIONS: readonly ActionKind[] = ["request_delivery_changes"];

/** A flag that only some actions take, given for another action: a usage error naming both. */
function onlyFor(
  option: string,
  given: boolean,
  takers: readonly ActionKind[],
  action: ActionKind,
): void {
  if (given && !takers.includes(action)) {
    throw usageError(`${option} is taken only by ${takers.join(", ")}, not ${action}.`, {
      option,
      action,
    });
  }
}

/** A choice's free text: trimmed, not blank, and at most `MAX_CHOICE_REASON` characters. */
function choiceText(value: unknown, option: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") throw usageError(`${option} needs a value.`, { option });
  if (text.length > MAX_CHOICE_REASON) {
    throw usageError(`${option} is longer than ${MAX_CHOICE_REASON} characters.`, { option });
  }
  return text;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * One `<decision>=<text>` of `--answer` or `--alternative`: the decision's non-negative number, a
 * `=` and the text, which may itself contain `=`.
 */
function planAnswer(raw: string, option: string, what: string): { decision: number; text: string } {
  const separator = raw.indexOf("=");
  const decision = separator < 0 ? "" : raw.slice(0, separator).trim();
  const text = separator < 0 ? "" : raw.slice(separator + 1).trim();
  if (!/^\d+$/.test(decision) || !Number.isSafeInteger(Number(decision)) || text === "") {
    throw usageError(
      `${option} takes <decision>=<${what}>: the decision's number counting from 0, an =, then the ${what}.`,
      { option },
    );
  }
  return { decision: Number(decision), text };
}

/**
 * `--answer <decision>=<text>` (free text) and `--alternative <decision>=<option>` (a chosen
 * option), each repeatable, as the contract's `plan_correction`: one answer per decision, each with
 * exactly one of `free_text` and `alternative`, in the order of the decisions. A decision answered
 * twice, no answer at all, and more than `MAX_PLAN_ANSWERS` are usage errors.
 */
function planCorrectionFrom(options: Record<string, unknown>): ActionPlanCorrection | undefined {
  const answers = [
    ...strings(options["answer"]).map((raw) => ({
      ...planAnswer(raw, "--answer", "text"),
      field: "free_text" as const,
    })),
    ...strings(options["alternative"]).map((raw) => ({
      ...planAnswer(raw, "--alternative", "option"),
      field: "alternative" as const,
    })),
  ].sort((a, b) => a.decision - b.decision);
  if (answers.length === 0) return undefined;
  if (answers.length > MAX_PLAN_ANSWERS) {
    throw usageError(`A plan correction takes at most ${MAX_PLAN_ANSWERS} answers.`, {
      option: "--answer",
    });
  }
  const seen = new Set<number>();
  for (const { decision } of answers) {
    if (seen.has(decision)) {
      throw usageError(
        `Decision ${decision} is answered more than once; give one --answer or --alternative for it.`,
        { option: "--answer", decision },
      );
    }
    seen.add(decision);
  }
  return {
    answers: answers.map(({ decision, field, text }): PlanCorrectionAnswer =>
      field === "free_text" ? { decision, free_text: text } : { decision, alternative: text },
    ),
  };
}

/**
 * Reads `--exception-reason`, `--criterion-status` with `--override-reason`, and `--answer` or
 * `--alternative`, the choices of approve_with_exception, override_acceptance_criterion and
 * correct_plan_decision. They are sent on both the preview and the execute, so the same choices
 * reach both. A choice given for an action that does not take it, and an action that takes one
 * given without it, is a usage error (exit 2) and nothing is sent. Returns the choices given, and
 * none for an action that takes none.
 */
export function choicesFrom(action: ActionKind, options: Record<string, unknown>): ActionChoices {
  const exceptionReason = options["exceptionReason"];
  const status = options["criterionStatus"];
  const overrideReason = options["overrideReason"];
  const answers = strings(options["answer"]).length > 0;
  const alternatives = strings(options["alternative"]).length > 0;

  onlyFor("--exception-reason", exceptionReason !== undefined, EXCEPTION_ACTIONS, action);
  onlyFor("--criterion-status", status !== undefined, OVERRIDE_ACTIONS, action);
  onlyFor("--override-reason", overrideReason !== undefined, OVERRIDE_ACTIONS, action);
  onlyFor("--answer", answers, CORRECTION_ACTIONS, action);
  onlyFor("--alternative", alternatives, CORRECTION_ACTIONS, action);

  const choices: ActionChoices = {};
  if (EXCEPTION_ACTIONS.includes(action)) {
    if (exceptionReason === undefined) {
      throw usageError(
        `${action} needs --exception-reason <text>: why the delivery is approved although criteria are not proven.`,
        { action, option: "--exception-reason" },
      );
    }
    choices.exception = { reason: choiceText(exceptionReason, "--exception-reason") };
  }
  if (OVERRIDE_ACTIONS.includes(action)) {
    if (status === undefined || overrideReason === undefined) {
      const missing = [
        ...(status === undefined ? ["--criterion-status passing|failing|pending"] : []),
        ...(overrideReason === undefined ? ["--override-reason <text>"] : []),
      ];
      throw usageError(`${action} needs ${missing.join(" and ")}.`, {
        action,
        option: status === undefined ? "--criterion-status" : "--override-reason",
      });
    }
    choices.criterion_override = {
      status: status as ActionCriterionOverride["status"],
      reason: choiceText(overrideReason, "--override-reason"),
    };
  }
  if (CORRECTION_ACTIONS.includes(action)) {
    const correction = planCorrectionFrom(options);
    if (correction === undefined) {
      throw usageError(
        `${action} needs at least one --answer <decision>=<text> or --alternative <decision>=<option>.`,
        { action, option: "--answer" },
      );
    }
    choices.plan_correction = correction;
  }
  return choices;
}

/**
 * `--note`, sent as the execute's `note`. request_delivery_changes requires it, previewed or
 * applied, so that what is previewed is what is applied: given without it, or blank, it is a usage
 * error (exit 2) and nothing is sent. Every other action sends it only when given.
 */
export function noteFrom(action: ActionKind, options: Record<string, unknown>): string | undefined {
  const note = options["note"];
  if (NOTE_ACTIONS.includes(action)) {
    if (typeof note !== "string" || note.trim() === "") {
      throw usageError(`${action} needs --note <text>: what should change.`, {
        action,
        option: "--note",
      });
    }
  }
  return typeof note === "string" ? note : undefined;
}

/** The position of an acceptance criterion: a whole number from 0, as the contract's `criterion_index`. */
export function criterionIndex(value: unknown, option: string): number | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw usageError(`${option} takes the criterion's position, a whole number from 0.`, {
      option,
      ...(text !== "" ? { value: text } : {}),
    });
  }
  return Number(text);
}

export interface TargetFilter {
  run?: string;
  node?: string;
  fanOutKey?: string;
  prerequisite?: string;
  /** An acceptance criterion's position (`criterion_index`), counting from 0. */
  criterion?: number;
  /** A decision's `decision_key`: the actions route publishes no filter for it, so it is matched here. */
  decision?: string;
}

/**
 * Reads `--run`, `--node`, `--fan-out-key`, `--prerequisite`, `--criterion` and `--decision`, the
 * options that narrow the decisions to a target.
 */
export function targetFilterFrom(options: Record<string, unknown>): TargetFilter {
  const run = optionalId(options["run"], "--run", MAX_RUN_ID);
  const node = optionalId(options["node"], "--node", MAX_NODE_ID);
  const fanOutKey = optionalId(options["fanOutKey"], "--fan-out-key", MAX_FAN_OUT_KEY);
  const prerequisite = optionalId(options["prerequisite"], "--prerequisite", MAX_PREREQUISITE_ID);
  const criterion = criterionIndex(options["criterion"], "--criterion");
  const decision = optionalId(options["decision"], "--decision", MAX_DECISION_KEY);
  return {
    ...(run !== undefined ? { run } : {}),
    ...(node !== undefined ? { node } : {}),
    ...(fanOutKey !== undefined ? { fanOutKey } : {}),
    ...(prerequisite !== undefined ? { prerequisite } : {}),
    ...(criterion !== undefined ? { criterion } : {}),
    ...(decision !== undefined ? { decision } : {}),
  };
}

/**
 * `GET /tickets/{ref}/actions` with the `family`, `run_id`, `node_id`, `prerequisite_id` and
 * `criterion_index` filters given (a target's `decision_key` is not a published filter; see
 * `matchesTarget`). A body
 * without an `actions` list is `UNEXPECTED_RESPONSE` (exit 1).
 */
export async function fetchActions(
  api: Pick<ApiClient, "request">,
  segment: string,
  query: {
    family?: ActionFamily;
    run?: string;
    node?: string;
    prerequisite?: string;
    criterion?: number;
  },
): Promise<{ data: TicketActions; response: ApiResponse }> {
  const response = await api.request<unknown>({
    method: "GET",
    path: `/tickets/${segment}/actions`,
    query: {
      ...(query.family !== undefined ? { family: query.family } : {}),
      ...(query.run !== undefined ? { run_id: query.run } : {}),
      ...(query.node !== undefined ? { node_id: query.node } : {}),
      ...(query.prerequisite !== undefined ? { prerequisite_id: query.prerequisite } : {}),
      ...(query.criterion !== undefined ? { criterion_index: query.criterion } : {}),
    },
  });
  const data = response.data;
  if (!isRecord(data) || !Array.isArray(data["actions"]) || !data["actions"].every(isDecision)) {
    throw new CliError(
      "UNEXPECTED_RESPONSE",
      "The server's actions did not carry a list of action decisions.",
      ExitCode.Unexpected,
      { request_id: response.requestId },
    );
  }
  return { data: data as unknown as TicketActions, response };
}

/**
 * Whether a decision's target is the one `--run`, `--node`, `--fan-out-key`, `--prerequisite`,
 * `--criterion` and `--decision` name. A target may omit `run_id`, `node_id`, `fan_out_key`,
 * `prerequisite_id`, `criterion_index` and `decision_key`; an omitted one matches no flag that
 * names it.
 */
export function matchesTarget(decision: ActionDecision, filter: TargetFilter): boolean {
  const target = decision.target;
  return (
    (filter.run === undefined || target.run_id === filter.run) &&
    (filter.node === undefined || target.node_id === filter.node) &&
    (filter.fanOutKey === undefined || target.fan_out_key === filter.fanOutKey) &&
    (filter.prerequisite === undefined || target.prerequisite_id === filter.prerequisite) &&
    (filter.criterion === undefined || target.criterion_index === filter.criterion) &&
    (filter.decision === undefined || target.decision_key === filter.decision)
  );
}

/**
 * The idempotency key's target for a decision: the ticket reference, the action and each of the
 * target's ids that is present, e.g. `PIDGEN-4/retry_run/run-2`, `PIDGEN-4/remove_dependency/TKT-2`,
 * `PIDGEN-4/hold_decision/decision-1` or, for a criterion, its position:
 * `PIDGEN-4/override_acceptance_criterion/0`.
 */
export function actionKeyTarget(ref: string, action: ActionKind, target: ActionTarget): string {
  return [
    ref,
    action,
    target.run_id,
    target.node_id,
    target.fan_out_key,
    target.prerequisite_id,
    target.decision_key,
    target.criterion_index,
  ]
    .filter(
      (part): part is string | number =>
        (typeof part === "string" && part !== "") || typeof part === "number",
    )
    .join("/");
}

export interface Blocking {
  /** `admissible`: the Ticket's state does not allow it; `authorized`: the caller may not take it. */
  gate: "admissible" | "authorized";
  refusal: ActionRefusal;
}

/** Why a decision is blocked — its admissibility refusal first, then its authorization — or null. */
export function blockingRefusal(decision: ActionDecision): Blocking | null {
  for (const gate of ["admissible", "authorized"] as const) {
    const check = decision[gate];
    if (check.allowed) continue;
    return {
      gate,
      refusal: check.refusal ?? {
        code: gate === "admissible" ? "ACTION_NOT_ADMISSIBLE" : "FORBIDDEN",
        message:
          gate === "admissible"
            ? `${decision.label} is not possible now.`
            : `You may not ${decision.label.toLowerCase()}.`,
        instead: null,
      },
    };
  }
  return null;
}

/**
 * One decision as `pidgen ticket actions` prints it: the server's decision unchanged, with `state`
 * (`allowed` or `blocked`), the blocking `refusal` (code, message and the action to take
 * `instead`) and `blocked_by` (`admissible` or `authorized`), and `recommended_reason`.
 */
export function describeDecision(decision: ActionDecision): Record<string, unknown> {
  const blocking = blockingRefusal(decision);
  return {
    ...decision,
    state: blocking === null ? "allowed" : "blocked",
    blocked_by: blocking?.gate ?? null,
    refusal: blocking?.refusal ?? null,
    recommended_reason: decision.recommended?.reason ?? null,
  };
}

/**
 * The recommended action among an attention finding's decisions: its `action`, `label`, `reason`,
 * `target`, `state` and any blocking `refusal`; null when none is recommended or the finding carries
 * no decisions.
 */
export function recommendedAction(actions: unknown): Record<string, unknown> | null {
  if (!Array.isArray(actions)) return null;
  const decision = actions.filter(isDecision).find((item) => item.recommended != null);
  if (decision === undefined) return null;
  const blocking = blockingRefusal(decision);
  return {
    action: decision.action,
    label: decision.label,
    reason: decision.recommended?.reason ?? null,
    target: decision.target,
    state: blocking === null ? "allowed" : "blocked",
    refusal: blocking?.refusal ?? null,
  };
}

/**
 * A blocked decision is refused before anything is previewed: its refusal's code and message become
 * the error's, and it exits 5 (not admissible) or 3 (not authorized). `details.instead` names the
 * action to take instead, and `details.next` the command that takes it.
 */
export function blockedError(ref: string, decision: ActionDecision, blocking: Blocking): CliError {
  const instead = blocking.refusal.instead;
  return new CliError(
    blocking.refusal.code,
    blocking.refusal.message,
    blocking.gate === "admissible" ? ExitCode.Refused : ExitCode.Auth,
    {
      action: decision.action,
      label: decision.label,
      target: decision.target,
      blocked_by: blocking.gate,
      instead,
      ...(instead !== null
        ? { next: `See the alternative with: pidgen ticket act ${ref} ${instead} (preview).` }
        : {}),
    },
  );
}

/** No decision for the action and target: nothing the server offers matches, so nothing is sent. */
export function notOfferedError(
  ref: string,
  action: ActionKind,
  filter: TargetFilter,
  decisions: ActionDecision[],
): CliError {
  const named = [
    filter.run !== undefined ? `run ${filter.run}` : null,
    filter.node !== undefined ? `node ${filter.node}` : null,
    filter.fanOutKey !== undefined ? `fan-out item ${filter.fanOutKey}` : null,
    filter.prerequisite !== undefined ? `the dependency on ${filter.prerequisite}` : null,
    filter.criterion !== undefined ? `criterion ${filter.criterion}` : null,
    filter.decision !== undefined ? `decision ${filter.decision}` : null,
  ].filter((part): part is string => part !== null);
  return new CliError(
    "ACTION_NOT_OFFERED",
    `Ticket ${ref} offers no ${action}${named.length > 0 ? ` for ${named.join(", ")}` : ""}. List what it offers with pidgen ticket actions ${ref}.`,
    ExitCode.Refused,
    {
      action,
      ...(filter.run !== undefined ? { run_id: filter.run } : {}),
      ...(filter.node !== undefined ? { node_id: filter.node } : {}),
      ...(filter.fanOutKey !== undefined ? { fan_out_key: filter.fanOutKey } : {}),
      ...(filter.prerequisite !== undefined ? { prerequisite_id: filter.prerequisite } : {}),
      ...(filter.criterion !== undefined ? { criterion_index: filter.criterion } : {}),
      ...(filter.decision !== undefined ? { decision_key: filter.decision } : {}),
      offered: decisions.map((decision) => ({
        action: decision.action,
        target: decision.target,
      })),
    },
  );
}

export interface ActionExecution {
  /** Command identity, e.g. `ticket act`; part of the derived idempotency key. */
  command: string;
  /** The idempotency key's target, e.g. `PIDGEN-4/run-2`. */
  target: string;
  /** The ticket reference's path segment. */
  segment: string;
  decision: ActionDecision;
  /**
   * `explicit` (`pidgen ticket act`): `--apply` without `--digest` previews and executes that preview
   * when every required acknowledgement was given with `--acknowledge`/`--ack`, and otherwise exits 6
   * with `ACKNOWLEDGEMENT_REQUIRED`. `convention` (`retry`, `replay`): the shared rule, where such an
   * apply needs a preview without acknowledgements and otherwise exits 6 with `DIGEST_REQUIRED`.
   */
  acknowledgements: "explicit" | "convention";
  /** `--note`: sent as the execute request's `note` when given. */
  note?: string;
  /** `--until` and `--delegate-to`: sent as `followup` on the preview and the execute alike. */
  followup?: ActionFollowUp;
  /**
   * `--exception-reason`, `--criterion-status` with `--override-reason`, `--answer` and
   * `--alternative`: sent as `exception`, `criterion_override` and `plan_correction` on the
   * preview and the execute alike.
   */
  choices?: ActionChoices;
}

/**
 * Previews `{action, target}` with `POST /tickets/{ref}/actions/preview` and, with `--apply`,
 * executes it with `POST /tickets/{ref}/actions/execute`, sending the preview's digest, the
 * caller's acknowledgements, `--reason`, `--note` and the idempotency key beside the same action,
 * target and choices (`--until` and `--delegate-to`, sent as `followup`; `--exception-reason`,
 * `--criterion-status` with `--override-reason`, and `--answer` or `--alternative`, sent as
 * `exception`, `criterion_override` and `plan_correction`; each on the preview too). The execute body is checked against the published request schema first (`reason` at
 * most 10240 characters, `note` 4000, `idempotency_key` 1–255, at most 20 `acknowledgements`); a
 * body it refuses exits 2 with `INPUT_INVALID` and nothing is executed. A `202` is followed on its
 * `status_url` with `--wait`. Returns the command's `data`: the preview with the `decision` it
 * previewed, or the apply's `settled`, `result` (the server's execute result: `command_id`,
 * `ticket_id`, `status`, `disposition_code`, `workflow_run_id`, `status_url`, `action` and
 * `target`), `idempotency_key` and, while unsettled, `handle`.
 */
export async function executeAction(
  api: Pick<ApiClient, "request">,
  execution: ActionExecution,
  options: PreviewApplyOptions,
): Promise<CommandResult["data"]> {
  const { decision, segment } = execution;
  const subject = {
    action: decision.action,
    target: decision.target,
    ...(execution.followup !== undefined ? { followup: execution.followup } : {}),
    ...(execution.choices ?? {}),
  };
  const extra = execution.note !== undefined ? { note: execution.note } : {};
  const server = serverPreviewApply(api, {
    command: execution.command,
    target: execution.target,
    preview: { path: `/tickets/${segment}/actions/preview`, body: subject },
    apply: { path: `/tickets/${segment}/actions/execute`, body: { ...subject, ...extra } },
  });
  let previewed: Preview | null = null;
  const operation: PreviewApplyOperation = {
    ...server,
    async preview() {
      previewed ??= await server.preview();
      return previewed;
    },
    async apply(input) {
      validateBody(PUBLIC_API_DOCUMENT, "post", EXECUTE_TEMPLATE, {
        ...subject,
        ...extra,
        ...input,
      });
      return server.apply(input);
    },
  };

  let effective = options;
  if (execution.acknowledgements === "explicit" && options.apply && options.digest === undefined) {
    const fresh = await operation.preview();
    const given = new Set(normalizeAcknowledgements(options.acknowledgements));
    const missing = fresh.required_acknowledgements.filter((code) => !given.has(code));
    if (missing.length > 0) {
      throw confirmationGuidance(
        new CliError(
          "ACKNOWLEDGEMENT_REQUIRED",
          `This action needs the acknowledgement${missing.length === 1 ? "" : "s"} ${missing.join(", ")}; nothing was executed.`,
          ExitCode.ConfirmationRequired,
          { missing, required_acknowledgements: fresh.required_acknowledgements, preview: fresh },
        ),
      );
    }
    effective = { ...options, digest: fresh.preview_digest };
  }

  const result = await runPreviewApply(operation, effective);
  if (result.mode === "preview") return { ...result.preview, decision };
  return {
    settled: result.settled,
    result: result.result,
    idempotency_key: result.idempotency_key,
    ...(result.handle !== undefined ? { handle: result.handle } : {}),
  };
}

function isDecision(value: unknown): value is ActionDecision {
  if (!isRecord(value)) return false;
  const target = value["target"];
  return (
    typeof value["action"] === "string" &&
    typeof value["label"] === "string" &&
    isRecord(target) &&
    typeof target["ticket_id"] === "string" &&
    isGate(value["admissible"]) &&
    isGate(value["authorized"])
  );
}

function isGate(value: unknown): boolean {
  return isRecord(value) && typeof value["allowed"] === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
