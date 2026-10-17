import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findCitations,
  pruneRetired,
  pullContract,
  RETIRED_OPERATIONS,
} from "../../scripts/contract-check.mjs";

const BASE = "https://pidgen.example.com";
const PREVIOUS = '{ "openapi": "3.1.0", "paths": {} }\n';

function serve(document: unknown, status = 200) {
  const requested: string[] = [];
  const fetch = async (url: URL) => {
    requested.push(url.toString());
    return { ok: status >= 200 && status < 300, status, json: async () => document };
  };
  return { fetch, requested };
}

function cleanDocument() {
  return {
    openapi: "3.1.0",
    info: { title: "Pidgen public API", version: "1.0.0" },
    paths: {
      "/api/v1/tickets": {
        get: {
          summary: "List tickets",
          description: "Returns tickets, e.g. PIDGEN-12, filtered by status.",
          responses: { "200": { description: "OK" } },
        },
      },
      "/api/v1/tickets/{ticket_id}": {
        get: {
          summary: "Show a ticket",
          parameters: [{ name: "ticket_id", in: "path", example: "PIDGEN-12" }],
          responses: { "200": { description: "OK" } },
        },
      },
    },
  };
}

/** The legacy Epic routes the App Service is retiring (Epics are Tickets). */
const RETIRED_PATHS = [
  "/api/v1/epics",
  "/api/v1/epics/{epic_id}",
  "/api/v1/epics/{epic_id}/dag",
  "/api/v1/epics/{epic_id}/dag/edges",
  "/api/v1/tickets/{ticket_id}/epic",
];

/** The component schemas only the retired operations use. */
const RETIRED_SCHEMAS = [
  "CreateEpicRequest",
  "UpdateEpicRequest",
  "AddEdgeRequest",
  "EpicCreateResponse",
  "EpicListResponse",
  "EpicResponse",
  "EpicDagResponse",
  "TicketEpicMoveRequest",
  "TicketEpicMoveResponse",
];

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: string) => ({ content: { "application/json": { schema: ref(name) } } });

/** A document that still publishes the retired Epic routes beside current ones. */
function documentWithRetiredRoutes() {
  return {
    openapi: "3.1.0",
    info: { title: "Pidgen public API", version: "1.0.0" },
    paths: {
      "/api/v1/tickets": {
        get: { responses: { "200": json("TicketList"), "422": json("PublicError") } },
      },
      "/api/v1/domains/{domain_id}/epics": {
        get: { responses: { "200": json("DomainEpicList") } },
      },
      "/api/v1/epics": {
        get: {
          // The server's own note on a retired route may cite its decision record.
          description: "Deprecated: Epics are Tickets (ADR-147).",
          responses: { "200": json("EpicListResponse"), "422": json("PublicError") },
        },
        post: {
          requestBody: json("CreateEpicRequest"),
          responses: { "201": json("EpicCreateResponse") },
        },
      },
      "/api/v1/tickets/{ticket_id}/epic": {
        post: {
          requestBody: json("TicketEpicMoveRequest"),
          responses: { "200": json("TicketEpicMoveResponse"), "422": json("PublicError") },
        },
      },
    },
    components: {
      schemas: {
        PublicError: { type: "object" },
        TicketList: { type: "object" },
        DomainEpicList: { type: "object" },
        // Kept although nothing refers to it: only schemas the retired routes used are left out.
        Unreferenced: { type: "object" },
        EpicListResponse: { type: "array", items: ref("EpicResponse") },
        EpicResponse: { type: "object", properties: { status: ref("EpicStatus") } },
        EpicStatus: { type: "string", enum: ["open", "done"] },
        CreateEpicRequest: { type: "object" },
        EpicCreateResponse: { type: "object", properties: { epic: ref("EpicResponse") } },
        TicketEpicMoveRequest: { type: "object" },
        TicketEpicMoveResponse: { type: "object" },
      },
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    },
  };
}

describe("contract pull", () => {
  let dir: string;
  let file: string;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pidgen-contract-pull-"));
    file = join(dir, "openapi.json");
    await writeFile(file, PREVIOUS);
    out = [];
    err = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function pull(document: unknown, status = 200) {
    const { fetch, requested } = serve(document, status);
    const code = pullContract({
      base: BASE,
      file,
      fetch,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { code, requested };
  }

  it("refuses a citation with exit 1 and the JSON pointer of each match", async () => {
    const document = cleanDocument();
    document.info = {
      title: "Pidgen public API",
      version: "1.0.0",
      description: "Follows ADR-7 and the PRD §4.2.",
    } as typeof document.info;
    document.paths["/api/v1/tickets"].get.description = "See Decision 12 and slice 007/S3.";
    (document.paths["/api/v1/tickets/{ticket_id}"].get as Record<string, unknown>)["x-source"] =
      "app/routes/tickets.py";

    const { code } = pull(document);
    expect(await code).toBe(1);

    const listed = err.join("\n");
    for (const [pointer, text] of [
      ["/info/description", "ADR-7"],
      ["/info/description", "PRD"],
      ["/info/description", "§"],
      ["/paths/~1api~1v1~1tickets/get/description", "Decision 12"],
      ["/paths/~1api~1v1~1tickets/get/description", "007/S3"],
      ["/paths/~1api~1v1~1tickets~1{ticket_id}/get/x-source", "app/routes/tickets.py"],
    ]) {
      expect(listed).toContain(`${pointer}: ${JSON.stringify(text)}`);
    }
    expect(err[0]).toMatch(/Refused: .* 6 place\(s\)/);
    expect(out).toEqual([]);
  });

  it("refuses a citation found in array items and member names", () => {
    const found = findCitations({
      tags: [{ name: "tickets" }, { name: "Per ADR-3" }],
      paths: { "/legacy.py": {} },
    });
    expect(found).toEqual([
      { pointer: "/tags/1/name", kind: "ADR citation", text: "ADR-3" },
      { pointer: "/paths/~1legacy.py", kind: "source path", text: "/legacy.py" },
    ]);
  });

  it("writes nothing when the pull is refused", async () => {
    const document = cleanDocument();
    document.paths["/api/v1/tickets"].get.summary = "List tickets (ADR-1)";
    const { code } = pull(document);
    expect(await code).toBe(1);
    expect(await readFile(file, "utf8")).toBe(PREVIOUS);
  });

  it("writes a clean document and reports its path count", async () => {
    const document = cleanDocument();
    const { code, requested } = pull(document);
    expect(await code).toBe(0);
    expect(requested).toEqual([`${BASE}/api/v1/openapi.json`]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(document);
    expect(out[0]).toBe(`${file} updated from ${BASE} (2 paths).`);
    expect(err).toEqual([]);
  });

  it("does not refuse ticket keys given as example keys", async () => {
    expect(findCitations(cleanDocument())).toEqual([]);
    expect(findCitations({ description: "Ticket key, e.g. PIDGEN-12 or PROJ-3." })).toEqual([]);
    const { code } = pull(cleanDocument());
    expect(await code).toBe(0);
  });

  it("writes nothing when the server fails or the body is not an OpenAPI document", async () => {
    expect(await pull(cleanDocument(), 503).code).toBe(1);
    expect(await pull({ hello: "world" }).code).toBe(1);
    expect(await readFile(file, "utf8")).toBe(PREVIOUS);
  });

  it("leaves out the retired Epic routes and the schemas only they use, and says which", async () => {
    const { code } = pull(documentWithRetiredRoutes());
    expect(await code).toBe(0);
    const written = JSON.parse(await readFile(file, "utf8")) as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
    };
    expect(Object.keys(written.paths)).toEqual([
      "/api/v1/tickets",
      "/api/v1/domains/{domain_id}/epics",
    ]);
    expect(Object.keys(written.components.schemas).sort()).toEqual(
      ["DomainEpicList", "PublicError", "TicketList", "Unreferenced"].sort(),
    );
    expect(written.components.securitySchemes).toEqual({
      bearer: { type: "http", scheme: "bearer" },
    });
    expect(out[0]).toBe(`${file} updated from ${BASE} (2 paths).`);
    expect(out).toContain(
      "Left out 3 retired operation(s): GET /api/v1/epics, POST /api/v1/epics, " +
        "POST /api/v1/tickets/{ticket_id}/epic.",
    );
    expect(out).toContain(
      "Left out 7 schema(s) only they used: CreateEpicRequest, EpicCreateResponse, " +
        "EpicListResponse, EpicResponse, EpicStatus, TicketEpicMoveRequest, TicketEpicMoveResponse.",
    );
    expect(err).toEqual([]);
  });

  it("says nothing about retired routes when the server no longer publishes them", async () => {
    const { code } = pull(cleanDocument());
    expect(await code).toBe(0);
    expect(out.join("\n")).not.toMatch(/Left out/);
  });

  it("retires exactly the eight legacy Epic operations", () => {
    expect(RETIRED_OPERATIONS).toEqual([
      ["get", "/api/v1/epics"],
      ["post", "/api/v1/epics"],
      ["get", "/api/v1/epics/{epic_id}"],
      ["patch", "/api/v1/epics/{epic_id}"],
      ["get", "/api/v1/epics/{epic_id}/dag"],
      ["post", "/api/v1/epics/{epic_id}/dag/edges"],
      ["delete", "/api/v1/epics/{epic_id}/dag/edges"],
      ["post", "/api/v1/tickets/{ticket_id}/epic"],
    ]);
  });

  it("keeps a current operation that shares a path with a retired one", () => {
    const document = documentWithRetiredRoutes();
    (document.paths["/api/v1/epics"] as Record<string, unknown>).put = {
      responses: { "200": json("EpicResponse") },
    };
    const { document: pruned, operations, schemas } = pruneRetired(document);
    expect(Object.keys(pruned.paths["/api/v1/epics"] as object)).toEqual(["put"]);
    expect(operations).toEqual([
      "GET /api/v1/epics",
      "POST /api/v1/epics",
      "POST /api/v1/tickets/{ticket_id}/epic",
    ]);
    expect(schemas).not.toContain("EpicResponse");
    expect(schemas).not.toContain("EpicStatus");
    // The input document is not changed.
    expect(Object.keys(document.paths["/api/v1/epics"])).toEqual(["get", "post", "put"]);
  });

  it("commits a contract without the retired Epic routes or the schemas only they used", async () => {
    const committed = JSON.parse(await readFile("contracts/openapi.json", "utf8")) as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    const paths = Object.keys(committed.paths);
    for (const retired of RETIRED_PATHS) expect(paths).not.toContain(retired);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/api/v1/domains/{domain_id}/epics",
        "/api/v1/projects/{project_id}/epics",
      ]),
    );
    const schemas = Object.keys(committed.components.schemas);
    for (const retired of RETIRED_SCHEMAS) expect(schemas).not.toContain(retired);
    // Nothing is left that only the retired routes used: pruning again changes nothing.
    const again = pruneRetired(committed);
    expect(again.operations).toEqual([]);
    expect(again.schemas).toEqual([]);
  });

  it("accepts the committed contract", async () => {
    const text = await readFile("contracts/openapi.json", "utf8");
    const committed = JSON.parse(text) as { paths: Record<string, unknown> };
    expect(findCitations(committed)).toEqual([]);
    // It is the App Service's published document, not the empty placeholder.
    expect(Object.keys(committed.paths)).toEqual(
      expect.arrayContaining(["/api/v1/tickets", "/api/v1/projects", "/api/v1/health"]),
    );
    expect(text).not.toMatch(/localhost|127\.0\.0\.1/);
  });
});
