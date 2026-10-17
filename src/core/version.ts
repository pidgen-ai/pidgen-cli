import { CliError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";

export const CLI_VERSION: string = __PIDGEN_VERSION__;

/**
 * The npm dist-tag a version is published under, as the release workflow chooses it: a prerelease
 * under its identifier (`0.1.0-alpha.1` under `alpha`), any other version under `latest`.
 */
export function distTag(version: string): string {
  return /^\d+\.\d+\.\d+-([0-9A-Za-z]+)/.exec(version)?.[1] ?? "latest";
}

/**
 * The public API version this CLI speaks. It is sent as `PIDGEN-API-Version` on every request;
 * the server accepts its current minor and the previous minor of the same major.
 */
export const API_VERSION = "1.0";

export interface ApiVersion {
  major: number;
  minor: number;
}

export function parseApiVersion(value: string): ApiVersion {
  const match = /^(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) {
    throw new CliError(
      "UNEXPECTED_RESPONSE",
      `Not an API version: "${value}"`,
      ExitCode.Unexpected,
    );
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** Orders two API versions: negative when `a` is older, zero when equal, positive when newer. */
export function compareApiVersions(a: ApiVersion, b: ApiVersion): number {
  return a.major - b.major || a.minor - b.minor;
}

/** True when the server's supported range includes the version this CLI sends. */
export function serverAccepts(
  server: { current: string; minimum: string },
  client: string = API_VERSION,
): boolean {
  const version = parseApiVersion(client);
  return (
    compareApiVersions(version, parseApiVersion(server.minimum)) >= 0 &&
    compareApiVersions(version, parseApiVersion(server.current)) <= 0
  );
}
