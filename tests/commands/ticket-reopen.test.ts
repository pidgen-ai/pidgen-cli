import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { deriveIdempotencyKey } from "../../src/core/preview.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";

const SERVER = "https://pidgen.example.com";
const TOKEN = "pidgen_pat_fake_token_for_tests";
const REF = "PIDGEN-4";
const REOPEN_PATH = `/api/v1/tickets/${REF}/reopen`;
const PREVIEW_PATH = `${REOPEN_PATH}/preview`;

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

function preview(options: { digest?: string; acks?: string[] } = {}) {
  return {
    plan: {
      ticket_id: "tkt-example",
      from_stage: "completed",
      to_stage: "awaiting_review",
      violated_invariants: ["completed_without_delivery"],
      invariant_details: ["The ticket is completed but has no verified delivery."],
      delivery: { delivery_id: "dlv-example", kind: "unverified_claim", verified: false },
      execution_run_statuses: ["failed"],
    },
    preview_digest: options.digest ?? "sha256:reopen-1",
    required_acknowledgements: options.acks ?? [],
  };
}

function applyResult(reason = "") {
  return {
    command_id: "cmd-1",
    status: "applied",
    ticket_id: "tkt-example",
    from_stage: "completed",
    to_stage: "awaiting_review",
    violated_invariants: ["completed_without_delivery"],
    deliveries_superseded: 1,
    findings_resolved: 1,
    preview_digest: "sha256:reopen-1",
    reason,
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

const reopenKey = (acks: string[] = [], digest = "sha256:reopen-1") =>
  deriveIdempotencyKey({ command: "ticket reopen", target: REF }, digest, acks);

describe("pidgen ticket reopen: preview", () => {
  it("preview shows the reopen plan and digest, changing nothing", async () => {
    const { ctx, calls } = await setup({ [`POST ${PREVIEW_PATH}`]: [ok(preview())] });
    const { code, body } = await cli(ctx, "ticket", "reopen", REF);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({
      ok: true,
      error: null,
      data: {
        plan: {
          from_stage: "completed",
          to_stage: "awaiting_review",
          violated_invariants: ["completed_without_delivery"],
          delivery: { delivery_id: "dlv-example", verified: false },
        },
        preview_digest: "sha256:reopen-1",
        required_acknowledgements: [],
      },
      meta: { request_id: "req-example", profile: "default", account: "ACC-EXAMPLE" },
    });
    expect(calls.map(routeOf)).toEqual([`POST ${PREVIEW_PATH}`]);
    expect(calls[0]?.headers["x-pidgen-account"]).toBe("ACC-EXAMPLE");
  });

  it("preview encodes a ticket id in the route", async () => {
    const { ctx, calls } = await setup({
      [`POST /api/v1/tickets/tkt-example/reopen/preview`]: [ok(preview())],
    });
    const { code } = await cli(ctx, "ticket", "reopen", "tkt-example");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([`POST /api/v1/tickets/tkt-example/reopen/preview`]);
  });

  it("preview that is not a preview exits 1 with UNEXPECTED_RESPONSE", async () => {
    const { ctx } = await setup({ [`POST ${PREVIEW_PATH}`]: [ok({ plan: {} })] });
    const { code, body } = await cli(ctx, "ticket", "reopen", REF);
    expect(code).toBe(ExitCode.Unexpected);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "UNEXPECTED_RESPONSE" } });
  });
});

describe("pidgen ticket reopen: apply", () => {
  it("apply --digest reopens the ticket with the digest, reason and a derived key", async () => {
    const key = reopenKey();
    const { ctx, calls } = await setup({
      [`POST ${REOPEN_PATH}`]: [ok(applyResult("Delivery was never verified"))],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "reopen",
      REF,
      "--apply",
      "--digest",
      "sha256:reopen-1",
      "--reason",
      "Delivery was never verified",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([`POST ${REOPEN_PATH}`]);
    expect(calls[0]?.body).toEqual({
      preview_digest: "sha256:reopen-1",
      idempotency_key: key,
      acknowledgements: [],
      reason: "Delivery was never verified",
    });
    expect(calls[0]?.headers["x-pidgen-account"]).toBe("ACC-EXAMPLE");
    expect(body).toMatchObject({
      ok: true,
      error: null,
      data: {
        settled: true,
        idempotency_key: key,
        result: {
          status: "applied",
          from_stage: "completed",
          to_stage: "awaiting_review",
          deliveries_superseded: 1,
        },
      },
      meta: { request_id: "req-example", account: "ACC-EXAMPLE" },
    });
    expect(body.data).not.toHaveProperty("handle");
  });

  it("apply with --idempotency-key sends that key", async () => {
    const { ctx, calls } = await setup({ [`POST ${REOPEN_PATH}`]: [ok(applyResult())] });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "reopen",
      REF,
      "--apply",
      "--digest",
      "sha256:reopen-1",
      "--idempotency-key",
      "reopen-example-1",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toMatchObject({ idempotency_key: "reopen-example-1" });
    expect(body.data).toMatchObject({ idempotency_key: "reopen-example-1" });
  });

  it("apply without a digest applies a fresh preview that needs no acknowledgement", async () => {
    const key = reopenKey();
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [ok(preview())],
      [`POST ${REOPEN_PATH}`]: [ok(applyResult())],
    });
    const { code, body } = await cli(ctx, "ticket", "reopen", REF, "--apply");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([`POST ${PREVIEW_PATH}`, `POST ${REOPEN_PATH}`]);
    expect(calls[1]?.body).toMatchObject({
      preview_digest: "sha256:reopen-1",
      idempotency_key: key,
    });
    expect(body.data).toMatchObject({ settled: true, idempotency_key: key });
  });

  it("apply without a digest when the preview requires an acknowledgement exits 6", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [ok(preview({ acks: ["unverified_delivery"] }))],
    });
    const { code, body } = await cli(ctx, "ticket", "reopen", REF, "--apply");
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "DIGEST_REQUIRED" } });
    expect(calls.map(routeOf)).toEqual([`POST ${PREVIEW_PATH}`]);
  });

  it("apply with --ack sends the acknowledgement snake_case", async () => {
    const key = reopenKey(["unverified_delivery"]);
    const { ctx, calls } = await setup({ [`POST ${REOPEN_PATH}`]: [ok(applyResult())] });
    const { code } = await cli(
      ctx,
      "ticket",
      "reopen",
      REF,
      "--apply",
      "--digest",
      "sha256:reopen-1",
      "--ack",
      "unverified-delivery",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toMatchObject({
      acknowledgements: ["unverified_delivery"],
      idempotency_key: key,
    });
  });

  it("apply refused as PREVIEW_STALE exits 6 and says to preview again", async () => {
    const { ctx } = await setup({
      [`POST ${REOPEN_PATH}`]: [
        refusal(409, "PREVIEW_STALE", "The ticket changed since the preview."),
      ],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "reopen",
      REF,
      "--apply",
      "--digest",
      "sha256:old",
    );
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "PREVIEW_STALE" } });
    expect(String(body.error?.details["next"])).toContain("Preview again");
  });

  it("apply refused as ACKNOWLEDGEMENT_REQUIRED exits 6 naming the --ack", async () => {
    const { ctx } = await setup({
      [`POST ${REOPEN_PATH}`]: [
        refusal(409, "ACKNOWLEDGEMENT_REQUIRED", "An acknowledgement is missing.", {
          missing: ["unverified_delivery"],
        }),
      ],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "reopen",
      REF,
      "--apply",
      "--digest",
      "sha256:reopen-1",
    );
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body.error?.code).toBe("ACKNOWLEDGEMENT_REQUIRED");
    expect(String(body.error?.details["next"])).toContain("--ack unverified_delivery");
  });
});

describe("pidgen ticket reopen: refused", () => {
  for (const code of [
    "REOPEN_NOT_JUSTIFIED",
    "REOPEN_NOT_COMPLETED",
    "ACTIVE_ATTEMPT_EXISTS",
    "REOPEN_REQUIRES_HUMAN",
  ]) {
    it(`refused preview with ${code} keeps the server's code and exits 5`, async () => {
      const { ctx, calls } = await setup({
        [`POST ${PREVIEW_PATH}`]: [refusal(409, code, "The ticket cannot be reopened.")],
      });
      const result = await cli(ctx, "ticket", "reopen", REF);
      expect(result.code).toBe(ExitCode.Refused);
      expect(result.body).toMatchObject({
        ok: false,
        data: null,
        error: { code, message: "The ticket cannot be reopened." },
      });
      expect(calls.map(routeOf)).toEqual([`POST ${PREVIEW_PATH}`]);
    });
  }

  it("refused apply with REOPEN_NOT_JUSTIFIED keeps the server's code and exits 5", async () => {
    const { ctx } = await setup({
      [`POST ${REOPEN_PATH}`]: [
        refusal(409, "REOPEN_NOT_JUSTIFIED", "Its completion invariants hold.", {
          command_id: "cmd-1",
        }),
      ],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "reopen",
      REF,
      "--apply",
      "--digest",
      "sha256:reopen-1",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "REOPEN_NOT_JUSTIFIED", details: { command_id: "cmd-1" } },
    });
  });

  it("refused apply answered as a 200 refusal keeps its disposition code and exits 5", async () => {
    const { ctx } = await setup({
      [`POST ${REOPEN_PATH}`]: [
        ok({ ...applyResult(), status: "refused", disposition_code: "ACTIVE_ATTEMPT_EXISTS" }),
      ],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "reopen",
      REF,
      "--apply",
      "--digest",
      "sha256:reopen-1",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({ ok: false, error: { code: "ACTIVE_ATTEMPT_EXISTS" } });
  });

  it("refused: an unknown ticket exits 4 with TICKET_NOT_FOUND", async () => {
    const { ctx } = await setup({
      [`POST ${PREVIEW_PATH}`]: [refusal(404, "TICKET_NOT_FOUND", "No such ticket.")],
    });
    const { code, body } = await cli(ctx, "ticket", "reopen", REF);
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "TICKET_NOT_FOUND" } });
  });
});

describe("pidgen ticket reopen: usage errors", () => {
  it("usage: a missing ticket reference exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await cli(ctx, "ticket", "reopen");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toEqual([]);
  });

  it("usage: an empty or malformed ticket reference exits 2", async () => {
    for (const ref of ["", "..", "../PIDGEN-4"]) {
      const { ctx, calls } = await setup();
      const { code, body } = await cli(ctx, "ticket", "reopen", ref);
      expect(code).toBe(ExitCode.Usage);
      expect(body).toMatchObject({ ok: false, error: { code: "CLI_USAGE" } });
      expect(calls).toEqual([]);
    }
  });

  it("usage: --digest without --apply exits 2", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await cli(ctx, "ticket", "reopen", REF, "--digest", "sha256:reopen-1");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(calls).toEqual([]);
  });

  it("usage: a malformed --ack code exits 2", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await cli(
      ctx,
      "ticket",
      "reopen",
      REF,
      "--apply",
      "--ack",
      "not a code",
    );
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(calls).toEqual([]);
  });

  it("usage: an extra argument exits 2", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await cli(ctx, "ticket", "reopen", REF, "PIDGEN-5");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(calls).toEqual([]);
  });
});
