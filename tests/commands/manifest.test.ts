import { expectMutationParity } from "../support/context.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { runCli } from "../../src/cli.js";
import { MANIFEST_DOCUMENT } from "../../src/commands/manifest/contract.js";
import { manifestTemplateYaml } from "../../src/commands/manifest/template.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { NOUNS } from "../../src/core/registry.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { validateBody, type OpenApiDocument } from "../../src/core/input.js";
import { deriveIdempotencyKey } from "../../src/core/preview.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";

/**
 * `pidgen manifest template` and `pidgen manifest apply`, against recorded preview and commit
 * responses (tests/fixtures/ticket-manifests) of the ticket-manifest routes in the committed
 * contracts/openapi.json. No server is contacted.
 */

const SERVER = "https://pidgen.example.com";
const TOKEN = "pidgen_pat_fake_token_for_tests";
const PREVIEW_PATH = "/api/v1/ticket-manifests/preview";
const COMMIT_PATH = "/api/v1/ticket-manifests";
const STATUS_PATH = "/api/v1/ticket-manifests/applications/cmd-manifest-1";

const CONFIG: Config = {
  default_profile: "default",
  profiles: {
    default: {
      url: SERVER,
      default_account: "ACC-EXAMPLE",
      credentials: { "ACC-EXAMPLE": { kind: "pat", token: TOKEN } },
    },
  },
};

async function fixture(name: string): Promise<Record<string, unknown>> {
  const url = new URL(`../fixtures/ticket-manifests/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as Record<string, unknown>;
}

const MANIFEST = await fixture("manifest.json");
const PREVIEW_OK = await fixture("preview-committable.json");
const PREVIEW_BLOCKED = await fixture("preview-not-committable.json");
const COMMIT_APPLIED = await fixture("commit-applied.json");

function recorded(body: unknown, status = 200): Response {
  return jsonResponse(status, body, { "x-request-id": "req-example" });
}

function withData(body: Record<string, unknown>, data: Record<string, unknown>) {
  return { ...body, data: { ...(body["data"] as Record<string, unknown>), ...data } };
}

function refusal(status: number, code: string, message: string, details: object | null = null) {
  return jsonResponse(status, {
    status: "error",
    error: { code, message, details, request_id: "req-example" },
  });
}

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

interface Body {
  ok: boolean;
  data: Record<string, unknown> | null;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  meta: Record<string, unknown>;
}

/** A fake server answering each `METHOD path` with its queued responses, in order. */
async function setup(routes: Record<string, Response[]> = {}, config: Config | null = CONFIG) {
  const calls: Call[] = [];
  const ctx = await testContext({
    fetch: (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path: url.pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      const next = routes[`${method} ${url.pathname}`]?.shift();
      if (next === undefined)
        return Promise.reject(new Error(`unexpected ${method} ${url.pathname}`));
      return Promise.resolve(next);
    },
  });
  if (config) await saveConfig(ctx, config);
  return { ctx, calls };
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(argv, ctx);
  expect(ctx.out).toHaveLength(1);
  return { code, body: envelope(ctx) as unknown as Body };
}

async function writeManifest(ctx: TestContext, manifest: unknown = MANIFEST, name = "m.json") {
  await writeFile(
    join(ctx.cwd, name),
    name.endsWith(".json") ? JSON.stringify(manifest) : stringify(manifest),
  );
  return name;
}

/** Checks `value` against a named schema of the committed manifest contract. */
function checkSchema(name: string, value: unknown): unknown {
  const document: OpenApiDocument = {
    ...MANIFEST_DOCUMENT,
    paths: {
      "/check": {
        post: {
          requestBody: {
            content: {
              "application/json": { schema: { $ref: `#/components/schemas/${name}` } },
            },
          },
        },
      },
    },
  };
  return validateBody(document, "post", "/check", value);
}

describe("the committed ticket-manifest contract", () => {
  it("publishes the preview, commit and status routes", () => {
    const paths = MANIFEST_DOCUMENT.paths ?? {};
    expect(paths[PREVIEW_PATH]?.["post"]).toBeDefined();
    expect(paths[COMMIT_PATH]?.["post"]).toBeDefined();
    expect(paths["/api/v1/ticket-manifests/applications/{command_id}"]?.["get"]).toBeDefined();
  });

  it("accepts the recorded manifest, previews and commit result", () => {
    expect(() =>
      validateBody(MANIFEST_DOCUMENT, "post", PREVIEW_PATH, { manifest: MANIFEST }),
    ).not.toThrow();
    expect(() => checkSchema("TicketManifestPreviewResponse", PREVIEW_OK)).not.toThrow();
    expect(() => checkSchema("TicketManifestPreviewResponse", PREVIEW_BLOCKED)).not.toThrow();
    expect(() => checkSchema("TicketManifestCommitResponse", COMMIT_APPLIED)).not.toThrow();
  });

  it("refuses an unknown manifest field, a bad ref and a null team_member_id", () => {
    const bad = {
      ...MANIFEST,
      start_refinement: true,
      root: { ...(MANIFEST["root"] as object), team_member_id: null },
      children: [{ ref: "Bad Ref", title: "x", objective: "y" }],
    };
    expect(() => validateBody(MANIFEST_DOCUMENT, "post", PREVIEW_PATH, { manifest: bad })).toThrow(
      /does not match the schema/,
    );
  });
});

describe("pidgen manifest template", () => {
  it("writes a valid annotated manifest with two children by default", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "manifest", "template");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({
      ok: true,
      data: { path: "ticket-manifest.yaml", format: "yaml", children: 2 },
    });
    expect(calls).toEqual([]);
    const text = await readFile(join(ctx.cwd, "ticket-manifest.yaml"), "utf8");
    expect(text).toBe(manifestTemplateYaml(2));
    const manifest = parse(text) as Record<string, unknown>;
    expect(() => validateBody(MANIFEST_DOCUMENT, "post", PREVIEW_PATH, { manifest })).not.toThrow();
    const children = manifest["children"] as Record<string, unknown>[];
    expect(children.map((child) => child["ref"])).toEqual(["child-1", "child-2"]);
    expect(manifest["edges"]).toEqual([
      { source: "child-1", target: "child-2", dep_type: "blocks" },
    ]);
  });

  it.each([0, 1, 5, 50])("--children %i writes that many valid children", async (count) => {
    const text = manifestTemplateYaml(count);
    const manifest = parse(text) as Record<string, unknown>;
    expect(() => validateBody(MANIFEST_DOCUMENT, "post", PREVIEW_PATH, { manifest })).not.toThrow();
    const children = (manifest["children"] ?? []) as Record<string, unknown>[];
    expect(children).toHaveLength(count);
    expect(new Set(children.map((child) => child["ref"])).size).toBe(count);
    expect(new Set(children.map((child) => child["title"])).size).toBe(count);
    expect(manifest["edges"] ?? []).toHaveLength(Math.max(0, count - 1));

    const { ctx } = await setup();
    const { code, body } = await run(ctx, "manifest", "template", "--children", String(count));
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ children: count });
    expect(await readFile(join(ctx.cwd, "ticket-manifest.yaml"), "utf8")).toBe(text);
  });

  it("names the root's Epic as an epic-kind ticket that becomes its parent_ticket_id", () => {
    const text = manifestTemplateYaml(1);
    // epic_id is the only name the manifest contract takes for the root's Epic.
    expect(parse(text)).toHaveProperty("epic_id", null);
    expect(text).toContain("parent_ticket_id");
    expect(text).not.toMatch(/EXAMPLE-E\d/);
  });

  it("annotates every field: each key follows a comment, and every schema field appears", () => {
    const text = manifestTemplateYaml(1);
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (!/^\s*(- )?[a-z_]+:/.test(line)) return;
      let previous = index - 1;
      while (previous >= 0 && (lines[previous] as string).trim() === "") previous--;
      expect(lines[previous], `the line before "${line}"`).toMatch(/^\s*#/);
    });
    const schemas = MANIFEST_DOCUMENT["components"] as {
      schemas: Record<string, { properties: Record<string, unknown> }>;
    };
    for (const name of [
      "TicketManifest",
      "ManifestRoot",
      "ManifestChild",
      "ManifestCriterion",
      "ManifestEdge",
    ]) {
      for (const field of Object.keys(schemas.schemas[name]?.properties ?? {})) {
        expect(text, `${name}.${field}`).toMatch(new RegExp(`^\\s*(#\\s*)?(- )?${field}:`, "m"));
      }
    }
  });

  it("annotates each content field with the readiness points it earns", () => {
    const text = manifestTemplateYaml(1);
    /** The comment block directly above the first `field:` line. */
    const noteFor = (field: string) => {
      const lines = text.split("\n");
      const at = lines.findIndex((line) => new RegExp(`^\\s*${field}:`).test(line));
      expect(at, field).toBeGreaterThan(0);
      const block: string[] = [];
      for (let i = at - 1; i >= 0 && /^\s*#/.test(lines[i] as string); i--)
        block.unshift(lines[i] as string);
      return block.join("\n");
    };
    expect(text).toMatch(/60 of 100/);
    expect(noteFor("acceptance_criteria")).toMatch(
      /Readiness: 10 points per criterion, at most 30/,
    );
    expect(noteFor("acceptance_criteria")).toMatch(/5 more per MUST criterion, at most 20/);
    expect(noteFor("scope_boundaries")).toMatch(/Readiness: 10 points/);
    expect(noteFor("success_metrics")).toMatch(/Readiness: 10 points/);
    expect(noteFor("context_artifacts")).toMatch(/Readiness: 5 points each, at most 15/);
    expect(noteFor("open_questions")).toMatch(/Readiness: minus 5 points per question/);
    expect(noteFor("estimated_complexity")).toMatch(/Readiness: .*required/);
    expect(noteFor("assumptions")).toMatch(/Readiness:/);
    expect(noteFor("required_capabilities")).toMatch(/Readiness: no points/);
    expect(noteFor("children")).toMatch(/15 points/);
  });

  it("writes JSON without comments for a .json output", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(
      ctx,
      "manifest",
      "template",
      "-o",
      "m.json",
      "--children",
      "1",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ path: "m.json", format: "json", children: 1 });
    const written = JSON.parse(await readFile(join(ctx.cwd, "m.json"), "utf8")) as unknown;
    expect(written).toEqual(parse(manifestTemplateYaml(1)));
  });

  it("keeps an existing file unless --force: FILE_EXISTS exits 5", async () => {
    const { ctx } = await setup();
    await writeFile(join(ctx.cwd, "ticket-manifest.yaml"), "keep me\n");
    const kept = await run(ctx, "manifest", "template");
    expect(kept.code).toBe(ExitCode.Refused);
    expect(kept.body.error?.code).toBe("FILE_EXISTS");
    expect(await readFile(join(ctx.cwd, "ticket-manifest.yaml"), "utf8")).toBe("keep me\n");
    const forced = await run(ctx, "manifest", "template", "--force");
    expect(forced.code).toBe(ExitCode.Ok);
    expect(await readFile(join(ctx.cwd, "ticket-manifest.yaml"), "utf8")).toBe(
      manifestTemplateYaml(2),
    );
  });

  it.each(["-1", "51", "two", "1.5", ""])(
    "--children %j is a usage error and writes nothing",
    async (value) => {
      const { ctx } = await setup();
      const { code, body } = await run(ctx, "manifest", "template", "--children", value);
      expect(code).toBe(ExitCode.Usage);
      expect(body.error?.code).toBe("CLI_USAGE");
      await expect(readFile(join(ctx.cwd, "ticket-manifest.yaml"), "utf8")).rejects.toThrow();
    },
  );
});

describe("pidgen manifest apply", () => {
  it("previews a committable manifest: findings grouped by ref, committable, promotable, digest; exits 0", async () => {
    const { ctx, calls } = await setup({ [`POST ${PREVIEW_PATH}`]: [recorded(PREVIEW_OK)] });
    const name = await writeManifest(ctx, MANIFEST, "manifest.yaml");
    const { code, body } = await run(ctx, "manifest", "apply", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    const findings = (PREVIEW_OK["data"] as { findings: { subject: string }[] }).findings;
    expect(body).toMatchObject({
      ok: true,
      error: null,
      data: {
        committable: true,
        promotable: false,
        preview_digest: "sha256:manifest-preview-1",
        required_acknowledgements: [],
        finding_count: 4,
        plan: { project_id: "proj-example" },
      },
      meta: { request_id: "req-example", account: "ACC-EXAMPLE" },
    });
    const grouped = body.data?.["findings"] as Record<string, unknown[]>;
    expect(Object.keys(grouped)).toEqual(["root", "api-filter", "board-read"]);
    expect(grouped["root"]).toEqual([findings[1], findings[3]]);
    expect(grouped["api-filter"]).toEqual([findings[2]]);
    expect(grouped["board-read"]).toEqual([findings[0]]);
    expect(calls).toEqual([
      expect.objectContaining({ method: "POST", path: PREVIEW_PATH, body: { manifest: MANIFEST } }),
    ]);
    expect(calls[0]?.headers["x-pidgen-account"]).toBe("ACC-EXAMPLE");
  });

  it("refuses a preview with commit-blocking findings: exits 5 and sends no commit", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [recorded(PREVIEW_BLOCKED), recorded(PREVIEW_BLOCKED)],
    });
    const name = await writeManifest(ctx);
    for (const argv of [[], ["--apply"]]) {
      const { code, body } = await run(ctx, "manifest", "apply", "-f", name, ...argv);
      expect(code).toBe(ExitCode.Refused);
      expect(body).toMatchObject({
        ok: false,
        data: null,
        error: {
          code: "MANIFEST_NOT_COMMITTABLE",
          details: {
            committable: false,
            promotable: false,
            preview_digest: "sha256:manifest-preview-blocked",
            finding_count: 4,
          },
        },
      });
      const grouped = body.error?.details["findings"] as Record<string, { code: string }[]>;
      expect(Object.keys(grouped)).toEqual(["manifest", "root", "api-filter", "board-read"]);
      expect(grouped["manifest"]?.map((finding) => finding.code)).toEqual(["MANIFEST_EDGE_CYCLE"]);
      expect(grouped["root"]?.map((finding) => finding.code)).toEqual(["CRITERION_REF_DUPLICATE"]);
      expect(body.error?.details["blocking"]).toEqual([
        "UNKNOWN_WORKFLOW_TYPE",
        "MANIFEST_EDGE_CYCLE",
        "CRITERION_REF_DUPLICATE",
      ]);
    }
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST ${PREVIEW_PATH}`,
      `POST ${PREVIEW_PATH}`,
    ]);
  });

  it("--apply commits with the preview's digest and a derived idempotency key, and prints each ref's ticket key", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [recorded(PREVIEW_OK)],
      [`POST ${COMMIT_PATH}`]: [recorded(COMMIT_APPLIED)],
    });
    const name = await writeManifest(ctx);
    const { code, body } = await run(ctx, "manifest", "apply", "-f", name, "--apply");
    expect(code).toBe(ExitCode.Ok);
    const key = deriveIdempotencyKey(
      { command: "manifest apply", target: "EXAMPLE/root" },
      "sha256:manifest-preview-1",
      [],
    );
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST ${PREVIEW_PATH}`,
      `POST ${COMMIT_PATH}`,
    ]);
    expect(calls[1]?.body).toEqual({
      manifest: MANIFEST,
      preview_digest: "sha256:manifest-preview-1",
      idempotency_key: key,
      acknowledgements: [],
    });
    expect(body).toMatchObject({
      ok: true,
      data: {
        settled: true,
        preview_digest: "sha256:manifest-preview-1",
        idempotency_key: key,
        promoted: false,
        tickets: { root: "EXAMPLE-50", "api-filter": "EXAMPLE-51", "board-read": "EXAMPLE-52" },
        result: COMMIT_APPLIED["data"],
      },
    });
  });

  it("--apply --digest --idempotency-key --reason sends exactly those", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [recorded(PREVIEW_OK)],
      [`POST ${COMMIT_PATH}`]: [recorded(COMMIT_APPLIED)],
    });
    const name = await writeManifest(ctx);
    const { code, body } = await run(
      ctx,
      "manifest",
      "apply",
      "-f",
      name,
      "--apply",
      "--digest",
      "sha256:given",
      "--idempotency-key",
      "key-example-1",
      "--reason",
      "File the board fix",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[1]?.body).toEqual({
      manifest: MANIFEST,
      preview_digest: "sha256:given",
      idempotency_key: "key-example-1",
      acknowledgements: [],
      reason: "File the board fix",
    });
    expect(body.data).toMatchObject({
      idempotency_key: "key-example-1",
      preview_digest: "sha256:given",
    });
  });

  it("follows a 202 commit on its status route until it settles", async () => {
    const applying = withData(COMMIT_APPLIED, { status: "applying" });
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [recorded(PREVIEW_OK)],
      [`POST ${COMMIT_PATH}`]: [recorded(applying, 202)],
      [`GET ${STATUS_PATH}`]: [recorded(applying, 202), recorded(COMMIT_APPLIED)],
    });
    const name = await writeManifest(ctx);
    const { code, body } = await run(ctx, "manifest", "apply", "-f", name, "--apply");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST ${PREVIEW_PATH}`,
      `POST ${COMMIT_PATH}`,
      `GET ${STATUS_PATH}`,
      `GET ${STATUS_PATH}`,
    ]);
    expect(body.data).toMatchObject({ settled: true, tickets: { root: "EXAMPLE-50" } });
  });

  it("--no-wait returns the status route of an unsettled commit", async () => {
    const applying = withData(COMMIT_APPLIED, { status: "applying" });
    const { ctx } = await setup({
      [`POST ${PREVIEW_PATH}`]: [recorded(PREVIEW_OK)],
      [`POST ${COMMIT_PATH}`]: [recorded(applying, 202)],
    });
    const name = await writeManifest(ctx);
    const { code, body } = await run(ctx, "manifest", "apply", "-f", name, "--apply", "--no-wait");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ settled: false, handle: STATUS_PATH });
  });

  it("a stale commit exits 6 with PREVIEW_STALE and says to preview again", async () => {
    const { ctx } = await setup({
      [`POST ${PREVIEW_PATH}`]: [recorded(PREVIEW_OK)],
      [`POST ${COMMIT_PATH}`]: [
        refusal(409, "PREVIEW_STALE", "The manifest previews differently now.", {
          current_preview_digest: "sha256:new",
        }),
      ],
    });
    const name = await writeManifest(ctx);
    const { code, body } = await run(ctx, "manifest", "apply", "-f", name, "--apply");
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body.error).toMatchObject({
      code: "PREVIEW_STALE",
      details: { current_preview_digest: "sha256:new" },
    });
    expect(body.error?.message).toMatch(/Preview again/);
  });

  it("a commit the server refuses exits 5 with its code", async () => {
    const { ctx } = await setup({
      [`POST ${PREVIEW_PATH}`]: [recorded(PREVIEW_OK)],
      [`POST ${COMMIT_PATH}`]: [
        refusal(409, "PROMOTION_GATE_FAILED", "A promotion gate failed.", { failing_gates: [] }),
      ],
    });
    const name = await writeManifest(ctx);
    const { code, body } = await run(ctx, "manifest", "apply", "-f", name, "--apply");
    expect(code).toBe(ExitCode.Refused);
    expect(body.error?.code).toBe("PROMOTION_GATE_FAILED");
  });

  it("an unknown Project exits 4", async () => {
    const { ctx } = await setup({
      [`POST ${PREVIEW_PATH}`]: [refusal(404, "PROJECT_NOT_FOUND", "No such Project.")],
    });
    const name = await writeManifest(ctx);
    const { code, body } = await run(ctx, "manifest", "apply", "-f", name);
    expect(code).toBe(ExitCode.NotFound);
    expect(body.error?.code).toBe("PROJECT_NOT_FOUND");
  });

  it("a preview without findings, committable and promotable is UNEXPECTED_RESPONSE", async () => {
    const data = { ...(PREVIEW_OK["data"] as Record<string, unknown>) };
    delete data["committable"];
    const { ctx } = await setup({
      [`POST ${PREVIEW_PATH}`]: [recorded({ ...PREVIEW_OK, data })],
    });
    const name = await writeManifest(ctx);
    const { code, body } = await run(ctx, "manifest", "apply", "-f", name);
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("UNEXPECTED_RESPONSE");
  });

  it("an invalid manifest exits 2 with every issue at its place in the file, and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const bad = {
      ...MANIFEST,
      root: { ...(MANIFEST["root"] as object), title: "" },
      children: [{ ref: "Not A Ref", title: "x", objective: "y" }],
      extra: true,
    };
    const name = await writeManifest(ctx, bad);
    const { code, body } = await run(ctx, "manifest", "apply", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("INPUT_INVALID");
    const paths = (body.error?.details["issues"] as { path: string }[]).map((issue) => issue.path);
    expect(paths).toEqual(expect.arrayContaining(["$.root.title", "$.children[0].ref"]));
    expect(paths.every((path) => !path.startsWith("$.manifest"))).toBe(true);
    expect(calls).toEqual([]);
  });

  it("--digest without --apply, and a missing -f, are usage errors that send nothing", async () => {
    const { ctx, calls } = await setup();
    const name = await writeManifest(ctx);
    const digestOnly = await run(ctx, "manifest", "apply", "-f", name, "--digest", "sha256:x");
    expect(digestOnly.code).toBe(ExitCode.Usage);
    expect(digestOnly.body.error?.code).toBe("CLI_USAGE");
    const noFile = await run(ctx, "manifest", "apply");
    expect(noFile.code).toBe(ExitCode.Usage);
    expect(calls).toEqual([]);
  });

  it("manifest is a described command noun, so help and the skill lint know it", () => {
    expect(NOUNS["manifest"]).toMatch(/manifest/i);
  });

  it("docs/commands.md lists both commands", async () => {
    const text = await readFile(new URL("../../docs/commands.md", import.meta.url), "utf8");
    expect(text).toMatch(/^### manifest template$/m);
    expect(text).toMatch(/^### manifest apply$/m);
    expect(text).toMatch(/^manifest\s+template \| apply$/m);
  });
});

it.each([40, 80, 120])(
  "manifest findings and created keys preserve execution at %s columns",
  async (columns) => {
    for (const state of ["preview", "blocked", "applied"] as const) {
      const data = state === "blocked" ? PREVIEW_BLOCKED : PREVIEW_OK;
      const { ctx, calls } = await setup({
        [`POST ${PREVIEW_PATH}`]: [recorded(data), recorded(data)],
        [`POST ${COMMIT_PATH}`]: [recorded(COMMIT_APPLIED), recorded(COMMIT_APPLIED)],
      });
      ctx.io.stdoutColumns = columns;
      const file = await writeManifest(ctx);
      const argv = ["manifest", "apply", "-f", file];
      if (state === "applied") argv.push("--apply");
      const fragments =
        state === "blocked"
          ? ["MANIFEST_NOT_COMMITTABLE", "Findings", "Preview — not applied."]
          : state === "preview"
            ? ["Preview — not applied.", "Committable: true", "--apply --digest"]
            : ["Applied — settled.", "Tickets", "Promoted:"];
      const json = await expectMutationParity(
        ctx,
        calls,
        argv,
        fragments,
        state === "blocked" ? ExitCode.Refused : ExitCode.Ok,
      );
      expect(json.ok).toBe(state !== "blocked");
      expect(calls).toHaveLength(state === "applied" ? 2 : 1);
    }
  },
);
