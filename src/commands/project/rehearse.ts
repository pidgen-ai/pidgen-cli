import type { Command } from "commander";
import { CliError, usageError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import { pathSegment } from "../../core/read.js";
import {
  followRehearsal,
  READINESS_ROUTES,
  renderStep,
  renderVerdict,
  sendReadiness,
  type Rehearsal,
} from "../../core/readiness.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";

/**
 * `pidgen project rehearse <key> [--ref <branch>] [--no-follow]`: asks a worker to build a
 * throwaway workspace from the proposal's branch (or `--ref`), run the setup and the tests, and
 * tear it down (`POST /projects/{project_ref}/readiness/rehearse`), then follows it by reading
 * `GET /projects/{project_ref}/readiness` until it settles. Each step is printed as it is
 * reported (on a terminal's standard output, or on standard error under `--format json`), and the
 * verdict last. `data` is the settled rehearsal. A failed rehearsal exits 1 with
 * `REHEARSAL_FAILED`, a cancelled one with `REHEARSAL_CANCELLED`, the rehearsal in
 * `error.details.rehearsal`. `--no-follow` returns the requested rehearsal at once.
 */
export const projectRehearse: CommandSpec = {
  path: ["project", "rehearse"],
  summary: "Rehearse the workspace setup on a worker and follow it to its verdict",
  configure(command: Command) {
    command
      .argument("<key>", "the project's id (proj-…) or ticket-key prefix, e.g. STO")
      .option("--ref <branch>", "the branch to rehearse (default: the proposal's, or the base)")
      .option("--no-follow", "return as soon as the rehearsal is requested");
  },
  async run(ctx, { args, options, global }) {
    const key = pathSegment("project key", args[0]);
    const name = decodeURIComponent(key);
    const ref = options["ref"] as string | undefined;
    if (ref !== undefined && ref.trim() === "") {
      throw usageError("--ref needs a branch name.", { option: "--ref" });
    }
    const session = await openSession(ctx, global);
    const requested = await sendReadiness<Rehearsal>(
      session,
      READINESS_ROUTES.rehearse,
      key,
      ref === undefined ? {} : { ref: ref.trim() },
    );
    if (options["follow"] === false) {
      return {
        data: requested.data,
        meta: session.meta(requested),
        human: renderVerdict(requested.data, name),
      };
    }

    const human = global.format === "table";
    const report = (step: Parameters<typeof renderStep>[0]) => {
      if (human) ctx.io.stdout(`  ${renderStep(step)}\n`);
      else if (ctx.io.interactive) ctx.io.stderr(`  ${renderStep(step)}\n`);
    };
    const { rehearsal, response } = await followRehearsal(
      ctx,
      session,
      key,
      requested.data,
      report,
    );
    const verdict = renderVerdict(rehearsal, name);
    if (rehearsal.state !== "passed") {
      const error = new CliError(
        rehearsal.state === "cancelled" ? "REHEARSAL_CANCELLED" : "REHEARSAL_FAILED",
        rehearsal.verdict ??
          `The rehearsal ${rehearsal.state === "cancelled" ? "was cancelled" : "failed"}.`,
        ExitCode.Unexpected,
        { rehearsal },
      );
      error.human = verdict;
      throw error;
    }
    return { data: rehearsal, meta: session.meta(response ?? requested), human: verdict };
  },
};
