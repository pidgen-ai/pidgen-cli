import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { subscriptionRows } from "../../src/commands/worker/subscriptions.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import type { components } from "../../src/generated/api.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";

type WorkerSubscriptions = components["schemas"]["WorkerSubscriptionsResource"];

const SERVER = "https://pidgen.example.com";
const PAT = "pidgen_pat_fake_token_for_tests";
/** A worker's id as the App Service mints it: read with no lookup by name. */
const WORKER = "wkr_vyemfavnwd4fa7v3uzpr4hq6ia";
const NOW = Date.parse("2026-10-09T10:00:00Z");

const CONFIG: Config = {
  default_profile: "default",
  profiles: {
    default: {
      url: SERVER,
      default_account: "ACC-EXAMPLE",
      credentials: { "ACC-EXAMPLE": { kind: "pat", token: PAT } },
    },
  },
};

interface Body {
  ok: boolean;
  data: Record<string, unknown> | null;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  meta: Record<string, unknown>;
}

interface Call {
  url: URL;
  method: string;
  body: unknown;
}

/** A worker's subscriptions as the read route answers them: two harnesses, one failed over. */
function subscriptions(overrides: Partial<WorkerSubscriptions> = {}): WorkerSubscriptions {
  return {
    host_id: WORKER,
    connected: true,
    advertised: true,
    harnesses: [
      {
        harness: "claude",
        primary: "claude-primary",
        active: "claude-fallback-1",
        subscriptions: [
          {
            label: "claude-primary",
            primary: true,
            active: false,
            login: "ready",
            entitled: true,
            last_error: null,
            quota: [
              {
                window: "five_hour",
                used_percent: 100,
                resets_at: "2026-10-09T11:00:00Z",
                observed_at: "2026-10-09T09:48:00Z",
              },
              {
                window: "seven_day",
                used_percent: 40,
                resets_at: null,
                observed_at: "2026-10-09T09:48:00Z",
              },
            ],
            paused: true,
            pauses: [
              {
                capacity_key: "claude:claude-primary",
                window: "five_hour",
                resets_at: "2026-10-09T11:00:00Z",
              },
            ],
            resets_at: "2026-10-09T11:00:00Z",
          },
          {
            label: "claude-fallback-1",
            primary: false,
            active: true,
            login: "ready",
            entitled: true,
            last_error: null,
            quota: [
              {
                window: "five_hour",
                used_percent: 12,
                resets_at: null,
                observed_at: "2026-10-09T07:00:00Z",
              },
            ],
            paused: false,
            pauses: [],
            resets_at: null,
          },
          {
            label: "claude-fallback-2",
            primary: false,
            active: false,
            login: "not_ready",
            entitled: false,
            last_error: "Not logged in.",
            quota: null,
            paused: false,
            pauses: [],
            resets_at: null,
          },
        ],
      },
      {
        harness: "codex",
        primary: "default",
        active: "default",
        subscriptions: [
          {
            label: "default",
            primary: true,
            active: true,
            login: "ready",
            entitled: true,
            last_error: null,
            quota: [],
            paused: false,
            pauses: [],
            resets_at: null,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function applied(overrides: Record<string, unknown> = {}) {
  return {
    request_id: "subcmd-example-1",
    harness: "claude",
    outcome: "applied",
    primary: "claude-fallback-1",
    active: "claude-fallback-1",
    detail: null,
    ...overrides,
  };
}

function ok(data: unknown) {
  return jsonResponse(
    200,
    { status: "ok", data },
    { "x-request-id": "req_fake_1", "pidgen-api-version": "1.0" },
  );
}

function refusal(status: number, code: string, message: string) {
  return jsonResponse(status, {
    status: "error",
    error: { code, message, details: {}, request_id: "req_fake_2" },
  });
}

async function setup(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const ctx: TestContext = await testContext({
    now: () => NOW,
    fetch: async (input, init) => {
      const raw = init?.body;
      const call: Call = {
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        body: typeof raw === "string" ? JSON.parse(raw) : undefined,
      };
      calls.push(call);
      return respond(call);
    },
  });
  await saveConfig(ctx, CONFIG);
  return { ctx, calls };
}

async function run(ctx: TestContext, args: string[]) {
  const code = await runCli(args, ctx);
  return { code, body: envelope(ctx) as unknown as Body };
}

const READ_PATH = `/api/v1/workers/${WORKER}/subscriptions`;
const WORKERS_PATH = "/api/v1/workers";

/** A worker as `GET /workers` lists it, with what the name lookup reads. */
function listed(
  hostId: string,
  displayName: string | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    host_id: hostId,
    display_name: displayName,
    revoked_at: null,
    created_at: "2026-10-01T00:00:00Z",
    connected: true,
    ...overrides,
  };
}

function workerList(workers: unknown[]) {
  return { service_protocol: "1.0", accepted_protocols: ["1.0"], workers };
}
const PUT_PATH = `/api/v1/workers/${WORKER}/subscriptions/claude/primary`;

describe("pidgen worker subscriptions <worker>", () => {
  it("reads GET /workers/{worker}/subscriptions and prints the API response's data unchanged as JSON", async () => {
    const data = subscriptions();
    const { ctx, calls } = await setup(() => ok(data));
    const { code, body } = await run(ctx, ["--format", "json", "worker", "subscriptions", WORKER]);

    expect(code).toBe(ExitCode.Ok);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url.pathname).toBe(READ_PATH);
    expect(body.ok).toBe(true);
    // Unchanged: no derived field is added and none is dropped.
    expect(body.data).toStrictEqual(data);
    expect(body.meta["request_id"]).toBe("req_fake_1");
  });

  it("is JSON by default, the same document as --format json", async () => {
    const data = subscriptions();
    const { ctx } = await setup(() => ok(data));
    const { code, body } = await run(ctx, ["worker", "subscriptions", WORKER]);
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toStrictEqual(data);
  });

  it("encodes the worker as one path segment", async () => {
    const { ctx, calls } = await setup((call) =>
      call.url.pathname === WORKERS_PATH
        ? ok(workerList([listed("host/with space", null)]))
        : ok(subscriptions()),
    );
    await run(ctx, ["worker", "subscriptions", "host/with space"]);
    expect(calls.at(-1)?.url.pathname).toBe("/api/v1/workers/host%2Fwith%20space/subscriptions");
  });

  // AC-7107494b616c: <worker> is a worker's name or id.
  describe("a worker's name or id", () => {
    const MAD_MAX = "wkr_examplexxxxxxxxxxxxxxxxxx";
    const answer = (workers: unknown[]) => (call: Call) =>
      call.url.pathname === WORKERS_PATH ? ok(workerList(workers)) : ok(subscriptions());

    it("resolves a name through GET /workers to its host_id, case-insensitively", async () => {
      const { ctx, calls } = await setup(
        answer([
          listed(MAD_MAX, "Mad-Max", { revoked_at: null }),
          listed("wkr_removedxxxxxxxxxxxxxxxxxx", "Other", {}),
        ]),
      );
      const { code, body } = await run(ctx, ["worker", "subscriptions", "mad-max"]);
      expect(code).toBe(ExitCode.Ok);
      expect(body.ok).toBe(true);
      expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
        `GET ${WORKERS_PATH}`,
        `GET /api/v1/workers/${MAD_MAX}/subscriptions`,
      ]);
    });

    it("takes a listed id as it is", async () => {
      const { ctx, calls } = await setup(answer([listed("dev-laptop", null)]));
      const { code } = await run(ctx, ["worker", "subscriptions", "dev-laptop"]);
      expect(code).toBe(ExitCode.Ok);
      expect(calls.map((call) => call.url.pathname)).toEqual([
        WORKERS_PATH,
        "/api/v1/workers/dev-laptop/subscriptions",
      ]);
    });

    it("takes a minted id with no lookup", async () => {
      const { ctx, calls } = await setup(answer([]));
      const { code } = await run(ctx, ["worker", "subscriptions", WORKER]);
      expect(code).toBe(ExitCode.Ok);
      expect(calls.map((call) => call.url.pathname)).toEqual([READ_PATH]);
    });

    it("an unknown name exits 4 WORKER_NOT_FOUND, and asks for no subscriptions", async () => {
      const removed = listed("wkr_removedxxxxxxxxxxxxxxxxxx", "Ghost", {
        revoked_at: "2026-10-01T00:00:00Z",
      });
      const { ctx, calls } = await setup(answer([listed(MAD_MAX, "Mad-Max"), removed]));
      const { code, body } = await run(ctx, ["worker", "subscriptions", "ghost"]);
      expect(code).toBe(ExitCode.NotFound);
      expect(body.ok).toBe(false);
      expect(body.error?.code).toBe("WORKER_NOT_FOUND");
      expect(body.error?.details).toMatchObject({ worker: "ghost" });
      expect(calls.map((call) => call.url.pathname)).toEqual([WORKERS_PATH]);
    });

    it("a name more than one unrevoked worker answers to exits 2 CLI_USAGE listing their ids", async () => {
      const { ctx, calls } = await setup(
        answer([listed("build-box", null), listed(MAD_MAX, "Build-Box")]),
      );
      const { code, body } = await run(ctx, ["worker", "subscriptions", "BUILD-BOX"]);
      expect(code).toBe(ExitCode.Usage);
      expect(body.error?.code).toBe("CLI_USAGE");
      expect(body.error?.message).toContain("build-box");
      expect(body.error?.message).toContain(MAD_MAX);
      expect(body.error?.details).toMatchObject({ host_ids: ["build-box", MAD_MAX] });
      expect(calls.map((call) => call.url.pathname)).toEqual([WORKERS_PATH]);
    });

    it("use resolves the name too, and puts the primary under the id", async () => {
      const { ctx, calls } = await setup((call) =>
        call.url.pathname === WORKERS_PATH
          ? ok(workerList([listed(MAD_MAX, "Mad-Max")]))
          : call.method === "PUT"
            ? ok(applied())
            : ok(subscriptions()),
      );
      const { code } = await run(ctx, [
        "worker",
        "subscriptions",
        "use",
        "Mad-Max",
        "claude",
        "claude-fallback-1",
      ]);
      expect(code).toBe(ExitCode.Ok);
      expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
        `GET ${WORKERS_PATH}`,
        `GET /api/v1/workers/${MAD_MAX}/subscriptions`,
        `PUT /api/v1/workers/${MAD_MAX}/subscriptions/claude/primary`,
      ]);
    });

    it("use with an unknown name exits 4 and sends nothing else", async () => {
      const { ctx, calls } = await setup(answer([]));
      const { code, body } = await run(ctx, [
        "worker",
        "subscriptions",
        "use",
        "nobody",
        "claude",
        "claude-fallback-1",
      ]);
      expect(code).toBe(ExitCode.NotFound);
      expect(body.error?.code).toBe("WORKER_NOT_FOUND");
      expect(calls.map((call) => call.url.pathname)).toEqual([WORKERS_PATH]);
    });
  });

  // AC-e9b2af44165c: retain connection, login errors and quota observations in human mode.
  it.each([40, 80, 120])(
    "human subscriptions retain complete state at %s columns",
    async (columns) => {
      const data = subscriptions();
      const { ctx, calls } = await setup(() => ok(data));
      ctx.io.stdoutIsTTY = true;
      ctx.io.stdoutColumns = columns;
      expect(await runCli(["worker", "subscriptions", WORKER], ctx)).toBe(ExitCode.Ok);
      const text = ctx.out.join("");
      for (const fragment of [
        "Worker subscriptions",
        WORKER,
        "Connected: true",
        "Advertised: true",
        "Primary:",
        "Active:",
        "Login:",
        "Entitled:",
        "Not logged in.",
        "five_hour",
        "100",
        "2026-10-09T09:48:00Z",
        "2026-10-09T11:00:00Z",
        "Paused: true",
      ])
        expect(text).toContain(fragment);
      expect(text.replace(/\s+/g, " ")).toContain(
        "five_hour 100% (12m ago), seven_day 40% (12m ago)",
      );
      expect(text.replace(/\s+/g, " ")).toContain("paused until 2026-10-09T11:00:00Z (five_hour)");
      const requests = [...calls];
      calls.length = 0;
      ctx.out.length = 0;
      expect(await runCli(["worker", "subscriptions", WORKER, "--format", "json"], ctx)).toBe(
        ExitCode.Ok,
      );
      expect(envelope(ctx).data).toStrictEqual(data);
      expect(calls).toEqual(requests);
      expect(ctx.err).toEqual([]);
    },
  );

  it("subscriptionRows: one row per subscription, in each harness's fallback order", () => {
    const rows = subscriptionRows(subscriptions(), NOW);
    expect(rows.map((row) => `${row.harness}/${row.subscription}`)).toEqual([
      "claude/claude-primary",
      "claude/claude-fallback-1",
      "claude/claude-fallback-2",
      "codex/default",
    ]);
    expect(rows[0]).toEqual({
      harness: "claude",
      subscription: "claude-primary",
      primary: "yes",
      active: "no",
      login: "ready",
      entitled: "yes",
      quota: "five_hour 100% (12m ago), seven_day 40% (12m ago)",
      pause: "paused until 2026-10-09T11:00:00Z (five_hour)",
    });
    expect(rows[2]).toMatchObject({
      login: "not_ready",
      entitled: "no",
      quota: "unknown",
      pause: "",
    });
  });

  it("subscriptionRows: quota ages in seconds, minutes, hours and days", () => {
    const at = (observed: string) =>
      subscriptionRows(
        subscriptions({
          harnesses: [
            {
              harness: "pi",
              primary: "pi-a",
              active: "pi-a",
              subscriptions: [
                {
                  label: "pi-a",
                  primary: true,
                  active: true,
                  login: "unknown",
                  entitled: true,
                  last_error: null,
                  quota: [
                    {
                      window: "five_hour",
                      used_percent: 5,
                      resets_at: null,
                      observed_at: observed,
                    },
                  ],
                  paused: false,
                  pauses: [],
                  resets_at: null,
                },
              ],
            },
          ],
        }),
        NOW,
      )[0]?.quota;
    expect(at("2026-10-09T09:59:30Z")).toBe("five_hour 5% (30s ago)");
    expect(at("2026-10-07T09:00:00Z")).toBe("five_hour 5% (2d ago)");
    // A clock behind the worker's never shows a negative age.
    expect(at("2026-10-09T10:05:00Z")).toBe("five_hour 5% (0s ago)");
  });

  it("keeps a server refusal of the read: an unknown worker exits 4 with its code", async () => {
    const { ctx } = await setup(() => refusal(404, "WORKER_NOT_FOUND", "No such worker."));
    const { code, body } = await run(ctx, ["worker", "subscriptions", WORKER]);
    expect(code).toBe(ExitCode.NotFound);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("WORKER_NOT_FOUND");
    expect(body.error?.details["status"]).toBe(404);
  });

  it("is a usage error without a worker, and sends nothing", async () => {
    const { ctx, calls } = await setup(() => ok(subscriptions()));
    const { code, body } = await run(ctx, ["worker", "subscriptions"]);
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(calls).toHaveLength(0);
  });

  it("is a usage error for an empty worker", async () => {
    const { ctx, calls } = await setup(() => ok(subscriptions()));
    const { code } = await run(ctx, ["worker", "subscriptions", " "]);
    expect(code).toBe(ExitCode.Usage);
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen worker subscriptions use <worker> <harness> <label>", () => {
  it("reads the worker first and sends the PUT with expected_primary from that read; prints the worker's result", async () => {
    const result = applied();
    const { ctx, calls } = await setup((call) =>
      call.method === "GET" ? ok(subscriptions()) : ok(result),
    );
    const { code, body } = await run(ctx, [
      "worker",
      "subscriptions",
      "use",
      WORKER,
      "claude",
      "claude-fallback-1",
    ]);

    expect(code).toBe(ExitCode.Ok);
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      `GET ${READ_PATH}`,
      `PUT ${PUT_PATH}`,
    ]);
    expect(calls[1]?.body).toStrictEqual({
      label: "claude-fallback-1",
      expected_primary: "claude-primary",
      move_continuing_steps: false,
    });
    expect(body.ok).toBe(true);
    expect(body.data).toStrictEqual(result);
  });

  it("takes expected_primary from a fresh read every time, never from an earlier one", async () => {
    let primary = "claude-primary";
    const { ctx, calls } = await setup((call) => {
      if (call.method === "PUT") return ok(applied());
      const data = subscriptions();
      data.harnesses[0]!.primary = primary;
      return ok(data);
    });
    await run(ctx, ["worker", "subscriptions", "use", WORKER, "claude", "claude-fallback-1"]);
    primary = "claude-fallback-2";
    ctx.out.length = 0;
    await run(ctx, ["worker", "subscriptions", "use", WORKER, "claude", "claude-fallback-1"]);

    const puts = calls.filter((call) => call.method === "PUT");
    expect(calls.map((call) => call.method)).toEqual(["GET", "PUT", "GET", "PUT"]);
    expect((puts[0]?.body as Record<string, unknown>)["expected_primary"]).toBe("claude-primary");
    expect((puts[1]?.body as Record<string, unknown>)["expected_primary"]).toBe(
      "claude-fallback-2",
    );
  });

  it("--move-continuing sends move_continuing_steps: true", async () => {
    const { ctx, calls } = await setup((call) =>
      call.method === "GET"
        ? ok(subscriptions())
        : ok(applied({ detail: "2 continuing steps moved" })),
    );
    const { code, body } = await run(ctx, [
      "worker",
      "subscriptions",
      "use",
      WORKER,
      "claude",
      "claude-fallback-1",
      "--move-continuing",
    ]);
    expect(code).toBe(ExitCode.Ok);
    expect((calls[1]?.body as Record<string, unknown>)["move_continuing_steps"]).toBe(true);
    expect(body.data?.["detail"]).toBe("2 continuing steps moved");
  });

  it("prints an unknown result as the worker's result and exits 0", async () => {
    const result = applied({
      outcome: "unknown",
      primary: null,
      active: null,
      detail: "The worker did not answer in time.",
    });
    const { ctx } = await setup((call) =>
      call.method === "GET" ? ok(subscriptions()) : ok(result),
    );
    const { code, body } = await run(ctx, [
      "worker",
      "subscriptions",
      "use",
      WORKER,
      "claude",
      "claude-fallback-1",
    ]);
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toStrictEqual(result);
  });

  const REFUSALS = [
    { status: 403, code: "ENTITLEMENT_LIMIT_REACHED", says: /multiple_subscriptions/ },
    { status: 503, code: "WORKER_OFFLINE", says: /not connected/ },
    { status: 409, code: "SUBSCRIPTION_STALE", says: /changed/ },
    { status: 409, code: "SUBSCRIPTION_UNAVAILABLE", says: /claude-fallback-1/ },
    { status: 409, code: "SUBSCRIPTIONS_NOT_ENTITLED", says: /multiple_subscriptions/ },
  ] as const;

  for (const { status, code: refusalCode, says } of REFUSALS) {
    it(`${refusalCode} prints a one-line explanation and exits 5`, async () => {
      const { ctx } = await setup((call) =>
        call.method === "GET"
          ? ok(subscriptions())
          : refusal(status, refusalCode, "Server wording\nover two lines."),
      );
      const { code, body } = await run(ctx, [
        "worker",
        "subscriptions",
        "use",
        WORKER,
        "claude",
        "claude-fallback-1",
      ]);

      expect(code).toBe(ExitCode.Refused);
      expect(code).not.toBe(0);
      expect(body.ok).toBe(false);
      expect(body.error?.code).toBe(refusalCode);
      const message = body.error?.message ?? "";
      expect(message).not.toContain("\n");
      expect(message).not.toBe("Server wording\nover two lines.");
      expect(message).toMatch(says);
      expect(body.error?.details["status"]).toBe(status);
      expect(body.error?.details["request_id"]).toBe("req_fake_2");
      expect(body.error?.details["server_message"]).toBe("Server wording\nover two lines.");
    });

    it(`${refusalCode} in human format retains the refusal and server details on standard output`, async () => {
      const { ctx } = await setup((call) =>
        call.method === "GET" ? ok(subscriptions()) : refusal(status, refusalCode, "Refused."),
      );
      const code = await runCli(
        [
          "--format",
          "table",
          "worker",
          "subscriptions",
          "use",
          WORKER,
          "claude",
          "claude-fallback-1",
        ],
        ctx,
      );
      expect(code).toBe(ExitCode.Refused);
      const text = ctx.out.join("");
      expect(text).toContain("Server message: Refused.");
      expect(text).toContain("Status:");
      expect(text).toContain(String(status));
      expect(ctx.err).toEqual([]);
      expect(text).toMatch(new RegExp(`^error ${refusalCode}: `));
    });
  }

  it("a worker the App Service no longer knows is the read's refusal, and nothing is sent", async () => {
    const { ctx, calls } = await setup(() => refusal(404, "WORKER_NOT_FOUND", "No such worker."));
    const { code, body } = await run(ctx, [
      "worker",
      "subscriptions",
      "use",
      WORKER,
      "claude",
      "claude-fallback-1",
    ]);
    expect(code).toBe(ExitCode.NotFound);
    expect(body.error?.code).toBe("WORKER_NOT_FOUND");
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("a harness the worker does not advertise exits 4 with HARNESS_NOT_ADVERTISED, and no PUT is sent", async () => {
    const { ctx, calls } = await setup(() => ok(subscriptions()));
    const { code, body } = await run(ctx, [
      "worker",
      "subscriptions",
      "use",
      WORKER,
      "gemini",
      "gemini-a",
    ]);
    expect(code).toBe(ExitCode.NotFound);
    expect(body.error?.code).toBe("HARNESS_NOT_ADVERTISED");
    expect(body.error?.message).not.toContain("\n");
    expect(body.error?.details).toMatchObject({
      harness: "gemini",
      advertised: ["claude", "codex"],
    });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("a label the request schema refuses is INPUT_INVALID (exit 2), and nothing is sent", async () => {
    const { ctx, calls } = await setup(() => ok(subscriptions()));
    const { code, body } = await run(ctx, [
      "worker",
      "subscriptions",
      "use",
      WORKER,
      "claude",
      "not a label!",
    ]);
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("INPUT_INVALID");
    expect(calls).toHaveLength(0);
  });

  it("is a usage error without the harness or the label", async () => {
    for (const args of [
      ["worker", "subscriptions", "use", WORKER],
      ["worker", "subscriptions", "use", WORKER, "claude"],
    ]) {
      const { ctx, calls } = await setup(() => ok(subscriptions()));
      const { code, body } = await run(ctx, args);
      expect(code).toBe(ExitCode.Usage);
      expect(body.error?.code).toBe("CLI_USAGE");
      expect(calls).toHaveLength(0);
    }
  });

  it("is a usage error for an empty harness", async () => {
    const { ctx, calls } = await setup(() => ok(subscriptions()));
    const { code } = await run(ctx, ["worker", "subscriptions", "use", WORKER, " ", "claude-a"]);
    expect(code).toBe(ExitCode.Usage);
    expect(calls).toHaveLength(0);
  });
});

describe("docs", () => {
  it("docs/commands.md lists both commands, the routes, --move-continuing and the refusal codes", async () => {
    const text = await readFile(new URL("../../docs/commands.md", import.meta.url), "utf8");
    expect(text).toContain("`pidgen worker subscriptions <worker>`");
    expect(text).toContain(
      "`pidgen worker subscriptions use <worker> <harness> <label> [--move-continuing]`",
    );
    expect(text).toContain("GET /workers/{host_id}/subscriptions");
    expect(text).toContain("PUT /workers/{host_id}/subscriptions/{harness}/primary");
    for (const code of [
      "ENTITLEMENT_LIMIT_REACHED",
      "WORKER_OFFLINE",
      "SUBSCRIPTION_STALE",
      "SUBSCRIPTION_UNAVAILABLE",
    ]) {
      expect(text).toContain(code);
    }
  });
});
