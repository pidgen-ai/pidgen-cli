import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, testContext } from "../support/context.js";
import { useMockServer } from "../support/mock-server.js";

// `pidgen worker subscriptions` against Prism mocking the committed contracts/openapi.json: the read
// and the primary PUT are routes of the document, and the command's request matches its schema.

const server = useMockServer();

/** A worker id as the App Service mints it: the command sends it with no lookup by name. */
const WORKER = "wkr_vyemfavnwd4fa7v3uzpr4hq6ia";

interface Body {
  ok: boolean;
  data: Record<string, unknown> | null;
  error: { code: string } | null;
}

async function context(sent: { method: string; url: string; body?: unknown }[]) {
  return testContext({
    env: {
      PIDGEN_API_URL: server().url,
      PIDGEN_TOKEN: "pidgen_pat_fake_contract_token",
      PIDGEN_ACCOUNT: "ACC-EXAMPLE",
    },
    fetch: (input, init) => {
      const raw = init?.body;
      sent.push({
        method: init?.method ?? "GET",
        url: String(input),
        ...(typeof raw === "string" ? { body: JSON.parse(raw) } : {}),
      });
      return globalThis.fetch(input, init);
    },
  });
}

describe("pidgen worker subscriptions against the Prism mock of the committed document", () => {
  it("reads the documented subscriptions route and passes its data through", async () => {
    const sent: { method: string; url: string }[] = [];
    const ctx = await context(sent);
    const code = await runCli(["--timeout", "10", "worker", "subscriptions", WORKER], ctx);
    const body = envelope(ctx) as unknown as Body;

    expect(code).toBe(ExitCode.Ok);
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      host_id: expect.any(String),
      connected: expect.any(Boolean),
      harnesses: expect.any(Array),
    });
    expect(sent).toEqual([
      {
        method: "GET",
        url: `${server().url}/api/v1/workers/${WORKER}/subscriptions`,
      },
    ]);
  });

  it("use sends a PUT the documented request schema accepts, with the read's primary", async () => {
    const sent: { method: string; url: string; body?: unknown }[] = [];
    const ctx = await context(sent);
    // Prism answers the read with the schema's example, so ask for the harness it names.
    const read = (await (
      await globalThis.fetch(`${server().url}/api/v1/workers/w/subscriptions`, {
        headers: { authorization: "Bearer pidgen_pat_fake_contract_token" },
      })
    ).json()) as { data: { harnesses: Array<{ harness: string; primary: string }> } };
    const harness = read.data.harnesses[0]!;
    expect(harness).toBeDefined();

    const code = await runCli(
      ["--timeout", "10", "worker", "subscriptions", "use", WORKER, harness.harness, "claude-a"],
      ctx,
    );
    const body = envelope(ctx) as unknown as Body;

    expect(body.error).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ outcome: expect.stringMatching(/^(applied|unknown)$/) });
    expect(sent.map((call) => call.method)).toEqual(["GET", "PUT"]);
    expect(sent[1]?.body).toEqual({
      label: "claude-a",
      expected_primary: harness.primary,
      move_continuing_steps: false,
    });
  });
});
