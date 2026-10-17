import { CliError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";
import type { ApiClient } from "./http.js";
import { API_VERSION, serverAccepts } from "./version.js";

/** The `service` value a Pidgen App Service reports from `GET /api/v1/health`. */
export const PIDGEN_SERVICE = "pidgen";

export interface ServerIdentity {
  service: string;
  api_version: { current: string; minimum: string };
}

/**
 * Confirms the server is Pidgen and accepts this CLI's API version, before any credential is sent.
 * The client passed in must not carry a token.
 */
export async function checkServer(client: ApiClient): Promise<ServerIdentity> {
  const { data } = await client.request<unknown>({ method: "GET", path: "/health" });
  const identity = asIdentity(data);
  if (!identity || identity.service !== PIDGEN_SERVICE) {
    throw new CliError(
      "NOT_PIDGEN",
      "The server answered, but it is not a Pidgen App Service.",
      ExitCode.Unexpected,
      { health: data },
    );
  }
  if (!serverAccepts(identity.api_version)) {
    throw new CliError(
      "API_VERSION_UNSUPPORTED",
      `This CLI speaks API ${API_VERSION}; the server supports ${identity.api_version.minimum}–${identity.api_version.current}. Upgrade pidgen.`,
      ExitCode.VersionIncompatible,
      { client: API_VERSION, server: identity.api_version },
    );
  }
  return identity;
}

function asIdentity(data: unknown): ServerIdentity | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const version = record["api_version"] as Record<string, unknown> | undefined;
  if (
    typeof record["service"] !== "string" ||
    typeof version?.["current"] !== "string" ||
    typeof version["minimum"] !== "string"
  ) {
    return null;
  }
  return {
    service: record["service"],
    api_version: { current: version["current"], minimum: version["minimum"] },
  };
}
