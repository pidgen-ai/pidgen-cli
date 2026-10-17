import { Option, type Command } from "commander";
import { recommendedAction } from "../../core/actions.js";
import { readRoute } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import type { components } from "../../generated/api.js";

type AttentionQueue = components["schemas"]["AttentionQueue"];

/**
 * `pidgen review attention`: the open findings that need a person's decision (`GET /attention`), in
 * the server's order — findings with a recommended action first, then the oldest. Each finding names
 * its `target` (the step, run, dependency or Ticket it is about, or null), its `label`, the
 * `run_id`, `node_id`, `fan_out_key` and `prerequisite_id` concerned, and the server's further
 * facts. A finding has no `action` field: what can be done is in its `actions`, the action
 * decisions for its target, unchanged. `data` is the server's queue — `findings`, `open_count`,
 * `ticket_count`, `swept_at` (when the audit sweep last ran), `addressee`, `counts` and `following`
 * — with one field added to each finding: `recommended_action`, the recommended decision among the
 * finding's `actions` (its `action`, `label`, `reason`, `target`, `state` and any blocking
 * `refusal`), or null when it recommends none; take it with `pidgen ticket act`. Optional
 * --addressee filters the queue (`on_hold`: the holds due for review in the caller's review
 * scope, which the queue's `review_scope` names; it needs a server that publishes that view);
 * without it the request stays unfiltered. Every other field, `followup` and `hold` on each
 * finding included, passes through unchanged. So do the queue's `requests` — the intake requests
 * waiting on a person, each `{decision_key, request}` — and `request_counts` (`me`, `all`,
 * `items`) when a server that publishes durable requests returns them; against one that does not,
 * the queue has neither field and is printed as before. See docs/commands.md, "review".
 */
export const reviewAttention: CommandSpec = {
  path: ["review", "attention"],
  summary: "List the open findings that need a person's decision, recommended actions first",
  configure(command: Command) {
    command.addOption(
      new Option("--addressee <addressee>", "whose attention to list").choices([
        "me",
        "claimable",
        "following",
        "on_hold",
        "all",
      ]),
    );
  },
  async run(ctx, { options, global }) {
    const addressee = options["addressee"] as string | undefined;
    const result = await readRoute<AttentionQueue>(
      ctx,
      global,
      "/attention",
      addressee === undefined ? undefined : { addressee },
    );
    return { ...result, data: withRecommendedActions(result.data) };
  },
};

function withRecommendedActions(queue: AttentionQueue): unknown {
  const data: unknown = queue;
  if (typeof data !== "object" || data === null || !Array.isArray(queue.findings)) return data;
  return {
    ...queue,
    findings: queue.findings.map((finding: unknown) =>
      typeof finding === "object" && finding !== null
        ? {
            ...finding,
            recommended_action: recommendedAction((finding as Record<string, unknown>)["actions"]),
          }
        : finding,
    ),
  };
}
