import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, testContext, type TestContext } from "../support/context.js";
import { useMockServer } from "../support/mock-server.js";

// The ticket write commands against Prism mocking the committed contracts/openapi.json: Prism
// refuses a request whose body does not match the document, so a success here means the CLI sent
// a body the document accepts.

const server = useMockServer();

interface Body {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  meta: Record<string, unknown>;
}

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

/** Asks Prism to answer requests of `method` with the document's response for `status`. */
interface Prefer {
  method: string;
  status: number;
}

async function setup(prefer?: Prefer) {
  const sent: Sent[] = [];
  const ctx = await testContext({
    env: {
      PIDGEN_API_URL: server().url,
      PIDGEN_TOKEN: "pidgen_pat_fake_contract_token",
      PIDGEN_ACCOUNT: "ACC-EXAMPLE",
    },
    fetch: (input, init) => {
      const text = init?.body;
      const method = init?.method ?? "GET";
      sent.push({
        url: String(input),
        method,
        body: typeof text === "string" ? (JSON.parse(text) as unknown) : undefined,
      });
      if (prefer?.method !== method) return globalThis.fetch(input, init);
      const headers = {
        ...(init?.headers as Record<string, string>),
        prefer: `code=${prefer.status}`,
      };
      return globalThis.fetch(input, { ...init, headers });
    },
  });
  return { ctx, sent };
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(["--timeout", "10", ...argv], ctx);
  expect(ctx.out).toHaveLength(1);
  return { code, body: envelope(ctx) as unknown as Body };
}

describe("ticket write commands against the Prism mock of the committed document", () => {
  it.each([[["--user", "user-example"]], [["--clear"]]])(
    "pidgen ticket owner %j sends the current version",
    async (flags) => {
      const { ctx, sent } = await setup();
      const { code, body } = await run(
        ctx,
        "ticket",
        "owner",
        "PIDGEN-12",
        ...flags,
        "--reason",
        "Owner change",
      );
      expect(code).toBe(ExitCode.Ok);
      expect(body).toMatchObject({
        ok: true,
        error: null,
        data: {
          ticket_id: expect.any(String),
          version: expect.any(Number),
          effective_owner: { source: expect.any(String) },
        },
      });
      expect(sent.map((call) => [call.method, call.url])).toEqual([
        ["GET", `${server().url}/api/v1/tickets/PIDGEN-12`],
        ["PUT", `${server().url}/api/v1/tickets/PIDGEN-12/owner`],
      ]);
      expect(sent[1]?.body).toEqual({
        version: expect.any(Number),
        owner_user_id: flags[0] === "--clear" ? null : "user-example",
        reason: "Owner change",
      });
    },
  );

  it.each([
    ["follow", true],
    ["unfollow", false],
  ])("pidgen ticket %s sends the following state", async (verb, following) => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "ticket", String(verb), "PIDGEN-12");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({
      ok: true,
      error: null,
      data: { ticket_id: expect.any(String), following: expect.any(Boolean) },
    });
    expect(body.data).toHaveProperty("source");
    expect(sent).toEqual([
      {
        method: "PUT",
        url: `${server().url}/api/v1/tickets/PIDGEN-12/following`,
        body: { following },
      },
    ]);
  });

  it("pidgen ticket create sends the template's body and returns the documented ticket", async () => {
    const { ctx, sent } = await setup();
    expect((await run(ctx, "ticket", "template")).code).toBe(ExitCode.Ok);
    const { code, body } = await run(ctx, "ticket", "create", "-f", "ticket.yaml");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null, meta: { account: "ACC-EXAMPLE" } });
    expect(body.data).toEqual(expect.objectContaining({ ticket_key: expect.any(String) }));
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["POST", `${server().url}/api/v1/tickets`],
    ]);
  });

  it("pidgen ticket edit sends the read version with the changed fields", async () => {
    const { ctx, sent } = await setup();
    await writeFile(join(ctx.cwd, "edit.yaml"), "priority: 2\n");
    const { code, body } = await run(ctx, "ticket", "edit", "PIDGEN-12", "-f", "edit.yaml");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    expect(body.data).toEqual(
      expect.objectContaining({ ticket_key: expect.any(String), admission: expect.anything() }),
    );
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${server().url}/api/v1/tickets/PIDGEN-12`],
      ["PATCH", `${server().url}/api/v1/tickets/PIDGEN-12`],
    ]);
    expect(sent[1]?.body).toEqual({ version: expect.any(Number), priority: 2 });
  });

  it("pidgen ticket edit sends a file naming only title with the read version, in a body the document accepts", async () => {
    const { ctx, sent } = await setup();
    await writeFile(join(ctx.cwd, "edit.yaml"), "title: A clearer title\n");
    const { code, body } = await run(ctx, "ticket", "edit", "PIDGEN-12", "-f", "edit.yaml");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${server().url}/api/v1/tickets/PIDGEN-12`],
      ["PATCH", `${server().url}/api/v1/tickets/PIDGEN-12`],
    ]);
    expect(sent[1]?.body).toEqual({ version: expect.any(Number), title: "A clearer title" });
  });

  it("pidgen ticket edit prints the documented meta, planning_restarted included, in data.admission", async () => {
    const { ctx } = await setup();
    await writeFile(join(ctx.cwd, "edit.yaml"), "title: A clearer title\n");
    const { body } = await run(ctx, "ticket", "edit", "PIDGEN-12", "-f", "edit.yaml");
    expect(body.data).toMatchObject({
      admission: {
        root_ticket_id: expect.any(String),
        admission_invalidated: expect.any(Boolean),
        root_stage: expect.any(String),
        plan_revised: expect.any(Boolean),
        review_required: expect.any(Boolean),
        planning_restarted: expect.any(Boolean),
      },
    });
  });

  it("pidgen ticket edit refuses a blank title before the server sees it", async () => {
    const { ctx, sent } = await setup();
    await writeFile(join(ctx.cwd, "edit.yaml"), 'title: "   "\n');
    const { code, body } = await run(ctx, "ticket", "edit", "PIDGEN-12", "-f", "edit.yaml");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, error: { code: "INPUT_INVALID" } });
    expect(sent).toEqual([]);
  });

  it("pidgen ticket edit reports the document's 409 refusal as a conflict, exit 5", async () => {
    const { ctx, sent } = await setup({ method: "PATCH", status: 409 });
    await writeFile(join(ctx.cwd, "edit.yaml"), "title: A clearer title\n");
    const { code, body } = await run(ctx, "ticket", "edit", "PIDGEN-12", "-f", "edit.yaml");
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: expect.any(String), details: { status: 409 } },
    });
    expect(sent.map((call) => call.method)).toEqual(["GET", "PATCH"]);
  });

  it("pidgen ticket edit sends team_member_id with the read version, in a body the document accepts", async () => {
    const { ctx, sent } = await setup();
    await writeFile(join(ctx.cwd, "edit.yaml"), "priority: 2\nteam_member_id: AGENT-EXAMPLE\n");
    const { code, body } = await run(ctx, "ticket", "edit", "PIDGEN-12", "-f", "edit.yaml");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${server().url}/api/v1/tickets/PIDGEN-12`],
      ["PATCH", `${server().url}/api/v1/tickets/PIDGEN-12`],
    ]);
    expect(sent[1]?.body).toEqual({
      version: expect.any(Number),
      priority: 2,
      team_member_id: "AGENT-EXAMPLE",
    });
  });

  it("root creation with an Agent ID matches the committed provider contract", async () => {
    const { ctx, sent } = await setup();
    await writeFile(
      join(ctx.cwd, "ticket.yaml"),
      "title: A root\nobjective: Deliver an outcome\nproject_id: EXAMPLE\nteam_member_id: AGENT-EXAMPLE\n",
    );
    const { code, body } = await run(ctx, "ticket", "create", "-f", "ticket.yaml");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({
      title: "A root",
      objective: "Deliver an outcome",
      project_id: "EXAMPLE",
      team_member_id: "AGENT-EXAMPLE",
    });
  });

  it("pidgen plan apply sends a child Agent ID in a body Prism accepts, and refuses a null one before Prism", async () => {
    const { ctx, sent } = await setup();
    const children = [
      {
        key: "new",
        title: "New child",
        objective: "Deliver a behavior",
        workflow_type: "implementation",
        team_member_id: "AGENT-EXAMPLE-A",
      },
      {
        plan_item_id: "item-kept",
        title: "Kept child",
        objective: "Extend a behavior",
        workflow_type: "implementation",
      },
    ];
    await writeFile(
      join(ctx.cwd, "assigned.json"),
      JSON.stringify({ children: [{ ...children[0], team_member_id: null }] }),
    );
    const refused = await run(ctx, "plan", "apply", "PIDGEN-12", "-f", "assigned.json");
    expect(refused.code).toBe(ExitCode.Usage);
    expect(refused.body).toMatchObject({ ok: false, error: { code: "INPUT_INVALID" } });
    expect(sent).toEqual([]);

    await writeFile(join(ctx.cwd, "plan.json"), JSON.stringify({ children }));
    const { code, body } = await run(ctx, "plan", "apply", "PIDGEN-12", "-f", "plan.json");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["POST", `${server().url}/api/v1/tickets/PIDGEN-12/child-plan/preview`],
    ]);
    expect(sent[0]?.body).toEqual({ plan: { children } });
  });

  it("pidgen plan apply sends briefs, inline and from a file, as a body Prism accepts, and refuses a bad brief before Prism", async () => {
    const { ctx, sent } = await setup();
    const brief = {
      type: "brief",
      tier: "stage",
      content: "Files: src/a.ts. Test: tests/a.test.ts.",
    };
    await mkdir(join(ctx.cwd, "plans"));
    await writeFile(join(ctx.cwd, "plans", "second.md"), "Copy the pattern in src/b.ts.\n");
    const children = [
      {
        key: "new",
        title: "New child",
        objective: "Deliver a behavior",
        workflow_type: "implementation",
        context_artifacts: [brief, { ...brief, reference_url: "https://example.com/a" }],
      },
      {
        plan_item_id: "item-kept",
        title: "Kept child",
        objective: "Extend a behavior",
        workflow_type: "implementation",
        brief_file: "second.md",
      },
    ];
    await writeFile(join(ctx.cwd, "plans", "plan.json"), JSON.stringify({ children }));
    const previewed = await run(ctx, "plan", "apply", "PIDGEN-12", "-f", "plans/plan.json");
    expect(previewed.code).toBe(ExitCode.Ok);
    expect(previewed.body).toMatchObject({ ok: true, error: null });
    const kept = { ...children[1] } as Record<string, unknown>;
    delete kept["brief_file"];
    const expected = {
      plan: {
        children: [
          children[0],
          {
            ...kept,
            context_artifacts: [
              { type: "brief", tier: "stage", content: "Copy the pattern in src/b.ts.\n" },
            ],
          },
        ],
      },
    };
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["POST", `${server().url}/api/v1/tickets/PIDGEN-12/child-plan/preview`],
    ]);
    expect(sent[0]?.body).toEqual(expected);

    // A fourth brief, another tier and an oversized brief_file never reach the server.
    sent.length = 0;
    const bad = [
      { context_artifacts: [brief, brief, brief, brief] },
      { context_artifacts: [{ ...brief, tier: "reference" }] },
      { brief_file: "oversized.md" },
    ];
    await writeFile(join(ctx.cwd, "oversized.md"), "x".repeat(8193));
    for (const extra of bad) {
      const plan = { children: [{ ...children[0], context_artifacts: undefined, ...extra }] };
      await writeFile(join(ctx.cwd, "bad.json"), JSON.stringify(plan));
      const refused = await run(ctx, "plan", "apply", "PIDGEN-12", "-f", "bad.json");
      expect(refused.code).toBe(ExitCode.Usage);
      expect(refused.body).toMatchObject({ ok: false, error: { code: "INPUT_INVALID" } });
    }
    expect(sent).toEqual([]);
  });

  it("Prism enforces the brief contract on both child-plan routes: another type or tier, a fourth item and oversized content are 422", async () => {
    const brief = { type: "brief", tier: "stage", content: "A brief." };
    const child = { title: "A child", objective: "An outcome", workflow_type: "implementation" };
    const post = async (method: string, path: string, context_artifacts: unknown) => {
      const plan = { children: [{ ...child, context_artifacts }] };
      const body =
        method === "PUT"
          ? { plan, preview_digest: "sha256:preview-1", idempotency_key: "key-1" }
          : { plan };
      return globalThis.fetch(`${server().url}/api/v1/tickets/PIDGEN-12/child-plan${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer pidgen_pat_fake_contract_token",
        },
        body: JSON.stringify(body),
      });
    };
    for (const [method, path] of [
      ["POST", "/preview"],
      ["PUT", ""],
    ] as const) {
      expect((await post(method, path, [brief])).status).toBeLessThan(300);
      expect((await post(method, path, [])).status).toBeLessThan(300);
      for (const refused of [
        [{ ...brief, type: "incident_link" }],
        [{ ...brief, tier: "reference" }],
        [brief, brief, brief, brief],
        [{ ...brief, content: "x".repeat(8193) }],
        [{ ...brief, content: "" }],
      ]) {
        expect((await post(method, path, refused)).status).toBe(422);
      }
    }
  });

  it("pidgen epic create sends POST /tickets with kind epic, a body the document accepts", async () => {
    const { ctx, sent } = await setup();
    await writeFile(
      join(ctx.cwd, "epic.yaml"),
      [
        "title: Sign-in",
        "description: Everything people need to sign in.",
        "project_id: Pidgen",
        "branch_mode: create_new",
        "feature_branch: epic/sign-in",
        "target_date: 2026-12-01T00:00:00Z",
        "merge_policy: manual",
        "",
      ].join("\n"),
    );
    const { code, body } = await run(ctx, "epic", "create", "-f", "epic.yaml");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null, meta: { account: "ACC-EXAMPLE" } });
    expect(body.data).toEqual(expect.objectContaining({ ticket_key: expect.any(String) }));
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["POST", `${server().url}/api/v1/tickets`],
    ]);
    expect(sent[0]?.body).toMatchObject({ kind: "epic", title: "Sign-in" });
  });

  it("pidgen ticket create --kind epic sends the same body as epic create", async () => {
    const { ctx, sent } = await setup();
    await writeFile(join(ctx.cwd, "epic.yaml"), "title: Sign-in\nproject_id: Pidgen\n");
    const { code } = await run(ctx, "ticket", "create", "--kind", "epic", "-f", "epic.yaml");
    expect(code).toBe(ExitCode.Ok);
    expect(sent[0]?.body).toEqual({ title: "Sign-in", project_id: "Pidgen", kind: "epic" });
  });

  it("pidgen ticket edit --kind sends PATCH /tickets/{ref} when the kind matches", async () => {
    // The mock answers the document's default ticket, a task.
    const { ctx, sent } = await setup();
    await writeFile(join(ctx.cwd, "edit.yaml"), "title: Sign-in, revised\nmerge_policy: null\n");
    const argv = ["ticket", "edit", "PIDGEN-12", "--kind", "task", "-f", "edit.yaml"];
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${server().url}/api/v1/tickets/PIDGEN-12`],
      ["PATCH", `${server().url}/api/v1/tickets/PIDGEN-12`],
    ]);
    expect(sent[1]?.body).toEqual(
      expect.objectContaining({ title: "Sign-in, revised", merge_policy: null }),
    );
  });

  it("pidgen epic edit reads GET /tickets/{key} and sends no PATCH for a ticket that is not an Epic", async () => {
    const { ctx, sent } = await setup();
    await writeFile(join(ctx.cwd, "edit.yaml"), "merge_policy: null\n");
    const { code, body } = await run(ctx, "epic", "edit", "PIDGEN-12", "-f", "edit.yaml");
    expect(code).toBe(ExitCode.NotFound);
    expect(body.error).toMatchObject({ code: "TICKET_KIND_MISMATCH" });
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${server().url}/api/v1/tickets/PIDGEN-12`],
    ]);
  });

  it("pidgen epic edge add sends POST /tickets/{--to}/dependencies, a body the document accepts", async () => {
    const { ctx, sent } = await setup();
    const argv = ["epic", "edge", "add", "PIDGEN-12", "--from", "PIDGEN-2", "--to", "PIDGEN-3"];
    const { code, body } = await run(ctx, ...argv, "--type", "blocks");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    expect(body.data).toEqual(
      expect.objectContaining({ source_id: expect.any(String), target_id: expect.any(String) }),
    );
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["POST", `${server().url}/api/v1/tickets/PIDGEN-3/dependencies`],
    ]);
    expect(sent[0]?.body).toEqual({ source_id: "PIDGEN-2", dep_type: "blocks" });
  });

  it("pidgen epic edge rm sends DELETE /tickets/{--to}/dependencies/{--from} and returns the removed edge", async () => {
    const { ctx, sent } = await setup();
    const argv = ["epic", "edge", "rm", "PIDGEN-12", "--from", "PIDGEN-2", "--to", "PIDGEN-3"];
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    expect(body.data).toEqual(
      expect.objectContaining({ source_id: expect.any(String), target_id: expect.any(String) }),
    );
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["DELETE", `${server().url}/api/v1/tickets/PIDGEN-3/dependencies/PIDGEN-2`],
    ]);
  });

  it("pidgen ticket dep add sends a body the document accepts and returns the documented edge", async () => {
    const { ctx, sent } = await setup();
    const argv = ["ticket", "dep", "add", "PIDGEN-3", "--on", "PIDGEN-2", "--type", "blocks"];
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    expect(body.data).toEqual(
      expect.objectContaining({ source_id: expect.any(String), target_id: expect.any(String) }),
    );
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["POST", `${server().url}/api/v1/tickets/PIDGEN-3/dependencies`],
    ]);
    expect(sent[0]?.body).toEqual({ source_id: "PIDGEN-2", dep_type: "blocks" });
  });

  it("pidgen ticket dep rm sends the documented route and returns the removed edge", async () => {
    const { ctx, sent } = await setup();
    const argv = ["ticket", "dep", "rm", "PIDGEN-3", "--on", "PIDGEN-2", "--type", "blocks"];
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    expect(body.data).toEqual(
      expect.objectContaining({ source_id: expect.any(String), target_id: expect.any(String) }),
    );
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["DELETE", `${server().url}/api/v1/tickets/PIDGEN-3/dependencies/PIDGEN-2?dep_type=blocks`],
    ]);
  });

  it.each([
    ["--epic PIDGEN-12", ["--epic", "PIDGEN-12"], "PIDGEN-12"],
    ["--no-epic", ["--no-epic"], null],
  ])(
    "pidgen ticket move %s sets parent_ticket_id with PATCH /tickets/{ref}, a body the document accepts",
    async (_, flags, parent) => {
      const { ctx, sent } = await setup();
      const { code, body } = await run(ctx, "ticket", "move", "PIDGEN-3", ...flags);
      expect(code).toBe(ExitCode.Ok);
      expect(body).toMatchObject({ ok: true, error: null });
      expect(body.data).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          move: expect.objectContaining({ moved: expect.any(Boolean) }),
        }),
      );
      expect(sent.map((call) => [call.method, call.url])).toEqual([
        ["GET", `${server().url}/api/v1/tickets/PIDGEN-3`],
        ["PATCH", `${server().url}/api/v1/tickets/PIDGEN-3`],
      ]);
      expect(sent[1]?.body).toEqual({ version: expect.any(Number), parent_ticket_id: parent });
    },
  );
});
