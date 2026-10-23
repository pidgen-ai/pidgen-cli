import type { WorkerList, WorkerResource } from "./worker-enrollments.js";

/**
 * How the CLI tells workers apart. The App Service mints each new worker's id at enrollment
 * (`wkr_` and 26 base32 characters), whatever host id the worker asked for, and lists it as
 * `host_id`; the name the person chose is its `display_name`. The worker saves the minted id as
 * `PIDGEN_LOCALITY_DOMAIN` in the worker home's `worker.env` and authenticates as it. A worker
 * enrolled before minted ids keeps its old host id (often the machine's host name), and one
 * enrolled before names has a `null` `display_name`: its host id is its name.
 */

type Worker = Pick<WorkerResource, "host_id" | "display_name" | "revoked_at" | "created_at"> & {
  install_id?: string | null;
};

/** Which rule found this machine's worker: `worker status`'s `server.selected_by`. */
export type WorkerSelectedBy = "option" | "worker_home" | "install_id" | "host_name";

/** This machine's worker, as `selectWorker` found it. */
export interface WorkerSelection {
  /** The worker's id: its `host_id` on the App Service. */
  host_id: string;
  selected_by: WorkerSelectedBy;
}

/** What `selectWorker` looks for this machine's worker by, in order. */
export interface WorkerSelectionInputs {
  /** `--host`: a worker's id or name. */
  option?: string;
  /**
   * The id in the worker home's `worker.env` (`PIDGEN_LOCALITY_DOMAIN`), when the file holds a
   * credential for the configured server, else `null`.
   */
  homeId: string | null;
  /** This install's id (the worker home's `install-id`), or `null`. */
  installId: string | null;
  /** This machine's host name. */
  hostName: string;
}

const MINTED_ID = /^wkr_[a-z2-7]{26}$/;

/** Whether `value` has the shape of a worker id the App Service mints. */
export function isMintedWorkerId(value: string): boolean {
  return MINTED_ID.test(value);
}

/** A worker's name: its `display_name`, or its `host_id` for a worker enrolled before names. */
export function workerName(worker: Pick<Worker, "host_id" | "display_name">): string {
  return worker.display_name ?? worker.host_id;
}

/**
 * A worker as people read it: its name with its id, `Mad-Max (wkr_…)`. Either alone when the
 * other is unknown or the same.
 */
export function workerLabel(id: string | null, name: string | null): string {
  if (name === null || name === "") return id ?? "";
  if (id === null || id === "" || id === name) return name;
  return `${name} (${id})`;
}

/**
 * The Account's unrevoked workers named `name`: `display_name` compared case-insensitively, and
 * `host_id` only for a worker whose `display_name` is `null`.
 */
export function liveWorkersNamed<T extends Worker>(list: { workers: T[] }, name: string): T[] {
  return list.workers.filter(
    (worker) => worker.revoked_at === null && sameName(workerName(worker), name),
  );
}

/** Names compare case-insensitively. */
export function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** This install's newest worker in `list`: the newest whose `install_id` is `installId`. */
export function newestOfInstall<T extends Worker>(
  list: { workers: T[] },
  installId: string,
): T | null {
  const ours = list.workers.filter((worker) => worker.install_id === installId);
  return [...ours].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

/**
 * This machine's worker in the Account's list, in order: the worker `--host` names (its `host_id`
 * exactly, else its name among unrevoked workers; else what was given); else the id the worker
 * home's `worker.env` holds a credential for; else this install's newest worker by `install_id`;
 * else, for workers enrolled before minted ids, this machine's host name as a host id.
 */
export function selectWorker(
  list: Pick<WorkerList, "workers">,
  inputs: WorkerSelectionInputs,
): WorkerSelection {
  if (inputs.option !== undefined) {
    const option = inputs.option;
    const exact = list.workers.find((worker) => worker.host_id === option);
    const named = exact === undefined ? liveWorkersNamed(list, option)[0] : undefined;
    return { host_id: exact?.host_id ?? named?.host_id ?? option, selected_by: "option" };
  }
  if (inputs.homeId !== null) return { host_id: inputs.homeId, selected_by: "worker_home" };
  if (inputs.installId !== null) {
    const mine = newestOfInstall(list, inputs.installId);
    if (mine !== null) return { host_id: mine.host_id, selected_by: "install_id" };
  }
  return { host_id: inputs.hostName, selected_by: "host_name" };
}

/** Whether two server URLs name the same server (the same origin). */
export function sameServer(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
