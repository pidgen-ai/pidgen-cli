import { readdir, readFile } from "node:fs/promises";
import openapiTS, { astToString } from "openapi-typescript";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { COMMAND_OPERATIONS, renderCoverage } from "../../scripts/api-coverage.mjs";

const DOCUMENT = new URL("../../contracts/openapi.json", import.meta.url);
const GENERATED = new URL("../../src/generated/api.d.ts", import.meta.url);
const CI = new URL("../../.github/workflows/ci.yml", import.meta.url);
const PENDING_DIR = new URL("../../contracts/pending/", import.meta.url);
const PACKAGE = new URL("../../package.json", import.meta.url);

/**
 * Every pending fragment under contracts/pending/ and the routes it holds, `METHOD path`. A new
 * fragment is listed here; once the server publishes its routes the fragment and its entry go.
 * The seven that stood in for the worker release, domain, Domain Epic, contract, contract
 * creation, contract publishing and Request routes were deleted when the server published those
 * routes (RETIRED_FRAGMENTS).
 */
const PENDING_ROUTES: Record<string, readonly string[]> = {
  "worker-enrollments": [
    "GET /api/v1/workers",
    "POST /api/v1/workers/enrollments",
    "GET /api/v1/workers/enrollments",
    "DELETE /api/v1/workers/enrollments/{enrollment_id}",
  ],
  "project-readiness": [
    "GET /api/v1/projects/{project_ref}/readiness",
    "GET /api/v1/projects/{project_ref}/readiness/proposal/archive",
    "POST /api/v1/projects/{project_ref}/readiness/proposal/pull-request",
    "POST /api/v1/projects/{project_ref}/readiness/answers",
    "POST /api/v1/projects/{project_ref}/readiness/rehearse",
    "POST /api/v1/projects/{project_ref}/readiness/doctor",
  ],
};

/** The published schemas each fragment copies verbatim from contracts/openapi.json. */
const COPIED_SCHEMAS: Record<string, readonly string[]> = {
  "worker-enrollments": [
    "CreatedEnrollmentResponse",
    "WorkerList",
    "WorkerListResponse",
    "PublicError",
    "InstallOption",
    "WorkerEula",
  ],
  "project-readiness": ["PublicError", "PublicErrorDetail"],
};
const FRAGMENTS = Object.keys(PENDING_ROUTES);

/**
 * Routes a fragment holds that the server already publishes, extended with a field the published
 * schema lacks. Their reminder is not the route but the field.
 */
const EXTENDED_ROUTES: Record<string, readonly string[]> = {
  "worker-enrollments": ["GET /api/v1/workers", "POST /api/v1/workers/enrollments"],
};

/**
 * Published schemas a fragment holds under their published names with fields added, and those
 * fields. Apart from them each is the published schema; once the published one carries them, the
 * fragment's reminder fires.
 */
const EXTENDED_SCHEMAS: Record<string, Record<string, readonly string[]>> = {
  "worker-enrollments": {
    CreateEnrollmentRequest: ["install_id"],
    CreatedEnrollment: ["install_id"],
    WorkerResource: ["install_id"],
  },
};

/**
 * The fragments the published document replaced, and the routes each stood in for. Their files,
 * their generated types and every import of them are gone; the commands are typed from and
 * validated against contracts/openapi.json.
 */
const RETIRED_FRAGMENTS: Record<string, readonly string[]> = {
  "worker-releases": ["GET /api/v1/workers/releases"],
  domains: [
    "GET /api/v1/domains",
    "POST /api/v1/domains",
    "GET /api/v1/domains/{domain_id}",
    "PATCH /api/v1/domains/{domain_id}",
    "PUT /api/v1/domains/{domain_id}/projects/{project_ref}",
    "DELETE /api/v1/domains/{domain_id}/projects/{project_ref}",
    "PUT /api/v1/domains/{domain_id}/parents/{parent_id}",
    "DELETE /api/v1/domains/{domain_id}/parents/{parent_id}",
    "PUT /api/v1/domains/{domain_id}/people/{user_id}",
    "DELETE /api/v1/domains/{domain_id}/people/{user_id}",
  ],
  "domain-epics": ["POST /api/v1/tickets", "GET /api/v1/domains/{domain_id}/epics"],
  contracts: [
    "GET /api/v1/projects/{project_ref}/contracts",
    "GET /api/v1/domains/{domain_id}/contracts",
    "GET /api/v1/contracts/{contract_id}",
    "POST /api/v1/contracts/{contract_id}/revisions",
    "POST /api/v1/contracts/{contract_id}/revisions/{revision_number}/accept",
    "POST /api/v1/tickets/{ticket_id}/contracts",
    "DELETE /api/v1/tickets/{ticket_id}/contracts/{contract_id}",
  ],
  "contract-create": [
    "POST /api/v1/projects/{project_ref}/contracts",
    "POST /api/v1/domains/{domain_id}/contracts",
  ],
  "contract-publish": [
    "POST /api/v1/projects/{project_ref}/contracts/publish",
    "POST /api/v1/domains/{domain_id}/contracts/publish",
    "POST /api/v1/contracts/{contract_id}/proposals",
    "POST /api/v1/projects/{project_ref}/contracts/proposals",
    "GET /api/v1/projects/{project_ref}/contract-refusals/{refusal_id}/file",
  ],
  requests: [
    "POST /api/v1/requests",
    "GET /api/v1/requests",
    "GET /api/v1/requests/{request_id}",
    "PATCH /api/v1/requests/{request_id}",
    "GET /api/v1/requests/{request_id}/timeline",
    "POST /api/v1/requests/{request_id}/acknowledge",
    "POST /api/v1/requests/{request_id}/ask",
    "POST /api/v1/requests/{request_id}/reply",
    "POST /api/v1/requests/{request_id}/note",
    "POST /api/v1/requests/{request_id}/accept",
    "POST /api/v1/requests/{request_id}/close",
    "POST /api/v1/requests/{request_id}/reopen",
    "POST /api/v1/requests/{request_id}/retarget",
    "POST /api/v1/requests/{request_id}/mark-duplicate",
    "POST /api/v1/requests/{request_id}/promote",
    "POST /api/v1/requests/{request_id}/attachments",
    "GET /api/v1/requests/{request_id}/attachments/{attachment_id}",
  ],
};

interface Fragment {
  info: { title: string };
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { schemas: Record<string, unknown> };
}

async function fragment(name: string): Promise<Fragment> {
  return JSON.parse(await readFile(new URL(`${name}.json`, PENDING_DIR), "utf8")) as Fragment;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

/** The `METHOD path` operations of a document. */
function operationsOf(document: { paths: Record<string, Record<string, unknown>> }): string[] {
  const found: string[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.includes(method)) found.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return found;
}

/** The banner `openapi-typescript`'s command line puts above the generated types. */
const BANNER = /^\/\*\*\n(?: \*.*\n)* \*\/\n\n/;

/** Every operation a command sends, from the API coverage report's map (scripts/api-coverage.mjs). */
const OPERATIONS: ReadonlyArray<readonly [string, string]> = COMMAND_OPERATIONS.map(
  ([method, path]) => [method, path] as const,
);

/** Every TypeScript source under `root`, recursively. */
async function* sources(root: URL): AsyncGenerator<URL> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, root);
    if (entry.isDirectory()) yield* sources(child);
    else if (entry.name.endsWith(".ts")) yield child;
  }
}

describe("npm run contract:generate", () => {
  it("the committed contract carries no x-pidgen-intended-contract block and resolves from this file", async () => {
    const document = JSON.parse(await readFile(DOCUMENT, "utf8"));
    const schemas = document.components.schemas;
    // The document is pulled verbatim from the server; nothing is added under an extension block.
    expect(document).not.toHaveProperty("x-pidgen-intended-contract");
    // Agent selection is published on root creation, on edits and on child-plan children.
    expect(schemas.CreateTicketRequest.properties.team_member_id.anyOf).toEqual([
      { maxLength: 80, minLength: 1, type: "string" },
      { type: "null" },
    ]);
    // An edit names the Agent to reassign the ticket to; null is refused, so the type is a string.
    expect(schemas.EditTicketRequest.properties.team_member_id).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 80,
    });
    expect(schemas.EditTicketRequest.additionalProperties).toBe(false);
    expect(schemas.EditTicketRequest.required).toEqual(["version"]);
    expect(schemas.ChildPlanDraftChild.properties).toHaveProperty("team_member_id");
    // Every reference can be resolved from this file; generation needs no provider or network.
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          if (key === "$ref") expect(child).toMatch(/^#\//);
          else walk(child);
        }
      }
    };
    walk(document);
  });

  it("the published document carries every operation and schema the CLI is built against", async () => {
    // The document is the App Service's published public API, pulled verbatim
    // (npm run contract:pull). The agreed worker-release route is held separately in a pending
    // fragment until published; other missing routes wait, marked planned.
    const document = JSON.parse(await readFile(DOCUMENT, "utf8")) as {
      info: { title: string; version: string };
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(document.info).toMatchObject({ title: "Pidgen Public API", version: "1.0" });
    for (const path of Object.keys(document.paths)) {
      expect(path).not.toMatch(/^\/api\/v1\/admin/);
      expect(path).not.toMatch(/^\/api\/v1\/worker(-gateway)?\//);
    }
    for (const [method, path] of OPERATIONS) {
      expect(document.paths[path], `${method.toUpperCase()} ${path}`).toHaveProperty(method);
    }
    // Every schema a command types itself with exists under that name: in the published document,
    // or for a module typed from a pending fragment, in that fragment (or in the published document
    // when the module is typed from both).
    const named = new Set<string>();
    const namedPending = new Map<string, Set<string>>(FRAGMENTS.map((name) => [name, new Set()]));
    const fragments = new Map<string, Fragment>();
    for (const name of FRAGMENTS) fragments.set(name, await fragment(name));
    for await (const file of sources(new URL("../../src/", import.meta.url))) {
      const text = await readFile(file, "utf8");
      const typedFrom = FRAGMENTS.filter(
        (name) =>
          file.pathname.endsWith(`/src/generated/${name}.d.ts`) ||
          text.includes(`generated/${name}.js`),
      );
      const typedFromPublished = typedFrom.length === 0 || text.includes("generated/api.js");
      for (const match of text.matchAll(/components\["schemas"\]\["([A-Za-z0-9_]+)"\]/g)) {
        const schema = match[1]!;
        if (typedFrom.length === 0) {
          named.add(schema);
          continue;
        }
        const owner = typedFrom.find((name) =>
          Object.hasOwn(fragments.get(name)!.components.schemas, schema),
        );
        if (owner !== undefined) namedPending.get(owner)!.add(schema);
        else if (typedFromPublished) named.add(schema);
        else
          expect.fail(`${file.pathname} names ${schema}, which no fragment it is typed from has`);
      }
    }
    expect(named.size).toBeGreaterThan(20);
    for (const name of named) expect(document.components.schemas, name).toHaveProperty(name);
    for (const [name, schemas] of namedPending) {
      expect(schemas.size, `modules typed from contracts/pending/${name}.json`).toBeGreaterThan(0);
    }
  });

  it("the API coverage report lists every published operation once, attributing the ones commands send", async () => {
    const document = JSON.parse(await readFile(DOCUMENT, "utf8")) as {
      info: { version: string };
      paths: Record<string, Record<string, unknown>>;
    };
    const published = new Set<string>();
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const method of Object.keys(methods)) {
        if (["get", "post", "put", "patch", "delete"].includes(method)) {
          published.add(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    // The report's map names each operation once, with the commands that send it.
    const mapped = COMMAND_OPERATIONS.map(([method, path]) => `${method.toUpperCase()} ${path}`);
    expect(new Set(mapped).size).toBe(mapped.length);
    for (const [, , commands] of COMMAND_OPERATIONS) {
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) expect(command).toMatch(/^pidgen /);
    }

    // The report lists every published operation once, with the counts that match.
    const page = renderCoverage(document);
    const rows = [...page.matchAll(/^\| `(GET|POST|PUT|PATCH|DELETE)` \| `([^`]+)` \| (.+) \|$/gm)];
    const listed = new Map(rows.map((row) => [`${row[1]} ${row[2]}`, row[3]!.trim()]));
    expect(listed.size).toBe(rows.length);
    expect([...listed.keys()].sort()).toEqual([...published].sort());
    const used = [...listed.values()].filter((command) => command !== "—").length;
    expect(used).toBe(mapped.length);
    expect(page).toContain(`| Published | ${published.size} |`);
    expect(page).toContain(`| Called by a command | ${used} |`);
    expect(page).toContain(`| No command yet | ${published.size - used} |`);
  });

  it("the child-plan brief contract: optional context_artifacts on each child, at most 3 briefs of 1-8192 characters", async () => {
    const document = JSON.parse(await readFile(DOCUMENT, "utf8"));
    const schemas = document.components.schemas;
    const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

    // Both routes take the same draft, so the field is declared once, on the draft's child.
    for (const [path, method, request] of [
      ["/api/v1/tickets/{ticket_id}/child-plan/preview", "post", "ChildPlanPreviewRequest"],
      ["/api/v1/tickets/{ticket_id}/child-plan", "put", "ChildPlanApplyRequest"],
    ] as const) {
      expect(document.paths[path][method].requestBody.content["application/json"].schema).toEqual(
        ref(request),
      );
      expect(schemas[request].properties.plan).toEqual(ref("ChildPlanDraft"));
    }
    expect(schemas.ChildPlanDraft.properties.children.items).toEqual(ref("ChildPlanDraftChild"));

    // Optional: omitted means none, and a kept child's artifacts change only when it is present.
    const child = schemas.ChildPlanDraftChild;
    expect(child.required).toEqual(["title", "objective", "workflow_type"]);
    const field = child.properties.context_artifacts;
    // The server published the briefs as PlanContextArtifact, which replaces ChildPlanBrief.
    expect(field).toMatchObject({ type: "array", maxItems: 3, items: ref("PlanContextArtifact") });
    expect(schemas).not.toHaveProperty("ChildPlanBrief");
    expect(field).not.toHaveProperty("default");
    expect(field.description).toMatch(/omitted/i);
    expect(field.description).toMatch(/kept child keeps its stored ones/i);
    expect(field.description).toMatch(/replaces a kept child's briefs/i);

    // A brief: type brief, tier stage, content of 1-8192 characters, an optional reference_url.
    const brief = schemas.PlanContextArtifact;
    expect(Object.keys(brief.properties).sort()).toEqual([
      "content",
      "reference_url",
      "tier",
      "type",
    ]);
    expect([...brief.required].sort()).toEqual(["content", "tier", "type"]);
    expect(brief.properties.type).toMatchObject({ type: "string", const: "brief" });
    expect(brief.properties.tier).toMatchObject({ type: "string", const: "stage" });
    expect(brief.properties.content).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 8192,
    });
    expect(brief.properties.reference_url.anyOf).toEqual([{ type: "string" }, { type: "null" }]);

    // The preview echoes the plan as a draft, so a brief comes back in the same shape.
    expect(schemas.ChildPlanPreview.properties.plan.$ref).toBe(
      "#/components/schemas/ChildPlanDraft",
    );
    // The rejections are stated on both routes, next to the existing 422s.
    for (const [path, method] of [
      ["/api/v1/tickets/{ticket_id}/child-plan/preview", "post"],
      ["/api/v1/tickets/{ticket_id}/child-plan", "put"],
    ] as const) {
      expect(document.paths[path][method].responses["422"].description).toContain("INPUT_INVALID");
    }

    // The generated types carry the field, so the commands type-check against it.
    const types = await readFile(GENERATED, "utf8");
    expect(types).toMatch(/PlanContextArtifact: \{/);
    expect(types).toMatch(
      /context_artifacts\?: components\["schemas"\]\["PlanContextArtifact"\]\[\];/,
    );
  });

  it("src/generated/api.d.ts is current with the committed contracts/openapi.json", async () => {
    const generated = astToString(await openapiTS(DOCUMENT));
    const committed = await readFile(GENERATED, "utf8");
    expect(committed).toMatch(BANNER);
    // A mismatch means the types are stale: run `npm run contract:generate` and commit the result.
    expect(committed.replace(BANNER, "")).toBe(generated);
  });

  it("contracts/pending/ holds exactly the listed fragments", async () => {
    const listed = await readdir(PENDING_DIR).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    const files = listed.filter((file) => file.endsWith(".json")).sort();
    expect(files).toEqual(FRAGMENTS.map((name) => `${name}.json`).sort());
  });

  it("each pending fragment holds only its routes, cites nothing internal, and the published document lacks them", async () => {
    for (const name of FRAGMENTS) {
      // A route agreed with the App Service may stand in as a pending fragment until the server
      // publishes it; then it is pulled with contracts/openapi.json and the fragment is deleted.
      const pending = await fragment(name);
      const published = JSON.parse(await readFile(DOCUMENT, "utf8")) as Fragment;
      expect(pending.info.title).toMatch(/^Pidgen Public API: pending /);
      expect(operationsOf(pending).sort()).toEqual([...PENDING_ROUTES[name]!].sort());
      for (const route of PENDING_ROUTES[name]!) {
        const [method, path] = route.split(" ") as [string, string];
        if (EXTENDED_ROUTES[name]?.includes(route)) {
          // A published route the fragment extends: its reminder is the field it adds.
          expect(published.paths[path] ?? {}, route).toHaveProperty(method.toLowerCase());
        } else {
          expect(
            published.paths[path] ?? {},
            `The server publishes ${route} now: pull it with the document and delete contracts/pending/${name}.json`,
          ).not.toHaveProperty(method.toLowerCase());
        }
        // Every operation answers a 2xx with an example (or named examples, one per case) and
        // errors in the public error shape.
        const responses = pending.paths[path]![method.toLowerCase()]!["responses"] as Record<
          string,
          {
            content?: Record<
              string,
              { example?: unknown; examples?: Record<string, unknown>; schema?: unknown }
            >;
          }
        >;
        // A route that answers a file (an attachment download) states its example in the file's
        // media type instead of JSON.
        const success = Object.entries(responses).find(([status]) => /^2\d\d$/.test(status));
        const json =
          success?.[1].content?.["application/json"] ??
          Object.values(success?.[1].content ?? {})[0];
        expect(json?.example ?? Object.values(json?.examples ?? {})[0], route).toBeDefined();
        expect(responses["default"]?.content?.["application/json"]?.schema).toEqual({
          $ref: "#/components/schemas/PublicError",
        });
      }
      // The fragment is committed to a public repository like the document.
      const { findCitations } = await import("../../scripts/contract-check.mjs");
      expect(findCitations(pending)).toEqual([]);
    }
  });

  it("each pending fragment copies the published schemas it uses verbatim, and states the rest", async () => {
    const published = JSON.parse(await readFile(DOCUMENT, "utf8")) as Fragment;
    for (const name of FRAGMENTS) {
      const pending = await fragment(name);
      const schemas = pending.components.schemas;
      // Every schema the fragment names, copied or referenced from one copied, is the published one;
      // only the schemas the published document lacks are the fragment's own.
      for (const copied of COPIED_SCHEMAS[name] ?? []) {
        expect(schemas[copied], `${name}: ${copied}`).toEqual(published.components.schemas[copied]);
      }
      for (const [schema, value] of Object.entries(schemas)) {
        if (!Object.hasOwn(published.components.schemas, schema)) continue;
        const added = EXTENDED_SCHEMAS[name]?.[schema];
        if (added === undefined) {
          expect(value, `${name}: ${schema}`).toEqual(published.components.schemas[schema]);
          continue;
        }
        // An extended schema is the published one plus its added fields, none of them required.
        const own = published.components.schemas[schema] as { properties: Record<string, unknown> };
        const extended = value as { properties: Record<string, unknown>; required?: string[] };
        for (const field of added) {
          expect(
            own.properties,
            `The published ${schema} carries ${field} now: drop it from contracts/pending/${name}.json`,
          ).not.toHaveProperty(field);
          expect(extended.properties, `${name}: ${schema}.${field}`).toHaveProperty(field);
          expect(extended.required ?? [], `${name}: ${schema}.${field}`).not.toContain(field);
        }
        const properties = Object.fromEntries(
          Object.entries(extended.properties).filter(([key]) => !added.includes(key)),
        );
        expect({ ...extended, properties }, `${name}: ${schema}`).toEqual(own);
      }
    }
  });

  // AC-2fc2fc58890f: the worker enrollments fragment holds only the agreed routes and fields.
  it("the worker enrollments fragment adds install_id, the enrollment list and the withdraw, and nothing else", async () => {
    const pending = (await fragment("worker-enrollments")) as Fragment & {
      security?: unknown;
      components: { securitySchemes?: unknown };
    };
    const published = JSON.parse(await readFile(DOCUMENT, "utf8")) as Fragment;
    type Schema = {
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
      additionalProperties?: unknown;
    };
    const schemas = pending.components.schemas as Record<string, Schema>;
    expect(pending.info.title).toBe("Pidgen Public API: pending worker enrollment routes");
    expect(pending.security).toEqual([{ bearerAuth: [] }]);
    expect(pending.components.securitySchemes).toHaveProperty("bearerAuth");

    // install_id: optional, 32 lowercase hex characters, on the request, the created enrollment,
    // each worker and each listed enrollment.
    const installId = { type: "string", pattern: "^[0-9a-f]{32}$" };
    for (const schema of [
      "CreateEnrollmentRequest",
      "CreatedEnrollment",
      "WorkerResource",
      "WorkerEnrollment",
    ]) {
      expect(schemas[schema]!.properties["install_id"]!["anyOf"], schema).toEqual([
        installId,
        { type: "null" },
      ]);
      expect(schemas[schema]!.required ?? [], schema).not.toContain("install_id");
    }
    // The published request refuses unknown fields: why the create is held here.
    const request = published.components.schemas["CreateEnrollmentRequest"] as Schema;
    expect(request.additionalProperties).toBe(false);
    expect(schemas["CreateEnrollmentRequest"]!.additionalProperties).toBe(false);

    // An enrollment: CreatedEnrollment's fields without the token and install steps, plus install_id.
    const createdFields = Object.keys(schemas["CreatedEnrollment"]!.properties);
    const omitted = ["token", "install_commands", "install", "eula"];
    expect(Object.keys(schemas["WorkerEnrollment"]!.properties).sort()).toEqual(
      createdFields.filter((field) => !omitted.includes(field)).sort(),
    );
    expect(schemas["WorkerEnrollment"]!.properties).not.toHaveProperty("token");
    expect(schemas["WorkerEnrollmentListResponse"]!.properties["data"]).toEqual({
      items: { $ref: "#/components/schemas/WorkerEnrollment" },
      type: "array",
      title: "Data",
    });
    expect(schemas["WorkerEnrollmentResponse"]!.properties["data"]).toEqual({
      $ref: "#/components/schemas/WorkerEnrollment",
    });

    // The list: the caller's own, pending unless ?state= widens it.
    const list = pending.paths["/api/v1/workers/enrollments"]!["get"]!;
    expect(
      (list["parameters"] as Array<{ name: string; in: string }>).map((p) => `${p.in} ${p.name}`),
    ).toEqual(["query state"]);
    // The withdraw: the enrollment, or 404 WORKER_ENROLLMENT_NOT_FOUND.
    const withdraw = pending.paths["/api/v1/workers/enrollments/{enrollment_id}"]!["delete"]!;
    expect(JSON.stringify(withdraw["responses"])).toContain('"code":"WORKER_ENROLLMENT_NOT_FOUND"');
    expect(
      (withdraw["parameters"] as Array<{ name: string; in: string }>).map(
        (p) => `${p.in} ${p.name}`,
      ),
    ).toEqual(["path enrollment_id"]);

    // The two published routes are held as published: same body, operation id and responses' schemas.
    for (const [path, method] of [
      ["/api/v1/workers/enrollments", "post"],
      ["/api/v1/workers", "get"],
    ] as const) {
      const ours = pending.paths[path]![method]!;
      const theirs = published.paths[path]![method]!;
      expect(ours["operationId"]).toBe(theirs["operationId"]);
      expect(ours["requestBody"]).toEqual(theirs["requestBody"]);
      expect(ours["parameters"]).toEqual(theirs["parameters"]);
    }

    // Every 2xx example matches its schema in the fragment, so Prism serves what the CLI reads.
    const { schemaIssues } = await import("../../src/core/input.js");
    for (const route of PENDING_ROUTES["worker-enrollments"]!) {
      const [method, path] = route.split(" ") as [string, string];
      const responses = pending.paths[path]![method.toLowerCase()]!["responses"] as Record<
        string,
        { content?: Record<string, { example?: unknown; schema?: unknown }> }
      >;
      const [, success] = Object.entries(responses).find(([status]) => /^2\d\d$/.test(status))!;
      const json = success.content!["application/json"]!;
      expect(schemaIssues(pending as never, json.schema, json.example), route).toEqual([]);
    }
  });

  // AC-bc2d5eeb9a5f: the readiness fragment holds the readiness routes the commands send.
  it("the project readiness fragment states the readiness routes, their examples match, and the archive is gzip", async () => {
    const pending = (await fragment("project-readiness")) as Fragment & {
      security?: unknown;
      components: { securitySchemes?: unknown };
    };
    expect(pending.info.title).toBe("Pidgen Public API: pending project readiness routes");
    expect(pending.security).toEqual([{ bearerAuth: [] }]);
    expect(pending.components.securitySchemes).toHaveProperty("bearerAuth");
    const schemas = pending.components.schemas as Record<
      string,
      { properties: Record<string, Record<string, unknown>>; required?: string[] }
    >;
    // A finding's state is one of the words the report shows.
    expect(schemas["ReadinessArea"]!.properties["state"]!["enum"]).toEqual([
      "ok",
      "proposed",
      "needs_you",
      "cannot_tell",
      "pending",
    ]);
    expect(schemas["ReadinessAnswer"]!.required).toEqual(["question_id", "value"]);
    // The archive is a file, not JSON.
    const archive = pending.paths["/api/v1/projects/{project_ref}/readiness/proposal/archive"]!
      .get!["responses"] as Record<string, { content: Record<string, unknown> }>;
    expect(Object.keys(archive["200"]!.content)).toEqual(["application/gzip"]);

    // Every JSON 2xx example (and each named example) matches its schema, so Prism serves what
    // the CLI reads.
    const { schemaIssues } = await import("../../src/core/input.js");
    for (const route of PENDING_ROUTES["project-readiness"]!) {
      const [method, path] = route.split(" ") as [string, string];
      const responses = pending.paths[path]![method.toLowerCase()]!["responses"] as Record<
        string,
        {
          content?: Record<
            string,
            { example?: unknown; examples?: Record<string, { value: unknown }>; schema?: unknown }
          >;
        }
      >;
      const [, success] = Object.entries(responses).find(([status]) => /^2\d\d$/.test(status))!;
      const json = success.content!["application/json"];
      if (json === undefined) continue;
      const examples = [
        ...(json.example === undefined ? [] : [json.example]),
        ...Object.values(json.examples ?? {}).map((example) => example.value),
      ];
      expect(examples.length, route).toBeGreaterThan(0);
      for (const example of examples) {
        expect(schemaIssues(pending as never, json.schema, example), route).toEqual([]);
      }
    }
  });

  // AC-9f7dca84dddc: the doctor route answers the report the command renders, its examples the
  // fixtures under tests/fixtures/readiness/.
  it("the project readiness fragment states the doctor route, its verdicts and its named examples", async () => {
    const pending = await fragment("project-readiness");
    const schemas = pending.components.schemas as Record<
      string,
      { properties: Record<string, Record<string, unknown>>; required?: string[] }
    >;
    expect(schemas["ProjectDoctorReport"]!.properties["verdict"]!["enum"]).toEqual([
      "setup",
      "code",
      "unclear",
    ]);
    expect(schemas["DoctorGroup"]!.properties["group"]!["enum"]).toEqual([
      "setup_files",
      "workers",
      "secrets",
      "workspaces",
      "tests",
      "drift",
    ]);
    expect(schemas["DoctorCheck"]!.properties["state"]!["enum"]).toEqual([
      "ok",
      "needs_you",
      "failed",
    ]);
    expect(Object.keys(schemas["ProjectDoctorRequest"]!.properties).sort()).toEqual([
      "propose_fix",
      "since_days",
    ]);
    const doctor = pending.paths["/api/v1/projects/{project_ref}/readiness/doctor"]!.post!;
    const examples = (
      doctor["responses"] as Record<
        string,
        { content: Record<string, { examples: Record<string, { value: { data: unknown } }> }> }
      >
    )["200"]!.content["application/json"]!.examples;
    const fixtures = new URL("../fixtures/readiness/", import.meta.url);
    for (const [name, file] of [
      ["setup", "doctor-setup.json"],
      ["code", "doctor-code.json"],
      ["unclear", "doctor-unclear.json"],
      ["fix_proposed", "doctor-fix-proposed.json"],
    ] as const) {
      const expected = JSON.parse(await readFile(new URL(file, fixtures), "utf8")) as unknown;
      expect(examples[name]?.value.data, name).toEqual(expected);
    }
  });

  it("each pending fragment's src/generated/<name>.d.ts is current, and contract:generate writes it", async () => {
    for (const name of FRAGMENTS) {
      const generated = astToString(await openapiTS(new URL(`${name}.json`, PENDING_DIR)));
      const committed = await readFile(
        new URL(`../../src/generated/${name}.d.ts`, import.meta.url),
        "utf8",
      );
      expect(committed).toMatch(BANNER);
      expect(committed.replace(BANNER, "")).toBe(generated);
      const scripts = (
        JSON.parse(await readFile(PACKAGE, "utf8")) as { scripts: Record<string, string> }
      ).scripts;
      expect(scripts["contract:generate"]).toContain(
        `openapi-typescript contracts/pending/${name}.json -o src/generated/${name}.d.ts`,
      );
    }
  });

  it("the retired fragments are gone: no file, no generated types, no import, no generate step", async () => {
    const scripts = (
      JSON.parse(await readFile(PACKAGE, "utf8")) as { scripts: Record<string, string> }
    ).scripts;
    // contract:generate writes the published types, then each pending fragment's.
    expect(scripts["contract:generate"]).toBe(
      [
        "openapi-typescript contracts/openapi.json -o src/generated/api.d.ts",
        ...FRAGMENTS.map(
          (name) =>
            `openapi-typescript contracts/pending/${name}.json -o src/generated/${name}.d.ts`,
        ),
      ].join(" && "),
    );
    for (const name of Object.keys(RETIRED_FRAGMENTS)) {
      await expect(readFile(new URL(`${name}.json`, PENDING_DIR)), name).rejects.toThrow();
      await expect(
        readFile(new URL(`../../src/generated/${name}.d.ts`, import.meta.url)),
        name,
      ).rejects.toThrow();
    }
    for (const root of ["../../src/", "../../tests/", "../../scripts/"]) {
      for await (const file of sources(new URL(root, import.meta.url))) {
        const text = await readFile(file, "utf8");
        for (const name of Object.keys(RETIRED_FRAGMENTS)) {
          expect(text, file.pathname).not.toContain(`contracts/pending/${name}.json`);
          expect(text, file.pathname).not.toContain(`generated/${name}.js`);
        }
      }
    }
  });

  it("the published document carries every route the retired fragments stood in for", async () => {
    const published = JSON.parse(await readFile(DOCUMENT, "utf8")) as Fragment;
    const operations = new Set(operationsOf(published));
    for (const routes of Object.values(RETIRED_FRAGMENTS)) {
      for (const route of routes) expect(operations, route).toContain(route);
    }
    // The accept route names its parameter revision_number, as the command fills it.
    const accept =
      published.paths["/api/v1/contracts/{contract_id}/revisions/{revision_number}/accept"]![
        "post"
      ]!;
    expect((accept["parameters"] as Array<{ name: string }>).map(({ name }) => name)).toContain(
      "revision_number",
    );
    // The create carries domain_id, so a Domain Epic is validated against the published request.
    const create = published.components.schemas["CreateTicketRequest"] as {
      properties: Record<string, unknown>;
    };
    expect(create.properties).toHaveProperty("domain_id");
  });

  it("the published Domain and contract shapes are the ones the commands parse", async () => {
    const published = JSON.parse(await readFile(DOCUMENT, "utf8")) as Fragment;
    type Schema = { properties: Record<string, unknown>; required?: string[] };
    const schema = (name: string) => published.components.schemas[name] as Schema;
    // A domain counts its people under people and its Epics under epics.
    expect(schema("DomainResource").required).toEqual(expect.arrayContaining(["people", "epics"]));
    expect(schema("DomainResource").properties).not.toHaveProperty("members");
    expect([...schema("DomainPeopleCounts").required!].sort()).toEqual(["maintainers", "members"]);
    // A contract's provider is a project, or a domain's home project, and its owner a user id.
    expect([...schema("ContractProvider").required!].sort()).toEqual(
      ["domain_id", "key", "kind", "name", "project_id"].sort(),
    );
    expect(schema("ContractSummaryResource").required).toContain("owner_user_id");
    expect(schema("ContractSummaryResource").properties).not.toHaveProperty("owner");
    // A project's list has no covered; a domain's has own and coverage.
    expect([...schema("ProjectContractsResource").required!].sort()).toEqual([
      "builds_against",
      "provides",
    ]);
    expect([...schema("DomainContractsResource").required!].sort()).toEqual([
      "builds_against",
      "coverage",
      "own",
    ]);
    // A publish names its outcome and why a change is breaking; --check reads change and
    // change_reason.
    expect(schema("ContractPublishResult").required).toEqual(
      expect.arrayContaining(["outcome", "change", "change_reason", "removed", "still_pending"]),
    );
    // A contract read states each operation's state under operation_states.
    expect(schema("ContractDetail").properties).toHaveProperty("operation_states");
    // A submission answers the Request and what to attach evidence to; a reply its entry.
    expect([...schema("RequestReceived").required!].sort()).toEqual(
      ["entry_id", "occurrence_id", "outcome", "request"].sort(),
    );
    expect(schema("RequestEntryWritten").required).toEqual(
      expect.arrayContaining(["request", "entry_id"]),
    );
    // A requester may be null; its contact is withheld from a caller without request.triage.
    expect(schema("RequesterInput").properties).toHaveProperty("contact");
    expect(schema("RequestRequester").properties).toHaveProperty("contact");
  });

  it("CI regenerates the types and fails when the committed file differs", async () => {
    const workflow = parse(await readFile(CI, "utf8")) as {
      jobs: Record<string, { steps: Array<{ run?: string }> }>;
    };
    const steps = workflow.jobs["test"]?.steps.map((step) => step.run ?? "") ?? [];
    const generate = steps.findIndex((run) => run.includes("npm run contract:generate"));
    expect(generate).toBeGreaterThanOrEqual(0);
    expect(steps[generate]).toMatch(/git diff --exit-code -- src\/generated/);
    expect(steps[generate]!.indexOf("git diff")).toBeGreaterThan(
      steps[generate]!.indexOf("npm run contract:generate"),
    );
  });
});
