import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, testContext, type TestContext } from "../support/context.js";
import { useMockServer } from "../support/mock-server.js";

// AC-bc2d5eeb9a5f, AC-9f7dca84dddc: `pidgen project inspect`, `project setup`, `project rehearse`
// and `project doctor` against Prism
// mocking the pending readiness fragment (contracts/pending/project-readiness.json). Prism refuses
// a path or a body the fragment does not accept, and answers with its documented examples; a
// test picks a named example with Prism's `Prefer: example=<name>` header.

const PENDING = fileURLToPath(
  new URL("../../contracts/pending/project-readiness.json", import.meta.url),
);
const FIXTURES = new URL("../fixtures/readiness/", import.meta.url);
const server = useMockServer(PENDING);

interface Body {
  ok: boolean;
  data: Record<string, unknown> | null;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
}

interface Sent {
  method: string;
  path: string;
  body: unknown;
  status: number;
  contentType: string | null;
}

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(name, FIXTURES), "utf8")) as Record<string, unknown>;
}

/**
 * A context whose requests go to Prism, each recorded with its answer. `prefer` names the example
 * the n-th GET of the readiness is answered with, and `doctor` the one the doctor answers with; `body` may replace an answer's body (Prism serves
 * the archive's example text, not an archive).
 */
async function context(
  sent: Sent[],
  {
    prefer = () => undefined,
    doctor,
    body,
  }: {
    prefer?: (getIndex: number) => string | undefined;
    doctor?: string;
    body?: (path: string) => Uint8Array | undefined;
  } = {},
): Promise<TestContext> {
  let gets = 0;
  return testContext({
    env: {
      PIDGEN_API_URL: server().url,
      PIDGEN_TOKEN: "pidgen_pat_fake_contract_token",
      PIDGEN_ACCOUNT: "ACC-EXAMPLE",
    },
    fetch: async (input, init) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(input)).pathname;
      const headers = { ...(init?.headers as Record<string, string>) };
      if (method === "GET" && path.endsWith("/readiness")) {
        const example = prefer(gets++);
        if (example) headers["prefer"] = `example=${example}`;
      }
      if (method === "POST" && path.endsWith("/readiness/doctor") && doctor) {
        headers["prefer"] = `example=${doctor}`;
      }
      const response = await globalThis.fetch(input, { ...init, headers });
      sent.push({
        method,
        path,
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
        status: response.status,
        contentType: response.headers.get("content-type"),
      });
      const replaced = response.ok ? body?.(path) : undefined;
      if (replaced === undefined) return response;
      await response.arrayBuffer();
      return new Response(replaced, { status: response.status, headers: response.headers });
    },
  });
}

async function json(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(["--timeout", "10", ...argv, "--format", "json"], ctx);
  return { code, body: envelope(ctx) as unknown as Body };
}

describe("pidgen project readiness commands against the Prism mock of the pending fragment", () => {
  it("inspect reads the documented readiness, and the CLI accepts it", async () => {
    const sent: Sent[] = [];
    const ctx = await context(sent, { prefer: () => "findings" });
    const { code, body } = await json(ctx, "project", "inspect", "STO");
    expect(body.error).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(await fixture("findings.json"));
    expect(sent).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/api/v1/projects/STO/readiness",
        status: 200,
      }),
    ]);
  });

  it("inspect --answer sends a body the fragment accepts and reads the re-inspection", async () => {
    const sent: Sent[] = [];
    const ctx = await context(sent);
    const { code, body } = await json(
      ctx,
      "project",
      "inspect",
      "STO",
      "--answer",
      "stripe-test-key=skip",
    );
    expect(body.error).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(await fixture("inspecting.json"));
    expect(sent).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/api/v1/projects/STO/readiness/answers",
        status: 202,
        body: { answers: [{ question_id: "stripe-test-key", value: "skip" }] },
      }),
    ]);
  });

  it("setup shows the documented proposal, and --pull-request reads the documented pull request", async () => {
    const sent: Sent[] = [];
    const ctx = await context(sent, { prefer: () => "findings" });
    const shown = await json(ctx, "project", "setup", "STO");
    expect(shown.code).toBe(ExitCode.Ok);
    expect(shown.body.data).toEqual((await fixture("findings.json"))["proposal"]);

    const opened = await json(ctx, "project", "setup", "STO", "--pull-request");
    expect(opened.body.error).toBeNull();
    expect(opened.code).toBe(ExitCode.Ok);
    expect(opened.body.data).toEqual(await fixture("pull-request.json"));
    expect(sent.at(-1)).toMatchObject({
      method: "POST",
      path: "/api/v1/projects/STO/readiness/proposal/pull-request",
      status: 200,
    });
  });

  it("setup --write asks for the archive the fragment documents and extracts it under .pidgen/", async () => {
    const sent: Sent[] = [];
    const archive = new Uint8Array(await readFile(new URL("proposal.tar.gz", FIXTURES)));
    const ctx = await context(sent, {
      body: (path) => (path.endsWith("/proposal/archive") ? archive : undefined),
    });
    const root = join(ctx.homeDir, "storefront");
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    ctx.cwd = root;
    const { code, body } = await json(ctx, "project", "setup", "STO", "--write");
    expect(body.error).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    // Prism answered the route the fragment documents, in its media type.
    expect(sent).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/api/v1/projects/STO/readiness/proposal/archive",
        status: 200,
        contentType: expect.stringContaining("application/gzip"),
      }),
    ]);
    expect((await stat(join(root, ".pidgen", "scripts", "provision"))).mode & 0o111).toBe(0o111);
    expect((await stat(join(root, ".pidgen", "pidgen.toml"))).mode & 0o111).toBe(0);
  });

  it("rehearse sends a body the fragment accepts and follows the documented rehearsal to its verdict", async () => {
    const sent: Sent[] = [];
    const ctx = await context(sent, {
      prefer: (index) => (index === 0 ? "rehearsing" : "rehearsed"),
    });
    const { code, body } = await json(ctx, "project", "rehearse", "STO", "--ref", "pidgen/setup");
    expect(body.error).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(await fixture("rehearsal-passed.json"));
    expect(sent.map((call) => `${call.method} ${call.path} ${call.status}`)).toEqual([
      "POST /api/v1/projects/STO/readiness/rehearse 202",
      "GET /api/v1/projects/STO/readiness 200",
      "GET /api/v1/projects/STO/readiness 200",
    ]);
    expect(sent[0]!.body).toEqual({ ref: "pidgen/setup" });
  });

  it("rehearse exits 1 with REHEARSAL_FAILED on the documented failed rehearsal", async () => {
    const sent: Sent[] = [];
    const ctx = await context(sent, { prefer: () => "failed" });
    const { code, body } = await json(ctx, "project", "rehearse", "STO");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("REHEARSAL_FAILED");
    expect(body.error?.details["rehearsal"]).toEqual(await fixture("rehearsal-failed.json"));
  });

  it("doctor sends a body the fragment accepts and reads the documented report, exiting 1 when the setup is the problem", async () => {
    const sent: Sent[] = [];
    const ctx = await context(sent, { doctor: "setup" });
    const { code, body } = await json(ctx, "project", "doctor", "STO", "--since", "14d");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("SETUP_IS_THE_PROBLEM");
    expect(body.error?.details["report"]).toEqual(await fixture("doctor-setup.json"));
    expect(sent).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/api/v1/projects/STO/readiness/doctor",
        status: 200,
        body: { since_days: 14 },
      }),
    ]);
  });

  it("doctor --json prints the documented report unchanged, and --propose-fix reads the opened pull request", async () => {
    const sent: Sent[] = [];
    const healthy = await context(sent, { doctor: "code" });
    healthy.out.length = 0;
    const code = await runCli(["--timeout", "10", "project", "doctor", "STO", "--json"], healthy);
    expect(code).toBe(ExitCode.Ok);
    expect(JSON.parse(healthy.out.join(""))).toEqual(await fixture("doctor-code.json"));

    const unclear = await context(sent, { doctor: "unclear" });
    const unclearCode = await runCli(["--timeout", "10", "project", "doctor", "STO"], unclear);
    expect(unclearCode).toBe(ExitCode.Ok);

    const proposed = await context(sent, { doctor: "fix_proposed" });
    const { code: fixCode, body } = await json(
      proposed,
      "project",
      "doctor",
      "STO",
      "--propose-fix",
    );
    expect(fixCode).toBe(ExitCode.Unexpected);
    expect(body.error?.details["report"]).toEqual(await fixture("doctor-fix-proposed.json"));
    expect(sent.at(-1)).toMatchObject({ status: 200, body: { propose_fix: true } });
  });
});
