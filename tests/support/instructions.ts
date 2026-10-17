/**
 * Fixtures for the steering instruction contract (`Instruction` in contracts/openapi.json),
 * shared by the command tests. Nothing here is a real person, session or Ticket.
 */

/**
 * An instruction as the contract states it: queued for one session, not yet delivered, in the
 * default `steer` mode, never dispatched to a running session.
 */
export function instruction(overrides: Record<string, unknown> = {}) {
  return {
    instruction_id: "ins-example-1",
    kind: "steer",
    ticket_id: "TKT-example-7",
    target_run_id: "run-example-1",
    target_node_id: "implement",
    target_fan_out_key: null,
    target_session_id: "ses-example-1",
    delivered_session_id: null,
    target_label: "Implement",
    author: { kind: "user", user_id: "usr-example-1", display_name: "Example Person" },
    text: "Prefer the existing retry helper.",
    artifact_refs: [],
    source_message_ids: [],
    presented_message_ids: [],
    reviewed_revision: null,
    request_key: null,
    items: [],
    state: "queued",
    queued_at: "2026-10-05T09:00:00Z",
    delivered_at: null,
    acknowledged_at: null,
    unapplied_at: null,
    unapplied_reason: null,
    withdrawn_at: null,
    editable: true,
    version: 1,
    mode: "steer",
    deadline_seconds: null,
    dispatched_at: null,
    accepted_at: null,
    consumed_at: null,
    provider_message_ref: null,
    return_code: null,
    quoted_event_refs: [],
    quoted_file_refs: [],
    ...overrides,
  };
}

/** The same instruction once its next prompt carried it. */
export function deliveredInstruction(overrides: Record<string, unknown> = {}) {
  return instruction({
    state: "delivered",
    delivered_session_id: "ses-example-1",
    delivered_at: "2026-10-05T09:05:00Z",
    editable: false,
    version: 2,
    ...overrides,
  });
}

/** The instruction claimed for the step's running delivery and sent to its worker (live path). */
export function dispatchedInstruction(overrides: Record<string, unknown> = {}) {
  return instruction({
    state: "dispatched",
    dispatched_at: "2026-10-05T09:00:02Z",
    editable: false,
    version: 2,
    ...overrides,
  });
}

/** The instruction once the provider added it to the running conversation's input. */
export function acceptedInstruction(overrides: Record<string, unknown> = {}) {
  return dispatchedInstruction({
    state: "accepted",
    accepted_at: "2026-10-05T09:00:03Z",
    provider_message_ref: "msg-provider-example-1",
    version: 3,
    ...overrides,
  });
}

/**
 * The instruction returned to `queued` after the running session refused it: it keeps the time it
 * was dispatched and carries the refusal's code, and goes to the step's next attempt.
 */
export function returnedInstruction(overrides: Record<string, unknown> = {}) {
  return instruction({
    dispatched_at: "2026-10-05T09:00:02Z",
    return_code: "HARNESS_UNSUPPORTED",
    version: 3,
    ...overrides,
  });
}
