import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, testContext, type TestContext } from "../support/context.js";
import { useMockServer } from "../support/mock-server.js";

// The pidgen domain commands against Prism mocking the committed contracts/openapi.json. Prism
// checks each request (path, credential, body) against the published document and generates the
// answer from the route's schema, which the command validates against the same document.

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

async function setup() {
  const sent: Sent[] = [];
  const ctx = await testContext({
    env: {
      PIDGEN_API_URL: server().url,
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

const DOMAIN = {
  id: expect.any(String) as unknown,
  key: expect.any(String) as unknown,
  name: expect.any(String) as unknown,
  is_account_root: expect.any(Boolean) as unknown,
  archived: expect.any(Boolean) as unknown,
  parents: expect.any(Array) as unknown,
  projects: expect.any(Array) as unknown,
  domains: expect.any(Array) as unknown,
  people: { members: expect.any(Number) as unknown, maintainers: expect.any(Number) as unknown },
  epics: { open: expect.any(Number) as unknown, total: expect.any(Number) as unknown },
};

/** A person's user id: the published people routes take a UUID. */
const USER = "00000000-0000-4000-8000-000000000007";

describe("domain commands against the Prism mock of the published document", () => {
  it("pidgen domain list returns the documented domains", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "domain", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null, meta: { account: "ACC-EXAMPLE" } });
    const domains = body.data as Array<Record<string, unknown>>;
    expect(Array.isArray(domains)).toBe(true);
    for (const domain of domains) expect(domain).toMatchObject(DOMAIN);
    expect(sent).toEqual([{ method: "GET", url: `${server().url}/api/v1/domains` }]);
  });

  it.each([
    [["domain", "show", "PAY"], "GET", "/domains/PAY"],
    [["domain", "create", "--name", "Cards", "--key", "CARDS"], "POST", "/domains"],
    [
      ["domain", "create", "--name", "Cards", "--key", "CARDS", "--parent", "PAY"],
      "POST",
      "/domains",
    ],
    [["domain", "edit", "PAY", "--name", "Payments and billing"], "PATCH", "/domains/PAY"],
    [["domain", "edit", "PAY", "--key", "BILL"], "PATCH", "/domains/PAY"],
    [["domain", "archive", "PAY"], "PATCH", "/domains/PAY"],
    [["domain", "unarchive", "PAY"], "PATCH", "/domains/PAY"],
    [["domain", "project", "add", "PAY", "ALPHA"], "PUT", "/domains/PAY/projects/ALPHA"],
    [["domain", "project", "rm", "PAY", "ALPHA"], "DELETE", "/domains/PAY/projects/ALPHA"],
    [["domain", "parent", "add", "PAY", "FIN"], "PUT", "/domains/PAY/parents/FIN"],
    [["domain", "parent", "rm", "PAY", "FIN"], "DELETE", "/domains/PAY/parents/FIN"],
    [["domain", "member", "add", "PAY", USER], "PUT", `/domains/PAY/people/${USER}`],
    [["domain", "member", "rm", "PAY", USER], "DELETE", `/domains/PAY/people/${USER}`],
    [["domain", "maintainer", "add", "PAY", USER], "PUT", `/domains/PAY/people/${USER}`],
    [["domain", "maintainer", "rm", "PAY", USER], "PUT", `/domains/PAY/people/${USER}`],
  ])(
    "pidgen %j sends the documented request and returns the documented domain",
    async (argv, method, path) => {
      const { ctx, sent } = await setup();
      const { code, body } = await run(ctx, ...argv);
      expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
      expect(body).toMatchObject({
        ok: true,
        error: null,
        data: { ...DOMAIN, granted: expect.any(Array) as unknown },
      });
      expect(sent).toEqual([{ method, url: `${server().url}/api/v1${path}` }]);
    },
  );
});
