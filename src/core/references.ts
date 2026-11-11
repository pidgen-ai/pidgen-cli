import { CliError } from "./errors.js";
import type { OpenApiDocument } from "./input.js";

/**
 * Reference Projects: a ticket's `references`, the Projects (by id or ticket-key prefix) that the
 * ticket's reading runs (refinement, queries, a domain Request's decomposition) may read beside its
 * own. Implementation never gets a checkout of them; it learns another Project from the ticket, a
 * contract, an attachment or the scope.
 *
 * `POST /tickets` and a ticket manifest's root and children take `references`; the App Service has
 * agreed the field but not yet published it in `contracts/openapi.json`. Until it does, the CLI
 * checks bodies against the published document with `references` added to those three request
 * schemas (`withReferences`). A schema that already publishes `references` is left as published.
 *
 * A reference to a Project outside the ticket's own domains is refused 422
 * `REFERENCE_OUTSIDE_DOMAIN`, naming the Project by its key in `error.details`
 * (`referenceRefusal`). A Project in no domain of its own may reference any Project of its Account.
 */

/** The request schemas that carry `references`. */
export const REFERENCE_SCHEMAS = ["CreateTicketRequest", "ManifestRoot", "ManifestChild"] as const;

/** `references`: Project ids or key prefixes, each non-empty. */
export const REFERENCES_SCHEMA = {
  type: "array",
  title: "References",
  description:
    "Projects this ticket's reading runs may read, by id or ticket-key prefix. Each must be in one of the ticket's own domains.",
  items: { type: "string", minLength: 1 },
} as const;

/** The server's refusal of a reference to a Project outside the ticket's own domains. */
export const REFERENCE_OUTSIDE_DOMAIN = "REFERENCE_OUTSIDE_DOMAIN";

/** `document` with `references` on each of `REFERENCE_SCHEMAS` that does not publish it yet. */
export function withReferences(document: OpenApiDocument): OpenApiDocument {
  const components = isRecord(document["components"]) ? document["components"] : {};
  const schemas = isRecord(components["schemas"]) ? components["schemas"] : {};
  const extended: Record<string, unknown> = { ...schemas };
  for (const name of REFERENCE_SCHEMAS) {
    const schema = schemas[name];
    if (!isRecord(schema)) continue;
    const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
    if (Object.hasOwn(properties, "references")) continue;
    extended[name] = { ...schema, properties: { ...properties, references: REFERENCES_SCHEMA } };
  }
  return { ...document, components: { ...components, schemas: extended } };
}

/**
 * `body` with each of `given` added to its `references` once, after those it names, in the order
 * given. Without `given` the body is returned unchanged.
 */
export function addReferences(body: unknown, given: readonly string[]): unknown {
  if (given.length === 0 || !isRecord(body)) return body;
  const named = Array.isArray(body["references"]) ? (body["references"] as unknown[]) : [];
  const references = [...named];
  for (const project of given) if (!references.includes(project)) references.push(project);
  return { ...body, references };
}

/**
 * Runs `send`, and reports a `REFERENCE_OUTSIDE_DOMAIN` refusal with the Project's key and the
 * fix. Every other outcome, and the refusal's code, exit code and details, are kept.
 */
export async function reportingReferenceRefusal<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    throw referenceRefusal(error);
  }
}

/**
 * The refusal `error` restated: `Project <KEY> is outside the ticket's own domains: reference only
 * Projects in the ticket's own domains, or remove it from references.` Any other error is
 * returned as it is.
 */
export function referenceRefusal(error: unknown): unknown {
  if (!(error instanceof CliError) || error.code !== REFERENCE_OUTSIDE_DOMAIN) return error;
  const key = projectKey(error.details);
  const project = key === undefined ? "A referenced Project" : `Project ${key}`;
  const removal = key === undefined ? "remove it" : `remove ${key}`;
  const restated = new CliError(
    error.code,
    `${project} is outside the ticket's own domains, so it cannot be a reference: reference only Projects in the ticket's own domains, or ${removal} from references.`,
    error.exitCode,
    { ...error.details, server_message: error.message },
  );
  if (error.human !== undefined) restated.human = error.human;
  return restated;
}

/** The refused Project's key, as the server's details name it. */
function projectKey(details: Record<string, unknown>): string | undefined {
  const nested = isRecord(details["details"]) ? details["details"] : {};
  for (const source of [details, nested]) {
    for (const field of ["project_key", "key", "project", "project_ref", "reference"]) {
      const value = source[field];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
