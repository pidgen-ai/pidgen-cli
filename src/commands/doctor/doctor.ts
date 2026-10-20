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

/** The oldest git the worker's coding agents work with. */
export const MINIMUM_GIT = { major: 2, minor: 38 } as const;

/** Where to get each tool a check may find missing. */
export const FIXES = {
  node: "https://nodejs.org/en/download",
  /** The newest release on this CLI's own channel: `pidgen@alpha` while it is an alpha. */
  upgradeCli: `npm install -g pidgen@${distTag(CLI_VERSION)}`,
  uv: "https://docs.astral.sh/uv/getting-started/installation/",
  docker: "https://docs.docker.com/get-started/get-docker/",
  cosign: "https://docs.sigstore.dev/cosign/system_config/installation/",
} as const;

const GIT_MINIMUM = `${MINIMUM_GIT.major}.${MINIMUM_GIT.minor}`;

const UBUNTU_GIT_FIX = `Install git from the git-core PPA, since Ubuntu's own git can be older than ${GIT_MINIMUM} (22.04 packages 2.34): \`sudo add-apt-repository ppa:git-core/ppa && sudo apt update && sudo apt install git\``;

/** The systems whose way to get git the `git` check names: macOS and Linux distribution families. */
export type GitSystem =
  "macos" | "ubuntu" | "debian" | "fedora" | "arch" | "alpine" | "suse" | "linux" | "other";

/**
 * How to get git `MINIMUM_GIT` or later on each system: `missing` when git is not on `PATH` (or did
 * not report a version), `old` when it is older. Each is one sentence, with no closing full stop, its
 * commands in backticks (setup prints it after "Fix:" and drops the backticks on screen).
 */
export const GIT_FIXES: Record<GitSystem, { missing: string; old: string }> = {
  macos: {
    missing:
      "Install Apple's Command Line Tools with `xcode-select --install`, or git from Homebrew (https://brew.sh) with `brew install git`",
    old: `Install git ${GIT_MINIMUM} or later from Homebrew (https://brew.sh) with \`brew install git\` and put Homebrew's bin directory before /usr/bin on PATH, or update the Command Line Tools through Software Update`,
  },
  // Ubuntu 22.04 packages git 2.34, so its own apt does not reach 2.38: the git-core PPA does.
  ubuntu: { missing: UBUNTU_GIT_FIX, old: UBUNTU_GIT_FIX },
  debian: {
    missing: "Install git with `sudo apt update && sudo apt install git`",
    old: `Debian 12 or later packages git ${GIT_MINIMUM} or later, so there run \`sudo apt update && sudo apt install git\`, and on older Debian see https://git-scm.com/downloads/linux`,
  },
  fedora: {
    missing: "Install git with `sudo dnf install git`",
    old: "Upgrade git with `sudo dnf upgrade git`",
  },
  arch: {
    missing: "Install git with `sudo pacman -S git`",
    old: "Upgrade git with `sudo pacman -S git`",
  },
  alpine: {
    missing: "Install git with `sudo apk add git`",
    old: "Upgrade git with `sudo apk upgrade git`",
  },
  suse: {
    missing: "Install git with `sudo zypper install git`",
    old: "Upgrade git with `sudo zypper install git`",
  },
  linux: {
    missing: `install git ${GIT_MINIMUM} or later with your package manager: https://git-scm.com/downloads/linux`,
    old: `install git ${GIT_MINIMUM} or later with your package manager: https://git-scm.com/downloads/linux`,
  },
  other: {
    missing: `install git ${GIT_MINIMUM} or later: https://git-scm.com/downloads`,
    old: `install git ${GIT_MINIMUM} or later: https://git-scm.com/downloads`,
  },
};

/** The distribution family an os-release `ID` or `ID_LIKE` entry names, or `null`. */
function distributionFamily(id: string): GitSystem | null {
  if (["ubuntu", "linuxmint", "pop"].includes(id)) return "ubuntu";
  if (id === "debian") return "debian";
  if (["fedora", "rhel", "centos", "rocky", "almalinux", "amzn"].includes(id)) return "fedora";
  if (["arch", "manjaro"].includes(id)) return "arch";
  if (id === "alpine") return "alpine";
  if (["opensuse", "sles", "suse"].includes(id) || id.startsWith("opensuse-")) return "suse";
  return null;
}

/** The `KEY=value` lines of an os-release file, with quoted values unquoted. */
export function parseOsRelease(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (match === null) continue;
    let value = match[2]!.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\(["$`\\])/g, "$1");
    }
    fields[match[1]!] = value;
  }
  return fields;
}

/**
 * The system whose git fix applies: macOS; on Linux, the family of the os-release `ID`, else of its
 * first `ID_LIKE` entry that names one, else plain `linux` (also when os-release is unreadable).
 */
export function gitSystem(platform: NodeJS.Platform, osRelease: string | null): GitSystem {
  if (platform === "darwin") return "macos";
  if (platform !== "linux") return "other";
  if (osRelease === null) return "linux";
  const fields = parseOsRelease(osRelease);
  const ids = [(fields["ID"] ?? "").trim(), ...(fields["ID_LIKE"] ?? "").split(/\s+/)].map((id) =>
    id.toLowerCase(),
  );
  for (const id of ids) {
    const family = id === "" ? null : distributionFamily(id);
    if (family !== null) return family;
  }
  return "linux";
}

/**
 * `pidgen doctor`: diagnoses this machine and its connection to Pidgen before anything is changed,
 * and works with nothing configured and no worker installed. `data.checks` is, in order:
 * `node` (the Node.js version), `git` (on `PATH`, 2.38 or later), `server` (`GET /health` answers as Pidgen and accepts this CLI's
 * API version), `credential` (`GET /me` accepts the credential; the Account's role, the token kind
 * and scopes, and whether it may enroll workers), `runtime` (`uv` for the wheel runtime; `docker`
 * and `cosign` for the container runtime), then the checks the server's worker release list gives,
 * read with no credential: `releases`, one `harness:<kind>` per harness it names, and `worker` (the
 * installed worker against the accepted releases, and whether `pidgen-worker` first on `PATH` is
 * it). A check that cannot run because an earlier one failed is `skip`. Any `fail` exits 1 with `DOCTOR_FAILED` and the report in `error.details`;
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
    await gitDoctorCheck(ctx),
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

/** git as found on `PATH`: where, and the version `git --version` printed (`null`: unreadable). */
export interface FoundGit {
  path: string;
  version: string | null;
}

/**
 * The `git` check: git on `PATH`, 2.38 or later (`MINIMUM_GIT`), compared numerically. A failing
 * check's fix is the system's way to get it (`GIT_FIXES`): on macOS the Command Line Tools or
 * Homebrew; on Linux the distribution's, from `osRelease` (the contents of `/etc/os-release`, `null`
 * when unreadable), with distinct fixes for a missing and a too old git where the commands differ.
 */
export function gitCheck(
  git: FoundGit | null,
  platform: NodeJS.Platform,
  osRelease: string | null = null,
): DoctorCheck {
  const fixes = GIT_FIXES[gitSystem(platform, osRelease)];
  if (git === null) return check("git", "fail", "git is not on PATH.", fixes.missing);
  if (git.version === null) {
    return check("git", "fail", `${git.path} did not report a git version.`, fixes.missing);
  }
  const [major = 0, minor = 0] = git.version.split(".").map((part) => Number.parseInt(part, 10));
  const supported =
    major > MINIMUM_GIT.major || (major === MINIMUM_GIT.major && minor >= MINIMUM_GIT.minor);
  return supported
    ? check(
        "git",
        "ok",
        `git ${git.version} at ${git.path} (the worker needs ${GIT_MINIMUM} or later).`,
      )
    : check(
        "git",
        "fail",
        `git ${git.version} at ${git.path} is older than ${GIT_MINIMUM}, the oldest the worker supports.`,
        fixes.old,
      );
}

/** The doctor's `git` check; `/etc/os-release` is read only on Linux and only when git fails. */
async function gitDoctorCheck(ctx: RunContext): Promise<DoctorCheck> {
  const runtime = ctx.workerRuntime;
  const git = await findGit(ctx);
  const result = gitCheck(git, runtime.platform);
  if (result.status !== "fail" || runtime.platform !== "linux") return result;
  return gitCheck(git, runtime.platform, await runtime.osRelease());
}

/** git on `PATH` and its version, from `git --version`; `null` when it is not on `PATH`. */
async function findGit(ctx: RunContext): Promise<FoundGit | null> {
  const path = await findOnPath(ctx, "git", ctx.workerRuntime);
  if (path === null) return null;
  const output = await new Promise<string | null>((resolveOutput) => {
    let child;
    try {
      child = ctx.workerRuntime.spawn(path, ["--version"], {
        cwd: ctx.cwd,
        env: ctx.env,
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
      });
    } catch {
      resolveOutput(null);
      return;
    }
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: string | Buffer) => chunks.push(Buffer.from(chunk)));
    child.once("error", () => resolveOutput(null));
    child.once("close", (code: number | null) =>
      resolveOutput(code === 0 ? Buffer.concat(chunks).toString("utf8") : null),
    );
  });
  const version = output === null ? null : (/(\d+\.\d+(?:\.\d+)?)/.exec(output)?.[1] ?? null);
  return { path, version };
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
