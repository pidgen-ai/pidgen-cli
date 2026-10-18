import type { components } from "../generated/api.js";
import { renderDetails, wrap } from "./resource-human.js";

/** Lifecycle and diagnostic commands retain complete details rather than projecting status rows. */
export const LIFECYCLE_PRESENTATIONS: Readonly<Record<string, string>> = {
  "auth login": "Signed in.",
  "auth logout": "Stored credential removed.",
  "auth revoke": "Credential revoked.",
  "auth list": "Sessions and CLI tokens",
  "auth status": "Authentication",
  "account list": "Accounts",
  "account use": "Default Account selected.",
  "worker install": "Worker installed.",
  "worker update": "Worker updated.",
  "worker uninstall": "Worker uninstalled.",
  "worker enroll": "Worker enrolled.",
  "worker start": "Worker started in background.",
  "worker stop": "Worker stopped.",
  "worker status": "Worker status",
  "worker verify": "Worker verification",
  "worker doctor": "Worker diagnostics",
  "worker login": "Coding agent signed in.",
  "worker subscriptions": "Worker subscriptions",
  "worker subscriptions use": "Primary subscription changed.",
  setup: "Setup complete.",
  doctor: "Diagnostics",
  "skills status": "Skills status",
};

type WorkerSubscriptions = components["schemas"]["WorkerSubscriptionsResource"];
type WorkerSubscription = components["schemas"]["WorkerSubscriptionResource"];
type Row = Record<string, unknown>;
function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function renderLifecycle(
  command: string,
  data: unknown,
  columns?: number,
  now?: number,
  /** Lines the command adds under the heading, such as why nothing was updated. */
  extraNotes: readonly string[] = [],
): string | undefined {
  let heading = LIFECYCLE_PRESENTATIONS[command];
  if (!heading) return undefined;
  const row = isRecord(data) ? data : {};
  const notes: string[] = [...extraNotes];
  if (command === "worker install" && row["installed"] === false)
    heading = "Worker already installed.";
  if (command === "worker update" && row["updated"] === false)
    heading = "Worker already up to date.";
  if (command === "worker login" && row["login"] === "unknown") {
    heading = "Coding agent login finished; it cannot report whether it is signed in.";
  }
  if (command === "worker subscriptions use" && row["outcome"] !== "applied") {
    heading = "Outcome unknown — check the worker's subscriptions before retrying.";
  }
  if (command === "worker status") {
    if (!("server" in row)) notes.push("Local status only; server not checked.");
    else if (row["server"] === null)
      notes.push("Server status unavailable; showing local status only.");
  }
  if (command === "auth status" && row["server"] === null) {
    notes.push("Server compatibility not checked.");
  }
  if (Array.isArray(row["warnings"]) && row["warnings"].length > 0) {
    notes.push("Completed with warnings; review the warnings below.");
  }
  if (Array.isArray(row["checks"])) {
    const checks = row["checks"].filter(isRecord);
    const count = (status: string) =>
      checks.filter((entry) => {
        const actual =
          entry["status"] ??
          (entry["ok"] === true ? "ok" : entry["ok"] === false ? "fail" : undefined);
        return actual === status;
      }).length;
    // Skipped checks are not passed checks. Do not infer overall health from exit status.
    notes.push(
      `Checks: ${count("ok")} ok, ${count("warn")} warnings, ${count("fail")} failed, ${count("skip")} skipped.`,
    );
  }
  if (command === "skills status" && isRecord(row["contract"])) {
    const state = row["contract"]["state"];
    if (state === "different")
      notes.push("Contract differs from the server; review the operations below.");
    if (state === "unchecked") notes.push("Contract unchecked; review the reason below.");
    if (state === "same") notes.push("Contract matches the server.");
  }
  const body =
    command === "worker subscriptions" && now !== undefined && Array.isArray(row["harnesses"])
      ? { summary: subscriptionRows(data as WorkerSubscriptions, now), ...row }
      : data;
  const width =
    columns !== undefined && Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80;
  return (
    [...[heading, ...notes].map((text) => wrap(text, width)), renderDetails(body, columns)].join(
      "\n",
    ) + "\n"
  );
}

/**
 * One row per subscription, in each harness's fallback order, for `--format table`: whether it is
 * the primary and the active one, its login and entitlement, each quota window with its age as
 * of `now`, and its pause.
 */
export function subscriptionRows(data: WorkerSubscriptions, now: number) {
  return data.harnesses.flatMap((harness) =>
    harness.subscriptions.map((subscription) => ({
      harness: harness.harness,
      subscription: subscription.label,
      primary: yesNo(subscription.primary),
      active: yesNo(subscription.active),
      login: subscription.login,
      entitled: yesNo(subscription.entitled),
      quota: quotaText(subscription.quota, now),
      pause: pauseText(subscription),
    })),
  );
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function quotaText(quota: WorkerSubscription["quota"], now: number): string {
  if (quota === null) return "unknown";
  if (quota.length === 0) return "none reported";
  return quota
    .map(
      (window) =>
        `${window.window} ${window.used_percent}% (${age(now - Date.parse(window.observed_at))} ago)`,
    )
    .join(", ");
}

/** The pause column: nothing unless paused, else until when, and the windows that pause it. */
function pauseText(subscription: WorkerSubscription): string {
  if (!subscription.paused) return "";
  const windows = subscription.pauses.map((pause) => pause.window).join(", ");
  const until =
    subscription.resets_at === null ? "paused" : `paused until ${subscription.resets_at}`;
  return windows === "" ? until : `${until} (${windows})`;
}

/** A duration as its largest whole unit: `30s`, `12m`, `3h`, `2d`. Never negative. */
function age(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
