import { readdir, readFile, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { PUBLIC_API_DOCUMENT } from "../commands/api/document.js";
import type { GlobalOptions, RunContext } from "./context.js";
import { sendContractRequest, type ContractRoute } from "./contracts.js";
import { CliError, usageError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";
import { validateBody } from "./input.js";
import type { CommandResult } from "./registry.js";
import { openSession } from "./session.js";
import type { components } from "../generated/api.js";

/**
 * Contract publishing: a spec file and the files beside it published as a Project's or a Domain's
 * contract (`POST /projects/{project_ref}/contracts/publish`, `POST /domains/{domain_id}/contracts/publish`),
 * and a proposed revision from a fragment file (`POST /contracts/{contract_id}/proposals`, or
 * `POST /projects/{project_ref}/contracts/proposals` for a contract that does not exist yet). Every
 * request's fields are validated against the published document before anything is sent and every
 * answer after.
 *
 * The CLI does not read spec formats: it sends files. The App converts them, resolving relative
 * `$ref`s among the files sent and nowhere else.
 */

export type ContractPublishResult = components["schemas"]["ContractPublishResult"];
export type ContractProposalResult = components["schemas"]["ContractProposalResult"];

/** One error in a refused file, as the server lists it in `error.details.errors`. */
export interface ContractFileError {
  message: string;
  /** Where in the files the error is, or null when there is no location. */
  location: string | null;
}

/** The publishing and proposal routes. */
export const CONTRACT_PUBLISH_ROUTES = {
  projectPublish: {
    method: "POST",
    path: "/projects/{project_ref}/contracts/publish",
    answers: "ContractPublishResult",
    what: "publish result",
  },
  domainPublish: {
    method: "POST",
    path: "/domains/{domain_id}/contracts/publish",
    answers: "ContractPublishResult",
    what: "publish result",
  },
  propose: {
    method: "POST",
    path: "/contracts/{contract_id}/proposals",
    answers: "ContractProposalResult",
    what: "proposal result",
  },
  projectPropose: {
    method: "POST",
    path: "/projects/{project_ref}/contracts/proposals",
    answers: "ContractProposalResult",
    what: "proposal result",
  },
} as const satisfies Record<string, ContractRoute>;

/** The most files a bundle holds, the entry included, and the most bytes in all. */
export const BUNDLE_LIMITS = { files: 200, bytes: 8 * 1024 * 1024 } as const;

/** The extensions sent beside the entry by default. */
const BUNDLE_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);
/** Directories never walked for the bundle. */
const SKIPPED_DIRECTORIES = new Set(["node_modules"]);

/**
 * Each refusal of a file the document states, and the sentence the CLI prints for it in
 * `error.message` before the errors (the server's own message is kept in
 * `error.details.server_message`). Each exits 5, whatever the HTTP status.
 */
export const FILE_REFUSALS = {
  CONTRACT_FILE_INVALID: "The file does not parse or fails validation",
  CONTRACT_FORMAT_UNSUPPORTED: "The file is not OpenAPI (2.0, 3.0, 3.1) or AsyncAPI (2.x, 3.x)",
  CONTRACT_EXTERNAL_REF: "A $ref is not a relative path inside the files sent",
  CONTRACT_CONVERSION_TIMEOUT: "Converting the files took longer than 60 seconds",
  FILE_TOO_LARGE: `The files are over ${BUNDLE_LIMITS.bytes / 1024 / 1024} MiB or ${BUNDLE_LIMITS.files} files in all`,
} as const satisfies Record<string, string>;

/** One file read for sending: its name in the multipart body and its bytes. */
export interface BundleFile {
  /** The part's filename: the entry's base name, or a file's path relative to the entry's directory. */
  name: string;
  file: Blob;
}

export interface Bundle {
  entry: BundleFile;
  files: BundleFile[];
}

/**
 * Reads the entry `given` (relative to the working directory) and the files beside it: every
 * `.json`, `.yaml` and `.yml` file under the entry's directory, or with `include` the files there
 * that match any of its globs, never under `node_modules` or a dot directory. A missing entry is a
 * usage error (exit 2); a bundle over 200 files or 8 MiB is `FILE_TOO_LARGE` (exit 5). Nothing is
 * sent in either case.
 */
export async function readBundle(
  ctx: RunContext,
  given: string,
  include: readonly string[] = [],
  option = "<file>",
): Promise<Bundle & { path: string }> {
  const path = await entryPath(ctx, given, option);
  const directory = dirname(path);
  const matchers = include.map((glob) => globMatcher(glob));
  const names: string[] = [];
  for await (const name of walk(directory, "")) {
    if (join(directory, name) === path) continue;
    const wanted =
      matchers.length > 0
        ? matchers.some((matches) => matches(name))
        : BUNDLE_EXTENSIONS.has(extname(name).toLowerCase());
    if (wanted) names.push(name);
  }
  names.sort();
  if (names.length + 1 > BUNDLE_LIMITS.files) {
    throw tooLarge(`${names.length + 1} files`, { files: names.length + 1 });
  }
  let bytes = 0;
  const read = async (absolute: string, name: string): Promise<BundleFile> => {
    const content = await readFile(absolute);
    bytes += content.byteLength;
    if (bytes > BUNDLE_LIMITS.bytes) throw tooLarge(`over ${bytes} bytes`, { bytes });
    return { name, file: new Blob([content]) };
  };
  const entry = await read(path, basename(path));
  const files: BundleFile[] = [];
  for (const name of names) files.push(await read(join(directory, ...name.split("/")), name));
  return { path, entry, files };
}

async function entryPath(ctx: RunContext, given: string, option: string): Promise<string> {
  const trimmed = given.trim();
  if (trimmed === "") throw usageError(`${option} needs a file.`, { option });
  const path = resolve(ctx.cwd, trimmed);
  try {
    if (!(await stat(path)).isFile()) {
      throw usageError(`${trimmed} is not a file.`, { option, file: trimmed });
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    const reason = (error as NodeJS.ErrnoException).code ?? String(error);
    throw usageError(`Cannot read ${trimmed}, relative to the working directory: ${reason}.`, {
      option,
      file: trimmed,
    });
  }
  return path;
}

function tooLarge(what: string, details: Record<string, unknown>): CliError {
  return new CliError(
    "FILE_TOO_LARGE",
    `${FILE_REFUSALS.FILE_TOO_LARGE} (${what}); nothing was sent. Narrow the files with --include.`,
    ExitCode.Refused,
    { ...details, limit_files: BUNDLE_LIMITS.files, limit_bytes: BUNDLE_LIMITS.bytes },
  );
}

/** Every file under `directory`, as paths relative to it with `/`, skipping node_modules and dot directories. */
async function* walk(directory: string, prefix: string): AsyncGenerator<string> {
  const entries = await readdir(join(directory, ...prefix.split("/").filter(Boolean)), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      yield* walk(directory, name);
    } else if (entry.isFile()) {
      yield name;
    }
  }
}

/**
 * A matcher for a glob over `/`-separated relative paths: `*` matches within a segment, `**`
 * across segments, `?` one character, and `{a,b}` either.
 */
export function globMatcher(glob: string): (path: string) => boolean {
  const trimmed = glob.trim().replace(/^\.\//, "");
  if (trimmed === "") throw usageError("--include needs a glob.", { option: "--include" });
  let pattern = "";
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i]!;
    if (char === "*") {
      if (trimmed[i + 1] === "*") {
        const slash = trimmed[i + 2] === "/";
        pattern += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else if (char === "{") {
      const end = trimmed.indexOf("}", i);
      if (end === -1) {
        pattern += "\\{";
        continue;
      }
      const options = trimmed.slice(i + 1, end).split(",");
      pattern += `(?:${options.map((option) => option.replace(/[.+^$()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*")).join("|")})`;
      i = end;
    } else {
      pattern += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
  }
  const regex = new RegExp(`^${pattern}$`);
  return (path) => regex.test(path);
}

/**
 * The source path a publish names: `--path` when given (relative, inside the repository), else the
 * entry's path relative to the root of the git repository it sits in. Outside a repository without
 * `--path` is a usage error (exit 2).
 */
export async function sourcePath(entry: string, given: string | undefined): Promise<string> {
  if (given !== undefined) {
    const trimmed = given.trim().replaceAll("\\", "/");
    if (trimmed === "") throw usageError("--path needs a value.", { option: "--path" });
    const normal = posix.normalize(trimmed).replace(/^\.\//, "");
    if (
      isAbsolute(trimmed) ||
      posix.isAbsolute(normal) ||
      normal === ".." ||
      normal.startsWith("../")
    ) {
      throw usageError(
        `--path ${trimmed} is not a path inside the repository; give it relative to the repository root.`,
        { option: "--path", value: trimmed },
      );
    }
    return normal;
  }
  const root = await repositoryRoot(dirname(entry));
  if (root === undefined) {
    throw usageError(
      `${entry} is not inside a git repository; give its source path with --path <source path>.`,
      { option: "--path" },
    );
  }
  return relative(root, entry).split(sep).join("/");
}

/**
 * The nearest directory at or above `start` that is a git repository's root: it holds `.git`, a
 * directory with `HEAD` or a worktree's file pointing at its git directory (`gitdir: …`). An empty
 * `.git` directory is not a repository.
 */
async function repositoryRoot(start: string): Promise<string | undefined> {
  let directory = start;
  for (;;) {
    if (await isRepositoryRoot(directory)) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

async function isRepositoryRoot(directory: string): Promise<boolean> {
  const git = join(directory, ".git");
  try {
    const found = await stat(git);
    if (found.isDirectory()) return (await stat(join(git, "HEAD"))).isFile();
    return found.isFile() && (await readFile(git, "utf8")).startsWith("gitdir:");
  } catch {
    return false;
  }
}

/** `ci` when the environment says it is a CI run (`CI=true`), else `upload`. */
export function sourceKind(ctx: RunContext): "ci" | "upload" {
  return (ctx.env["CI"] ?? "").trim().toLowerCase() === "true" ? "ci" : "upload";
}

export interface PublishInput {
  provider: { project: string } | { domain: string };
  bundle: Bundle;
  source_path: string;
  source_kind: "ci" | "upload";
  commit?: string;
  ref?: string;
  format?: string;
  title?: string;
  breaking: boolean;
  check: boolean;
}

/**
 * Publishes a bundle: validates its fields against the route's multipart body in the published
 * document (`INPUT_INVALID`, exit 2, and nothing is sent), sends it as multipart, and answers the
 * server's result. With `check` it is a dry run, and a breaking change without `breaking` exits 5
 * with `CONTRACT_CHANGE_BREAKING`, naming the server's `change_reason`. A refused file exits 5 with
 * every error and its location.
 */
export async function publishBundle(
  ctx: RunContext,
  global: GlobalOptions,
  input: PublishInput,
): Promise<CommandResult> {
  const fields: Record<string, string | boolean> = {
    source_path: input.source_path,
    source_kind: input.source_kind,
    dry_run: input.check,
    breaking: input.breaking,
  };
  if (input.commit !== undefined) fields["commit"] = input.commit;
  if (input.ref !== undefined) fields["ref"] = input.ref;
  if (input.format !== undefined) fields["format"] = input.format;
  if (input.title !== undefined) fields["title"] = input.title;
  const [route, params] =
    "project" in input.provider
      ? [CONTRACT_PUBLISH_ROUTES.projectPublish, { project_ref: input.provider.project }]
      : [CONTRACT_PUBLISH_ROUTES.domainPublish, { domain_id: input.provider.domain }];
  const { data, result } = await sendFiles<ContractPublishResult>(
    ctx,
    global,
    route,
    params,
    fields,
    input.bundle,
    { source_path: input.source_path },
  );
  if (input.check && data.change === "breaking" && !input.breaking) {
    const why =
      data.change_reason.trim() !== ""
        ? data.change_reason.trim()
        : data.removed.map((name) => `Removes ${name}.`).join(" ");
    throw new CliError(
      "CONTRACT_CHANGE_BREAKING",
      `Publishing ${input.source_path} would record a breaking change: ${why} Give --breaking to accept it.`,
      ExitCode.Refused,
      { source_path: input.source_path, result: data },
    );
  }
  return result;
}

export interface ProposeInput {
  target: { contract: string } | { project: string; title: string };
  /** The fragment and the files beside it, read as a publish reads them. */
  bundle: Bundle;
  /** The fragment as given, for the refusal's message. */
  given: string;
  /** `openapi` or `asyncapi`; the server detects it when omitted. */
  format?: string;
  check: boolean;
}

/**
 * Proposes a revision from a fragment file and the files beside it, as a publish sends them; a
 * refused fragment exits 5 with every error.
 */
export async function proposeFragment(
  ctx: RunContext,
  global: GlobalOptions,
  input: ProposeInput,
): Promise<CommandResult> {
  const fields: Record<string, string | boolean> = { dry_run: input.check };
  if (input.format !== undefined) fields["format"] = input.format;
  let route: ContractRoute;
  let params: Record<string, string>;
  if ("contract" in input.target) {
    route = CONTRACT_PUBLISH_ROUTES.propose;
    params = { contract_id: input.target.contract };
  } else {
    route = CONTRACT_PUBLISH_ROUTES.projectPropose;
    params = { project_ref: input.target.project };
    fields["title"] = input.target.title;
  }
  return (
    await sendFiles(ctx, global, route, params, fields, input.bundle, {
      file: input.given,
    })
  ).result;
}

/**
 * Validates the fields (the files stood in by their names) against the route's multipart schema,
 * opens a session, and sends them with the files: `file` the entry, each other file a `files` part
 * named by its relative path.
 */
async function sendFiles<T>(
  ctx: RunContext,
  global: GlobalOptions,
  route: ContractRoute,
  params: Record<string, string>,
  fields: Record<string, string | boolean>,
  bundle: Bundle,
  context: Record<string, unknown>,
): Promise<{ data: T; result: CommandResult }> {
  const checked: Record<string, unknown> = { ...fields, file: bundle.entry.name };
  if (bundle.files.length > 0) checked["files"] = bundle.files.map((part) => part.name);
  validateBody(PUBLIC_API_DOCUMENT, route.method, route.path, checked);

  const form = new FormData();
  form.append("file", bundle.entry.file, bundle.entry.name);
  for (const part of bundle.files) form.append("files", part.file, part.name);
  for (const [name, value] of Object.entries(fields)) form.append(name, String(value));

  const session = await openSession(ctx, global);
  try {
    return await sendContractRequest<T>(session, route, params, undefined, form);
  } catch (error) {
    throw withErrors(error, context);
  }
}

/**
 * A refused file as the CLI prints it: its sentence and every error with its location in
 * `error.message`, the errors as `{message, location}` in `error.details.errors`, the server's
 * message in `error.details.server_message`, exit 5. Anything else as it is.
 */
export function withErrors(error: unknown, context: Record<string, unknown> = {}): unknown {
  if (!(error instanceof CliError) || !Object.hasOwn(FILE_REFUSALS, error.code)) return error;
  const sentence = FILE_REFUSALS[error.code as keyof typeof FILE_REFUSALS];
  const raw = Array.isArray(error.details["errors"]) ? (error.details["errors"] as unknown[]) : [];
  const errors: ContractFileError[] = raw.map((item) => {
    const record =
      typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    return {
      message: typeof record["message"] === "string" ? record["message"] : String(item),
      location: typeof record["location"] === "string" ? record["location"] : null,
    };
  });
  const lines = errors.map(
    ({ message, location }) => `  ${location ?? "(no location)"}: ${message}`,
  );
  const count = errors.length === 1 ? "1 error" : `${errors.length} errors`;
  const message =
    errors.length > 0
      ? `${sentence}; nothing was recorded. ${count}:\n${lines.join("\n")}`
      : `${sentence}; nothing was recorded. ${error.message}`;
  return new CliError(error.code, message, ExitCode.Refused, {
    ...error.details,
    ...context,
    errors,
    refusal_id:
      typeof error.details["refusal_id"] === "string" ? error.details["refusal_id"] : null,
    server_message: error.message,
  });
}
