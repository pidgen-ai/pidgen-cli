import type { Command } from "commander";
import { CliError, usageError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import { pathSegment } from "../../core/read.js";
import {
  READINESS_ROUTES,
  renderDoctor,
  sendReadiness,
  type DoctorReport,
  type DoctorRequest,
} from "../../core/readiness.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";

/** The widest window `--since` may ask for, in days, as the contract bounds `since_days`. */
export const DOCTOR_MAX_DAYS = 90;

/**
 * `pidgen project doctor <key> [--since <n>d|<n>w] [--propose-fix] [--json]`: asks whether the
 * workspace setup is why work in the Project fails (`POST /projects/{project_ref}/readiness/doctor`).
 * The doctor reads the setup files at the base branch, the connected workers and the last seven
 * days of runs (`--since` widens it) and changes nothing; `--propose-fix` has it open the fix as a
 * pull request when it has a template for it.
 *
 * A terminal shows the CLI transcript of the Project page wireframe: one line per group with the
 * failures beneath by Ticket key, then the verdict and the fix. `data` is the server's report
 * unchanged. When the setup is the problem it exits 1 with `SETUP_IS_THE_PROBLEM`, the report in
 * `error.details.report`. `--json` prints the report alone, as the server answered it, with the
 * same exit status, for scripts; an error under `--json` is the JSON envelope.
 */
export const projectDoctor: CommandSpec = {
  path: ["project", "doctor"],
  summary: "Ask whether the workspace setup is why work in the project fails",
  configure(command: Command) {
    command
      .argument("<key>", "the project's id (proj-…) or ticket-key prefix, e.g. STO")
      .option(
        "--since <window>",
        "how far back to read runs, in days or weeks, e.g. 14d or 2w (default 7d)",
      )
      .option(
        "--propose-fix",
        "open the fix as a pull request when the doctor has a template for it",
      )
      .option("--json", "print the server's report unchanged, for scripts");
  },
  async run(ctx, { args, options, global }) {
    const raw = options["json"] === true;
    // Errors under --json are JSON too.
    if (raw) global.format = "json";
    const key = pathSegment("project key", args[0]);
    const since = options["since"] as string | undefined;
    const proposeFix = options["proposeFix"] === true;
    const body: DoctorRequest = {};
    if (since !== undefined) body.since_days = sinceDays(since);
    if (proposeFix) body.propose_fix = true;

    const session = await openSession(ctx, global);
    const response = await sendReadiness<DoctorReport>(session, READINESS_ROUTES.doctor, key, body);
    const report = response.data;
    const setupIsTheProblem = report.verdict === "setup";
    if (raw) {
      ctx.io.stdout(JSON.stringify(report) + "\n");
      return { exitCode: setupIsTheProblem ? ExitCode.Unexpected : ExitCode.Ok, envelope: false };
    }
    const human = renderDoctor(report, { ...(since === undefined ? {} : { since }), proposeFix });
    if (setupIsTheProblem) {
      const error = new CliError("SETUP_IS_THE_PROBLEM", report.summary, ExitCode.Unexpected, {
        report,
      });
      error.human = human;
      throw error;
    }
    return { data: report, meta: session.meta(response), human };
  },
};

/** `--since 14d` or `--since 2w` as days, 1 to `DOCTOR_MAX_DAYS`; anything else is `CLI_USAGE`. */
function sinceDays(value: string): number {
  const match = /^\s*([0-9]+)\s*([dw])\s*$/i.exec(value);
  const days = match ? Number(match[1]) * (match[2]!.toLowerCase() === "w" ? 7 : 1) : NaN;
  if (!Number.isInteger(days) || days < 1 || days > DOCTOR_MAX_DAYS) {
    throw usageError(
      `--since takes a window of 1 to ${DOCTOR_MAX_DAYS} days, in days or weeks, e.g. 14d or 2w: ${value}`,
      { option: "--since", value },
    );
  }
  return days;
}
