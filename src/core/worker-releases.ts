import { PUBLIC_API_DOCUMENT } from "../commands/api/document.js";
import { loadConfig, resolveTarget } from "./config.js";
import type { GlobalOptions, RunContext } from "./context.js";
import { CliError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";
import type { ApiResponse } from "./http.js";
import { schemaIssues } from "./input.js";
import { anonymousClient, type SessionMeta } from "./session.js";
import type { components } from "../generated/api.js";

/**
 * The worker releases the App Service publishes: `GET /api/v1/workers/releases`, read with no
 * credential and no Account. The answer's `data` is validated against the published document's
 * `WorkerReleaseList` (`contracts/openapi.json`).
 */

export type WorkerReleaseList = components["schemas"]["WorkerReleaseList"];
export type WorkerRelease = components["schemas"]["WorkerRelease"];
export type WorkerHarness = components["schemas"]["WorkerHarness"];
export type WorkerEula = components["schemas"]["WorkerEula"];

/** The operation, as the published document names it. */
export const WORKER_RELEASES_ROUTE = { method: "get", path: "/workers/releases" } as const;

const LIST_SCHEMA = { $ref: "#/components/schemas/WorkerReleaseList" };

export interface ReadReleases {
  list: WorkerReleaseList;
  meta: SessionMeta;
}

/**
 * Reads the configured server's release list without a credential or an Account, and validates
 * it against the published contract. A body that does not match the contract is
 * `UNEXPECTED_RESPONSE` (exit 1).
 */
export async function readWorkerReleases(
  ctx: RunContext,
  global: Pick<GlobalOptions, "profile" | "account" | "timeoutSeconds">,
): Promise<ReadReleases> {
  const config = await loadConfig(ctx);
  const target = resolveTarget(ctx, config, global);
  const client = anonymousClient(ctx, target.url, global);
  const response: ApiResponse<unknown> = await client.request({
    method: "GET",
    path: WORKER_RELEASES_ROUTE.path,
  });
  const issues = schemaIssues(PUBLIC_API_DOCUMENT, LIST_SCHEMA, response.data);
  if (issues.length > 0) {
    throw new CliError(
      "UNEXPECTED_RESPONSE",
      `The server's worker release list does not match the contract (${issues.length} issue${issues.length === 1 ? "" : "s"}).`,
      ExitCode.Unexpected,
      { route: `GET /api/v1${WORKER_RELEASES_ROUTE.path}`, issues },
    );
  }
  return {
    list: response.data as WorkerReleaseList,
    meta: {
      profile: target.profile,
      account: null,
      request_id: response.requestId,
      api_version: response.apiVersion,
    },
  };
}

/** The release series the server accepts: `current` first, then `supported`, newest first. */
export function acceptedSeries(list: WorkerReleaseList): string[] {
  return list.releases.map((release) => release.series);
}

/** The series a worker version belongs to: `2.10.3` and `2.10.3.dev4` are both `2.10`. */
export function seriesOf(version: string): string {
  const [major = "", minor = ""] = version.split(".");
  return `${major}.${minor}`;
}

/**
 * The series to install: the series of `version` when given, else the list's `current`. A version
 * whose series the server does not accept is `RELEASE_UNSUPPORTED` (exit 5).
 */
export function selectSeries(list: WorkerReleaseList, version?: string): WorkerRelease {
  const wanted = version === undefined ? list.current : seriesOf(version);
  const release = list.releases.find((candidate) => candidate.series === wanted);
  if (release !== undefined) return release;
  if (version === undefined) {
    throw new CliError(
      "UNEXPECTED_RESPONSE",
      `The server names ${wanted} as the current worker series but does not list it.`,
      ExitCode.Unexpected,
      { current: list.current },
    );
  }
  throw new CliError(
    "RELEASE_UNSUPPORTED",
    `The server does not accept worker ${version} (series ${wanted}). Install the current series (${list.current}) or one of ${acceptedSeries(list).join(", ")}.`,
    ExitCode.Refused,
    { version, series: wanted, current: list.current, accepted: acceptedSeries(list) },
  );
}

/**
 * Orders two worker versions: numeric parts first (`2.10.0` after `2.9.4`), then a development
 * build before its release (`2.10.0.dev3` before `2.10.0`) and a lower `.devN` before a higher one.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const match = /^(\d+(?:\.\d+)*)(?:[.-]?(?:dev|rc|a|b)\.?(\d+))?/.exec(version);
    const parts = (match?.[1] ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
    const pre = match?.[2] === undefined ? null : Number.parseInt(match[2], 10);
    return { parts, pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.parts.length, right.parts.length); index++) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return Math.sign(left.pre - right.pre);
}

export type UpdateReason = "protocol_unsupported" | "protocol_outdated" | "newer_available";

/** Whether the installed worker should be updated, and why. */
export interface UpdateSignal {
  /** The version the install record names, or `null` with no record. */
  installed: string | null;
  /** The release list's `current` series, or `null` when the list was not read. */
  current: string | null;
  needed: boolean;
  reason: UpdateReason | null;
}

/**
 * The update signal: `protocol_unsupported` or `protocol_outdated` from the server's record of the
 * worker (its `protocol_state`), else `newer_available` when the installed version is of an older
 * series than the list's `current`. A newer patch of the same series is found by
 * `pidgen worker update`, which asks the package index.
 */
export function updateSignal(
  installed: string | null,
  current: string | null,
  protocolState: string | null,
): UpdateSignal {
  let reason: UpdateReason | null = null;
  if (protocolState === "unsupported") reason = "protocol_unsupported";
  else if (protocolState === "outdated") reason = "protocol_outdated";
  else if (
    installed !== null &&
    current !== null &&
    compareVersions(current, seriesOf(installed)) > 0
  ) {
    reason = "newer_available";
  }
  return { installed, current, needed: reason !== null, reason };
}
