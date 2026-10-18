import type { Command } from "commander";
import { PUBLIC_API_DOCUMENT } from "../api/document.js";
import { inputInvalid, readInput, validateBody, type InputIssue } from "../../core/input.js";
import { pathSegment } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import { presentIntent } from "../../core/requests.js";
import { openSession } from "../../core/session.js";
import type { components } from "../../generated/api.js";

type RespondedIntent =
  components["schemas"]["IntentCreated"] | components["schemas"]["IntentStillNeedsClarification"];

type RespondBody = components["schemas"]["RespondRequest"];

/**
 * The rules of a response the published schema leaves to the server, checked here so nothing is
 * sent that the server would refuse: `answers` may be empty only with `delegate: true`; each
 * answer names its question by exactly one of `question_id` and `question_index`; an `answer`
 * outcome (the default) carries non-empty text. Each problem is one issue, located as
 * `validateBody` locates its own (`$.answers[1].answer`).
 */
export function answerIssues(body: RespondBody): InputIssue[] {
  const issues: InputIssue[] = [];
  if (body.answers.length === 0 && body.delegate !== true) {
    issues.push({ path: "$.answers", message: "answers may be empty only when delegate is true" });
  }
  body.answers.forEach((answer, index) => {
    const at = `$.answers[${index}]`;
    const byId = answer.question_id !== undefined && answer.question_id !== null;
    const byIndex = answer.question_index !== undefined && answer.question_index !== null;
    if (byId === byIndex) {
      issues.push({
        path: at,
        message: byId
          ? "an answer names its question by question_id or question_index, not both"
          : "an answer names its question by question_id or question_index",
      });
    }
    const outcome = answer.outcome ?? "answer";
    const text = answer.answer ?? null;
    if (outcome === "answer") {
      if (text === null) {
        issues.push({ path: at, message: "the answer outcome needs the answer text" });
      } else if (text.trim() === "") {
        issues.push({ path: `${at}.answer`, message: "the answer text is empty" });
      }
    }
    if (outcome === "ask_teammate" && !answer.ask_user_id) {
      issues.push({ path: `${at}.ask_user_id`, message: "ask_teammate needs ask_user_id" });
    }
  });
  return issues;
}

/** The operation `intent respond` sends, as the public API document names it. */
export const RESPOND_ROUTE = {
  method: "post",
  path: "/intents/{conversation_id}/respond",
} as const;

/**
 * `pidgen intent respond <conversation> -f <answers>`: settles the questions of an intake request
 * (`POST /intents/{conversation_id}/respond`), named by the key (`REQ-{n}`) that `pidgen intent
 * submit` printed as its `conversation_id`, sent as given. The file is the request body, as JSON or YAML, or standard input with `-f -`:
 * `answers`, each naming its question by `question_id` (or by 0-based `question_index`) and
 * giving an `outcome` — `answer` (the default, with the `answer` text), `use_recommendation`
 * (assume the question's recommendation), `ask_teammate` (with `ask_user_id`) or `leave_open` —
 * and optionally `delegate: true`, which creates the ticket now and lets `answers` be empty. It is
 * validated against `RespondRequest` before anything is sent, and then against the rules the
 * server applies when it answers: a body that does not parse or match, one with no answers and no
 * delegate, an answer naming no question (or naming it twice), or an `answer` outcome without its
 * text, is `INPUT_INVALID` (exit code 2) with each problem in `error.details.issues`. `data` is the server's
 * result, switched on `outcome`: `created` carries the new ticket and `assumptions_recorded`, and
 * `still_needs_clarification` says questions remain and carries the updated `request`, each
 * request named by its key. The
 * request never expires. An unknown or another Account's conversation is the server's
 * `CONVERSATION_NOT_FOUND` (exit code 4); a withdrawn one is `REQUEST_WITHDRAWN` (exit code 5).
 * See docs/commands.md, "intent".
 */
export const intentRespond: CommandSpec = {
  path: ["intent", "respond"],
  summary: "Answer an intake request's questions",
  configure(command: Command) {
    command
      .argument("<conversation>", "the request: its key from pidgen intent submit, e.g. REQ-12")
      .requiredOption(
        "-f, --file <answers>",
        "the answers as JSON or YAML ({answers: [{question_id, outcome, answer}], delegate}); - reads standard input",
      )
      .addHelpText(
        "after",
        [
          "",
          "Each answer names its question by question_id (or question_index) and has an outcome:",
          "  answer              record the answer text (the default; the answer is required)",
          "  use_recommendation  assume the question's recommendation",
          "  ask_teammate        ask the teammate named by ask_user_id",
          "  leave_open          leave the question open",
          "",
          "answers may be empty when delegate is true, which creates the ticket now.",
          "The request never expires: answer it later, or withdraw it with pidgen intent withdraw.",
          "",
        ].join("\n"),
      );
  },
  async run(ctx, { args, options, global }) {
    const conversation = pathSegment("conversation", args[0]);
    const input = await readInput(ctx, String(options["file"]));
    const body = validateBody(
      PUBLIC_API_DOCUMENT,
      RESPOND_ROUTE.method,
      RESPOND_ROUTE.path,
      input.value,
    ) as RespondBody;
    const issues = answerIssues(body);
    if (issues.length > 0) {
      const count = issues.length === 1 ? "1 issue" : `${issues.length} issues`;
      throw inputInvalid(
        `Request body for POST ${RESPOND_ROUTE.path} does not match the schema (${count})`,
        { method: "POST", path: RESPOND_ROUTE.path, issues },
      );
    }
    const session = await openSession(ctx, global);
    const response = await session.client.request<RespondedIntent>({
      method: "POST",
      path: `/intents/${conversation}/respond`,
      body,
    });
    return { data: presentIntent(response.data), meta: session.meta(response) };
  },
};
