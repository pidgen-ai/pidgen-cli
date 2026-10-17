import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, testContext, type TestContext } from "../support/context.js";
import { useMockServer } from "../support/mock-server.js";

// `pidgen manifest apply` against Prism mocking the committed contracts/openapi.json: Prism refuses
// a request whose body does not match the document, so a success here means the CLI sent bodies
// the published ticket-manifest routes accept, and read answers in their documented shape.

const server = useMockServer();

interface Body {
  ok: boolean;
  data: Record<string, unknown> | null;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  meta: Record<string, unknown>;
}

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

const MANIFEST = JSON.parse(
  await readFile(new URL("../fixtures/ticket-manifests/manifest.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const PREVIEW = "/api/v1/ticket-manifests/preview";
const COMMIT = "/api/v1/ticket-manifests";

async function setup() {
  const sent: Sent[] = [];
  const ctx = await testContext({
    env: {
      PIDGEN_API_URL: server().url,
      PIDGEN_TOKEN: "pidgen_pat_fake_contract_token",
      PIDGEN_ACCOUNT: "ACC-EXAMPLE",
    },
    fetch: (input, init) => {
      const text = init?.body;
      sent.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof text === "string" ? (JSON.parse(text) as unknown) : undefined,
      });
      return globalThis.fetch(input, init);
    },
  });
  await writeFile(join(ctx.cwd, "manifest.json"), JSON.stringify(MANIFEST));
  return { ctx, sent };
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(["--timeout", "10", ...argv], ctx);
  return { code, body: envelope(ctx) as unknown as Body };
}

/** A raw request to the mock, apart from the CLI's own checks. */
async function raw(method: string, path: string, body?: unknown): Promise<number> {
  const response = await globalThis.fetch(`${server().url}${path}`, {
    method,
    headers: {
      authorization: "Bearer pidgen_pat_fake_contract_token",
      "x-pidgen-account": "ACC-EXAMPLE",
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return response.status;
}

describe("pidgen manifest apply against the Prism mock of the committed document", () => {
  it("previews with POST /ticket-manifests/preview in a body the document accepts, and prints the documented preview", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "manifest", "apply", "-f", "manifest.json");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null, meta: { account: "ACC-EXAMPLE" } });
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["POST", `${server().url}${PREVIEW}`],
    ]);
    expect(sent[0]?.body).toEqual({ manifest: MANIFEST });
    expect(body.data).toEqual(
      expect.objectContaining({
        preview_digest: expect.any(String),
        required_acknowledgements: expect.any(Array),
        committable: expect.any(Boolean),
        promotable: expect.any(Boolean),
        finding_count: expect.any(Number),
        // Findings are grouped by the manifest's refs, so the report's findings are an object.
        findings: expect.any(Object),
      }),
    );
  });

  it("--apply without the preview's digest stops at exit 6 with DIGEST_REQUIRED and commits nothing", async () => {
    const { ctx, sent } = await setup();
    const previewed = await run(ctx, "manifest", "apply", "-f", "manifest.json");
    const required = previewed.body.data?.["required_acknowledgements"] as string[];
    expect(required.length).toBeGreaterThan(0);

    const { code, body } = await run(ctx, "manifest", "apply", "-f", "manifest.json", "--apply");
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body).toMatchObject({ ok: false, error: { code: "DIGEST_REQUIRED" } });
    expect(body.error?.message).toMatch(/--digest/);
    // Missing acknowledgements are the server's refusal (ACKNOWLEDGEMENT_REQUIRED, exit 6), which
    // the mock cannot give; the engine's handling of it is covered with recorded responses in
    // tests/commands/ticket-cancel.test.ts and tests/commands/ticket-actions.test.ts.
    expect(sent.filter((call) => call.url.endsWith(COMMIT))).toEqual([]);
  });

  it("--apply with the preview's digest and acknowledgements commits with POST /ticket-manifests in a body the document accepts", async () => {
    const { ctx, sent } = await setup();
    const previewed = await run(ctx, "manifest", "apply", "-f", "manifest.json");
    const digest = previewed.body.data?.["preview_digest"] as string;
    const acks = previewed.body.data?.["required_acknowledgements"] as string[];

    const { code, body } = await run(
      ctx,
      "manifest",
      "apply",
      "-f",
      "manifest.json",
      "--apply",
      "--digest",
      digest,
      ...acks.flatMap((ack) => ["--ack", ack]),
      "--reason",
      "Filed from the contract test.",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    // The first preview, then the apply's own preview and the commit.
    expect(sent.slice(1).map((call) => [call.method, call.url])).toEqual([
      ["POST", `${server().url}${PREVIEW}`],
      ["POST", `${server().url}${COMMIT}`],
    ]);
    expect(sent[2]?.body).toEqual({
      manifest: MANIFEST,
      preview_digest: digest,
      idempotency_key: expect.any(String),
      acknowledgements: acks,
      reason: "Filed from the contract test.",
    });
    expect(body.data).toEqual(
      expect.objectContaining({
        settled: true,
        preview_digest: digest,
        idempotency_key: expect.any(String),
        tickets: expect.any(Object),
        promoted: expect.any(Boolean),
        result: expect.objectContaining({
          command_id: expect.any(String),
          status: expect.any(String),
          root: expect.objectContaining({
            ref: expect.any(String),
            ticket_key: expect.any(String),
          }),
          children: expect.any(Array),
        }),
      }),
    );
  });

  it("the document itself refuses a manifest with an unknown field, without a root, or with a bad ref, and answers the application read", async () => {
    expect(await raw("POST", PREVIEW, { manifest: MANIFEST })).toBe(200);
    expect(await raw("POST", PREVIEW, { manifest: { ...MANIFEST, colour: "blue" } })).toBe(422);
    const noRoot = Object.fromEntries(Object.entries(MANIFEST).filter(([key]) => key !== "root"));
    expect(await raw("POST", PREVIEW, { manifest: noRoot })).toBe(422);
    expect(
      await raw("POST", PREVIEW, {
        manifest: {
          ...MANIFEST,
          children: [{ ...(MANIFEST["children"] as object[])[0], ref: "Not A Ref" }],
        },
      }),
    ).toBe(422);
    expect(await raw("POST", COMMIT, { manifest: MANIFEST })).toBe(422);
    expect(
      await raw("POST", COMMIT, {
        manifest: MANIFEST,
        preview_digest: "sha256:example",
        idempotency_key: "key-example-1",
        acknowledgements: [],
      }),
    ).toBe(200);
    expect(await raw("GET", `${COMMIT}/applications/cmd-example-1`)).toBe(200);
  });
});
