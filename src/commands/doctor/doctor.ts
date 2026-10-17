import {
  configPath,
  loadConfig,
  resolveTarget,
  type Profile,
  type Target,
} from "../../core/config.js";
import type { GlobalOptions, RunContext } from "../../core/context.js";
import { check, isHealthy, releaseListChecks, type DoctorCheck } from "../../core/doctor.js";
import { CliError, toCliError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import type { ApiResponse } from "../../core/http.js";
import {
  ENROLL_SCOPE,
  enrollPermission,
  readMe,
  targetCredentialKind,
  type CredentialKind,
  type Me,
} from "../../core/me.js";
import type { CommandSpec } from "../../core/registry.js";
import { checkServer, type ServerIdentity } from "../../core/server.js";
import { anonymousClient, responseMeta, type SessionMeta } from "../../core/session.js";
import {
  API_VERSION,
  CLI_VERSION,
  compareApiVersions,
  distTag,
  parseApiVersion,
} from "../../core/version.js";
import { findOnPath, workerPlatformSupported } from "../../core/worker.js";

export type { CheckStatus, DoctorCheck } from "../../core/doctor.js";

/** The oldest Node.js this CLI runs on: package.json's `engines.node`. */
export const MINIMUM_NODE = { major: 22, minor: 12 } as const;

/** Where to get each tool a check may find missing. */
export const FIXES = {
  node: "https://nodejs.org/en/download",
  /** The newest release on this CLI's own channel: `pidgen@alpha` while it is an alpha. */
  upgradeCli: `npm install -g pidgen@${distTag(CLI_VERSION)}`,
  uv: "https://docs.astral.sh/uv/getting-started/installation/",
  docker: "https://docs.docker.com/get-started/get-docker/",
  cosign: "https://docs.sigstore.dev/cosign/system_config/installation/",
} as const;

/**
 * `pidgen doctor`: diagnoses this machine and its connection to Pidgen before anything is changed,
 * and works with nothing configured and no worker installed. `data.checks` is, in order:
 * `node` (the Node.js version), `server` (`GET /health` answers as Pidgen and accepts this CLI's
 * API version), `credential` (`GET /me` accepts the credential; the Account's role, the token kind
 * and scopes, and whether it may enroll workers), `runtime` (`uv` for the wheel runtime; `docker`
 * and `cosign` for the container runtime), then the checks the server's worker release list gives,
 * read with no credential: `releases`, one `harness:<kind>` per harness it names, and `worker` (the
 * installed worker against the accepted releases). A check that cannot run because an earlier one
 * failed is `skip`. Any `fail` exits 1 with `DOCTOR_FAILED` and the report in `error.details`;
 * `warn` exits 0.
 */
export const doctor: CommandSpec = {
  path: ["doctor"],
  summary: "Diagnose this machine and its connection to Pidgen",
  async run(ctx, { global }) {
    const { checks, meta } = await doctorChecks(ctx, global);
    if (!isHealthy(checks)) {
      const failed = checks.filter((entry) => entry.status === "fail");
      const names = failed.map((entry) => entry.id).join(", ");
      throw new CliError(
        "DOCTOR_FAILED",
        `${failed.length} check${failed.length === 1 ? "" : "s"} failed: ${names}. Each failing check names its fix.`,
        ExitCode.Unexpected,
        { checks },
      );
    }
    return { data: { checks }, meta };
  },
};

/**
 * Every check `pidgen doctor` reports, in order, without judging them: `pidgen setup` runs the same
 * checks and decides which of them a later step fixes.
 */
export async function doctorChecks(
  ctx: RunContext,
  global: Pick<GlobalOptions, "profile" | "account" | "timeoutSeconds">,
): Promise<{ checks: DoctorCheck[]; meta: Partial<SessionMeta> }> {
  const connection = await connectionChecks(ctx, global);
  const server =
    connection.target !== null && connection.server.status !== "fail"
      ? connection.target.url
      : null;
  const checks: DoctorCheck[] = [
    nodeCheck(process.versions.node),
    connection.server,
    connection.credential,
    await runtimeCheck(ctx),
    ...(await releaseListChecks(ctx, global, server)),
  ];
  const meta = connection.target ? responseMeta(connection.target, connection.response) : {};
  return { checks, meta };
}

/** The `node` check: the Node.js version this CLI runs on against `engines.node`. */
export function nodeCheck(version: string): DoctorCheck {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  const supported =
    major > MINIMUM_NODE.major || (major === MINIMUM_NODE.major && minor >= MINIMUM_NODE.minor);
  const minimum = `${MINIMUM_NODE.major}.${MINIMUM_NODE.minor}`;
  return supported
    ? check("node", "ok", `Node.js ${version} (this CLI needs ${minimum} or later).`)
    : check(
        "node",
        "fail",
        `Node.js ${version} is older than ${minimum}, the oldest this CLI supports.`,
        FIXES.node,
      );
}

interface Connection {
  server: DoctorCheck;
  credential: DoctorCheck;
  target: Target | null;
  response: ApiResponse | null;
}

/** The `server` and `credential` checks; the credential is skipped unless the server passes. */
async function connectionChecks(
  ctx: RunContext,
  global: Pick<GlobalOptions, "profile" | "account" | "timeoutSeconds">,
): Promise<Connection> {
  let target: Target;
  let profile: Profile | undefined;
  try {
    const config = await loadConfig(ctx);
    target = resolveTarget(ctx, config, global);
    profile = config.profiles[target.profile];
  } catch (error) {
    const failure = toCliError(error);
    const fix = configFix(ctx, failure);
    return {
      server: check("server", "fail", failure.message, fix),
      credential: check("credential", "skip", "Skipped: the configuration could not be read.", fix),
      target: null,
      response: null,
    };
  }

  const login = `pidgen auth login ${target.url}${target.account ? ` --account ${target.account}` : ""}`;
  const server = await serverCheck(ctx, target, global);
  if (server.status === "fail") {
    return {
      server,
      credential: check(
        "credential",
        "skip",
        "Skipped: the server check failed, so the credential was not sent.",
        null,
      ),
      target,
      response: null,
    };
  }
  const { credential, response } = await credentialCheck(ctx, target, profile, global, login);
  return { server, credential, target, response };
}

/** The fix for a configuration that could not give a server. */
function configFix(ctx: RunContext, failure: CliError): string {
  if (failure.code === "CONFIG_PERMISSIONS") return `chmod 600 ${configPath(ctx)}`;
  if (failure.code === "CONFIG_INVALID") return `Repair or remove ${configPath(ctx)}`;
  return "pidgen auth login";
}

async function serverCheck(
  ctx: RunContext,
  target: Target,
  global: Pick<GlobalOptions, "timeoutSeconds">,
): Promise<DoctorCheck> {
  const health = `${target.url.replace(/\/+$/, "")}/api/v1/health`;
  let identity: ServerIdentity;
  try {
    identity = await checkServer(anonymousClient(ctx, target.url, global));
  } catch (error) {
    const failure = toCliError(error);
    if (failure.code === "NOT_PIDGEN") {
      return check(
        "server",
        "fail",
        `${target.url} answered, but it is not a Pidgen App Service.`,
        "pidgen auth login <url>",
      );
    }
    if (failure.code === "API_VERSION_UNSUPPORTED") {
      const range = failure.details["server"] as { current: string; minimum: string };
      // Below the server's minimum, a newer CLI fixes it; above its current, the server is behind.
      const tooOld =
        compareApiVersions(parseApiVersion(API_VERSION), parseApiVersion(range.minimum)) < 0;
      return check(
        "server",
        "fail",
        `${target.url} supports API ${range.minimum}–${range.current}; this CLI speaks API ${API_VERSION}.`,
        tooOld
          ? FIXES.upgradeCli
          : `Ask the operator of ${target.url} to upgrade it to API ${API_VERSION}`,
      );
    }
    return check(
      "server",
      "fail",
      `${target.url} did not answer GET /health (${failure.code}): ${failure.message}`,
      health,
    );
  }
  const { current, minimum } = identity.api_version;
  return check(
    "server",
    "ok",
    `${target.url} is Pidgen and accepts this CLI's API ${API_VERSION} (it supports ${minimum}–${current}).`,
  );
}

const KIND_NAMES: Record<"cli" | "pat", string> = {
  cli: "CLI token",
  pat: "Personal API Token",
};

async function credentialCheck(
  ctx: RunContext,
  target: Target,
  profile: Profile | undefined,
  global: Pick<GlobalOptions, "timeoutSeconds">,
  login: string,
): Promise<{ credential: DoctorCheck; response: ApiResponse | null }> {
  if (!target.token) {
    const summary = target.account
      ? `No credential is stored for ${target.account} in profile ${target.profile}.`
      : `No Account is selected in profile ${target.profile}.`;
    return { credential: check("credential", "fail", summary, login), response: null };
  }
  let read: { me: Me; response: ApiResponse };
  try {
    read = await readMe(ctx, target.url, target.token, global);
  } catch (error) {
    const failure = toCliError(error);
    const fix =
      failure.exitCode === ExitCode.Auth || failure.exitCode === ExitCode.NotFound ? login : null;
    return {
      credential: check(
        "credential",
        "fail",
        `GET /me refused the credential (${failure.code}): ${failure.message}`,
        fix,
      ),
      response: null,
    };
  }
  const known: CredentialKind = targetCredentialKind(ctx, target, profile);
  return {
    credential: describeCredential(read.me, target.account, known, login),
    response: read.response,
  };
}

/** The credential check from a `GET /me` answer: the token kind, the role and the enroll right. */
function describeCredential(
  me: Me,
  selected: string | null,
  localKind: CredentialKind,
  login: string,
): DoctorCheck {
  const permission = enrollPermission(me, selected, localKind);
  const { account, kind, role, scopes } = permission;
  const membership = me.memberships.find((entry) => entry.account_id === account);
  const kindName = kind ? KIND_NAMES[kind] : "credential";
  const who = `${me.user.email} with a ${kindName}`;
  const where = `${account ?? "no Account"}${membership ? ` (${membership.account_name})` : ""}`;
  const roleText = role ? `role ${role}` : "no membership";
  const scopeText = scopes !== null ? `; scopes: ${scopes.join(", ") || "none"}` : "";
  const base = `Signed in as ${who} for ${where}, ${roleText}${scopeText}`;
  if (permission.allowed) return check("credential", "ok", `${base}; it may enroll workers.`);
  const reason =
    kind === "pat"
      ? `the token lacks ${ENROLL_SCOPE}; sign in with a Personal API Token that has it`
      : "enrolling needs the Account Owner or Administrator role";
  return check(
    "credential",
    "warn",
    `${base}; it may not enroll workers: ${reason}.`,
    kind === "pat"
      ? `${login} --with-token`
      : "Ask an Account Owner or Administrator to enroll the worker",
  );
}

/**
 * The `runtime` check: `uv` runs the wheel runtime; `docker` and `cosign` (which verifies the
 * image's signature) run the container runtime. One complete runtime is enough to pass; a container
 * runtime missing only `cosign` beside a working wheel runtime is a warning.
 */
async function runtimeCheck(ctx: RunContext): Promise<DoctorCheck> {
  const runtime = ctx.workerRuntime;
  if (!workerPlatformSupported(runtime)) {
    return check(
      "runtime",
      "fail",
      `pidgen-worker runs on Linux and macOS, not ${runtime.platform}.`,
      "Run the worker on a Linux or macOS machine",
    );
  }
  const config = { env: ctx.env, cwd: ctx.cwd };
  const [uv, docker, cosign] = await Promise.all([
    findOnPath(config, "uv", runtime),
    findOnPath(config, "docker", runtime),
    findOnPath(config, "cosign", runtime),
  ]);
  const wheel = uv !== null;
  const container = docker !== null && cosign !== null;
  const found = [uv && `uv (${uv})`, docker && `docker (${docker})`, cosign && `cosign (${cosign})`]
    .filter(Boolean)
    .join(", ");
  const missing = (tools: [string, string | null][]) =>
    tools.filter(([, path]) => path === null).map(([tool]) => tool);
  const containerMissing = missing([
    ["docker", docker],
    ["cosign", cosign],
  ]);

  if (wheel && container) {
    return check("runtime", "ok", `Both runtimes are available: ${found}.`);
  }
  if (wheel && docker !== null) {
    return check(
      "runtime",
      "warn",
      `The wheel runtime is available, but the container runtime also needs cosign to verify the image. Found: ${found}.`,
      FIXES.cosign,
    );
  }
  if (wheel) {
    return check(
      "runtime",
      "ok",
      `The wheel runtime is available: ${found}. The container runtime would need ${containerMissing.join(" and ")}.`,
    );
  }
  if (container) {
    return check(
      "runtime",
      "ok",
      `The container runtime is available: ${found}. The wheel runtime would need uv.`,
    );
  }
  const fix = docker !== null ? FIXES.cosign : FIXES.uv;
  return check(
    "runtime",
    "fail",
    `No worker runtime is available: the wheel runtime needs uv; the container runtime needs ${containerMissing.join(" and ")}.${found ? ` Found: ${found}.` : ""}`,
    fix,
  );
}
