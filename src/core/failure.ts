/**
 * The App Service's failure projection on a failed step: what happened
 * (`title`, `explanation`), what fixes it (`fix`), who can do it (`actor`), the ticket action it
 * recommends (`recommended_action`) and the masked git excerpt under `technical`. A ticket detail
 * carries it on `workflow_attention.failure` and on a failed node's `failure`.
 *
 * It is not in the committed public API document yet, and an older App Service omits it, so it is
 * read defensively: anything that is not an object with a `title` is no projection, and the
 * ticket renders as it did before.
 */
export interface FailureProjection {
  code?: string;
  reason?: string | null;
  title: string;
  explanation?: string;
  fix?: string;
  actor?: string;
  retry_class?: string;
  recommended_action?: string | null;
  docs_anchor?: string;
  technical?: FailureTechnical | null;
}

export interface FailureTechnical {
  operation?: string;
  exit_status?: number | null;
  reason?: string | null;
  excerpt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` as a failure projection, or undefined when it is none. */
export function readFailure(value: unknown): FailureProjection | undefined {
  if (!isRecord(value)) return undefined;
  const title = value["title"];
  return typeof title === "string" && title.trim() !== ""
    ? (value as unknown as FailureProjection)
    : undefined;
}

/**
 * The failure projection a ticket detail carries, exactly as the server sent it: its workflow
 * attention's `failure`, or else the first failed node's. Undefined when it carries none.
 */
export function ticketFailure(detail: unknown): Record<string, unknown> | undefined {
  if (!isRecord(detail)) return undefined;
  const attention = detail["workflow_attention"];
  if (isRecord(attention) && readFailure(attention["failure"]) !== undefined) {
    return attention["failure"] as Record<string, unknown>;
  }
  const nodes = detail["failed_nodes"];
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      if (isRecord(node) && readFailure(node["failure"]) !== undefined) {
        return node["failure"] as Record<string, unknown>;
      }
    }
  }
  return undefined;
}

/** Who `actor` names, in a person's words; an actor this CLI does not know is shown as sent. */
export const FAILURE_ACTORS: Readonly<Record<string, string>> = {
  pidgen: "Pidgen",
  credential_owner: "The credential's owner",
  repository_admin: "A repository administrator",
  worker_operator: "The worker's operator",
  the_work: "The work itself, in a new attempt",
};
