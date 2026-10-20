import { describe, expect, it, vi } from "vitest";
import { ExitCode } from "../../src/core/exit-codes.js";
import { ApiClient } from "../../src/core/http.js";
import { jsonResponse } from "../support/context.js";

function client(fetchImpl: typeof fetch, token: string | null = "pidgen_cli_example") {
  return new ApiClient({
    baseUrl: "https://pidgen.example.com",
    token,
    account: "ACC-EXAMPLE",
    fetch: fetchImpl,
    sleep: async () => {},
    timeoutMs: 1000,
  });
}

describe("ApiClient", () => {
  it("sends the version, credential and Account headers under /api/v1", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { status: "ok", data: { id: "PIDGEN-1" } }),
    );
    const response = await client(fetchMock).request({
      method: "GET",
      path: "/tickets/PIDGEN-1",
      query: { expand: "delivery", skip: undefined },
    });
    expect(response.data).toEqual({ id: "PIDGEN-1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://pidgen.example.com/api/v1/tickets/PIDGEN-1?expand=delivery");
    expect(init.headers).toMatchObject({
      "pidgen-api-version": "1.0",
      authorization: "Bearer pidgen_cli_example",
      "x-pidgen-account": "ACC-EXAMPLE",
    });
  });

  it("omits the credential when there is none", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { status: "ok", data: {} }));
    await client(fetchMock, null).request({ method: "GET", path: "/health" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).not.toHaveProperty("authorization");
  });

  it("maps a structured server error onto code and exit code", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        409,
        { detail: { code: "ACTIVE_ATTEMPT_EXISTS", message: "A run is active.", run_id: "r1" } },
        { "x-request-id": "req_1" },
      ),
    );
    await expect(
      client(fetchMock).request({ method: "POST", path: "/tickets/PIDGEN-1/recovery", body: {} }),
    ).rejects.toMatchObject({
      code: "ACTIVE_ATTEMPT_EXISTS",
      message: "A run is active.",
      exitCode: ExitCode.Refused,
      details: { status: 409, request_id: "req_1", run_id: "r1" },
    });
  });

  describe("public error shape", () => {
    function publicError(
      code: string,
      message: string,
      details: unknown = {},
      requestId: string | null = "req_public",
    ) {
      return {
        status: "error",
        error: { code, message, details, request_id: requestId },
      };
    }

    it("reads error.code and error.message from the public error shape", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(409, publicError("ACTIVE_ATTEMPT_EXISTS", "A run is active.")),
      );
      await expect(
        client(fetchMock).request({ method: "POST", path: "/tickets/PIDGEN-1/recovery", body: {} }),
      ).rejects.toMatchObject({
        code: "ACTIVE_ATTEMPT_EXISTS",
        message: "A run is active.",
        exitCode: ExitCode.Refused,
      });
    });

    it("maps a confirmation code to exit 6 whatever the status", async () => {
      for (const [status, code] of [
        [409, "PREVIEW_STALE"],
        [400, "ACKNOWLEDGEMENT_REQUIRED"],
        [428, "DIGEST_REQUIRED"],
        [422, "PREVIEW_STALE"],
      ] as const) {
        const fetchMock = vi.fn(async () =>
          jsonResponse(status, publicError(code, "Preview again.")),
        );
        await expect(
          client(fetchMock).request({ method: "POST", path: "/x", body: {} }),
        ).rejects.toMatchObject({ code, exitCode: ExitCode.ConfirmationRequired });
      }
    });

    it("carries error details and request_id into the envelope details", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          409,
          publicError(
            "PREVIEW_STALE",
            "The recovery plan changed since it was previewed.",
            { current_digest: "sha256:new", preview_digest: "sha256:old" },
            "req_body",
          ),
          { "x-request-id": "req_header" },
        ),
      );
      await expect(
        client(fetchMock).request({ method: "POST", path: "/x", body: {} }),
      ).rejects.toMatchObject({
        code: "PREVIEW_STALE",
        exitCode: ExitCode.ConfirmationRequired,
        details: {
          status: 409,
          request_id: "req_body",
          current_digest: "sha256:new",
          preview_digest: "sha256:old",
        },
      });
    });

    it("falls back to the header request id and keeps error details that are not an object", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          404,
          {
            status: "error",
            error: { code: "TICKET_NOT_FOUND", message: "No ticket.", details: ["x"] },
          },
          { "x-request-id": "req_header" },
        ),
      );
      await expect(client(fetchMock).request({ method: "GET", path: "/x" })).rejects.toMatchObject({
        code: "TICKET_NOT_FOUND",
        exitCode: ExitCode.NotFound,
        details: { status: 404, request_id: "req_header", details: ["x"] },
      });
    });

    it("maps input invalid (422) to exit 2 and keeps details.errors", async () => {
      const errors = [{ loc: ["body", "title"], msg: "Field required", type: "missing" }];
      const fetchMock = vi.fn(async () =>
        jsonResponse(422, publicError("INPUT_INVALID", "The request is invalid.", { errors })),
      );
      const failure = await client(fetchMock)
        .request({ method: "POST", path: "/x", body: {} })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "INPUT_INVALID",
        message: "The request is invalid.",
        exitCode: ExitCode.Usage,
        details: { status: 422, request_id: "req_public", errors },
      });
    });

    it("uses the status default when the public shape has no code", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(403, { status: "error", error: { message: "Not yours." } }),
      );
      await expect(client(fetchMock).request({ method: "GET", path: "/x" })).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Not yours.",
        exitCode: ExitCode.Auth,
      });
    });

    it("still reads the legacy detail shape when the body is not in the public shape", async () => {
      const fetchMock = vi.fn(async () => jsonResponse(400, { detail: "Bad cursor." }));
      await expect(client(fetchMock).request({ method: "GET", path: "/x" })).rejects.toMatchObject({
        code: "INPUT_INVALID",
        message: "Bad cursor.",
        exitCode: ExitCode.Usage,
      });
    });
  });

  it("reports a version mismatch as exit 7", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(426, { detail: { code: "API_VERSION_UNSUPPORTED", message: "Upgrade." } }),
    );
    await expect(client(fetchMock).request({ method: "GET", path: "/x" })).rejects.toMatchObject({
      exitCode: ExitCode.VersionIncompatible,
    });
  });

  // AC-bc2d5eeb9a5f: `pidgen project setup --write` downloads the proposal archive this way.
  it("downloads a file's bytes unread, asking for its media type, and reads a refusal as JSON", async () => {
    const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff]);
    const fetchMock = vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "application/gzip", "x-request-id": "req_file" },
        }),
    );
    const response = await client(fetchMock).download(
      { method: "GET", path: "/projects/STO/readiness/proposal/archive" },
      "application/gzip",
    );
    expect(response.data).toEqual(bytes);
    expect(response.requestId).toBe("req_file");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://pidgen.example.com/api/v1/projects/STO/readiness/proposal/archive");
    expect(init.headers).toMatchObject({
      accept: "application/gzip, application/json",
      authorization: "Bearer pidgen_cli_example",
      "x-pidgen-account": "ACC-EXAMPLE",
    });

    const refusing = vi.fn(async () =>
      jsonResponse(404, {
        status: "error",
        error: { code: "READINESS_PROPOSAL_NOT_FOUND", message: "None yet.", request_id: "r" },
      }),
    );
    await expect(
      client(refusing).download({ method: "GET", path: "/x" }, "application/gzip"),
    ).rejects.toMatchObject({ code: "READINESS_PROPOSAL_NOT_FOUND", exitCode: ExitCode.NotFound });
  });

  it("retries GET on network failure", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(200, { status: "ok", data: 1 }));
    const response = await client(fetchMock as unknown as typeof fetch).request({
      method: "GET",
      path: "/x",
    });
    expect(response.data).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a POST without an idempotency key", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      client(fetchMock as unknown as typeof fetch).request({
        method: "POST",
        path: "/x",
        body: {},
      }),
    ).rejects.toMatchObject({ code: "NETWORK", exitCode: ExitCode.Network });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends a multipart form as it is, leaving its content type (with the boundary) to fetch", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, { status: "ok", data: { upload_id: "upl-example-1" } }),
    );
    const form = new FormData();
    form.append("file", new File(["bytes"], "notes.txt"));
    const response = await client(fetchMock).request({
      method: "POST",
      path: "/artifact-uploads",
      form,
    });
    expect(response.data).toEqual({ upload_id: "upl-example-1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://pidgen.example.com/api/v1/artifact-uploads");
    expect(init.body).toBe(form);
    expect(init.headers).not.toHaveProperty("content-type");
    expect(init.headers).toMatchObject({ authorization: "Bearer pidgen_cli_example" });
  });
});
