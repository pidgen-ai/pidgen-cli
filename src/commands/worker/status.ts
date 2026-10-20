import type { Command } from "commander";
import type { GlobalOptions, RunContext } from "../../core/context.js";
import { CliError, usageError } from "../../core/errors.js";
import type { ApiResponse } from "../../core/http.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession, type Session } from "../../core/session.js";
import { assertSupportedPlatform } from "../../core/worker.js";
import { adapterFor, readInstallRecord, type InstallRecord } from "../../core/worker-install.js";
import { readWorkerReleases, updateSignal } from "../../core/worker-releases.js";
import type { components } from "../../generated/api.js";

type WorkerList = components["schemas"]["WorkerList"];
type WorkerResource = components["schemas"]["WorkerResource"];

/** The operation `worker status` reads, as the public API document names it. */
export const WORKERS_ROUTE = { method: "get", path: "/workers" } as const;

/** Something `worker status` could not show; the local status is still reported. */
export interface StatusWarning {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

/** The App Service's record of this machine's worker. */
export interface ServerView {
  /** The host id looked for: `--host`, or this machine's host name. */
  host_id: string;
  /** Whether the Account has a worker with that host id whose credential is not revoked. */
  enrolled: boolean;
  /** That worker as `GET /workers` lists it (never its credential), or `null` when none matches. */
  worker: WorkerResource | null;
  service_protocol: string;
  accepted_protocols: string[];
}

/**
 * `pidgen worker status [--host <host_id>]`: the detached worker's local record and liveness (or,
 * for a container install, the container's), and, when
 * a credential is configured, the App Service's record of this worker from `GET /workers` — its
 * last-seen time, protocol state and git credential coverage.
 *
 * `installed` is whether a valid install record exists: `false` with none (or an unreadable one),
 * which is still a status, not a `WORKER_NOT_INSTALLED` failure, so the command exits 0.
 *
 * Without a credential it stays local: no request is made and `data` is
 * `{installed, record, running, update}`.
 * With one, `data` adds `server` and `warnings`. A server that cannot be reached or refuses the
 * request leaves `server: null` and adds a warning; the command still exits 0, since the local
 * status was read. No matching worker is reported as `server.enrolled: false`, not as an error.
 *
 * `update` is `{installed, current, needed, reason}`: `installed` from the install record,
 * `current` from the server's release list (read with no credential, and only when a credential
 * is configured and the server was reachable), and `reason` `protocol_unsupported` or
 * `protocol_outdated` from the server's record of the worker, else `newer_available`.
 */
export const workerStatus: CommandSpec = {
  path: ["worker", "status"],
  summary: "Show the detached worker's local status and the App Service's record of it",
  configure(command: Command) {
    command.option(
      "--host <host_id>",
      "the worker's host id on the App Service (default: this machine's host name)",
    );
  },
  async run(ctx, { options, global }) {
    const hostId = selectedHost(ctx, options["host"]);
    // Every path adds its warnings to this list; an unreadable install record is the first.
    const warnings: StatusWarning[] = [];
    const record = await installRecord(ctx, warnings);
    // The install record's form selects the adapter; with none, the detached wheel worker's.
    if (record?.form === "container") assertSupportedPlatform(ctx.workerRuntime);
    const local = {
      installed: record !== null,
      ...(await adapterFor(ctx, record?.form ?? "wheel").status()),
    };
    const installed = record?.version ?? null;
    const localOnly = {
      ...local,
      update: updateSignal(installed, null, null),
      ...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
    };

    let session: Session;
    try {
      session = await openSession(ctx, global, { credential: "optional" });
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      return {
        data: { ...localOnly, server: null, warnings: [...warnings, warningFrom(error)] },
      };
    }
    if (session.target.token === null) return { data: localOnly };

    let response: ApiResponse<WorkerList>;
    try {
      response = await session.client.request<WorkerList>({
        method: "GET",
        path: WORKERS_ROUTE.path,
      });
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      warnings.push(warningFrom(error));
      // An unreachable server is not asked again for its release list.
      const current = UNREACHABLE.has(error.code)
        ? null
        : await currentRelease(ctx, global, warnings);
      return {
        data: {
          ...local,
          server: null,
          update: updateSignal(installed, current, null),
          warnings,
        },
        meta: session.meta(),
      };
    }

    const list = response.data as Partial<WorkerList> | null;
    if (list === null || typeof list !== "object" || !Array.isArray(list.workers)) {
      warnings.push({
        code: "SERVER_RESPONSE_INVALID",
        message: "The App Service's worker list could not be read; showing the local status only.",
        details: { route: `GET ${WORKERS_ROUTE.path}` },
      });
      const current = await currentRelease(ctx, global, warnings);
      return {
        data: {
          ...local,
          server: null,
          update: updateSignal(installed, current, null),
          warnings,
        },
        meta: session.meta(response),
      };
    }

    const server = serverView(list as WorkerList, hostId);
    const current = await currentRelease(ctx, global, warnings);
    return {
      data: {
        ...local,
        server,
        update: updateSignal(installed, current, server.worker?.protocol_state ?? null),
        warnings,
      },
      meta: session.meta(response),
    };
  },
};

/** The install record, or `null` (with a warning when the record cannot be read). */
async function installRecord(
  ctx: RunContext,
  warnings: StatusWarning[],
): Promise<InstallRecord | null> {
  try {
    return await readInstallRecord(ctx);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    warnings.push({ code: error.code, message: error.message, details: error.details });
    return null;
  }
}

/** Error codes that mean the server could not be reached at all. */
const UNREACHABLE = new Set(["NETWORK", "TIMEOUT"]);

/**
 * The release list's `current`, read with no credential, or `null` with a warning when it cannot
 * be read.
 */
async function currentRelease(
  ctx: RunContext,
  global: Pick<GlobalOptions, "profile" | "account" | "timeoutSeconds">,
  warnings: StatusWarning[],
): Promise<string | null> {
  try {
    return (await readWorkerReleases(ctx, global)).list.current;
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    warnings.push({
      code: error.code,
      message: `${error.message} The update check could not read the server's release list.`,
      details: error.details,
    });
    return null;
  }
}

function selectedHost(ctx: RunContext, option: unknown): string {
  if (option === undefined) return ctx.hostName;
  if (typeof option !== "string" || option.trim() === "") {
    throw usageError("--host needs a non-empty host id.");
  }
  return option;
}

/**
 * Picks this worker from the Account's list: the unrevoked worker with the host id, else the most
 * recently enrolled revoked one, so a revoked credential is shown rather than hidden.
 */
export function serverView(list: WorkerList, hostId: string): ServerView {
  const matches = list.workers.filter((worker) => worker.host_id === hostId);
  const active = matches.find((worker) => worker.revoked_at === null);
  const latest = [...matches].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const worker = active ?? latest ?? null;
  return {
    host_id: hostId,
    enrolled: active !== undefined,
    worker,
    service_protocol: list.service_protocol,
    accepted_protocols: list.accepted_protocols,
  };
}

function warningFrom(error: CliError): StatusWarning {
  return {
    code: error.code,
    message: `${error.message} Showing the local status only.`,
    details: error.details,
  };
}
