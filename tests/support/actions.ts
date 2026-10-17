import { expect } from "vitest";
import { runCli } from "../../src/cli.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { envelope, jsonResponse, testContext, type TestContext } from "./context.js";

/**
 * A mock of the Ticket actions contract (`GET /tickets/{ref}/actions`,
 * `POST /tickets/{ref}/actions/preview`, `POST /tickets/{ref}/actions/execute`) shared by the
 * `ticket actions`, `ticket act`, `ticket retry` and `ticket replay` tests.
 */

export const SERVER = "https://pidgen.example.com";
export const TOKEN = "pidgen_pat_fake_token_for_tests";
export const REF = "PIDGEN-4";
export const TICKET_ID = "TKT-example";
export const ACTIONS_PATH = `/api/v1/tickets/${REF}/actions`;
export const PREVIEW_PATH = `${ACTIONS_PATH}/preview`;
export const EXECUTE_PATH = `${ACTIONS_PATH}/execute`;
export const COMMAND_ID = "11111111-1111-4111-8111-111111111111";
/** The execute result's `status_url`: the Ticket command status route. */
export const STATUS_PATH = `/api/v1/tickets/${REF}/commands/${COMMAND_ID}`;

export const CONFIG: Config = {
  default_profile: "default",
  profiles: {
    default: {
      url: SERVER,
      default_account: "ACC-EXAMPLE",
      credentials: { "ACC-EXAMPLE": { kind: "pat", token: TOKEN } },
    },
  },
};

export interface Target {
  kind: "ticket" | "run" | "node" | "dependency" | "decision" | "criterion";
  ticket_id: string;
  run_id?: string | null;
  node_id?: string | null;
  fan_out_key?: string | null;
  prerequisite_id?: string | null;
  decision_key?: string | null;
  criterion_index?: number | null;
}

export function ticketTarget(): Target {
  return { kind: "ticket", ticket_id: TICKET_ID, run_id: null, node_id: null, fan_out_key: null };
}

export function runTarget(run = "run-2"): Target {
  return { kind: "run", ticket_id: TICKET_ID, run_id: run, node_id: null, fan_out_key: null };
}

export function nodeTarget(node: string, run = "run-2", fanOutKey: string | null = null): Target {
  return { kind: "node", ticket_id: TICKET_ID, run_id: run, node_id: node, fan_out_key: fanOutKey };
}

/** A declared dependency on `prerequisite`: run, node and fan-out key are omitted, as they may be. */
export function dependencyTarget(prerequisite: string): Target {
  return { kind: "dependency", ticket_id: TICKET_ID, prerequisite_id: prerequisite };
}

/** A decision waiting on a person, named by its opaque `decision_key`; it has no run or node. */
export function decisionTarget(key: string): Target {
  return { kind: "decision", ticket_id: TICKET_ID, decision_key: key };
}

/** One acceptance criterion of the Ticket, named by its position in the list; it has no run or node. */
export function criterionTarget(index: number): Target {
  return { kind: "criterion", ticket_id: TICKET_ID, criterion_index: index };
}

export interface Refusal {
  code: string;
  message: string;
  instead: string | null;
}

const LABELS: Record<string, string> = {
  restart_refinement: "Restart refinement",
  replay_from_node: "Replay from this node",
  retry_run: "Retry the run",
  recover_parked_node: "Recover the parked node",
  reopen_for_delivery: "Reopen for delivery",
  pause_run: "Pause the run",
  resume_run: "Resume the run",
  cancel_ticket: "Cancel the ticket",
  terminate_run: "Terminate the run",
  remove_dependency: "Remove the dependency",
  resolve_target_conflict: "Resolve merge conflicts",
  snooze_reminders: "Snooze reminders",
  defer_decision: "Defer the decision",
  hold_decision: "Hold the decision",
  delegate_decision: "Delegate the decision",
  proceed_on_assumption: "Proceed on the recommended answer",
  keep_holding: "Keep holding",
  retry_admission: "Retry the admission",
  plan_work: "Plan the work",
  start_work: "Start the work",
  ask_before_starting: "Ask before starting",
  correct_plan_decision: "Correct a plan decision",
  approve_delivery: "Approve the delivery",
  approve_with_exception: "Approve with an exception",
  request_delivery_changes: "Ask for changes to the delivery",
  override_acceptance_criterion: "Override an acceptance criterion",
};

const DECISION_ANSWER_ACTIONS = [
  "plan_work",
  "start_work",
  "ask_before_starting",
  "correct_plan_decision",
  "approve_delivery",
  "approve_with_exception",
  "request_delivery_changes",
  "override_acceptance_criterion",
];

const FOLLOW_UP_ACTIONS = [
  "snooze_reminders",
  "defer_decision",
  "hold_decision",
  "delegate_decision",
  "proceed_on_assumption",
  "keep_holding",
];

export function decision(
  action: string,
  target: Target,
  options: {
    blocked?: Refusal;
    unauthorized?: Refusal;
    recommended?: string;
    run?: "continue" | "fresh";
    family?:
      "recovery" | "run_control" | "ticket_control" | "decision_followup" | "decision_answers";
  } = {},
) {
  return {
    action,
    family:
      options.family ??
      (["pause_run", "resume_run", "cancel_ticket", "terminate_run"].includes(action)
        ? "run_control"
        : action === "remove_dependency"
          ? "ticket_control"
          : FOLLOW_UP_ACTIONS.includes(action)
            ? "decision_followup"
            : DECISION_ANSWER_ACTIONS.includes(action)
              ? "decision_answers"
              : "recovery"),
    label: LABELS[action] ?? action,
    target,
    admissible: { allowed: options.blocked === undefined, refusal: options.blocked ?? null },
    authorized: {
      allowed: options.unauthorized === undefined,
      refusal: options.unauthorized ?? null,
    },
    recommended: options.recommended !== undefined ? { reason: options.recommended } : null,
    consequence: {
      run: options.run ?? (action === "retry_run" ? "fresh" : "continue"),
      inputs: [
        { class: "configuration", mode: "preserve" },
        { class: "contract", mode: action === "retry_run" ? "adopt" : "preserve" },
      ],
    },
    requires_preview: true,
  };
}

export function listing(...actions: ReturnType<typeof decision>[]) {
  return { ticket_id: TICKET_ID, actions };
}

export function preview(
  action: string,
  target: Target,
  options: { acks?: string[]; digest?: string; effects?: Record<string, unknown> } = {},
) {
  return {
    preview_digest: options.digest ?? "sha256:preview-1",
    required_acknowledgements: options.acks ?? [],
    action,
    target,
    consequence: decision(action, target).consequence,
    effects:
      options.effects ??
      (action === "replay_from_node"
        ? { reexecuted_nodes: [target.node_id, "verify"], reused_nodes: ["plan"] }
        : { reexecuted_nodes: ["plan", "implement"], reused_nodes: [] }),
  };
}

/**
 * The execute result as the published contract states it: `command_id`, `ticket_id`, `status`,
 * `disposition_code`, `workflow_run_id` and `status_url` beside the `action` and `target`. It has
 * no `result` object.
 */
export function executed(
  action: string,
  target: Target,
  options: {
    status?: "applied" | "applying";
    workflowRunId?: string | null;
    statusUrl?: string | null;
  } = {},
) {
  const status = options.status ?? "applied";
  return {
    command_id: COMMAND_ID,
    ticket_id: TICKET_ID,
    status,
    disposition_code: null,
    workflow_run_id:
      options.workflowRunId === undefined
        ? status === "applied"
          ? "run-3"
          : null
        : options.workflowRunId,
    status_url: options.statusUrl === undefined ? `${SERVER}${STATUS_PATH}` : options.statusUrl,
    action,
    target,
  };
}

export function ok(data: unknown, status = 200): Response {
  return jsonResponse(
    status,
    { status: "ok", data, meta: null },
    { "x-request-id": "req-example", "pidgen-api-version": "1.0" },
  );
}

export function refusal(
  status: number,
  code: string,
  message: string,
  details: object | null = null,
): Response {
  return jsonResponse(status, {
    status: "error",
    error: { code, message, details, request_id: "req-example" },
  });
}

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}

export interface Body {
  ok: boolean;
  data: Record<string, unknown> | null;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  meta: Record<string, unknown>;
}

/** A fake server answering each `METHOD path` with its queued responses, in order. */
export async function setup(routes: Record<string, Response[]> = {}) {
  const calls: Call[] = [];
  const ctx = await testContext({
    fetch: (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      const next = routes[`${method} ${url.pathname}`]?.shift();
      if (next === undefined)
        return Promise.reject(new Error(`unexpected ${method} ${url.pathname}`));
      return Promise.resolve(next);
    },
  });
  await saveConfig(ctx, CONFIG);
  return { ctx, calls };
}

export async function cli(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(argv, ctx);
  expect(ctx.out).toHaveLength(1);
  return { code, body: envelope(ctx) as unknown as Body };
}

export const routeOf = (call: Call) => `${call.method} ${call.path}`;
