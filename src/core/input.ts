import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parseDocument } from "yaml";
import * as z from "zod";
import type { RunContext } from "./context.js";
import { CliError, type ErrorDetails } from "./errors.js";
import { ExitCode } from "./exit-codes.js";

/**
 * Request bodies given with `-f <file>`: read, parsed as JSON or YAML, and validated against the
 * operation's request schema in the public API document before anything is sent.
 */

export type InputFormat = "json" | "yaml";

export interface InputBody {
  /** The file path as given, or `-` for standard input. */
  source: string;
  format: InputFormat;
  value: unknown;
}

/** One schema violation: a JSONPath-style location (`$` is the whole body) and what is wrong. */
export interface InputIssue {
  path: string;
  message: string;
}

/** The subset of an OpenAPI 3.1 document that request validation reads. */
export interface OpenApiDocument {
  paths?: Record<string, Record<string, unknown> | undefined>;
  [key: string]: unknown;
}

const STDIN = "-";
const API_PREFIX = "/api/v1";
const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

export function inputInvalid(message: string, details: ErrorDetails = {}): CliError {
  return new CliError("INPUT_INVALID", message, ExitCode.Usage, details);
}

/**
 * Reads the raw text of a file path, or of standard input when `source` is `-`. A file that cannot
 * be read is `INPUT_INVALID` (exit code 2).
 */
export async function readTextInput(ctx: RunContext, source: string): Promise<string> {
  if (source === STDIN) return ctx.readStdin();
  try {
    return await readFile(resolve(ctx.cwd, source), "utf8");
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? String(error);
    throw inputInvalid(`Cannot read input file ${source}: ${reason}`, { source });
  }
}

/** Reads and parses a body from a file path, or from standard input when `source` is `-`. */
export async function readInput(ctx: RunContext, source: string): Promise<InputBody> {
  const text = await readTextInput(ctx, source);
  const format =
    source === STDIN
      ? formatFromContent(text)
      : (formatFromExtension(source) ?? formatFromContent(text));
  return { source, format, value: parseInput(text, format, source) };
}

/** Parses `text` as JSON or YAML; syntax errors carry the line and column. */
export function parseInput(text: string, format: InputFormat, source = STDIN): unknown {
  if (text.trim() === "") throw inputInvalid(`Input ${describe(source)} is empty`, { source });
  return format === "json" ? parseJson(text, source) : parseYaml(text, source);
}

function formatFromExtension(source: string): InputFormat | null {
  const extension = extname(source).toLowerCase();
  if (extension === ".json") return "json";
  if (extension === ".yaml" || extension === ".yml") return "yaml";
  return null;
}

function formatFromContent(text: string): InputFormat {
  const first = text.trimStart()[0];
  return first === "{" || first === "[" ? "json" : "yaml";
}

function describe(source: string): string {
  return source === STDIN ? "from standard input" : source;
}

function syntaxError(
  format: InputFormat,
  source: string,
  line: number,
  column: number,
  reason: string,
): CliError {
  const kind = format === "json" ? "JSON" : "YAML";
  return inputInvalid(
    `Invalid ${kind} ${describe(source)} at line ${line}, column ${column}: ${reason}`,
    { source, format, line, column, reason },
  );
}

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const { line, column } = lineColumn(text, jsonErrorOffset(text));
    throw syntaxError("json", source, line, column, reason);
  }
}

function parseYaml(text: string, source: string): unknown {
  const document = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
  const error = document.errors[0];
  if (error !== undefined) {
    const position = error.linePos?.[0] ?? { line: 1, col: 1 };
    const reason = error.message.split("\n")[0] ?? error.message;
    throw syntaxError("yaml", source, position.line, position.col, reason);
  }
  return document.toJS({ maxAliasCount: 100 }) as unknown;
}

/** 1-based line and column of a character offset. */
function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: (lines.at(-1) ?? "").length + 1 };
}

/**
 * The offset of the first JSON syntax error. `JSON.parse` does not always report a position, so
 * this scans the text with a minimal recursive-descent recogniser.
 */
function jsonErrorOffset(text: string): number {
  let i = 0;
  const fail = (): never => {
    throw i;
  };
  const space = () => {
    while (i < text.length && " \t\n\r".includes(text[i] as string)) i++;
  };
  const literal = (word: string) => {
    if (!text.startsWith(word, i)) fail();
    i += word.length;
  };
  const string = () => {
    i++; // opening quote
    while (i < text.length) {
      const c = text[i] as string;
      if (c === '"') {
        i++;
        return;
      }
      if (c < " ") fail();
      if (c === "\\") {
        i++;
        const e = text[i];
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) fail();
          i += 5;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i++;
        else fail();
      } else i++;
    }
    fail();
  };
  const number = () => {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (match === null) fail();
    i += (match as RegExpExecArray)[0].length;
  };
  const value = (): void => {
    space();
    const c = text[i];
    if (c === "{") {
      i++;
      space();
      if (text[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        space();
        if (text[i] !== '"') fail();
        string();
        space();
        if (text[i] !== ":") fail();
        i++;
        value();
        space();
        if (text[i] === ",") i++;
        else if (text[i] === "}") {
          i++;
          return;
        } else fail();
      }
    } else if (c === "[") {
      i++;
      space();
      if (text[i] === "]") {
        i++;
        return;
      }
      for (;;) {
        value();
        space();
        if (text[i] === ",") i++;
        else if (text[i] === "]") {
          i++;
          return;
        } else fail();
      }
    } else if (c === '"') string();
    else if (c === "t") literal("true");
    else if (c === "f") literal("false");
    else if (c === "n") literal("null");
    else number();
  };
  try {
    value();
    space();
    if (i < text.length) fail();
  } catch (offset) {
    if (typeof offset === "number") return Math.min(offset, text.length);
    throw offset;
  }
  return text.length;
}

/**
 * Validates `body` against the request schema of `method path` in `document`. `path` is either
 * the document's path template (`/tickets/{ref}`) or a concrete path (`/tickets/PIDGEN-12`), with or
 * without the `/api/v1` prefix. Returns `body` unchanged; the server applies defaults.
 */
export function validateBody(
  document: OpenApiDocument,
  method: string,
  path: string,
  body: unknown,
): unknown {
  const operation = findOperation(document, method, path);
  const schema = requestSchema(document, operation, method, path);
  if (schema === undefined) return body;

  let validator: z.ZodType;
  try {
    validator = z.fromJSONSchema(toStandaloneSchema(document, schema) as never);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw internal(`Cannot use the request schema of ${method.toUpperCase()} ${path}: ${reason}`);
  }

  const result = validator.safeParse(body);
  if (result.success) return body;
  const issues: InputIssue[] = result.error.issues.map((issue) => ({
    path: jsonPath(issue.path),
    message: issue.message,
  }));
  const count = issues.length === 1 ? "1 issue" : `${issues.length} issues`;
  throw inputInvalid(
    `Request body for ${method.toUpperCase()} ${path} does not match the schema (${count})`,
    { method: method.toUpperCase(), path, issues },
  );
}

/**
 * Checks `value` against `schema`, a schema of `document` (its `$ref`s resolved in the document),
 * and returns every issue found; empty when it matches. Used for response bodies, which are the
 * server's to get right, so the caller decides what an issue means.
 */
export function schemaIssues(
  document: OpenApiDocument,
  schema: unknown,
  value: unknown,
): InputIssue[] {
  let validator: z.ZodType;
  try {
    validator = z.fromJSONSchema(toStandaloneSchema(document, schema) as never);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw internal(`Cannot use the schema: ${reason}`);
  }
  const result = validator.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    path: jsonPath(issue.path),
    message: issue.message,
  }));
}

function internal(message: string): CliError {
  return new CliError("CLI_INTERNAL", message, ExitCode.Unexpected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findOperation(
  document: OpenApiDocument,
  method: string,
  path: string,
): Record<string, unknown> {
  const verb = method.toLowerCase();
  const paths = document.paths ?? {};
  const bare = path.split("?")[0] as string;
  const candidates = [
    bare,
    bare.startsWith(API_PREFIX) ? bare.slice(API_PREFIX.length) : `${API_PREFIX}${bare}`,
  ];
  const lookup = (template: string) => {
    const item = paths[template];
    return METHODS.has(verb) && isRecord(item) && isRecord(item[verb]) ? item[verb] : undefined;
  };
  for (const candidate of candidates) {
    const exact = lookup(candidate);
    if (exact !== undefined) return exact;
  }
  for (const template of Object.keys(paths)) {
    if (candidates.some((candidate) => matchesTemplate(template, candidate))) {
      const operation = lookup(template);
      if (operation !== undefined) return operation;
    }
  }
  throw new CliError(
    "CLI_USAGE",
    `${method.toUpperCase()} ${path} is not in the public API document`,
    ExitCode.Usage,
    { method: method.toUpperCase(), path },
  );
}

function matchesTemplate(template: string, path: string): boolean {
  const wanted = template.split("/");
  const given = path.split("/");
  return (
    wanted.length === given.length &&
    wanted.every((segment, index) =>
      /^\{[^}]+\}$/.test(segment) ? given[index] !== "" : segment === given[index],
    )
  );
}

function requestSchema(
  document: OpenApiDocument,
  operation: Record<string, unknown>,
  method: string,
  path: string,
): unknown {
  let requestBody = operation.requestBody;
  const seen = new Set<string>();
  while (isRecord(requestBody) && typeof requestBody.$ref === "string") {
    if (seen.has(requestBody.$ref)) throw internal(`Circular $ref ${requestBody.$ref}`);
    seen.add(requestBody.$ref);
    requestBody = resolvePointer(document, requestBody.$ref);
  }
  if (!isRecord(requestBody)) {
    throw inputInvalid(`${method.toUpperCase()} ${path} does not take a request body`, {
      method: method.toUpperCase(),
      path,
    });
  }
  const content = isRecord(requestBody.content) ? requestBody.content : {};
  const types = Object.keys(content);
  const mediaType =
    types.find((type) => type === "application/json") ??
    types.find((type) => /[/+]json\b/i.test(type)) ??
    types[0];
  const media = mediaType === undefined ? undefined : content[mediaType];
  return isRecord(media) ? media.schema : undefined;
}

/** Follows a local JSON Pointer reference (`#/components/schemas/Ticket`) in the document. */
function resolvePointer(document: OpenApiDocument, ref: string): unknown {
  if (!ref.startsWith("#")) throw internal(`Only local $ref values are supported, got ${ref}`);
  let node: unknown = document;
  const pointer = ref.slice(1);
  if (pointer !== "") {
    for (const raw of pointer.split("/").slice(1)) {
      const token = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
      if (Array.isArray(node)) node = node[Number(token)];
      else if (isRecord(node)) node = node[token];
      else node = undefined;
      if (node === undefined) break;
    }
  }
  if (node === undefined) throw internal(`Unresolvable $ref ${ref} in the public API document`);
  return node;
}

/** Keywords whose values are data, not schemas; a `$ref` inside them is not a reference. */
const DATA_KEYWORDS = new Set(["const", "default", "enum", "example", "examples"]);
/** Keywords whose values map names to schemas; their keys are never keywords. */
const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
]);

/**
 * Copies `schema` into a self-contained JSON Schema: every local `$ref` into the document is
 * rewritten to `#/$defs/<name>` and the referenced schema is copied into `$defs`, so recursive
 * schemas keep working.
 */
function toStandaloneSchema(document: OpenApiDocument, schema: unknown): unknown {
  const names = new Map<string, string>();
  const defs: Record<string, unknown> = {};

  const nameFor = (ref: string): string => {
    const known = names.get(ref);
    if (known !== undefined) return known;
    const base = ref.replace(/^#\/?/, "").replace(/[^A-Za-z0-9_.-]+/g, "_") || "root";
    let name = base;
    for (let n = 2; Object.hasOwn(defs, name); n++) name = `${base}_${n}`;
    names.set(ref, name);
    defs[name] = true; // reserve the name before copying, for recursive schemas
    defs[name] = copy(resolvePointer(document, ref));
    return name;
  };

  /** `named` is true for maps from names to schemas, such as `properties`. */
  const copy = (node: unknown, named = false): unknown => {
    if (Array.isArray(node)) return node.map((item) => copy(item));
    if (!isRecord(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (named) out[key] = copy(value);
      else if (key === "$ref" && typeof value === "string") out.$ref = `#/$defs/${nameFor(value)}`;
      else if (DATA_KEYWORDS.has(key)) out[key] = value;
      else out[key] = copy(value, SCHEMA_MAP_KEYWORDS.has(key));
    }
    return out;
  };

  const root = copy(schema);
  if (Object.keys(defs).length === 0) return root;
  if (!isRecord(root)) return root;
  const existing = isRecord(root.$defs) ? root.$defs : {};
  return { ...root, $defs: { ...existing, ...defs } };
}

function jsonPath(path: readonly PropertyKey[]): string {
  let out = "$";
  for (const key of path) {
    if (typeof key === "number") out += `[${key}]`;
    else if (typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out += `.${key}`;
    else out += `[${JSON.stringify(String(key))}]`;
  }
  return out;
}
