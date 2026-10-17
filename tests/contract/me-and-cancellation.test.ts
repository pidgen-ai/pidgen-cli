import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { ApiClient } from "../../src/core/http.js";
import { runPreviewApply, serverPreviewApply } from "../../src/core/preview.js";
import type { components } from "../../src/generated/api.js";
import { envelope, testContext, type TestContext } from "../support/context.js";
import { COMMITTED_DOCUMENT, useMockServer } from "../support/mock-server.js";

// The signed-in User's routes (GET /me, GET /me/sessions, DELETE /me/sessions/{session_id}) and
// the ticket cancellation pair, against Prism mocking the committed contracts/openapi.json. Prism
// generates responses from the document's schemas and refuses a request body the document does not
// accept, so these tests check that the routes are published with the shapes the CLI will rely on.

const server = useMockServer(COMMITTED_DOCUMENT);

type DeliveryOperation = components["schemas"]["DeliveryOperation"];

/**
 * The committed document answers an error with a generated body, which names no code. The
 * delivery-operation refusals are therefore tested against a copy of it whose cancellation routes
 * carry one example each (a `409` for the preview, a `409` for the apply), written to a temporary
 * file, so everything else — the routes, the schemas, the request checks — is the committed
 * contract and cannot drift from it. The operations are typed with the generated schema.
 */
const IN_FLIGHT: DeliveryOperation = {
  operation_id: "dop-example",
  kind: "pr_update",
  ownership_generation: 3,
  worker: { host_id: "host-example", name: "worker-1" },
  started_at: "2026-09-28T09:58:00Z",
  observed_at: "2026-09-28T09:59:30Z",
  state: "in_flight",
};
const UNKNOWN: DeliveryOperation = { ...IN_FLIGHT, kind: "push", state: "unknown" };

const refusalDocumentDirectory = mkdtempSync(join(tmpdir(), "pidgen-cancel-refusals-"));
afterAll(() => rmSync(refusalDocumentDirectory, { recursive: true, force: true }));
const refusalServer = useMockServer(refusalDocument());

function refusalDocument(): string {
  const document = JSON.parse(readFileSync(COMMITTED_DOCUMENT, "utf8")) as {
    paths: Record<
      string,
      { post: { responses: Record<string, { content: Record<string, { example?: unknown }> }> } }
    >;
  };
  const example = (code: string, message: string, operation: DeliveryOperation) => ({
    status: "error",
    error: { code, message, details: { operation }, request_id: "req-example" },
  });
  const cancel = "/api/v1/tickets/{ticket_id}/cancellation";
  const conflict = (path: string) => document.paths[path]?.post.responses["409"]?.content;
  const preview = conflict(`${cancel}/preview`)?.["application/json"];
  const apply = conflict(cancel)?.["application/json"];
  if (preview === undefined || apply === undefined) {
    throw new Error("The cancellation routes document no 409");
  }
  preview.example = example("DELIVERY_IN_FLIGHT", "A delivery is in progress.", IN_FLIGHT);
  apply.example = example(
    "PUBLICATION_RESULT_UNKNOWN",
    "The result of a publication is unknown.",
    UNKNOWN,
  );
  const file = join(refusalDocumentDirectory, "openapi.json");
  writeFileSync(file, JSON.stringify(document));
  return file;
}

type Me = components["schemas"]["Me"];
type SessionEntry = components["schemas"]["SessionEntry"];
type SessionRevoked = components["schemas"]["SessionRevoked"];
type CancellationApplyResult = components["schemas"]["CancellationApplyResult"];

interface Body {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  meta: Record<string, unknown>;
}

async function setup(options: { server?: () => { url: string }; code?: number } = {}) {
  const sent: Array<{ url: string; method: string }> = [];
  const bodies: unknown[] = [];
  const target = options.server ?? server;
  const ctx = await testContext({
    env: {
      PIDGEN_API_URL: target().url,
      PIDGEN_TOKEN: "pidgen_cli_fake_contract_token",
      PIDGEN_ACCOUNT: "ACC-EXAMPLE",
    },
    fetch: (input, init) => {
      const url = String(input);
      sent.push({ url, method: init?.method ?? "GET" });
      bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
      // Prism answers the documented response a `__code` query names.
      const forced =
        options.code === undefined
          ? url
          : `${url}${url.includes("?") ? "&" : "?"}__code=${options.code}`;
      return globalThis.fetch(forced, init);
    },
  });
  return { ctx, sent, bodies };
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(["--timeout", "10", ...argv], ctx);
  return { code, body: envelope(ctx) as unknown as Body };
}

function client(): ApiClient {
  return new ApiClient({
    baseUrl: server().url,
    token: "pidgen_cli_fake_contract_token",
    account: "ACC-EXAMPLE",
    fetch: globalThis.fetch,
    sleep: async () => {},
    timeoutMs: 10_000,
    maxAttempts: 1,
  });
}

describe("GET /api/v1/me against the Prism mock of the committed document", () => {
  it("pidgen api get /me returns the signed-in User, memberships and CLI token", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "api", "get", "/me");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    const me = body.data as Me;
    expect(me.user).toEqual(
      expect.objectContaining({
        user_id: expect.any(String),
        email: expect.any(String),
        display_name: expect.any(String),
      }),
    );
    expect(Array.isArray(me.memberships)).toBe(true);
    for (const membership of me.memberships) {
      expect(membership).toEqual(
        expect.objectContaining({ account_id: expect.any(String), role: expect.any(String) }),
      );
    }
    expect(me).toHaveProperty("cli_token");
    expect(sent).toEqual([{ url: `${server().url}/api/v1/me`, method: "GET" }]);
  });

  it("the ApiClient unwraps GET /api/v1/me's data", async () => {
    const response = await client().request<Me>({ method: "GET", path: "/api/v1/me" });
    expect(response.status).toBe(200);
    expect(response.data).toEqual(
      expect.objectContaining({ user: expect.any(Object), memberships: expect.any(Array) }),
    );
  });

  it("maps GET /api/v1/me's documented 401 to the auth exit code", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "api", "get", "/me", "--query", "__code=401");
    expect(code).toBe(ExitCode.Auth);
    expect(body.ok).toBe(false);
    expect(body.error).toMatchObject({ code: expect.any(String), details: { status: 401 } });
  });
});

describe("pidgen auth status and pidgen account list against the Prism mock of the committed document", () => {
  it("pidgen auth status with a CLI token reads the User, Account and role from GET /me", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "auth", "status");
    expect(code).toBe(ExitCode.Ok);
    expect(body.ok).toBe(true);
    const data = body.data as { identity: Record<string, unknown>; identity_note: unknown };
    expect(data.identity).toEqual(
      expect.objectContaining({
        user: expect.objectContaining({ user_id: expect.any(String), email: expect.any(String) }),
      }),
    );
    expect(data.identity).toHaveProperty("account");
    expect(data.identity).toHaveProperty("role");
    expect(data.identity_note).toBeNull();
    expect(sent).toEqual([{ url: `${server().url}/api/v1/me`, method: "GET" }]);
  });

  it("pidgen account list with a CLI token merges GET /me's memberships", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "account", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(Array.isArray(body.data)).toBe(true);
    for (const entry of body.data as Array<Record<string, unknown>>) {
      expect(entry).toEqual(
        expect.objectContaining({
          account: expect.any(String),
          member: true,
          credential_stored: false,
          default: false,
        }),
      );
    }
    expect(sent).toEqual([{ url: `${server().url}/api/v1/me`, method: "GET" }]);
  });
});

describe("GET and DELETE /api/v1/me/sessions against the Prism mock of the committed document", () => {
  it("pidgen api get /me/sessions lists sessions and CLI tokens", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "api", "get", "/me/sessions");
    expect(code).toBe(ExitCode.Ok);
    expect(Array.isArray(body.data)).toBe(true);
    for (const entry of body.data as SessionEntry[]) {
      expect(["session", "cli_token"]).toContain(entry.kind);
    }
  });

  it("pidgen api delete /me/sessions/{session_id} revokes one session or token", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "api", "delete", "/me/sessions/tok-example");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data as SessionRevoked).toEqual(
      expect.objectContaining({ revoked: expect.any(Boolean), current: expect.any(Boolean) }),
    );
    expect(sent).toEqual([
      { url: `${server().url}/api/v1/me/sessions/tok-example`, method: "DELETE" },
    ]);
  });

  it("pidgen auth list reads GET /me/sessions and marks the current credential", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "auth", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(Array.isArray(body.data)).toBe(true);
    for (const entry of body.data as Array<Record<string, unknown>>) {
      expect(entry).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          kind: expect.stringMatching(/^(session|cli_token)$/),
          created_at: expect.any(String),
          last_used_at: expect.any(String),
          current: expect.any(Boolean),
        }),
      );
    }
    expect(sent).toEqual([{ url: `${server().url}/api/v1/me/sessions`, method: "GET" }]);
  });

  it("pidgen auth revoke calls DELETE /me/sessions/{session_id}", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "auth", "revoke", "tok-example");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(
      expect.objectContaining({ id: "tok-example", revoked: expect.any(Boolean) }),
    );
    expect(sent).toEqual([
      { url: `${server().url}/api/v1/me/sessions/tok-example`, method: "DELETE" },
    ]);
  });
});

describe("ticket cancellation against the Prism mock of the committed document", () => {
  it("drives the cancellation preview → apply pair through the preview/apply engine", async () => {
    const cancel = serverPreviewApply(client(), {
      command: "ticket cancel",
      target: "PIDGEN-4",
      preview: {
        path: "/tickets/PIDGEN-4/cancellation/preview",
        body: { retain_workspace: false },
      },
      apply: {
        path: "/tickets/PIDGEN-4/cancellation",
        body: { retain_workspace: false, disposition: "cancelled" },
      },
    });
    const options = {
      acknowledgements: [] as string[],
      wait: true,
      timeoutMs: 10_000,
      pollIntervalMs: 0,
      sleep: async () => {},
      now: () => 0,
    };

    const previewed = await runPreviewApply(cancel, { ...options, apply: false });
    if (previewed.mode !== "preview") throw new Error("expected a preview");
    expect(previewed.preview).toEqual(
      expect.objectContaining({
        preview_digest: expect.any(String),
        required_acknowledgements: expect.any(Array),
        plan: expect.any(Object),
      }),
    );

    const result = await runPreviewApply(cancel, {
      ...options,
      apply: true,
      digest: previewed.preview.preview_digest,
      acknowledgements: previewed.preview.required_acknowledgements,
    });
    if (result.mode !== "apply") throw new Error("expected an apply");
    expect(result.settled).toBe(true);
    expect(result.result as CancellationApplyResult).toEqual(
      expect.objectContaining({
        cancellation_id: expect.any(String),
        status: "applied",
        ticket_id: expect.any(String),
        cancelled_ticket_ids: expect.any(Array),
      }),
    );
  });

  it("pidgen api post validates and sends a cancellation apply body", async () => {
    const { ctx } = await setup();
    const file = join(ctx.cwd, "cancel.json");
    await writeFile(
      file,
      JSON.stringify({
        preview_digest: "sha256:abc",
        idempotency_key: "k-1",
        acknowledgements: ["cancels_descendants"],
        disposition: "wont_do",
        reason: "Not needed.",
      }),
    );
    const { code, body } = await run(
      ctx,
      "api",
      "post",
      "/tickets/PIDGEN-4/cancellation",
      "-f",
      file,
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(expect.objectContaining({ cancellation_id: expect.any(String) }));
  });

  it("pidgen ticket cancel previews, then applies with the digest and acknowledgements", async () => {
    const { ctx, sent } = await setup();
    const previewed = await run(ctx, "ticket", "cancel", "PIDGEN-4", "--discard-workspace");
    expect(previewed.code).toBe(ExitCode.Ok);
    const preview = previewed.body.data as {
      preview_digest: string;
      required_acknowledgements: string[];
      plan: unknown;
    };
    expect(preview).toEqual(
      expect.objectContaining({
        preview_digest: expect.any(String),
        required_acknowledgements: expect.any(Array),
        plan: expect.any(Object),
      }),
    );
    expect(sent).toEqual([
      { url: `${server().url}/api/v1/tickets/PIDGEN-4/cancellation/preview`, method: "POST" },
    ]);

    const applied = await run(
      ctx,
      "ticket",
      "cancel",
      "PIDGEN-4",
      "--discard-workspace",
      "--apply",
      "--digest",
      preview.preview_digest,
      "--disposition",
      "wont_do",
      "--reason",
      "Not needed.",
      ...preview.required_acknowledgements.flatMap((code) => ["--ack", code]),
    );
    expect(applied.code).toBe(ExitCode.Ok);
    expect(applied.body.data).toEqual(
      expect.objectContaining({
        settled: true,
        idempotency_key: expect.any(String),
        result: expect.objectContaining({ cancellation_id: expect.any(String) }),
      }),
    );
    expect(sent.at(-1)).toEqual({
      url: `${server().url}/api/v1/tickets/PIDGEN-4/cancellation`,
      method: "POST",
    });
  });

  it("maps the cancellation preview's documented 409 to a refusal", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(
      ctx,
      "api",
      "post",
      "/tickets/PIDGEN-4/cancellation/preview",
      "--query",
      "__code=409",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body.error?.details).toMatchObject({ status: 409 });
  });
});

describe("the cancellation pull-request choice against the Prism mock of the committed document", () => {
  it("pidgen ticket cancel --close-pr previews and applies with close_pull_request true", async () => {
    const { ctx, sent, bodies } = await setup();
    const previewed = await run(ctx, "ticket", "cancel", "PIDGEN-4", "--close-pr");
    expect(previewed.code).toBe(ExitCode.Ok);
    const preview = previewed.body.data as {
      preview_digest: string;
      required_acknowledgements: string[];
      plan: Record<string, unknown>;
    };
    // The plan carries the pull request and the latest delivery operation, each null or an object.
    expect(preview.plan).toHaveProperty("pull_request");
    expect(preview.plan).toHaveProperty("delivery_operation");
    expect(bodies).toEqual([{ retain_workspace: true, close_pull_request: true }]);

    const applied = await run(
      ctx,
      "ticket",
      "cancel",
      "PIDGEN-4",
      "--close-pr",
      "--apply",
      "--digest",
      preview.preview_digest,
      ...preview.required_acknowledgements.flatMap((code) => ["--ack", code]),
    );
    expect(applied.code).toBe(ExitCode.Ok);
    expect(bodies.at(-1)).toMatchObject({ close_pull_request: true, retain_workspace: true });
    expect(sent.map((request) => request.url)).toEqual([
      `${server().url}/api/v1/tickets/PIDGEN-4/cancellation/preview`,
      `${server().url}/api/v1/tickets/PIDGEN-4/cancellation`,
    ]);
    const result = (applied.body.data as { result: CancellationApplyResult }).result;
    expect(result).toEqual(
      expect.objectContaining({
        close_pull_request: expect.any(Boolean),
        pull_request_close: expect.stringMatching(
          /^(not_required|pending|closed|failed|left_open|merged)$/,
        ),
      }),
    );
  });

  it("pidgen ticket cancel without --close-pr sends close_pull_request false to the preview and the apply", async () => {
    const { ctx, bodies } = await setup();
    const previewed = await run(ctx, "ticket", "cancel", "PIDGEN-4");
    expect(previewed.code).toBe(ExitCode.Ok);
    const preview = previewed.body.data as {
      preview_digest: string;
      required_acknowledgements: string[];
    };
    const applied = await run(
      ctx,
      "ticket",
      "cancel",
      "PIDGEN-4",
      "--apply",
      "--digest",
      preview.preview_digest,
      ...preview.required_acknowledgements.flatMap((code) => ["--ack", code]),
    );
    expect(applied.code).toBe(ExitCode.Ok);
    expect(bodies).toEqual([
      { retain_workspace: true, close_pull_request: false },
      expect.objectContaining({ retain_workspace: true, close_pull_request: false }),
    ]);
  });

  it("the request check refuses a close_pull_request that is not a boolean, sending nothing", async () => {
    const { ctx, sent } = await setup();
    const file = join(ctx.cwd, "preview.json");
    await writeFile(file, JSON.stringify({ close_pull_request: "yes" }));
    const refused = await run(
      ctx,
      "api",
      "post",
      "/tickets/PIDGEN-4/cancellation/preview",
      "-f",
      file,
    );
    expect(refused.code).toBe(ExitCode.Usage);
    expect(refused.body.ok).toBe(false);
    expect(sent).toEqual([]);

    await writeFile(file, JSON.stringify({ close_pull_request: true }));
    const accepted = await run(
      ctx,
      "api",
      "post",
      "/tickets/PIDGEN-4/cancellation/preview",
      "-f",
      file,
    );
    expect(accepted.code).toBe(ExitCode.Ok);
  });

  it("pidgen ticket show carries the ticket's outcome pause and cancellation", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "ticket", "show", "PIDGEN-4");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toHaveProperty("outcome_pause");
    expect(body.data).toHaveProperty("cancellation");
  });
});

describe("the delivery operation refusals against the Prism mock of the committed cancellation routes", () => {
  it("a DELIVERY_IN_FLIGHT refusal of the preview prints the operation and exits 5", async () => {
    const { ctx, sent } = await setup({ server: refusalServer, code: 409 });
    const { code, body } = await run(ctx, "ticket", "cancel", "PIDGEN-4", "--close-pr");
    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "DELIVERY_IN_FLIGHT",
      details: { status: 409, operation: IN_FLIGHT },
    });
    expect(sent).toHaveLength(1);
  });

  it("a PUBLICATION_RESULT_UNKNOWN refusal of the apply prints the operation and exits 5", async () => {
    const { ctx, bodies } = await setup({ server: refusalServer, code: 409 });
    const { code, body } = await run(
      ctx,
      "ticket",
      "cancel",
      "PIDGEN-4",
      "--close-pr",
      "--apply",
      "--digest",
      "sha256:example",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "PUBLICATION_RESULT_UNKNOWN",
      details: { status: 409, operation: UNKNOWN },
    });
    expect(bodies).toEqual([expect.objectContaining({ close_pull_request: true })]);
  });
});
