import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, testContext, type TestContext } from "../support/context.js";
import {
  committedDocumentForStaticMock,
  useMockServer,
  type MockServer,
} from "../support/mock-server.js";
import { CONTRACT, PROPOSED, PUBLISHED_REVISED, publishedIssues } from "../support/published.js";

// The pidgen contract and ticket contract commands against Prism mocking the committed
// contracts/openapi.json. Prism checks each request (path, credential, body) against the published
// document and generates the answer from the route's schema, which the command validates against
// the same document.

const server = useMockServer();

interface Body {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  meta: Record<string, unknown>;
}

interface Sent {
  method: string;
  url: string;
}

async function setup(mock: () => MockServer = server) {
  const sent: Sent[] = [];
  const ctx = await testContext({
    env: {
      PIDGEN_API_URL: mock().url,
      PIDGEN_TOKEN: "pidgen_pat_fake_contract_token",
      PIDGEN_ACCOUNT: "ACC-EXAMPLE",
    },
    fetch: (input, init) => {
      sent.push({ method: init?.method ?? "GET", url: String(input) });
      return globalThis.fetch(input, init);
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

const SUMMARY = {
  id: expect.any(String) as unknown,
  key: expect.any(String) as unknown,
  title: expect.any(String) as unknown,
  provider: expect.objectContaining({
    project_id: expect.any(String),
    kind: expect.stringMatching(/^(project|domain)$/),
    key: expect.any(String),
    name: expect.any(String),
  }) as unknown,
  status: expect.any(String) as unknown,
  implemented: expect.any(Boolean) as unknown,
  waiting_revisions: expect.any(Array) as unknown,
};

const REVISION = {
  number: expect.any(Number) as unknown,
  kind: expect.any(String) as unknown,
  change: expect.any(String) as unknown,
  operations: expect.any(Array) as unknown,
  acceptance: expect.any(String) as unknown,
  markdown: expect.any(String) as unknown,
};

describe("contract commands against the Prism mock of the published document", () => {
  it.each([
    [
      ["contract", "list", "--project", "ALPHA"],
      "/projects/ALPHA/contracts",
      ["builds_against", "provides"],
    ],
    [
      ["contract", "list", "--domain", "PAY"],
      "/domains/PAY/contracts",
      ["builds_against", "coverage", "own"],
    ],
  ])("pidgen %j returns the documented lists", async (argv, path, lists) => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null, meta: { account: "ACC-EXAMPLE" } });
    const data = body.data as Record<string, Array<Record<string, unknown>>>;
    expect(Object.keys(data).sort()).toEqual(lists);
    const entries = [...(data["provides"] ?? data["own"])!, ...data["builds_against"]!];
    for (const contract of entries) {
      expect(contract).toMatchObject(SUMMARY);
      expect(contract).not.toHaveProperty("revisions");
    }
    expect(sent).toEqual([{ method: "GET", url: `${server().url}/api/v1${path}` }]);
  });

  it("pidgen contract show returns the documented contract with its revisions and hidden counts", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "contract", "show", "CT-7");
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    const data = body.data as Record<string, unknown> & { revisions: unknown[] };
    expect(data).toMatchObject({
      ...SUMMARY,
      implemented_by: { work: expect.any(Array), hidden_count: expect.any(Number) },
      built_against_by: { work: expect.any(Array), hidden_count: expect.any(Number) },
    });
    for (const revision of data.revisions) expect(revision).toMatchObject(REVISION);
    expect(sent).toEqual([{ method: "GET", url: `${server().url}/api/v1/contracts/CT-7` }]);
  });

  it("pidgen contract revise sends the documented body and returns the contract", async () => {
    const { ctx, sent } = await setup();
    await writeFile(
      join(ctx.cwd, "revision.yaml"),
      "kind: rest\nschema_format: openapi\nchange: additive\noperations:\n  - name: GET /payments/{id}\n",
    );
    await writeFile(join(ctx.cwd, "contract.md"), "# Payments API\n\nAdds reading one payment.\n");
    const { code, body } = await run(
      ctx,
      "contract",
      "revise",
      "CT-7",
      "-f",
      "revision.yaml",
      "--markdown",
      "contract.md",
    );
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ ...SUMMARY, revisions: expect.any(Array) });
    expect(sent).toEqual([
      { method: "POST", url: `${server().url}/api/v1/contracts/CT-7/revisions` },
    ]);
  });

  it("pidgen contract accept reads the contract and accepts its waiting revision", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "contract", "accept", "CT-7");
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject(SUMMARY);
    // The mock generates one revision, numbered 0 and waiting; accept sends its revision_number.
    expect(sent).toEqual([
      { method: "GET", url: `${server().url}/api/v1/contracts/CT-7` },
      { method: "POST", url: `${server().url}/api/v1/contracts/CT-7/revisions/0/accept` },
    ]);
  });

  it("pidgen contract accept --revision accepts the named revision", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "contract", "accept", "CT-7", "--revision", "3");
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    const data = body.data as { revisions: unknown[] };
    expect(data).toMatchObject(SUMMARY);
    for (const revision of data.revisions) expect(revision).toMatchObject(REVISION);
    expect(sent).toEqual([
      { method: "POST", url: `${server().url}/api/v1/contracts/CT-7/revisions/3/accept` },
    ]);
  });

  const LINK = {
    contract_id: expect.any(String) as unknown,
    key: expect.any(String) as unknown,
    provider_project_id: expect.any(String) as unknown,
    link: expect.stringMatching(/^(implements|builds_against)$/) as unknown,
    operations: expect.any(Array) as unknown,
    linked_at: expect.any(String) as unknown,
  };

  /** Each of the Ticket's contracts the answer lists is a published link. */
  function expectLinks(data: unknown) {
    const { contracts } = data as { contracts: unknown[] };
    expect(Array.isArray(contracts)).toBe(true);
    for (const link of contracts) {
      expect(link).toMatchObject(LINK);
      expect(link).toHaveProperty("criterion_id");
    }
  }

  it.each([
    [["ticket", "contract", "implements", "ALPHA-40", "CT-7", "--operation", "GET /payments"]],
    [["ticket", "contract", "builds-against", "BETA-12", "CT-7"]],
  ])("pidgen %j sends the documented link and returns the Ticket's contracts", async (argv) => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expectLinks(body.data);
    expect(sent).toEqual([
      { method: "POST", url: `${server().url}/api/v1/tickets/${argv[3]}/contracts` },
    ]);
  });

  it("pidgen ticket contract rm sends the documented route and returns the Ticket's contracts", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "ticket", "contract", "rm", "ALPHA-40", "CT-7");
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expectLinks(body.data);
    expect(sent).toEqual([
      { method: "DELETE", url: `${server().url}/api/v1/tickets/ALPHA-40/contracts/CT-7` },
    ]);
  });
});

// `pidgen contract create` against Prism mocking the committed document for the two create routes.
// Prism checks the request (path, credential, body) against the document and answers with a
// created contract, which the command validates against the same document. The routes state no
// example, so the answer is a fixture with one revision, checked against the published schema.
const CREATED = { ...CONTRACT, revisions: [CONTRACT.revisions[0]!] };
const CREATED_RESPONSE = { status: "ok", data: CREATED, meta: {} };

describe("pidgen contract create against the Prism mock of the published document", () => {
  const created = useMockServer(
    committedDocumentForStaticMock({
      "POST /api/v1/projects/{project_ref}/contracts": CREATED_RESPONSE,
      "POST /api/v1/domains/{domain_id}/contracts": CREATED_RESPONSE,
    }),
  );

  it("the created contract the mock answers with is the published ContractResponse", () => {
    expect(publishedIssues("ContractResponse", CREATED_RESPONSE)).toEqual([]);
  });

  it.each([
    [["--project", "ALPHA"], "/projects/ALPHA/contracts"],
    [["--domain", "DOM-example-pay"], "/domains/DOM-example-pay/contracts"],
  ])(
    "pidgen contract create %j sends the published body and returns the created contract",
    async (provider, path) => {
      const { ctx, sent } = await setup(created);
      await writeFile(
        join(ctx.cwd, "contract.yaml"),
        'title: Payments API\nkind: rest\nmarkdown: "# Payments API\\n"\noperations:\n  - name: GET /payments\n',
      );
      const { code, body } = await run(
        ctx,
        "contract",
        "create",
        ...provider,
        "-f",
        "contract.yaml",
        "--schema-format",
        "openapi",
        "--owner",
        "00000000-0000-4000-8000-000000000007",
        "--existing",
      );
      expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
      expect(body).toMatchObject({ ok: true, error: null, meta: { account: "ACC-EXAMPLE" } });
      const data = body.data as Record<string, unknown> & { revisions: unknown[] };
      expect(data).toMatchObject(SUMMARY);
      expect(data.revisions).toHaveLength(1);
      for (const revision of data.revisions) expect(revision).toMatchObject(REVISION);
      expect(sent).toEqual([{ method: "POST", url: `${created().url}/api/v1${path}` }]);
    },
  );

  it("a body the document refuses is a usage error and reaches no server", async () => {
    const { ctx, sent } = await setup(created);
    await writeFile(join(ctx.cwd, "contract.json"), JSON.stringify({ title: "Payments API" }));
    const { code, body } = await run(
      ctx,
      "contract",
      "create",
      "--project",
      "ALPHA",
      "-f",
      "contract.json",
    );
    expect(code).toBe(ExitCode.Usage);
    expect(body.error).toMatchObject({ code: "INPUT_INVALID" });
    expect(sent).toEqual([]);
  });
});

// `pidgen contract publish` and `pidgen contract propose` against Prism mocking the committed
// document: Prism checks each multipart body against the published one and answers with a publish
// or proposal fixture, checked against its published schema.
describe("pidgen contract publish and propose against the Prism mock of the published document", () => {
  const PUBLISH_RESPONSE = { status: "ok", data: PUBLISHED_REVISED, meta: {} };
  const PROPOSAL_RESPONSE = { status: "ok", data: PROPOSED, meta: {} };
  const publishing = useMockServer(
    committedDocumentForStaticMock({
      "POST /api/v1/projects/{project_ref}/contracts/publish": PUBLISH_RESPONSE,
      "POST /api/v1/domains/{domain_id}/contracts/publish": PUBLISH_RESPONSE,
      "POST /api/v1/contracts/{contract_id}/proposals": PROPOSAL_RESPONSE,
      "POST /api/v1/projects/{project_ref}/contracts/proposals": PROPOSAL_RESPONSE,
    }),
  );
  const SPEC = "openapi: 3.1.0\ninfo:\n  title: Payments API\n  version: '1'\npaths: {}\n";

  it("the answers the mock gives are the published responses", () => {
    expect(publishedIssues("ContractPublishResponse", PUBLISH_RESPONSE)).toEqual([]);
    expect(publishedIssues("ContractProposalResponse", PROPOSAL_RESPONSE)).toEqual([]);
  });

  it.each([
    [["--project", "ALPHA"], "/projects/ALPHA/contracts/publish"],
    [["--domain", "DOM-example-pay"], "/domains/DOM-example-pay/contracts/publish"],
  ])(
    "pidgen contract publish %j sends the file as multipart and prints the result",
    async (provider, path) => {
      // A lone entry: Prism does not gather repeated multipart parts into the `files` array, so
      // the files beside an entry are checked by the command tests (tests/commands/contract.test.ts).
      const { ctx, sent } = await setup(publishing);
      await writeFile(join(ctx.cwd, "openapi.yaml"), SPEC);
      const { code, body } = await run(
        ctx,
        "contract",
        "publish",
        "openapi.yaml",
        ...provider,
        "--path",
        "contracts/payments/openapi.yaml",
        "--commit",
        "9c01d2e",
      );
      expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
      expect(body).toMatchObject({ ok: true, data: PUBLISHED_REVISED, error: null });
      expect(sent).toEqual([{ method: "POST", url: `${publishing().url}/api/v1${path}` }]);
    },
  );

  it("pidgen contract publish --check exits 0 on the additive change the mock answers", async () => {
    const { ctx } = await setup(publishing);
    await writeFile(join(ctx.cwd, "openapi.yaml"), SPEC);
    const argv = ["openapi.yaml", "--project", "ALPHA", "--path", "openapi.yaml", "--check"];
    const { code, body } = await run(ctx, "contract", "publish", ...argv);
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ change: "additive" });
  });

  it.each([
    [["CT-12", "refund.yaml"], "/contracts/CT-12/proposals"],
    [
      ["--project", "ALPHA", "--title", "Refunds API", "refund.yaml"],
      "/projects/ALPHA/contracts/proposals",
    ],
  ])("pidgen contract propose %j sends the fragment and prints the result", async (argv, path) => {
    const { ctx, sent } = await setup(publishing);
    await writeFile(join(ctx.cwd, "refund.yaml"), SPEC);
    const { code, body } = await run(ctx, "contract", "propose", ...argv);
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: PROPOSED, error: null });
    expect(sent).toEqual([{ method: "POST", url: `${publishing().url}/api/v1${path}` }]);
  });
});
