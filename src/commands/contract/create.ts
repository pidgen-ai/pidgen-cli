import type { Command } from "commander";
import {
  proposeFragment,
  publishBundle,
  readBundle,
  sourceKind,
  sourcePath,
} from "../../core/contract-publish.js";
import {
  CONTRACT_ROUTES,
  contractRequest,
  readOptionFile,
  type ContractCreateRequest,
} from "../../core/contracts.js";
import { optionalText } from "../../core/domains.js";
import { usageError } from "../../core/errors.js";
import { readInput } from "../../core/input.js";
import { pathSegment } from "../../core/read.js";
import type { CommandResult, CommandSpec } from "../../core/registry.js";
import type { GlobalOptions, RunContext } from "../../core/context.js";

/**
 * `pidgen contract create (--project <project> | --domain <domain>) [-f <file>] [flags]`: creates
 * a contract a Project or a Domain provides, with its first revision
 * (`POST /projects/{project_ref}/contracts` or `POST /domains/{domain_id}/contracts`).
 *
 * The body is `-f`'s file (JSON or YAML, or `-` for standard input): `{title, kind, markdown,
 * schema_format, native_schema?, operations?, owner_user_id?, describes_existing?}`, each
 * operation `{name, types?}`. The flags override the file: `--title`, `--kind`, `--schema-format`
 * (`schema_format`; the global `--format` stays the output format), `--markdown <file.md>` (the
 * document), `--owner <user id>` (`owner_user_id`) and `--existing` (`describes_existing: true`:
 * the interface already exists in the provider's code). Files are read relative to the working
 * directory. With a native schema in the file and no markdown, the CLI writes the document:
 * `# <title>` and a line saying the interface is described by its `<format>` schema.
 *
 * `--schema <file>` (a spec file, e.g. an OpenAPI document) never reads the file into
 * `native_schema`: with `--existing` it publishes the file, with the files beside it, as
 * `pidgen contract publish` does (`POST /projects/{project_ref}/contracts/publish` or
 * `POST /domains/{domain_id}/contracts/publish`); without it, it proposes the file as a new
 * contract the Project is to provide, with `--title` (`POST /projects/{project_ref}/contracts/proposals`).
 * `--title` and `--schema-format` (`openapi` or `asyncapi`, the file's format) apply; `-f`,
 * `--kind`, `--markdown` and `--owner` do not and are a usage error with it, as is a Domain
 * without `--existing`. `data` is then the publish's or the proposal's answer.
 *
 * The body is validated against the published `ContractCreateRequest` before anything is sent: a
 * body that does not match is `INPUT_INVALID` (exit 2). Both or neither of `--project` and
 * `--domain`, or a missing or empty
 * file, is a usage error (exit 2). Nothing is sent then. `data` is the created contract as
 * `GET /contracts/{contract_id}` answers it, with revision 1, accepted at once or `waiting` for a
 * person; an answer that does not match the document is `UNEXPECTED_RESPONSE` (exit 1). A 403
 * (`FORBIDDEN`, `ENTITLEMENT_LIMIT_REACHED`) exits 3, an unknown Project or Domain
 * (`PROJECT_NOT_FOUND`, `DOMAIN_NOT_FOUND`) 4, and a 422 (`CONTRACT_TITLE_INVALID`,
 * `INPUT_INVALID`) 2.
 */
export const contractCreate: CommandSpec = {
  path: ["contract", "create"],
  summary: "Create a contract a Project or a Domain provides, from a file and flags",
  configure(command: Command) {
    command
      .option("--project <project>", "the provider Project: its key prefix, e.g. ALPHA, or its id")
      .option("--domain <domain>", "the provider Domain: its id (DOM-…)")
      .option(
        "-f, --file <file>",
        "the contract as JSON or YAML: title, kind, markdown, schema_format, native_schema, operations, owner_user_id, describes_existing; - reads standard input",
      )
      .option("--title <title>", "the contract's title")
      .option("--kind <kind>", "rest, graphql, grpc, events, library or other")
      .option(
        "--schema-format <format>",
        "the schema format: openapi, graphql, proto, asyncapi, typescript, python or prose",
      )
      .option(
        "--schema <file>",
        "a spec file, e.g. an OpenAPI document: published with --existing, otherwise proposed",
      )
      .option("--markdown <file.md>", "a Markdown file read into markdown")
      .option("--owner <user id>", "the owner's user id (default: you)")
      .option("--existing", "the interface already exists in the provider's code");
  },
  async run(ctx, { options, global }) {
    const project = optionalText(options, "project");
    const domain = optionalText(options, "domain");
    if ((project === undefined) === (domain === undefined)) {
      throw usageError("Give one of --project and --domain.", {
        options: ["--project", "--domain"],
      });
    }

    const schemaFile = options["schema"] as string | undefined;
    if (schemaFile !== undefined) {
      return fromSchemaFile(ctx, global, options, schemaFile, project, domain);
    }

    const source = options["file"] as string | undefined;
    let base: unknown = {};
    if (source !== undefined) base = (await readInput(ctx, source)).value;

    const flags: Partial<Record<keyof ContractCreateRequest, unknown>> = {};
    const title = optionalText(options, "title");
    if (title !== undefined) flags.title = title;
    const kind = optionalText(options, "kind");
    if (kind !== undefined) flags.kind = kind;
    const format = optionalText({ "schema-format": options["schemaFormat"] }, "schema-format");
    if (format !== undefined) flags.schema_format = format;
    const owner = optionalText(options, "owner");
    if (owner !== undefined) flags.owner_user_id = owner;
    if (options["existing"] === true) flags.describes_existing = true;
    const markdownFile = options["markdown"] as string | undefined;
    if (markdownFile !== undefined) {
      flags.markdown = await readOptionFile(
        ctx,
        "--markdown",
        markdownFile,
        "a contract needs its document",
      );
    }

    let body = base;
    if (Object.keys(flags).length > 0) {
      if (!isRecord(base)) {
        throw usageError(`${source ?? "The file"} is not an object; the flags cannot apply.`, {
          source,
        });
      }
      body = { ...base, ...flags };
    }
    if (isRecord(body)) body = withDocument(body);

    if (project !== undefined) {
      return contractRequest(
        ctx,
        global,
        CONTRACT_ROUTES.projectCreate,
        { project_ref: pathSegment("project", project) },
        body,
      );
    }
    return contractRequest(
      ctx,
      global,
      CONTRACT_ROUTES.domainCreate,
      { domain_id: pathSegment("domain", domain) },
      body,
    );
  },
};

/**
 * `--schema <file>`: publishes the file with `--existing`, otherwise proposes it as a new contract
 * the Project is to provide. The flags that write a contract body by hand do not apply.
 */
async function fromSchemaFile(
  ctx: RunContext,
  global: GlobalOptions,
  options: Record<string, unknown>,
  schemaFile: string,
  project: string | undefined,
  domain: string | undefined,
): Promise<CommandResult> {
  const refused = (
    [
      ["file", "-f"],
      ["kind", "--kind"],
      ["markdown", "--markdown"],
      ["owner", "--owner"],
    ] as const
  ).filter(([name]) => options[name] !== undefined);
  if (refused.length > 0) {
    const flags = refused.map(([, flag]) => flag);
    throw usageError(
      `--schema publishes or proposes the file, which the contract is read from; ${flags.join(", ")} cannot be given with it.`,
      { option: "--schema", options: flags },
    );
  }
  const format = optionalText({ "schema-format": options["schemaFormat"] }, "schema-format");
  if (format !== undefined && format !== "openapi" && format !== "asyncapi") {
    throw usageError(`--schema reads OpenAPI and AsyncAPI files, not ${format}.`, {
      option: "--schema-format",
      value: format,
    });
  }
  const title = optionalText(options, "title");
  if (options["existing"] === true) {
    const bundle = await readBundle(ctx, schemaFile, [], "--schema");
    return publishBundle(ctx, global, {
      provider:
        project !== undefined
          ? { project: pathSegment("project", project) }
          : { domain: pathSegment("domain", domain) },
      bundle,
      source_path: await sourcePath(bundle.path, undefined),
      source_kind: sourceKind(ctx),
      ...(format !== undefined ? { format } : {}),
      ...(title !== undefined ? { title } : {}),
      breaking: false,
      check: false,
    });
  }
  if (project === undefined) {
    throw usageError(
      "A Domain's contract is created from a spec file only when it already exists in the code: give --existing to publish it.",
      { option: "--existing" },
    );
  }
  if (title === undefined) {
    throw usageError("Proposing a new contract from --schema needs its --title.", {
      option: "--title",
    });
  }
  return proposeFragment(ctx, global, {
    target: { project: pathSegment("project", project), title },
    bundle: await readBundle(ctx, schemaFile, [], "--schema"),
    given: schemaFile,
    ...(format !== undefined ? { format } : {}),
    check: false,
  });
}

/**
 * The body with a document written for it when it has a native schema, a title and a format and
 * no markdown: `# <title>` and a line saying the interface is described by its schema.
 */
function withDocument(body: Record<string, unknown>): Record<string, unknown> {
  const { title, schema_format: format, native_schema: schema, markdown } = body;
  if (markdown !== undefined || typeof schema !== "string" || schema.trim() === "") return body;
  if (typeof title !== "string" || title.trim() === "" || typeof format !== "string") return body;
  return {
    ...body,
    markdown: `# ${title.trim()}\n\nThe interface is described by its ${format} schema.\n`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
