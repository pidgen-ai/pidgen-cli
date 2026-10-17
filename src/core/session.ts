import { credentialRequired, loadConfig, resolveTarget, type Target } from "./config.js";
import type { GlobalOptions, RunContext } from "./context.js";
import type { Meta } from "./envelope.js";
import { ApiClient, type ApiResponse } from "./http.js";

/** The envelope meta a command reports; `cli_version` is filled in by the CLI. */
export type SessionMeta = Pick<Meta, "profile" | "account" | "request_id" | "api_version">;

/** A client bound to the selected profile and Account. Commands build their client only here. */
export interface Session {
  target: Target;
  client: ApiClient;
  /** Envelope meta for this target, taking `request_id` and `api_version` from `response`. */
  meta(response?: ApiResponse | null): SessionMeta;
}

/**
 * Loads the configuration, resolves the target (flags, then `PIDGEN_*` environment variables, then
 * the stored profile, then the hosted server), and returns an API client for it. The global
 * `--timeout` is in seconds. With no credential it fails with `AUTH_REQUIRED` (exit code 3) and
 * sends nothing, unless `credential` is `"optional"`.
 */
export async function openSession(
  ctx: RunContext,
  global: Pick<GlobalOptions, "profile" | "account" | "timeoutSeconds">,
  { credential = "required" }: { credential?: "required" | "optional" } = {},
): Promise<Session> {
  const config = await loadConfig(ctx);
  const target = resolveTarget(ctx, config, global);
  if (target.token === null && credential === "required") {
    throw credentialRequired(target.profile, target.account);
  }
  const client = new ApiClient({
    baseUrl: target.url,
    token: target.token,
    account: target.account,
    fetch: ctx.fetch,
    sleep: ctx.sleep,
    timeoutMs: global.timeoutSeconds * 1000,
  });
  return { target, client, meta: (response) => responseMeta(target, response) };
}

/**
 * A client for `baseUrl` that carries no credential and no Account, for the server check that runs
 * before a credential is stored or trusted. The global `--timeout` is in seconds.
 */
export function anonymousClient(
  ctx: RunContext,
  baseUrl: string,
  global: Pick<GlobalOptions, "timeoutSeconds">,
): ApiClient {
  return new ApiClient({
    baseUrl,
    token: null,
    account: null,
    fetch: ctx.fetch,
    sleep: ctx.sleep,
    timeoutMs: global.timeoutSeconds * 1000,
  });
}

/**
 * A client for `baseUrl` that carries a credential not yet stored, and optionally an Account, for
 * `pidgen auth login` to verify the credential before it is saved. The global `--timeout` is in seconds.
 */
export function credentialClient(
  ctx: RunContext,
  baseUrl: string,
  token: string,
  account: string | null,
  global: Pick<GlobalOptions, "timeoutSeconds">,
): ApiClient {
  return new ApiClient({
    baseUrl,
    token,
    account,
    fetch: ctx.fetch,
    sleep: ctx.sleep,
    timeoutMs: global.timeoutSeconds * 1000,
  });
}

/** Turns a target and an API response into envelope meta. */
export function responseMeta(target: Target, response?: ApiResponse | null): SessionMeta {
  return {
    profile: target.profile,
    account: target.account,
    request_id: response?.requestId ?? null,
    api_version: response?.apiVersion ?? null,
  };
}
