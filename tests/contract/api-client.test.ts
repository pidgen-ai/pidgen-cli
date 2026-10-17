import { describe, expect, it } from "vitest";
import { CliError } from "../../src/core/errors.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { ApiClient } from "../../src/core/http.js";
import { runPreviewApply, serverPreviewApply } from "../../src/core/preview.js";
import type { components } from "../../src/generated/api.js";
import { FIXTURE_DOCUMENT, type MockServer, useMockServer } from "../support/mock-server.js";

type Ticket = components["schemas"]["TicketResource"];
type Project = components["schemas"]["ProjectResource"];

function clientFor(server: () => MockServer): () => ApiClient {
  return () =>
    new ApiClient({
      baseUrl: server().url,
      token: "pidgen_cli_example_token",
      account: "ACC-EXAMPLE",
      fetch: globalThis.fetch,
      sleep: async () => {},
      timeoutMs: 10_000,
      maxAttempts: 1,
    });
}

async function refusal(promise: Promise<unknown>): Promise<CliError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CliError);
  return error as CliError;
}

const WAIT = {
  apply: true,
  acknowledgements: [] as string[],
  wait: true,
  timeoutMs: 10_000,
  pollIntervalMs: 0,
  sleep: async () => {},
  now: () => 0,
};

describe("ApiClient against the Prism mock of the committed document", () => {
  // Prism generates responses from contracts/openapi.json's schemas, so these tests check shapes
  // and status mapping rather than particular values.
  const client = clientFor(useMockServer());

  it("unwraps data from a published list route", async () => {
    const response = await client().request<Ticket[]>({
      method: "GET",
      path: "/api/v1/tickets",
      query: { per_page: 10 },
    });
    expect(response.status).toBe(200);
    expect(Array.isArray(response.data)).toBe(true);
    for (const ticket of response.data) {
      expect(ticket).toEqual(expect.objectContaining({ id: expect.any(String) }));
    }
  });

  it("unwraps data from a published detail route", async () => {
    const response = await client().request<Project>({
      method: "GET",
      path: "/api/v1/projects/proj-example",
    });
    expect(response.status).toBe(200);
    expect(response.data).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        account_id: expect.any(String),
        name: expect.any(String),
      }),
    );
  });

  it("reads the public error shape of a published route (404)", async () => {
    const error = await refusal(
      client().request({
        method: "GET",
        path: "/api/v1/projects/proj-missing",
        query: { __code: 404 },
      }),
    );
    expect(error.code).toEqual(expect.any(String));
    expect(error.exitCode).toBe(ExitCode.NotFound);
    expect(error.details).toMatchObject({ status: 404 });
  });

  it("maps a published route's 409 to a refusal", async () => {
    const error = await refusal(
      client().request({
        method: "POST",
        path: "/api/v1/tickets/PIDGEN-4/reopen/preview",
        query: { __code: 409 },
      }),
    );
    expect(error.exitCode).toBe(ExitCode.Refused);
    expect(error.details).toMatchObject({ status: 409 });
  });

  it("drives a published preview → apply pair through the preview/apply engine", async () => {
    // The route pair follows the server's convention, so the engine's own operation drives it.
    const reopen = serverPreviewApply(client(), {
      command: "ticket reopen",
      target: "PIDGEN-4",
      preview: { path: "/tickets/PIDGEN-4/reopen/preview" },
      apply: { path: "/tickets/PIDGEN-4/reopen" },
    });

    const previewed = await runPreviewApply(reopen, { ...WAIT, apply: false });
    if (previewed.mode !== "preview") throw new Error("expected a preview");
    expect(previewed.preview).toEqual(
      expect.objectContaining({
        preview_digest: expect.any(String),
        required_acknowledgements: expect.any(Array),
      }),
    );

    const result = await runPreviewApply(reopen, {
      ...WAIT,
      digest: previewed.preview.preview_digest,
      acknowledgements: previewed.preview.required_acknowledgements,
    });
    expect(result).toMatchObject({
      mode: "apply",
      settled: true,
      result: { status: "applied", ticket_id: expect.any(String) },
    });
  });
});

describe("ApiClient against the Prism mock of the fixture document", () => {
  // The committed document carries no response examples, so a specific error code and an apply
  // that settles only after polling its status route are exercised against the fixture.
  const client = clientFor(useMockServer(FIXTURE_DOCUMENT));

  it("maps a mocked error code to its exit code (409 PREVIEW_STALE)", async () => {
    const error = await refusal(
      client().request({
        method: "POST",
        path: "/tickets/PIDGEN-4/retry/apply",
        query: { __code: 409 },
        body: { preview_digest: "sha256:stale", idempotency_key: "k", acknowledgements: [] },
      }),
    );
    expect(error.code).toBe("PREVIEW_STALE");
    expect(error.exitCode).toBe(ExitCode.ConfirmationRequired);
    expect(error.details).toMatchObject({ status: 409 });
  });

  it("drives preview → apply → status through the preview/apply engine", async () => {
    const api = client();
    const result = await runPreviewApply(
      {
        command: "ticket retry",
        target: "PIDGEN-4",
        preview: async () =>
          (
            await api.request<{ preview_digest: string; required_acknowledgements: string[] }>({
              method: "POST",
              path: "/tickets/PIDGEN-4/retry/preview",
            })
          ).data,
        apply: async (input) => {
          const response = await api.request<{ request_id: string; status: string }>({
            method: "POST",
            path: "/tickets/PIDGEN-4/retry/apply",
            body: input,
            idempotent: true,
          });
          expect(response.status).toBe(202);
          return {
            settled: false,
            result: response.data,
            handle: response.data.request_id,
          };
        },
        status: async (handle) => {
          const response = await api.request<{ status: string }>({
            method: "GET",
            path: `/requests/${handle}`,
          });
          return {
            settled: response.data.status === "applied" || response.data.status === "failed",
            result: response.data,
          };
        },
      },
      WAIT,
    );
    expect(result).toMatchObject({
      mode: "apply",
      settled: true,
      result: { request_id: "req-example", status: "applied", run_id: "run-example" },
    });
  });
});
