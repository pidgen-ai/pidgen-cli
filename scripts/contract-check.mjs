// Checks a fetched public API document before `npm run contract:pull` writes it.
// The document is committed to a public repository, so it must not cite internal records.
// See CONTRIBUTING.md, "Refusing internal citations".
import { writeFile } from "node:fs/promises";

/** Patterns for citations of internal records. Ticket keys such as "e.g. PIDGEN-12" are allowed. */
export const CITATION_PATTERNS = [
  { name: "ADR citation", pattern: /ADR-\d+/g },
  { name: "PRD citation", pattern: /\bPRD\b/g },
  { name: "section mark", pattern: /§/g },
  { name: "slice id", pattern: /\d{3}\/S\d+/g },
  { name: "decision citation", pattern: /Decision \d+/g },
  { name: "source path", pattern: /[\w./-]*\.py\b/g },
];

/**
 * Operations the App Service has retired but may still publish, as `[method, path]`. A pull leaves
 * them out, with the component schemas only they use, so the CLI treats them as removed without
 * waiting for the server release that stops publishing them. The legacy Epic routes: Epics are
 * Tickets, and every `pidgen epic` command uses the ticket routes.
 */
export const RETIRED_OPERATIONS = [
  ["get", "/api/v1/epics"],
  ["post", "/api/v1/epics"],
  ["get", "/api/v1/epics/{epic_id}"],
  ["patch", "/api/v1/epics/{epic_id}"],
  ["get", "/api/v1/epics/{epic_id}/dag"],
  ["post", "/api/v1/epics/{epic_id}/dag/edges"],
  ["delete", "/api/v1/epics/{epic_id}/dag/edges"],
  ["post", "/api/v1/tickets/{ticket_id}/epic"],
];

const OPERATION_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

const COMPONENT_REF = /^#\/components\/([^/]+)\/([^/]+)$/;

function unescapePointerToken(token) {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Every local component `$ref` reachable from the document outside `components`, transitively. */
function reachableComponents(document) {
  const reached = new Set();
  const pending = [];
  const collect = (value) => {
    if (Array.isArray(value)) {
      value.forEach(collect);
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (key === "$ref" && typeof item === "string" && COMPONENT_REF.test(item)) {
          if (!reached.has(item)) {
            reached.add(item);
            pending.push(item);
          }
        } else {
          collect(item);
        }
      }
    }
  };
  for (const [key, value] of Object.entries(document)) {
    if (key !== "components") collect(value);
  }
  while (pending.length > 0) {
    const [, kind, name] = COMPONENT_REF.exec(pending.pop());
    collect(document.components?.[kind]?.[unescapePointerToken(name)]);
  }
  return reached;
}

/**
 * Returns a copy of `document` without the RETIRED_OPERATIONS it publishes (and a path left with
 * no operation), and without each component that only they referred to. Components nothing
 * referred to before are kept. `operations` lists what was left out as `METHOD path`, `schemas`
 * the component names.
 */
export function pruneRetired(document) {
  const pruned = JSON.parse(JSON.stringify(document));
  const operations = [];
  for (const [method, path] of RETIRED_OPERATIONS) {
    const item = pruned.paths?.[path];
    if (item === null || typeof item !== "object" || !(method in item)) continue;
    delete item[method];
    operations.push(`${method.toUpperCase()} ${path}`);
    if (!Object.keys(item).some((key) => OPERATION_METHODS.has(key))) delete pruned.paths[path];
  }
  const schemas = [];
  if (operations.length > 0) {
    const kept = reachableComponents(pruned);
    for (const target of reachableComponents(document)) {
      if (kept.has(target)) continue;
      const [, kind, token] = COMPONENT_REF.exec(target);
      const name = unescapePointerToken(token);
      delete pruned.components[kind][name];
      schemas.push(name);
    }
  }
  schemas.sort();
  return { document: pruned, operations, schemas };
}

function escapePointerToken(token) {
  return String(token).replaceAll("~", "~0").replaceAll("/", "~1");
}

function matchesIn(text, pointer) {
  const found = [];
  for (const { name, pattern } of CITATION_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      found.push({ pointer, kind: name, text: match[0] });
    }
  }
  return found;
}

/**
 * Walks every string in `document` (values and member names) and returns each citation found,
 * with the JSON pointer of the value or member that contains it.
 */
export function findCitations(document) {
  const found = [];
  const walk = (value, pointer) => {
    if (typeof value === "string") {
      found.push(...matchesIn(value, pointer));
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${pointer}/${index}`));
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        const child = `${pointer}/${escapePointerToken(key)}`;
        found.push(...matchesIn(key, child));
        walk(item, child);
      }
    }
  };
  walk(document, "");
  return found;
}

/**
 * Fetches `<base>/api/v1/openapi.json`, leaves out the retired operations and the schemas only they
 * use (pruneRetired), refuses the rest if it cites internal records, and otherwise writes it to
 * `file`. Returns the process exit code: 0 written, 1 refused or failed.
 */
export async function pullContract({
  base,
  file = "contracts/openapi.json",
  fetch: fetchImpl = globalThis.fetch,
  out = (line) => console.log(line),
  err = (line) => console.error(line),
}) {
  const url = new URL("/api/v1/openapi.json", base);
  let document;
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      err(`GET ${url} → HTTP ${response.status}`);
      return 1;
    }
    document = await response.json();
  } catch (error) {
    err(`GET ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (
    typeof document?.openapi !== "string" ||
    typeof document?.paths !== "object" ||
    document.paths === null
  ) {
    err(`${url} did not return an OpenAPI document`);
    return 1;
  }
  const { document: pruned, operations, schemas } = pruneRetired(document);
  document = pruned;
  const citations = findCitations(document);
  if (citations.length > 0) {
    err(
      `Refused: ${url} cites internal records in ${citations.length} place(s); ${file} is unchanged.`,
    );
    for (const { pointer, kind, text } of citations) {
      err(`  ${pointer === "" ? "(root)" : pointer}: ${JSON.stringify(text)} (${kind})`);
    }
    err("Remove the citations from the App Service's public document, then pull again.");
    return 1;
  }
  await writeFile(file, JSON.stringify(document, null, 2) + "\n");
  out(`${file} updated from ${url.origin} (${Object.keys(document.paths).length} paths).`);
  if (operations.length > 0) {
    out(`Left out ${operations.length} retired operation(s): ${operations.join(", ")}.`);
  }
  if (schemas.length > 0) {
    out(`Left out ${schemas.length} schema(s) only they used: ${schemas.join(", ")}.`);
  }
  out("Next: npm run contract:generate, then review the diff.");
  return 0;
}
