import type { GlobalOptions, RunContext } from "./context.js";
import { CliError } from "./errors.js";
import { findOnPath } from "./worker.js";
import { readInstallRecord } from "./worker-install.js";
import {
  readWorkerReleases,
  seriesOf,
  WORKER_RELEASES_ROUTE,
  type WorkerReleaseList,
} from "./worker-releases.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

/**
 * One diagnostic check, in the shape `pidgen doctor` and `pidgen worker verify` report. `fix` is
 * the command or address that resolves the problem, or `null`.
 */
export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  summary: string;
  fix: string | null;
}

export function check(
  id: string,
  status: CheckStatus,
  summary: string,
  fix: string | null = null,
): DoctorCheck {
  return { id, status, summary, fix };
}

/** True when no check failed; `warn` and `skip` do not make a report unhealthy. */
export function isHealthy(checks: readonly DoctorCheck[]): boolean {
  return checks.every((entry) => entry.status !== "fail");
}

/** The command that installs, or moves to, the server's current worker release. */
const INSTALL = "pidgen worker install";

/**
 * The checks taken from the server's worker release list, read with no credential: `releases`
 * (the list itself), one `harness:<kind>` per harness the list names (on `PATH`), and `worker`
 * (the installed worker's version against the releases the server accepts). The CLI carries no
 * harness knowledge of its own.
 *
 * `server` is the configured server's address, or `null` when the server check failed; then, as
 * when the list cannot be read, the checks that need it are `skip` (`harness` standing for the
 * harness checks the list would have named).
 */
export async function releaseListChecks(
  ctx: RunContext,
  global: Pick<GlobalOptions, "profile" | "account" | "timeoutSeconds">,
  server: string | null,
): Promise<DoctorCheck[]> {
  const skipped = (reason: string): DoctorCheck[] => [
    check("harness", "skip", `Skipped: ${reason}, so its harnesses are unknown.`),
    check("worker", "skip", `Skipped: ${reason}, so the accepted releases are unknown.`),
  ];
  if (server === null) {
    return [
      check(
        "releases",
        "skip",
        "Skipped: the server check failed, so its worker release list was not read.",
      ),
      ...skipped("the server's worker release list was not read"),
    ];
  }

  let list: WorkerReleaseList;
  try {
    list = (await readWorkerReleases(ctx, global)).list;
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    const route = `${server.replace(/\/+$/, "")}/api/v1${WORKER_RELEASES_ROUTE.path}`;
    return [
      check(
        "releases",
        "fail",
        `The server's worker release list could not be read (${error.code}): ${error.message}`,
        route,
      ),
      ...skipped("the server's worker release list could not be read"),
    ];
  }

  return [
    check(
      "releases",
      "ok",
      `The server lists ${list.releases.length} worker release${list.releases.length === 1 ? "" : "s"}; ${list.current} is current.`,
    ),
    ...(await harnessChecks(ctx, list)),
    await workerCheck(ctx, list),
  ];
}

/**
 * One check per harness the list names: found on `PATH` is `ok`; missing is `warn` while another
 * is found, and `fail` when none is, since the worker then has nothing to run work with.
 */
async function harnessChecks(ctx: RunContext, list: WorkerReleaseList): Promise<DoctorCheck[]> {
  const config = { env: ctx.env, cwd: ctx.cwd };
  const found = await Promise.all(
    list.harnesses.map(async (harness) => ({
      harness,
      path: await findOnPath(config, harness.command, ctx.workerRuntime),
    })),
  );
  const any = found.some((entry) => entry.path !== null);
  return found.map(({ harness, path }) => {
    const id = `harness:${harness.kind}`;
    if (path !== null) return check(id, "ok", `${harness.command} is on PATH at ${path}.`);
    return check(
      id,
      any ? "warn" : "fail",
      any
        ? `${harness.command} is not on PATH; the worker cannot run ${harness.kind} work here.`
        : `${harness.command} is not on PATH, and no harness the server names is: the worker has nothing to run work with.`,
      `Install ${harness.command} and put it on PATH`,
    );
  });
}

/**
 * The installed worker against the list: `current` is `ok`, `supported` is `warn`, a release the
 * server no longer accepts or does not list is `fail`. No install record is `warn`, so the doctor
 * still passes on a machine that is being prepared.
 */
async function workerCheck(ctx: RunContext, list: WorkerReleaseList): Promise<DoctorCheck> {
  const record = await readInstallRecord(ctx);
  if (record === null) {
    return check(
      "worker",
      "warn",
      `The worker is not installed; the server's current release is ${list.current}.`,
      INSTALL,
    );
  }
  const status =
    list.releases.find((candidate) => candidate.series === seriesOf(record.version))?.status ??
    "unlisted";
  const installed = `pidgen-worker ${record.version} (${record.form}) is installed at ${record.location}`;
  if (status === "current") return check("worker", "ok", `${installed} and is current.`);
  if (status === "supported") {
    return check(
      "worker",
      "warn",
      `${installed} and is still accepted; ${list.current} is current.`,
      INSTALL,
    );
  }
  return check(
    "worker",
    "fail",
    `The server no longer accepts pidgen-worker ${record.version} (${status}); ${list.current} is current.`,
    INSTALL,
  );
}
