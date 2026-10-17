import { describe, expect, it, vi } from "vitest";
import { CliError } from "../../src/core/errors.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { ApiClient } from "../../src/core/http.js";
import {
  deriveIdempotencyKey,
  normalizeAcknowledgements,
  runPreviewApply,
  serverPreviewApply,
  type Outcome,
  type Preview,
  type PreviewApplyOperation,
  type PreviewApplyOptions,
} from "../../src/core/preview.js";

function operation(preview: Preview, applyOutcome: Outcome, statuses: Outcome[] = []) {
  return {
    command: "ticket retry",
    target: "PIDGEN-4",
    preview: vi.fn(async () => preview),
    apply: vi.fn(async () => applyOutcome),
    status: vi.fn(async () => statuses.shift() ?? { settled: false, result: null }),
  } satisfies PreviewApplyOperation;
}

function options(overrides: Partial<PreviewApplyOptions> = {}): PreviewApplyOptions {
  let clock = 0;
  return {
    apply: false,
    acknowledgements: [],
    wait: true,
    timeoutMs: 10_000,
    pollIntervalMs: 1000,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...overrides,
  };
}

const plain: Preview = { preview_digest: "sha256:aaa", required_acknowledgements: [] };
const needsAck: Preview = {
  preview_digest: "sha256:bbb",
  required_acknowledgements: ["ambiguous_effects"],
};

describe("runPreviewApply", () => {
  it("only previews without --apply", async () => {
    const op = operation(plain, { settled: true, result: null });
    expect(await runPreviewApply(op, options())).toEqual({ mode: "preview", preview: plain });
    expect(op.apply).not.toHaveBeenCalled();
  });

  it("applies a fresh preview's digest when no acknowledgement is needed", async () => {
    const op = operation(plain, { settled: true, result: { status: "applied" } });
    const result = await runPreviewApply(op, options({ apply: true }));
    expect(result).toMatchObject({ mode: "apply", settled: true, result: { status: "applied" } });
    expect(op.apply).toHaveBeenCalledWith(
      expect.objectContaining({ preview_digest: "sha256:aaa", acknowledgements: [] }),
    );
  });

  it("refuses --apply without --digest when the preview needs acknowledgements", async () => {
    const op = operation(needsAck, { settled: true, result: null });
    await expect(runPreviewApply(op, options({ apply: true }))).rejects.toMatchObject({
      code: "DIGEST_REQUIRED",
      exitCode: ExitCode.ConfirmationRequired,
      details: { preview: needsAck },
    });
    expect(op.apply).not.toHaveBeenCalled();
  });

  it("applies exactly the digest given, with normalized acknowledgements", async () => {
    const op = operation(needsAck, { settled: true, result: null });
    await runPreviewApply(
      op,
      options({ apply: true, digest: "sha256:bbb", acknowledgements: ["ambiguous-effects"] }),
    );
    expect(op.preview).not.toHaveBeenCalled();
    expect(op.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        preview_digest: "sha256:bbb",
        acknowledgements: ["ambiguous_effects"],
      }),
    );
  });

  it("derives the same idempotency key for the same apply", async () => {
    const first = operation(plain, { settled: true, result: null });
    const second = operation(plain, { settled: true, result: null });
    const a = await runPreviewApply(first, options({ apply: true, digest: "sha256:aaa" }));
    const b = await runPreviewApply(second, options({ apply: true, digest: "sha256:aaa" }));
    expect(a).toMatchObject({ idempotency_key: expect.stringMatching(/^pidgen-[0-9a-f]{32}$/) });
    expect(a).toEqual(b);
    expect(deriveIdempotencyKey(first, "sha256:other", [])).not.toBe(
      (a as { idempotency_key: string }).idempotency_key,
    );
  });

  it("waits for an unsettled apply to settle", async () => {
    const op = operation(plain, { settled: false, result: null, handle: "req-1" }, [
      { settled: false, result: { status: "applying" } },
      { settled: true, result: { status: "applied" } },
    ]);
    const result = await runPreviewApply(op, options({ apply: true }));
    expect(result).toMatchObject({ settled: true, result: { status: "applied" } });
    expect(op.status).toHaveBeenCalledTimes(2);
  });

  it("returns immediately with --no-wait", async () => {
    const op = operation(plain, { settled: false, result: null, handle: "req-1" });
    const result = await runPreviewApply(op, options({ apply: true, wait: false }));
    expect(result).toMatchObject({ settled: false, handle: "req-1" });
    expect(op.status).not.toHaveBeenCalled();
  });

  it("times out with exit 8 and leaves the operation running", async () => {
    const op = operation(plain, { settled: false, result: null, handle: "req-1" });
    await expect(
      runPreviewApply(op, options({ apply: true, timeoutMs: 3000 })),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      exitCode: ExitCode.Network,
      details: { handle: "req-1" },
    });
  });

  it("rejects --digest without --apply", async () => {
    const op = operation(plain, { settled: true, result: null });
    await expect(runPreviewApply(op, options({ digest: "sha256:aaa" }))).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    });
  });
});

describe("normalizeAcknowledgements", () => {
  it("accepts kebab or snake case, dedupes and sorts", () => {
    expect(
      normalizeAcknowledgements(["completed-source", "AMBIGUOUS_EFFECTS", "completed_source"]),
    ).toEqual(["ambiguous_effects", "completed_source"]);
  });

  it("rejects malformed codes", () => {
    expect(() => normalizeAcknowledgements(["not a code"])).toThrow();
  });
});

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

/** A fake App Service answering the published convention; each route answers its queue in order. */
function fakeServer(routes: Record<string, Response[]>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const method = init?.method ?? "GET";
    const key = `${method} ${parsed.pathname}`;
    calls.push({
      method,
      path: parsed.pathname,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
    });
    const next = routes[key]?.shift();
    if (next === undefined) throw new Error(`unexpected request ${key}`);
    return next;
  });
  const api = new ApiClient({
    baseUrl: "https://pidgen.example.com",
    token: "pidgen_cli_example_token",
    account: "ACC-EXAMPLE",
    fetch: fetchImpl as unknown as typeof fetch,
    sleep: async () => {},
    timeoutMs: 1000,
    maxAttempts: 1,
  });
  return { api, calls, fetchImpl };
}

function ok(status: number, data: unknown): Response {
  return new Response(JSON.stringify({ status: "ok", data, meta: null }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function refused(status: number, code: string, message: string, details: object | null = null) {
  return new Response(
    JSON.stringify({
      status: "error",
      error: { code, message, details, request_id: "req-example" },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

const PREVIEW_PATH = "/api/v1/tickets/PIDGEN-4/child-plan/preview";
const APPLY_PATH = "/api/v1/tickets/PIDGEN-4/child-plan";
const STATUS_PATH = "/api/v1/tickets/PIDGEN-4/child-plan/applications/cmd-1";
const PLAN = { items: [{ title: "Example child" }] };

function childPlan(api: ApiClient) {
  return serverPreviewApply(api, {
    command: "plan apply",
    target: "PIDGEN-4",
    preview: { path: "/tickets/PIDGEN-4/child-plan/preview", body: { plan: PLAN } },
    apply: { method: "PUT", path: "/tickets/PIDGEN-4/child-plan", body: { plan: PLAN } },
  });
}

const serverPreview = {
  plan: PLAN,
  preview_digest: "sha256:ccc",
  required_acknowledgements: ["supersedes_children"],
  effects: { creates: 1 },
};

function applying(status = "applying") {
  return {
    command_id: "cmd-1",
    status,
    status_url: `https://pidgen.example.com${STATUS_PATH}`,
    root_ticket_id: "PIDGEN-4",
  };
}

describe("runPreviewApply on the server's convention", () => {
  it("server preview returns the digest and required acknowledgements and changes nothing", async () => {
    const server = fakeServer({ [`POST ${PREVIEW_PATH}`]: [ok(200, serverPreview)] });
    const result = await runPreviewApply(childPlan(server.api), options());
    expect(result).toEqual({ mode: "preview", preview: serverPreview });
    if (result.mode !== "preview") throw new Error("expected a preview");
    expect(result.preview.preview_digest).toBe("sha256:ccc");
    expect(result.preview.required_acknowledgements).toEqual(["supersedes_children"]);
    // Only the preview route was called, and it is not the apply route.
    expect(server.calls).toEqual([{ method: "POST", path: PREVIEW_PATH, body: { plan: PLAN } }]);
  });

  it("server preview refuses a response that lacks the convention's fields", async () => {
    const server = fakeServer({ [`POST ${PREVIEW_PATH}`]: [ok(200, { plan: PLAN })] });
    await expect(runPreviewApply(childPlan(server.api), options())).rejects.toMatchObject({
      code: "UNEXPECTED_RESPONSE",
      exitCode: ExitCode.Unexpected,
    });
  });

  it("server apply sends the digest, acknowledgements, reason and a derived idempotency key", async () => {
    const server = fakeServer({
      [`PUT ${APPLY_PATH}`]: [ok(200, applying("applied"))],
    });
    const op = childPlan(server.api);
    const result = await runPreviewApply(
      op,
      options({
        apply: true,
        digest: "sha256:ccc",
        acknowledgements: ["supersedes-children"],
        reason: "Split the work in two",
      }),
    );
    const key = deriveIdempotencyKey(op, "sha256:ccc", ["supersedes_children"]);
    expect(key).toMatch(/^pidgen-[0-9a-f]{32}$/);
    expect(server.calls).toEqual([
      {
        method: "PUT",
        path: APPLY_PATH,
        body: {
          plan: PLAN,
          preview_digest: "sha256:ccc",
          idempotency_key: key,
          acknowledgements: ["supersedes_children"],
          reason: "Split the work in two",
        },
      },
    ]);
    expect(result).toMatchObject({ mode: "apply", settled: true, idempotency_key: key });
  });

  it("server apply sends --idempotency-key unchanged and adds no acknowledgement", async () => {
    const server = fakeServer({ [`PUT ${APPLY_PATH}`]: [ok(200, applying("applied"))] });
    await runPreviewApply(
      childPlan(server.api),
      options({ apply: true, digest: "sha256:ccc", idempotencyKey: "my-key-1" }),
    );
    expect(server.calls[0]?.body).toMatchObject({
      idempotency_key: "my-key-1",
      acknowledgements: [],
    });
    expect(server.calls[0]?.body).not.toHaveProperty("reason");
  });

  it("server apply without --digest applies a fresh preview's digest when it needs no acknowledgement", async () => {
    const server = fakeServer({
      [`POST ${PREVIEW_PATH}`]: [ok(200, { ...serverPreview, required_acknowledgements: [] })],
      [`PUT ${APPLY_PATH}`]: [ok(200, applying("applied"))],
    });
    await runPreviewApply(childPlan(server.api), options({ apply: true }));
    expect(server.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST ${PREVIEW_PATH}`,
      `PUT ${APPLY_PATH}`,
    ]);
    expect(server.calls[1]?.body).toMatchObject({
      preview_digest: "sha256:ccc",
      acknowledgements: [],
    });
  });

  it("settles a 202 by polling its status route with --wait", async () => {
    const server = fakeServer({
      [`PUT ${APPLY_PATH}`]: [ok(202, applying())],
      [`GET ${STATUS_PATH}`]: [ok(202, applying()), ok(200, { ...applying("applied"), items: [] })],
    });
    const result = await runPreviewApply(
      childPlan(server.api),
      options({ apply: true, digest: "sha256:ccc", acknowledgements: ["supersedes_children"] }),
    );
    expect(result).toMatchObject({
      mode: "apply",
      settled: true,
      result: { command_id: "cmd-1", status: "applied", items: [] },
    });
    // The absolute status_url is read from the configured server by its path.
    expect(server.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `PUT ${APPLY_PATH}`,
      `GET ${STATUS_PATH}`,
      `GET ${STATUS_PATH}`,
    ]);
  });

  it("settles nothing with --no-wait and returns the status route to check later", async () => {
    const server = fakeServer({ [`PUT ${APPLY_PATH}`]: [ok(202, applying())] });
    const result = await runPreviewApply(
      childPlan(server.api),
      options({ apply: true, digest: "sha256:ccc", wait: false }),
    );
    expect(result).toMatchObject({ settled: false, handle: STATUS_PATH });
    expect(server.calls).toHaveLength(1);
  });

  it("never sends the credential to another origin named by status_url", async () => {
    const server = fakeServer({
      [`PUT ${APPLY_PATH}`]: [
        ok(202, { ...applying(), status_url: `https://elsewhere.example.org${STATUS_PATH}` }),
      ],
      [`GET ${STATUS_PATH}`]: [ok(200, applying("applied"))],
    });
    await runPreviewApply(childPlan(server.api), options({ apply: true, digest: "sha256:ccc" }));
    const urls = server.fetchImpl.mock.calls.map(([url]) => new URL(String(url)).origin);
    expect(new Set(urls)).toEqual(new Set(["https://pidgen.example.com"]));
  });

  it("exits 6 on a stale preview (confirmation) and says to preview again", async () => {
    const server = fakeServer({
      [`PUT ${APPLY_PATH}`]: [refused(409, "PREVIEW_STALE", "The plan changed since the preview.")],
    });
    const error = await runPreviewApply(
      childPlan(server.api),
      options({ apply: true, digest: "sha256:old" }),
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({
      code: "PREVIEW_STALE",
      exitCode: ExitCode.ConfirmationRequired,
      details: {
        status: 409,
        request_id: "req-example",
        next: expect.stringMatching(/preview again/i),
      },
    });
    expect((error as CliError).message).toMatch(/--digest/);
  });

  it("exits 6 on a missing acknowledgement (confirmation), naming the codes and adding none", async () => {
    const server = fakeServer({
      [`PUT ${APPLY_PATH}`]: [
        refused(409, "ACKNOWLEDGEMENT_REQUIRED", "Acknowledge the superseded children.", {
          missing: ["supersedes_children"],
        }),
      ],
    });
    const error = await runPreviewApply(
      childPlan(server.api),
      options({ apply: true, digest: "sha256:ccc" }),
    ).catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: "ACKNOWLEDGEMENT_REQUIRED",
      exitCode: ExitCode.ConfirmationRequired,
      details: {
        missing: ["supersedes_children"],
        next: expect.stringContaining("--ack supersedes_children"),
      },
    });
    // One apply, sent with only what the caller passed: no acknowledgement added, no retry.
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.body).toMatchObject({ acknowledgements: [] });
  });

  it("exits 6 when a polled status route reports a stale preview (confirmation)", async () => {
    const server = fakeServer({
      [`PUT ${APPLY_PATH}`]: [ok(202, applying())],
      [`GET ${STATUS_PATH}`]: [refused(409, "PREVIEW_STALE", "The plan changed.")],
    });
    await expect(
      runPreviewApply(childPlan(server.api), options({ apply: true, digest: "sha256:ccc" })),
    ).rejects.toMatchObject({ code: "PREVIEW_STALE", exitCode: ExitCode.ConfirmationRequired });
  });

  it("exits 5 on a refusal of the apply with the server's code", async () => {
    const server = fakeServer({
      [`PUT ${APPLY_PATH}`]: [
        refused(409, "PLAN_ALREADY_ADMITTED", "The plan was already admitted.", {
          ticket: "PIDGEN-4",
        }),
      ],
    });
    await expect(
      runPreviewApply(childPlan(server.api), options({ apply: true, digest: "sha256:ccc" })),
    ).rejects.toMatchObject({
      code: "PLAN_ALREADY_ADMITTED",
      message: "The plan was already admitted.",
      exitCode: ExitCode.Refused,
      details: { status: 409, ticket: "PIDGEN-4" },
    });
  });

  it("exits 5 on a refusal reported by the polled status route with the server's code", async () => {
    const server = fakeServer({
      [`PUT ${APPLY_PATH}`]: [ok(202, applying())],
      [`GET ${STATUS_PATH}`]: [
        refused(409, "WORKSPACE_MUTATION_ACTIVE", "A workspace change is in progress."),
      ],
    });
    await expect(
      runPreviewApply(childPlan(server.api), options({ apply: true, digest: "sha256:ccc" })),
    ).rejects.toMatchObject({ code: "WORKSPACE_MUTATION_ACTIVE", exitCode: ExitCode.Refused });
  });

  it("exits 5 on a refusal of the preview with the server's code", async () => {
    const server = fakeServer({
      [`POST ${PREVIEW_PATH}`]: [
        refused(409, "HIGH_LEVEL_TICKET_REQUIRED", "The Ticket has a parent."),
      ],
    });
    await expect(runPreviewApply(childPlan(server.api), options())).rejects.toMatchObject({
      code: "HIGH_LEVEL_TICKET_REQUIRED",
      exitCode: ExitCode.Refused,
    });
  });
});
