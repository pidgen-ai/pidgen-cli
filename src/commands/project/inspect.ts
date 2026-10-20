import type { Command } from "commander";
import { usageError } from "../../core/errors.js";
import { pathSegment } from "../../core/read.js";
import {
  READINESS_ROUTES,
  readReadiness,
  renderReadiness,
  sendReadiness,
  type Readiness,
  type ReadinessAnswer,
} from "../../core/readiness.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";

/**
 * `pidgen project inspect <key> [--answer <id=value>]…`: the Project's readiness
 * (`GET /projects/{project_ref}/readiness`), one row per area with its state word and summary,
 * and the open questions with the `--answer` that answers each. With `--answer`, the answers are
 * sent (`POST /projects/{project_ref}/readiness/answers`) and the repository is inspected again;
 * `data` is the readiness the server answers, unchanged.
 */
export const projectInspect: CommandSpec = {
  path: ["project", "inspect"],
  summary: "Show what the repository needs before a Ticket can work in it",
  configure(command: Command) {
    command
      .argument("<key>", "the project's id (proj-…) or ticket-key prefix, e.g. STO")
      .option(
        "--answer <id=value>",
        "answer an open question and inspect again (repeatable)",
        (value: string, previous: string[] = []) => [...previous, value],
      );
  },
  async run(ctx, { args, options, global }) {
    const key = pathSegment("project key", args[0]);
    const answers = parseAnswers((options["answer"] as string[] | undefined) ?? []);
    const session = await openSession(ctx, global);
    const response =
      answers.length > 0
        ? await sendReadiness<Readiness>(session, READINESS_ROUTES.answers, key, { answers })
        : await readReadiness(session, key);
    return {
      data: response.data,
      meta: session.meta(response),
      human: renderReadiness(response.data),
    };
  },
};

/** Each `--answer id=value`: a missing `=`, id or value, or an id given twice, is `CLI_USAGE`. */
function parseAnswers(values: string[]): ReadinessAnswer[] {
  const answers: ReadinessAnswer[] = [];
  for (const value of values) {
    const equals = value.indexOf("=");
    const id = equals === -1 ? "" : value.slice(0, equals).trim();
    const answer = equals === -1 ? "" : value.slice(equals + 1).trim();
    if (id === "" || answer === "") {
      throw usageError(
        `--answer takes <question id>=<answer>, e.g. stripe-test-key=skip: ${value}`,
        {
          option: "--answer",
          value,
        },
      );
    }
    if (answers.some((existing) => existing.question_id === id)) {
      throw usageError(`--answer names ${id} more than once.`, { option: "--answer", value: id });
    }
    answers.push({ question_id: id, value: answer });
  }
  return answers;
}
