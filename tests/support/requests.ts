/**
 * Fixtures for the durable intake request contract (`IntakeRequest` in contracts/openapi.json),
 * shared by the command tests. Nothing here is a real person, project or Account.
 */

/**
 * An intake request as the durable-request contract states it: one open question, one settled. Its
 * id (`conv-…`) differs from its public key (`REQ-7`), which is what the CLI prints.
 */
export function intakeRequest(overrides: Record<string, unknown> = {}) {
  const person = { user_id: "usr-example-1", display_name: "Example Person" };
  return {
    request_id: "conv-example-1",
    request_key: "REQ-7",
    project_id: "proj-example",
    title: "Show the login page",
    text: "People can sign in from the home page.",
    source: "api",
    source_location: null,
    submitted_by: person,
    submitted_at: "2026-10-01T09:00:00Z",
    team_member_id: null,
    agent_source: "project_default",
    state: "clarifying",
    questions: [
      {
        question_id: "q-example-1",
        text: "Which login methods?",
        recommendation: { answer: "Email and password.", consequence: null },
        choices: ["Email and password.", "Single sign-on"],
        required: true,
        answer: null,
        asked: [],
        left_open: null,
      },
      {
        question_id: "q-example-2",
        text: "Should it remember the user?",
        recommendation: null,
        choices: null,
        required: false,
        answer: {
          text: "Yes, for 30 days.",
          kind: "answer",
          by: person,
          at: "2026-10-01T09:05:00Z",
        },
        asked: [],
        left_open: null,
      },
    ],
    question_count: 2,
    answered_count: 1,
    assumption_count: 0,
    ticket_id: null,
    ticket_key: null,
    created_by: null,
    withdrawn: null,
    decision_key: "request:conv-example-1",
    actions: [
      {
        action: "answer_request",
        admissible: { allowed: true, refusal: null },
        authorized: { allowed: true, refusal: null },
        recommended: { reason: "One question is still open." },
      },
      {
        action: "withdraw_request",
        admissible: { allowed: true, refusal: null },
        authorized: { allowed: true, refusal: null },
        recommended: null,
      },
    ],
    followup: null,
    version: 3,
    addressed_to: [{ ...person, reason: "submitter" }],
    waiting_since: "2026-10-01T09:00:00Z",
    ...overrides,
  };
}

/**
 * An intake request as the intent commands print it: named by its key in `request_id`, the id
 * only when it has no key.
 */
export function shownIntake(request: Record<string, unknown>): Record<string, unknown> {
  const { request_key: key, ...rest } = request;
  return { ...rest, request_id: key ?? request["request_id"] };
}
