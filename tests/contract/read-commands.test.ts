import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, testContext, type TestContext } from "../support/context.js";
import { useMockServer } from "../support/mock-server.js";

// The read commands against Prism mocking the committed contracts/openapi.json: Prism checks each
// request against the document and generates responses from its schemas.

const server = useMockServer();

interface Body {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  meta: Record<string, unknown>;
}

async function setup() {
  const urls: string[] = [];
  const ctx = await testContext({
    env: {
      PIDGEN_API_URL: server().url,
      PIDGEN_TOKEN: "pidgen_pat_fake_contract_token",
      PIDGEN_ACCOUNT: "ACC-EXAMPLE",
    },
    fetch: (input, init) => {
      urls.push(String(input));
      return globalThis.fetch(input, init);
    },
  });
  return { ctx, urls };
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(["--timeout", "10", ...argv], ctx);
  expect(ctx.out).toHaveLength(1);
  return { code, body: envelope(ctx) as unknown as Body };
}

describe("read commands against the Prism mock of the committed document", () => {
  it.each([undefined, "me", "claimable", "following", "all"])(
    "pidgen review attention addressee %s uses the documented query",
    async (addressee) => {
      const { ctx, urls } = await setup();
      const { code, body } = await run(
        ctx,
        "review",
        "attention",
        ...(addressee === undefined ? [] : ["--addressee", addressee]),
      );
      expect(code).toBe(ExitCode.Ok);
      expect(body).toMatchObject({
        ok: true,
        error: null,
        data: {
          findings: expect.any(Array),
          following: expect.any(Array),
          addressee: expect.any(String),
          counts: {
            me: expect.any(Number),
            claimable: expect.any(Number),
            following: expect.any(Number),
            all: expect.any(Number),
          },
        },
      });
      expect(urls).toEqual([
        `${server().url}/api/v1/attention${addressee === undefined ? "" : `?addressee=${addressee}`}`,
      ]);
    },
  );

  it("pidgen project list returns the documented projects", async () => {
    const { ctx, urls } = await setup();
    const { code, body } = await run(ctx, "project", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null, meta: { account: "ACC-EXAMPLE" } });
    expect(Array.isArray(body.data)).toBe(true);
    for (const project of body.data as unknown[]) {
      expect(project).toEqual(
        expect.objectContaining({ id: expect.any(String), merge_policy: expect.anything() }),
      );
    }
    expect(urls).toEqual([`${server().url}/api/v1/projects`]);
  });

  it("pidgen project show returns one documented project with its merge policy", async () => {
    const { ctx, urls } = await setup();
    const { code, body } = await run(ctx, "project", "show", "Pidgen");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(
      expect.objectContaining({ id: expect.any(String), merge_policy: expect.anything() }),
    );
    expect(urls).toEqual([`${server().url}/api/v1/projects/Pidgen`]);
  });

  it("pidgen ticket types returns the documented workflow types", async () => {
    const { ctx, urls } = await setup();
    const { code, body } = await run(ctx, "ticket", "types");
    expect(code).toBe(ExitCode.Ok);
    expect(Array.isArray(body.data)).toBe(true);
    for (const type of body.data as unknown[]) {
      expect(type).toEqual(
        expect.objectContaining({
          key: expect.any(String),
          label: expect.any(String),
          workflow_name: expect.any(String),
          ticket_count: expect.any(Number),
        }),
      );
    }
    expect(urls).toEqual([`${server().url}/api/v1/workflow-types`]);
  });

  it("pidgen ticket list returns the documented tickets, with its filters as query parameters", async () => {
    const { ctx, urls } = await setup();
    const { code, body } = await run(
      ctx,
      "ticket",
      "list",
      "--stage",
      "backlog",
      "--project",
      "proj-example",
      "--query",
      "login",
      "--intervention",
      "clarification_needed",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null, meta: { account: "ACC-EXAMPLE" } });
    expect(Array.isArray(body.data)).toBe(true);
    for (const ticket of body.data as unknown[]) {
      expect(ticket).toEqual(
        expect.objectContaining({ ticket_key: expect.any(String), stage: expect.any(String) }),
      );
    }
    expect(urls.length).toBeGreaterThanOrEqual(1);
    const first = new URL(urls[0] ?? "");
    expect(first.pathname).toBe("/api/v1/tickets");
    expect(Object.fromEntries(first.searchParams)).toEqual({
      stage: "backlog",
      project_id: "proj-example",
      q: "login",
      intervention: "clarification_needed",
      page: "1",
      per_page: "100",
    });
  });

  it("pidgen ticket show returns one documented ticket with its prerequisites", async () => {
    const { ctx, urls } = await setup();
    const { code, body } = await run(ctx, "ticket", "show", "PIDGEN-12");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(
      expect.objectContaining({
        ticket_key: expect.any(String),
        effective_owner: expect.objectContaining({ source: expect.any(String) }),
        viewer_following: expect.any(Boolean),
        prerequisites: expect.objectContaining({
          ready: expect.any(Boolean),
          blocking_prerequisites: expect.any(Array),
        }),
      }),
    );
    expect(body.data).toHaveProperty("owner_user_id");
    expect(body.data).toHaveProperty("viewer_following_source");
    expect(urls).toEqual([
      `${server().url}/api/v1/tickets/PIDGEN-12`,
      `${server().url}/api/v1/tickets/PIDGEN-12/prerequisites`,
    ]);
  });

  it("pidgen epic list asks GET /tickets for kind=epic, with --project as project_id", async () => {
    const { ctx, urls } = await setup();
    const { code, body } = await run(ctx, "epic", "list", "--project", "proj-example");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null, meta: { account: "ACC-EXAMPLE" } });
    expect(Array.isArray(body.data)).toBe(true);
    for (const epic of body.data as unknown[]) {
      expect(epic).toEqual(expect.objectContaining({ ticket_key: expect.any(String) }));
    }
    expect(urls).toEqual([
      `${server().url}/api/v1/tickets?project_id=proj-example&kind=epic&page=1&per_page=100`,
    ]);
  });

  it("pidgen ticket list --kind epic sends kind=epic", async () => {
    const { ctx, urls } = await setup();
    const { code } = await run(ctx, "ticket", "list", "--kind", "epic");
    expect(code).toBe(ExitCode.Ok);
    expect(urls).toEqual([`${server().url}/api/v1/tickets?kind=epic&page=1&per_page=100`]);
  });

  it("pidgen ticket show --kind reads the ticket and its prerequisites when the kind matches", async () => {
    // The mock answers the document's default ticket, a task.
    const { ctx, urls } = await setup();
    const { code, body } = await run(ctx, "ticket", "show", "PIDGEN-12", "--kind", "task");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(
      expect.objectContaining({ kind: "task", prerequisites: expect.anything() }),
    );
    expect(urls).toEqual([
      `${server().url}/api/v1/tickets/PIDGEN-12`,
      `${server().url}/api/v1/tickets/PIDGEN-12/prerequisites`,
    ]);
  });

  it("pidgen epic show reads GET /tickets/{key} and refuses a ticket that is not an Epic", async () => {
    const { ctx, urls } = await setup();
    const { code, body } = await run(ctx, "epic", "show", "PIDGEN-12");
    expect(code).toBe(ExitCode.NotFound);
    expect(body.error).toMatchObject({
      code: "TICKET_KIND_MISMATCH",
      details: { ticket: "PIDGEN-12", kind: "task", expected_kind: "epic" },
    });
    expect(urls).toEqual([`${server().url}/api/v1/tickets/PIDGEN-12`]);
  });

  it("pidgen epic dag show returns the documented dependency graph", async () => {
    const { ctx, urls } = await setup();
    const { code, body } = await run(ctx, "epic", "dag", "show", "PIDGEN-12");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(
      expect.objectContaining({
        ticket_key: expect.any(String),
        nodes: expect.any(Array),
        edges: expect.any(Array),
        pieces: expect.any(Array),
      }),
    );
    expect(urls).toEqual([`${server().url}/api/v1/tickets/PIDGEN-12/dependencies/graph`]);
  });

  it("pidgen ticket dep list returns the documented dependencies in both directions", async () => {
    const { ctx, urls } = await setup();
    const { code, body } = await run(ctx, "ticket", "dep", "list", "PIDGEN-3");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(
      expect.objectContaining({
        ticket_key: expect.any(String),
        blocked_by: expect.any(Array),
        blocks: expect.any(Array),
        inherited_blocked_by: expect.any(Array),
      }),
    );
    expect(urls).toEqual([`${server().url}/api/v1/tickets/PIDGEN-3/dependencies`]);
  });
  it("pidgen run list returns the documented runs of a ticket", async () => {
    const { ctx, urls } = await setup();
    const { code, body } = await run(ctx, "run", "list", "PIDGEN-3");
    expect(code).toBe(ExitCode.Ok);
    expect(Array.isArray(body.data)).toBe(true);
    for (const item of body.data as unknown[]) {
      expect(item).toEqual(
        expect.objectContaining({
          workflow_run_id: expect.any(String),
          attempt_number: expect.any(Number),
          liveness: expect.anything(),
        }),
      );
    }
    expect(urls).toEqual([`${server().url}/api/v1/tickets/PIDGEN-3/runs`]);
  });

  it("pidgen run show returns the documented run with its nodes", async () => {
    const { ctx, urls } = await setup();
    const { code, body } = await run(ctx, "run", "show", "WFR-1");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(
      expect.objectContaining({
        workflow_run_id: expect.any(String),
        liveness: expect.anything(),
        nodes: expect.any(Array),
      }),
    );
    expect(urls).toEqual([`${server().url}/api/v1/runs/WFR-1`]);
  });

  it("pidgen run node-output returns the documented node of a run", async () => {
    const { ctx, urls } = await setup();
    const { code, body } = await run(ctx, "run", "node-output", "WFR-1", "implement");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(
      expect.objectContaining({ node_id: expect.any(String), attempts: expect.any(Array) }),
    );
    expect(urls).toEqual([`${server().url}/api/v1/runs/WFR-1/nodes/implement`]);
  });
});
