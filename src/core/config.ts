import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { GlobalOptions, RunContext } from "./context.js";
import { CliError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";

/** The configuration file. See docs/authentication.md. */
const credentialSchema = z.object({
  kind: z.enum(["cli", "pat"]),
  token: z.string().min(1),
  token_id: z.string().optional(),
  expires_at: z.string().optional(),
});

const profileSchema = z.object({
  url: z.string().url(),
  default_account: z.string().optional(),
  server: z
    .object({
      service: z.string(),
      api_version: z.object({ current: z.string(), minimum: z.string() }),
      checked_at: z.string(),
    })
    .optional(),
  credentials: z.record(z.string(), credentialSchema).default({}),
});

const configSchema = z.object({
  default_profile: z.string().default("default"),
  profiles: z.record(z.string(), profileSchema).default({}),
});

export type Credential = z.infer<typeof credentialSchema>;
export type Profile = z.infer<typeof profileSchema>;
export type Config = z.infer<typeof configSchema>;

export function configPath(ctx: RunContext): string {
  const base = ctx.env["XDG_CONFIG_HOME"] || join(ctx.homeDir, ".config");
  return join(base, "pidgen", "config.json");
}

export async function loadConfig(ctx: RunContext): Promise<Config> {
  const path = configPath(ctx);
  let mode: number;
  try {
    mode = (await stat(path)).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return configSchema.parse({});
    throw error;
  }
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw new CliError(
      "CONFIG_PERMISSIONS",
      `${path} is readable by other users; run: chmod 600 ${path}`,
      ExitCode.Auth,
      { path },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new CliError("CONFIG_INVALID", `${path} is not valid JSON`, ExitCode.Usage, { path });
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliError(
      "CONFIG_INVALID",
      `${path} does not match the expected shape`,
      ExitCode.Usage,
      {
        path,
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      },
    );
  }
  return parsed.data;
}

/** Writes the file atomically, owner-only (0600 file, 0700 directory). */
export async function saveConfig(ctx: RunContext, config: Config): Promise<void> {
  const path = configPath(ctx);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(configSchema.parse(config), null, 2) + "\n", {
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/** What a server check found, as stored in a profile. */
export type ServerCheck = NonNullable<Profile["server"]>;

/**
 * Stores `credential` for `account` in the named profile, pointing the profile at `url` and
 * recording the server check. Credentials stored for another server are dropped, so they are never
 * sent to this one. The Account becomes the profile's default only if it had none.
 */
export function storeCredential(
  config: Config,
  profileName: string,
  url: string,
  server: ServerCheck,
  account: string,
  credential: Credential,
): Profile {
  const existing = config.profiles[profileName];
  const kept: Profile | undefined =
    existing && new URL(existing.url).origin === url ? existing : undefined;
  const profile: Profile = {
    ...kept,
    url,
    server,
    credentials: { ...kept?.credentials, [account]: credential },
    default_account: kept?.default_account ?? account,
  };
  config.profiles[profileName] = profile;
  return profile;
}

/** Where and as whom a command talks to Pidgen, after flags and environment overrides. */
export interface Target {
  profile: string;
  url: string;
  token: string | null;
  account: string | null;
}

/** The selected profile's name: `--profile`, then `PIDGEN_PROFILE`, then the file's default. */
export function selectProfile(
  ctx: RunContext,
  config: Config,
  options: Pick<GlobalOptions, "profile">,
): string {
  return options.profile ?? ctx.env["PIDGEN_PROFILE"] ?? config.default_profile;
}

/** The error for a command that needs a stored credential for `account` and has none. */
export function credentialRequired(profile: string, account: string | null): CliError {
  const login = `pidgen auth login <url> --with-token --account ${account ?? "<ACC-…>"}`;
  return new CliError(
    "AUTH_REQUIRED",
    account
      ? `No credential is stored for ${account} in profile ${profile}. Run \`${login}\`.`
      : `No Account is selected in profile ${profile}. Run \`${login}\`.`,
    ExitCode.Auth,
    { profile, account, hint: login },
  );
}

/** The hosted Pidgen server, used when neither `PIDGEN_API_URL` nor the profile names one. */
export const DEFAULT_SERVER_URL = "https://api.pidgen.ai";

export function resolveTarget(
  ctx: RunContext,
  config: Config,
  options: Pick<GlobalOptions, "profile" | "account">,
): Target {
  const profileName = selectProfile(ctx, config, options);
  const profile = config.profiles[profileName];
  const url = ctx.env["PIDGEN_API_URL"] ?? profile?.url ?? DEFAULT_SERVER_URL;
  const account = options.account ?? ctx.env["PIDGEN_ACCOUNT"] ?? profile?.default_account ?? null;
  const token =
    ctx.env["PIDGEN_TOKEN"] ?? (account ? profile?.credentials[account]?.token : undefined) ?? null;
  return { profile: profileName, url, token, account };
}
