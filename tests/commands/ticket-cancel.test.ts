import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { deriveIdempotencyKey } from "../../src/core/preview.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";

const SERVER = "https://pidgen.example.com";
const TOKEN = "pidgen_pat_fake_token_for_tests";
const REF = "PIDGEN-4";
const CANCEL_PATH = `/api/v1/tickets/${REF}/cancellation`;
const PREVIEW_PATH = `${CANCEL_PATH}/preview`;
const STATUS_PATH = `${CANCEL_PATH}/cnc-example`;

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

const ticket = (key: string, stage: string) => ({
  ticket_id: `tkt-${key.toLowerCase()}`,
  ticket_key: key,
  title: `Ticket ${key}`,
  stage,
});

const PULL_REQUEST = {
  url: "https://git.example.com/acme/web/pulls/17",
  number: 17,
  state: "open",
};

const OPERATION = {
  operation_id: "dop-example",
  kind: "pr_update",
  ownership_generation: 3,
  worker: { host_id: "host-example", name: "worker-1" },
  started_at: "2026-09-28T09:58:00Z",
  observed_at: "2026-09-28T09:59:30Z",
  state: "in_flight",
};

function preview(
  options: {
    digest?: string;
    acks?: string[];
    retain?: boolean;
    pullRequest?: Record<string, unknown> | null;
    operation?: Record<string, unknown> | null;
  } = {},
) {
  const retain = options.retain ?? true;
  return {
    plan: {
      ticket_id: "tkt-pidgen-4",
      ticket_key: REF,
      cancelled_tickets: [ticket("PIDGEN-5", "in_execution"), ticket(REF, "in_execution")],
      descendant_count: 1,
      blocked_dependents: [ticket("PIDGEN-9", "backlog")],
      workspace: {
        workspace_id: "ws-example",
        branch: "pidgen/Pidgen/PIDGEN-4",
        status: "active",
        is_owner: true,
        released: true,
      },
      retain_workspace: retain,
      pull_request: options.pullRequest === undefined ? PULL_REQUEST : options.pullRequest,
      delivery_operation: options.operation === undefined ? null : options.operation,
    },
    preview_digest: options.digest ?? "sha256:cancel-1",
    required_acknowledgements: options.acks ?? ["cancels_descendants"],
  };
}

function applyResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cancellation_id: "cnc-example",
    status: "applied",
    state: "accepted",
    ticket_id: "tkt-pidgen-4",
    disposition: "cancelled",
    superseded_by: null,
    retain_workspace: true,
    close_pull_request: false,
    pull_request_close: "left_open",
    reason: "",
    cancelled_ticket_ids: ["tkt-pidgen-5", "tkt-pidgen-4"],
    requested_at: "2026-09-28T10:00:00Z",
    ...overrides,
  };
}

function ok(data: unknown, status = 200): Response {
  return jsonResponse(
    status,
    { status: "ok", data, meta: null },
    { "x-request-id": "req-example" },
  );
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
async function setup(routes: Record<string, Response[]> = {}) {
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
  await saveConfig(ctx, CONFIG);
  return { ctx, calls };
}

async function cli(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(argv, ctx);
  expect(ctx.out).toHaveLength(1);
  return { code, body: envelope(ctx) as unknown as Body };
}

const routeOf = (call: Call) => `${call.method} ${call.path}`;

const cancelKey = (acks: string[] = [], digest = "sha256:cancel-1") =>
  deriveIdempotencyKey({ command: "ticket cancel", target: REF }, digest, acks);

const APPLY = ["ticket", "cancel", REF, "--apply", "--digest", "sha256:cancel-1"];

describe("pidgen ticket cancel: preview", () => {
  it("previews the cancellation by default and sends nothing else", async () => {
    const { ctx, calls } = await setup({ [`POST ${PREVIEW_PATH}`]: [ok(preview())] });
    const { code, body } = await cli(ctx, "ticket", "cancel", REF);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({
      ok: true,
      error: null,
      data: {
        plan: {
          ticket_key: REF,
          descendant_count: 1,
          cancelled_tickets: [{ ticket_key: "PIDGEN-5" }, { ticket_key: REF }],
          blocked_dependents: [{ ticket_key: "PIDGEN-9" }],
          workspace: { branch: "pidgen/Pidgen/PIDGEN-4", released: true },
          retain_workspace: true,
        },
        preview_digest: "sha256:cancel-1",
        required_acknowledgements: ["cancels_descendants"],
      },
      meta: { request_id: "req-example", profile: "default", account: "ACC-EXAMPLE" },
    });
    expect(calls.map(routeOf)).toEqual([`POST ${PREVIEW_PATH}`]);
    expect(calls[0]?.body).toEqual({ retain_workspace: true, close_pull_request: false });
    expect(calls[0]?.headers["x-pidgen-account"]).toBe("ACC-EXAMPLE");
  });

  it("previews with --discard-workspace sending retain_workspace false", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [
        ok(preview({ retain: false, acks: ["cancels_descendants", "discards_workspace"] })),
      ],
    });
    const { code, body } = await cli(ctx, "ticket", "cancel", REF, "--discard-workspace");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([`POST ${PREVIEW_PATH}`]);
    expect(calls[0]?.body).toEqual({ retain_workspace: false, close_pull_request: false });
    expect(body.data).toMatchObject({
      required_acknowledgements: ["cancels_descendants", "discards_workspace"],
    });
  });

  it("previews with --reason, --disposition and --ack still send only the preview", async () => {
    const { ctx, calls } = await setup({ [`POST ${PREVIEW_PATH}`]: [ok(preview())] });
    const { code } = await cli(
      ctx,
      "ticket",
      "cancel",
      REF,
      "--reason",
      "Not needed",
      "--disposition",
      "wont_do",
      "--ack",
      "cancels_descendants",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([`POST ${PREVIEW_PATH}`]);
  });

  it("previews a ticket named by id, encoded in the route", async () => {
    const { ctx, calls } = await setup({
      [`POST /api/v1/tickets/tkt-example/cancellation/preview`]: [ok(preview())],
    });
    const { code } = await cli(ctx, "ticket", "cancel", "tkt-example");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([`POST /api/v1/tickets/tkt-example/cancellation/preview`]);
  });

  it("a preview that is not a preview exits 1 with UNEXPECTED_RESPONSE", async () => {
    const { ctx } = await setup({ [`POST ${PREVIEW_PATH}`]: [ok({ plan: {} })] });
    const { code, body } = await cli(ctx, "ticket", "cancel", REF);
    expect(code).toBe(ExitCode.Unexpected);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "UNEXPECTED_RESPONSE" } });
  });
});

describe("pidgen ticket cancel: apply", () => {
  it("applies with --digest, the acks, the reason and a derived key, cancelling the ticket", async () => {
    const key = cancelKey(["cancels_descendants"]);
    const { ctx, calls } = await setup({
      [`POST ${CANCEL_PATH}`]: [ok(applyResult({ reason: "Replaced by a new plan" }))],
    });
    const { code, body } = await cli(
      ctx,
      ...APPLY,
      "--ack",
      "cancels-descendants",
      "--reason",
      "Replaced by a new plan",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([`POST ${CANCEL_PATH}`]);
    expect(calls[0]?.body).toEqual({
      retain_workspace: true,
      close_pull_request: false,
      disposition: "cancelled",
      preview_digest: "sha256:cancel-1",
      idempotency_key: key,
      acknowledgements: ["cancels_descendants"],
      reason: "Replaced by a new plan",
    });
    expect(calls[0]?.headers["x-pidgen-account"]).toBe("ACC-EXAMPLE");
    expect(body).toMatchObject({
      ok: true,
      error: null,
      data: {
        settled: true,
        idempotency_key: key,
        result: {
          cancellation_id: "cnc-example",
          status: "applied",
          state: "accepted",
          cancelled_ticket_ids: ["tkt-pidgen-5", "tkt-pidgen-4"],
          reason: "Replaced by a new plan",
        },
      },
      meta: { request_id: "req-example", account: "ACC-EXAMPLE" },
    });
    expect(body.data).not.toHaveProperty("handle");
  });

  it("applies --discard-workspace with retain_workspace false and --ack discards_workspace", async () => {
    const key = cancelKey(["cancels_descendants", "discards_workspace"]);
    const { ctx, calls } = await setup({
      [`POST ${CANCEL_PATH}`]: [ok(applyResult({ retain_workspace: false }))],
    });
    const { code } = await cli(
      ctx,
      ...APPLY,
      "--discard-workspace",
      "--ack",
      "discards_workspace",
      "--ack",
      "cancels_descendants",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toMatchObject({
      retain_workspace: false,
      acknowledgements: ["cancels_descendants", "discards_workspace"],
      idempotency_key: key,
    });
  });

  it("applies --disposition wont-do as wont_do", async () => {
    const { ctx, calls } = await setup({
      [`POST ${CANCEL_PATH}`]: [ok(applyResult({ disposition: "wont_do" }))],
    });
    const { code } = await cli(ctx, ...APPLY, "--disposition", "wont-do");
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toMatchObject({ disposition: "wont_do" });
    expect(calls[0]?.body).not.toHaveProperty("superseded_by");
  });

  it("applies --superseded-by as disposition superseded with superseded_by", async () => {
    const { ctx, calls } = await setup({
      [`POST ${CANCEL_PATH}`]: [
        ok(applyResult({ disposition: "superseded", superseded_by: "tkt-pidgen-7" })),
      ],
    });
    const { code, body } = await cli(ctx, ...APPLY, "--superseded-by", "PIDGEN-7");
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toMatchObject({ disposition: "superseded", superseded_by: "PIDGEN-7" });
    expect(body.data).toMatchObject({ result: { disposition: "superseded" } });
  });

  it("applies with --idempotency-key sending that key", async () => {
    const { ctx, calls } = await setup({ [`POST ${CANCEL_PATH}`]: [ok(applyResult())] });
    const { code, body } = await cli(ctx, ...APPLY, "--idempotency-key", "cancel-example-1");
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toMatchObject({ idempotency_key: "cancel-example-1" });
    expect(body.data).toMatchObject({ idempotency_key: "cancel-example-1" });
  });

  it("applies without a digest a fresh preview that needs no acknowledgement", async () => {
    const key = cancelKey();
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [ok(preview({ acks: [] }))],
      [`POST ${CANCEL_PATH}`]: [ok(applyResult())],
    });
    const { code, body } = await cli(ctx, "ticket", "cancel", REF, "--apply");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([`POST ${PREVIEW_PATH}`, `POST ${CANCEL_PATH}`]);
    expect(calls[0]?.body).toEqual({ retain_workspace: true, close_pull_request: false });
    expect(calls[1]?.body).toMatchObject({
      close_pull_request: false,
      preview_digest: "sha256:cancel-1",
      idempotency_key: key,
      acknowledgements: [],
    });
    expect(body.data).toMatchObject({ settled: true, idempotency_key: key });
  });

  it("applies and, on a 202, --wait follows the status route until it settles", async () => {
    const key = cancelKey(["cancels_descendants"]);
    const applying = applyResult({ status: "applying", status_url: `${SERVER}${STATUS_PATH}` });
    const { ctx, calls } = await setup({
      [`POST ${CANCEL_PATH}`]: [ok(applying, 202)],
      [`GET ${STATUS_PATH}`]: [ok(applying, 202), ok(applyResult({ state: "converged" }))],
    });
    const { code, body } = await cli(ctx, ...APPLY, "--ack", "cancels_descendants");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([
      `POST ${CANCEL_PATH}`,
      `GET ${STATUS_PATH}`,
      `GET ${STATUS_PATH}`,
    ]);
    expect(calls[1]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(body).toMatchObject({
      ok: true,
      data: {
        settled: true,
        idempotency_key: key,
        result: { status: "applied", state: "converged" },
      },
    });
    expect(body.data).not.toHaveProperty("handle");
  });

  it("applies with --no-wait returning at once with the status route as handle", async () => {
    const applying = applyResult({ status: "applying", status_url: `${SERVER}${STATUS_PATH}` });
    const { ctx, calls } = await setup({ [`POST ${CANCEL_PATH}`]: [ok(applying, 202)] });
    const { code, body } = await cli(ctx, ...APPLY, "--ack", "cancels_descendants", "--no-wait");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([`POST ${CANCEL_PATH}`]);
    expect(body.data).toMatchObject({
      settled: false,
      handle: STATUS_PATH,
      result: { status: "applying" },
    });
  });

  it("applies but times out on a 202 that never settles, exiting 8", async () => {
    const applying = () =>
      ok(applyResult({ status: "applying", status_url: `${SERVER}${STATUS_PATH}` }), 202);
    const statuses = Array.from({ length: 20 }, applying);
    const { ctx } = await setup({
      [`POST ${CANCEL_PATH}`]: [applying()],
      [`GET ${STATUS_PATH}`]: statuses,
    });
    const { code, body } = await cli(
      ctx,
      "--timeout",
      "3",
      ...APPLY,
      "--ack",
      "cancels_descendants",
    );
    expect(code).toBe(ExitCode.Network);
    expect(body).toMatchObject({
      ok: false,
      error: { code: "TIMEOUT", details: { handle: STATUS_PATH } },
    });
  });
});

describe("pidgen ticket cancel: stale previews and acknowledgements", () => {
  it("a stale digest exits 6 with PREVIEW_STALE and says to preview again", async () => {
    const { ctx, calls } = await setup({
      [`POST ${CANCEL_PATH}`]: [
        refusal(409, "PREVIEW_STALE", "The subtree changed since the preview."),
      ],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "cancel",
      REF,
      "--apply",
      "--digest",
      "sha256:old",
      "--ack",
      "cancels_descendants",
    );
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "PREVIEW_STALE" } });
    expect(String(body.error?.details["next"])).toContain("Preview again");
    expect(calls.map(routeOf)).toEqual([`POST ${CANCEL_PATH}`]);
  });

  it("a stale digest answered as a 200 refusal also exits 6 with PREVIEW_STALE", async () => {
    const { ctx } = await setup({
      [`POST ${CANCEL_PATH}`]: [ok({ status: "refused", disposition_code: "PREVIEW_STALE" })],
    });
    const { code, body } = await cli(ctx, ...APPLY);
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body.error?.code).toBe("PREVIEW_STALE");
  });

  it("a missing acknowledgement exits 6 with ACKNOWLEDGEMENT_REQUIRED naming the --ack", async () => {
    const { ctx } = await setup({
      [`POST ${CANCEL_PATH}`]: [
        refusal(409, "ACKNOWLEDGEMENT_REQUIRED", "An acknowledgement is missing.", {
          missing: ["cancels_descendants"],
        }),
      ],
    });
    const { code, body } = await cli(ctx, ...APPLY);
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "ACKNOWLEDGEMENT_REQUIRED", details: { missing: ["cancels_descendants"] } },
    });
    expect(String(body.error?.details["next"])).toContain("--ack cancels_descendants");
  });

  it("a missing acknowledgement without --digest exits 6 with DIGEST_REQUIRED and sends no apply", async () => {
    const { ctx, calls } = await setup({ [`POST ${PREVIEW_PATH}`]: [ok(preview())] });
    const { code, body } = await cli(ctx, "ticket", "cancel", REF, "--apply");
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "DIGEST_REQUIRED",
        details: { preview: { required_acknowledgements: ["cancels_descendants"] } },
      },
    });
    expect(calls.map(routeOf)).toEqual([`POST ${PREVIEW_PATH}`]);
  });
});

describe("pidgen ticket cancel: refused", () => {
  for (const code of ["ALREADY_TERMINAL", "ALREADY_DELIVERED", "DELIVERY_IN_FLIGHT"]) {
    it(`refused preview with ${code} keeps the server's code and exits 5`, async () => {
      const { ctx, calls } = await setup({
        [`POST ${PREVIEW_PATH}`]: [refusal(409, code, "The ticket cannot be cancelled.")],
      });
      const result = await cli(ctx, "ticket", "cancel", REF);
      expect(result.code).toBe(ExitCode.Refused);
      expect(result.body).toMatchObject({
        ok: false,
        data: null,
        error: { code, message: "The ticket cannot be cancelled." },
      });
      expect(calls.map(routeOf)).toEqual([`POST ${PREVIEW_PATH}`]);
    });
  }

  it("refused apply with DELIVERY_IN_FLIGHT keeps the server's code and exits 5", async () => {
    const { ctx } = await setup({
      [`POST ${CANCEL_PATH}`]: [refusal(409, "DELIVERY_IN_FLIGHT", "A delivery is in progress.")],
    });
    const { code, body } = await cli(ctx, ...APPLY);
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({ ok: false, error: { code: "DELIVERY_IN_FLIGHT" } });
  });

  it("refused: an unknown superseding ticket keeps SUPERSEDING_TICKET_NOT_FOUND", async () => {
    const { ctx } = await setup({
      [`POST ${CANCEL_PATH}`]: [
        refusal(422, "SUPERSEDING_TICKET_NOT_FOUND", "superseded_by names no ticket."),
      ],
    });
    const { code, body } = await cli(ctx, ...APPLY, "--superseded-by", "PIDGEN-99");
    expect(code).not.toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: false, error: { code: "SUPERSEDING_TICKET_NOT_FOUND" } });
  });

  it("refused: an unknown ticket exits 4 with TICKET_NOT_FOUND", async () => {
    const { ctx } = await setup({
      [`POST ${PREVIEW_PATH}`]: [refusal(404, "TICKET_NOT_FOUND", "No such ticket.")],
    });
    const { code, body } = await cli(ctx, "ticket", "cancel", REF);
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "TICKET_NOT_FOUND" } });
  });
});

describe("pidgen ticket cancel: the pull-request choice", () => {
  it("--close-pr previews with close_pull_request true and sends nothing else", async () => {
    const { ctx, calls } = await setup({ [`POST ${PREVIEW_PATH}`]: [ok(preview())] });
    const { code } = await cli(ctx, "ticket", "cancel", REF, "--close-pr");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([`POST ${PREVIEW_PATH}`]);
    expect(calls[0]?.body).toEqual({ retain_workspace: true, close_pull_request: true });
  });

  it("--close-pr goes with --discard-workspace", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [ok(preview({ retain: false }))],
    });
    const { code } = await cli(ctx, "ticket", "cancel", REF, "--close-pr", "--discard-workspace");
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual({ retain_workspace: false, close_pull_request: true });
  });

  it("the preview shows the pull request (number, state) and the latest delivery operation", async () => {
    const { ctx } = await setup({
      [`POST ${PREVIEW_PATH}`]: [ok(preview({ operation: { ...OPERATION, state: "settled" } }))],
    });
    const { code, body } = await cli(ctx, "ticket", "cancel", REF);
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({
      plan: {
        pull_request: { url: PULL_REQUEST.url, number: 17, state: "open" },
        delivery_operation: {
          operation_id: "dop-example",
          kind: "pr_update",
          ownership_generation: 3,
          worker: { host_id: "host-example", name: "worker-1" },
          started_at: "2026-09-28T09:58:00Z",
          observed_at: "2026-09-28T09:59:30Z",
          state: "settled",
        },
      },
    });
  });

  it("the preview of a ticket with no pull request and no delivery operation shows null for both", async () => {
    const { ctx } = await setup({
      [`POST ${PREVIEW_PATH}`]: [ok(preview({ pullRequest: null, operation: null }))],
    });
    const { code, body } = await cli(ctx, "ticket", "cancel", REF, "--close-pr");
    expect(code).toBe(ExitCode.Ok);
    const plan = (body.data as { plan: Record<string, unknown> }).plan;
    expect(plan).toHaveProperty("pull_request", null);
    expect(plan).toHaveProperty("delivery_operation", null);
  });

  it("the default apply sends close_pull_request false and the result says the pull request is left open", async () => {
    const { ctx, calls } = await setup({ [`POST ${CANCEL_PATH}`]: [ok(applyResult())] });
    const { code, body } = await cli(ctx, ...APPLY, "--ack", "cancels_descendants");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([`POST ${CANCEL_PATH}`]);
    expect(calls[0]?.body).toMatchObject({ close_pull_request: false });
    expect(body.data).toMatchObject({
      settled: true,
      result: { close_pull_request: false, pull_request_close: "left_open" },
    });
  });

  it("--close-pr applies with close_pull_request true and the result reports the pull request closed", async () => {
    const key = cancelKey(["cancels_descendants"]);
    const { ctx, calls } = await setup({
      [`POST ${CANCEL_PATH}`]: [
        ok(applyResult({ close_pull_request: true, pull_request_close: "closed" })),
      ],
    });
    const { code, body } = await cli(ctx, ...APPLY, "--ack", "cancels_descendants", "--close-pr");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([`POST ${CANCEL_PATH}`]);
    expect(calls[0]?.body).toEqual({
      retain_workspace: true,
      close_pull_request: true,
      disposition: "cancelled",
      preview_digest: "sha256:cancel-1",
      idempotency_key: key,
      acknowledgements: ["cancels_descendants"],
    });
    expect(body.data).toMatchObject({
      settled: true,
      idempotency_key: key,
      result: { close_pull_request: true, pull_request_close: "closed" },
    });
  });

  it("--close-pr with no --digest sends close_pull_request true on both the preview and the apply", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [ok(preview({ acks: [] }))],
      [`POST ${CANCEL_PATH}`]: [
        ok(applyResult({ close_pull_request: true, pull_request_close: "pending" })),
      ],
    });
    const { code, body } = await cli(ctx, "ticket", "cancel", REF, "--apply", "--close-pr");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([`POST ${PREVIEW_PATH}`, `POST ${CANCEL_PATH}`]);
    expect(calls[0]?.body).toEqual({ retain_workspace: true, close_pull_request: true });
    expect(calls[1]?.body).toMatchObject({ close_pull_request: true });
    expect(body.data).toMatchObject({ result: { pull_request_close: "pending" } });
  });

  it("without --close-pr and without --digest, both the preview and the apply send close_pull_request false", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [ok(preview({ acks: [] }))],
      [`POST ${CANCEL_PATH}`]: [ok(applyResult())],
    });
    const { code } = await cli(ctx, "ticket", "cancel", REF, "--apply");
    expect(code).toBe(ExitCode.Ok);
    expect((calls[0]?.body as Record<string, unknown>)["close_pull_request"]).toBe(false);
    expect((calls[1]?.body as Record<string, unknown>)["close_pull_request"]).toBe(false);
  });

  it("an apply whose choice differs from its preview's is PREVIEW_STALE: exit 6, preview again", async () => {
    const { ctx, calls } = await setup({
      [`POST ${CANCEL_PATH}`]: [
        refusal(409, "PREVIEW_STALE", "close_pull_request differs from the previewed value."),
      ],
    });
    const { code, body } = await cli(ctx, ...APPLY, "--ack", "cancels_descendants", "--close-pr");
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "PREVIEW_STALE", details: { status: 409 } },
    });
    expect(String(body.error?.details["next"])).toContain("Preview again");
    expect(calls.map(routeOf)).toEqual([`POST ${CANCEL_PATH}`]);
    expect(calls[0]?.body).toMatchObject({ close_pull_request: true });
  });

  it("against a server that does not publish the choice, the command still works", async () => {
    const legacyPreview = preview();
    delete (legacyPreview.plan as Record<string, unknown>)["pull_request"];
    delete (legacyPreview.plan as Record<string, unknown>)["delivery_operation"];
    const legacyResult = applyResult();
    delete legacyResult["close_pull_request"];
    delete legacyResult["pull_request_close"];
    const { ctx } = await setup({
      [`POST ${PREVIEW_PATH}`]: [ok(legacyPreview)],
      [`POST ${CANCEL_PATH}`]: [ok(legacyResult)],
    });
    const previewed = await cli(ctx, "ticket", "cancel", REF, "--close-pr");
    expect(previewed.code).toBe(ExitCode.Ok);
    expect(previewed.body.data).toMatchObject({ preview_digest: "sha256:cancel-1" });
    const applied = await cli(ctx, ...APPLY, "--ack", "cancels_descendants", "--close-pr");
    expect(applied.code).toBe(ExitCode.Ok);
    expect(applied.body.data).toMatchObject({ settled: true, result: { status: "applied" } });
  });

  it("a server that refuses the choice with its own code keeps that code and exit status", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [
        refusal(422, "INPUT_INVALID", "The request failed validation.", {
          errors: [{ loc: ["body", "close_pull_request"], msg: "Extra inputs", type: "extra" }],
        }),
      ],
    });
    const { code, body } = await cli(ctx, "ticket", "cancel", REF, "--close-pr");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "INPUT_INVALID", details: { status: 422 } },
    });
    expect(calls.map(routeOf)).toEqual([`POST ${PREVIEW_PATH}`]);
  });
});

describe("pidgen ticket cancel: delivery operation refusals", () => {
  for (const [code, state] of [
    ["DELIVERY_IN_FLIGHT", "in_flight"],
    ["PUBLICATION_RESULT_UNKNOWN", "unknown"],
  ] as const) {
    const operation = { ...OPERATION, state };

    it(`a ${code} refusal of the preview prints the operation, keeps its code and exits 5`, async () => {
      const { ctx, calls } = await setup({
        [`POST ${PREVIEW_PATH}`]: [
          refusal(409, code, "A delivery operation blocks the cancellation.", { operation }),
        ],
      });
      const result = await cli(ctx, "ticket", "cancel", REF);
      expect(result.code).toBe(ExitCode.Refused);
      expect(result.body).toMatchObject({
        ok: false,
        data: null,
        error: {
          code,
          message: "A delivery operation blocks the cancellation.",
          details: { status: 409, operation },
        },
      });
      expect(calls.map(routeOf)).toEqual([`POST ${PREVIEW_PATH}`]);
    });

    it(`a ${code} refusal of the apply with --close-pr prints the operation, keeps its code and exits 5`, async () => {
      const { ctx, calls } = await setup({
        [`POST ${CANCEL_PATH}`]: [
          refusal(409, code, "A delivery operation blocks the cancellation.", { operation }),
        ],
      });
      const result = await cli(ctx, ...APPLY, "--close-pr");
      expect(result.code).toBe(ExitCode.Refused);
      expect(result.body).toMatchObject({
        ok: false,
        data: null,
        error: { code, details: { status: 409, operation } },
      });
      expect(calls.map(routeOf)).toEqual([`POST ${CANCEL_PATH}`]);
      expect(calls[0]?.body).toMatchObject({ close_pull_request: true });
    });

    it(`a ${code} refusal answered with 200 and no digest still prints the operation and exits 5`, async () => {
      const { ctx } = await setup({
        [`POST ${PREVIEW_PATH}`]: [
          ok({ status: "refused", disposition_code: code, result: { operation } }),
        ],
      });
      const result = await cli(ctx, "ticket", "cancel", REF, "--apply");
      expect(result.code).toBe(ExitCode.Refused);
      expect(result.body.error?.code).toBe(code);
      expect(JSON.stringify(result.body.error?.details)).toContain("dop-example");
    });
  }
});

describe("pidgen ticket cancel: documentation", () => {
  it("docs/commands.md documents --close-pr and that the default leaves an open pull request open", async () => {
    const text = await readFile(new URL("../../docs/commands.md", import.meta.url), "utf8");
    const section = text.slice(
      text.indexOf("### ticket cancel"),
      text.indexOf("### ticket clarify"),
    );
    expect(section).toContain("--close-pr");
    expect(section).toContain("close_pull_request");
    expect(section).toMatch(
      /default[^.]*`close_pull_request: false`[^.]*open pull request is\s+left open/,
    );
    expect(section).toContain("PREVIEW_STALE");
    expect(section).toContain("pull_request_close");
    expect(section).toContain("DELIVERY_IN_FLIGHT");
    expect(section).toContain("PUBLICATION_RESULT_UNKNOWN");
    expect(section).toContain("error.details.operation");
    expect(section).toContain("delivery_operation");
    // The command table lists the flag too.
    expect(text).toMatch(/\| `pidgen ticket cancel <ref>[^|]*\[--close-pr\]`/);
  });
});

describe("pidgen ticket cancel: usage errors", () => {
  const usage = async (...argv: string[]) => {
    const { ctx, calls } = await setup();
    const { code, body } = await cli(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toEqual([]);
  };

  it("usage: a missing ticket reference exits 2 and sends nothing", async () => {
    await usage("ticket", "cancel");
  });

  it("usage: an empty or malformed ticket reference exits 2", async () => {
    for (const ref of ["", "..", "../PIDGEN-4"]) await usage("ticket", "cancel", ref);
  });

  it("usage: --digest without --apply exits 2", async () => {
    await usage("ticket", "cancel", REF, "--digest", "sha256:cancel-1");
  });

  it("usage: a malformed --ack code exits 2", async () => {
    await usage("ticket", "cancel", REF, "--apply", "--ack", "not a code");
  });

  it("usage: an unknown --disposition exits 2", async () => {
    await usage("ticket", "cancel", REF, "--disposition", "deleted");
  });

  it("usage: --disposition superseded without --superseded-by exits 2", async () => {
    await usage("ticket", "cancel", REF, "--apply", "--disposition", "superseded");
  });

  it("usage: --superseded-by with another disposition, or malformed, exits 2", async () => {
    await usage("ticket", "cancel", REF, "--superseded-by", "PIDGEN-7", "--disposition", "wont_do");
    await usage("ticket", "cancel", REF, "--superseded-by", "../PIDGEN-7");
  });

  it("usage: an extra argument exits 2", async () => {
    await usage("ticket", "cancel", REF, "PIDGEN-5");
  });

  it("usage: --close-pr takes no value, so one is an extra argument, exit 2", async () => {
    await usage("ticket", "cancel", REF, "--close-pr", "true");
  });
});
