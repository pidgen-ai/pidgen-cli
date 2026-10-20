import type { Command } from "commander";
import { CliError, usageError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import { pathSegment } from "../../core/read.js";
import {
  ARCHIVE_TYPE,
  checkoutRoot,
  READINESS_ROUTES,
  readReadiness,
  renderProposal,
  renderPullRequest,
  renderWritten,
  sendReadiness,
  writeProposal,
  type ReadinessProposal,
} from "../../core/readiness.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";

/**
 * `pidgen project setup <key> [--write [--force] | --pull-request]`: the proposed workspace setup,
 * `.pidgen/pidgen.toml` and the scripts it names.
 *
 * - Without flags it shows the proposal (`GET /projects/{project_ref}/readiness`, `data` its
 *   `proposal`) and writes nothing.
 * - `--write` downloads the files (`GET /projects/{project_ref}/readiness/proposal/archive`, a
 *   gzip tar) and extracts them under `.pidgen/` at the root of the current git checkout, keeping
 *   each file's executable bit. A file that differs is replaced only with `--force`.
 * - `--pull-request` opens the pull request that proposes them through the Project's forge
 *   (`POST /projects/{project_ref}/readiness/proposal/pull-request`); `data` is the proposal with
 *   its `pull_request`, unchanged.
 */
export const projectSetup: CommandSpec = {
  path: ["project", "setup"],
  summary: "Show the proposed workspace setup, write it under .pidgen/, or open its pull request",
  configure(command: Command) {
    command
      .argument("<key>", "the project's id (proj-…) or ticket-key prefix, e.g. STO")
      .option("--write", "write the proposed files under .pidgen/ in the current checkout")
      .option("--force", "with --write, replace files under .pidgen/ that differ")
      .option("--pull-request", "open the pull request that proposes the files");
  },
  async run(ctx, { args, options, global }) {
    const key = pathSegment("project key", args[0]);
    const name = decodeURIComponent(key);
    const write = options["write"] === true;
    const pullRequest = options["pullRequest"] === true;
    const force = options["force"] === true;
    if (write && pullRequest) {
      throw usageError("Choose one of --write and --pull-request.", {
        options: ["--write", "--pull-request"],
      });
    }
    if (force && !write) throw usageError("--force only goes with --write.", { option: "--force" });

    if (write) {
      const root = await checkoutRoot(ctx.cwd);
      const session = await openSession(ctx, global);
      const response = await session.client.download(
        { method: "GET", path: READINESS_ROUTES.archive.path.replace("{project_ref}", key) },
        ARCHIVE_TYPE,
      );
      const files = await writeProposal(root, response.data, { force, key: name });
      return {
        data: { project_key: name, root, files },
        meta: session.meta(response),
        human: renderWritten(name, root, files),
      };
    }

    const session = await openSession(ctx, global);
    if (pullRequest) {
      const response = await sendReadiness<ReadinessProposal>(
        session,
        READINESS_ROUTES.pullRequest,
        key,
      );
      return {
        data: response.data,
        meta: session.meta(response),
        human: renderPullRequest(name, response.data),
      };
    }

    const response = await readReadiness(session, key);
    const readiness = response.data;
    if (readiness.proposal === null) {
      throw new CliError(
        "READINESS_PROPOSAL_NOT_FOUND",
        readiness.inspection?.state === "inspecting"
          ? `${readiness.project_name} is still being inspected; the proposed setup follows.`
          : `${readiness.project_name} has no proposed setup.`,
        ExitCode.NotFound,
        {
          project_key: readiness.project_key,
          next: `pidgen project inspect ${readiness.project_key}`,
        },
      );
    }
    return {
      data: readiness.proposal,
      meta: session.meta(response),
      human: renderProposal(readiness, readiness.proposal),
    };
  },
};
