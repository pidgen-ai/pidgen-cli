import { Command, CommanderError, Help, Option } from "commander";
import { commands } from "./commands/index.js";
import type { GlobalOptions, RunContext } from "./core/context.js";
import { emptyMeta, failure, render, success, type OutputFormat } from "./core/envelope.js";
import { toCliError, usageError } from "./core/errors.js";
import { ExitCode } from "./core/exit-codes.js";
import type { PresentationContext } from "./core/human.js";
import { GROUPS, NOUNS, type CommandSpec } from "./core/registry.js";
import { API_VERSION, CLI_VERSION } from "./core/version.js";

const HELP_CODES = new Set(["commander.helpDisplayed", "commander.version"]);

/** Parses `argv`, runs one command, prints its envelope when applicable, and returns its exit code. */
export async function runCli(argv: string[], ctx: RunContext): Promise<number> {
  let exitCode: number | undefined;
  const program = buildProgram(ctx, (code) => (exitCode = code));
  const format = selectedFormat(argv, program, ctx);

  if (argv.length === 0) {
    ctx.io.stdout(program.helpInformation());
    return ExitCode.Ok;
  }
  if (asksForVersion(argv)) {
    ctx.io.stdout(`${CLI_VERSION} (API ${API_VERSION})\n`);
    return ExitCode.Ok;
  }

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (HELP_CODES.has(error.code)) return ExitCode.Ok;
      return emit(ctx, format, toCliError(usageError(cleanMessage(error.message))));
    }
    return emit(ctx, format, toCliError(error));
  }
  return exitCode ?? ExitCode.Ok;
}

function buildProgram(ctx: RunContext, done: (code: number) => void): Command {
  const program = new Command("pidgen")
    .description("Command-line client for Pidgen.")
    .option("--profile <name>", "configuration profile to use")
    .option("--account <id>", "use the stored credential for another Account")
    .addOption(
      new Option("--format <format>", "output format (automatic from stdout)")
        .choices(["json", "table"])
        .default(ctx.io.stdoutIsTTY ? "table" : "json"),
    )
    .option("--timeout <seconds>", "network and --wait timeout", parsePositiveInt, 120)
    .showSuggestionAfterError(true);

  configure(program, ctx);
  // `-V, --version` is read before parsing (`asksForVersion`), so a command's own `--version`
  // (`pidgen worker install --version <version>`) is not taken for it; it is still listed in help.
  const versionOption = new Option("-V, --version", "output the version number");
  program.configureHelp({
    visibleOptions(command) {
      const options = Help.prototype.visibleOptions.call(this, command);
      return command === program ? [versionOption, ...options] : options;
    },
  });

  const parents = new Map<string, Command>();
  const parent = (names: readonly string[]): Command => {
    if (names.length === 0) return program;
    const key = names.join(" ");
    let command = parents.get(key);
    if (!command) {
      const above = names.length === 1 ? program : parent(names.slice(0, -1));
      const description = names.length === 1 ? NOUNS[key] : GROUPS[key];
      command = above.command(names.at(-1) as string).description(description ?? "");
      configure(command, ctx);
      parents.set(key, command);
    }
    return command;
  };
  for (const spec of commands) {
    const verb = spec.path.at(-1) as string;
    const verbCommand = parent(spec.path.slice(0, -1)).command(verb).description(spec.summary);
    // A verb may also hold verbs of its own (`worker subscriptions <worker>` and
    // `worker subscriptions use …`): a later spec under its path is added to it.
    parents.set(spec.path.join(" "), verbCommand);
    configure(verbCommand, ctx);
    spec.configure?.(verbCommand);
    verbCommand.action(async (...actionArgs: unknown[]) => {
      const command = actionArgs.at(-1) as Command;
      const global = globalOptions(program.opts());
      done(await execute(ctx, spec, { args: command.args, options: command.opts(), global }));
    });
  }
  return program;
}

function configure(command: Command, ctx: RunContext): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (text) => ctx.io.stdout(text),
    writeErr: (text) => ctx.io.stderr(text),
    outputError: () => {},
  });
}

async function execute(
  ctx: RunContext,
  spec: CommandSpec,
  input: Parameters<CommandSpec["run"]>[1],
): Promise<number> {
  const meta = { ...emptyMeta(), profile: input.global.profile ?? null };
  try {
    const result = await spec.run(ctx, input);
    if (result.envelope === false) return result.exitCode;
    ctx.io.stdout(
      render(success(result.data, { ...meta, ...result.meta }), input.global.format, {
        ...presentationContext(ctx, spec.path),
        ...result.presentation,
      }),
    );
    return ExitCode.Ok;
  } catch (error) {
    return emit(ctx, input.global.format, toCliError(error), meta, spec.path);
  }
}

function emit(
  ctx: RunContext,
  format: OutputFormat,
  error: ReturnType<typeof toCliError>,
  meta = emptyMeta(),
  command?: readonly string[],
): ExitCode {
  ctx.io.stdout(render(failure(error, meta), format, presentationContext(ctx, command)));
  return error.exitCode;
}

function presentationContext(ctx: RunContext, command?: readonly string[]): PresentationContext {
  return {
    ...(command ? { command } : {}),
    terminal: {
      isTTY: ctx.io.stdoutIsTTY,
      ...(ctx.io.stdoutColumns ? { columns: ctx.io.stdoutColumns } : {}),
    },
  };
}

/** Global options that take a value, so their value is not mistaken for a command. */
const GLOBAL_VALUE_OPTIONS = new Set(["--profile", "--account", "--format", "--timeout"]);

/** True when `-V` or `--version` comes before the command: the CLI's version, not a command's option. */
function asksForVersion(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "-V" || arg === "--version") return true;
    if (GLOBAL_VALUE_OPTIONS.has(arg)) index++;
    else if (!arg.startsWith("-")) return false;
  }
  return false;
}

function globalOptions(raw: Record<string, unknown>): GlobalOptions {
  return {
    ...(typeof raw["profile"] === "string" ? { profile: raw["profile"] } : {}),
    ...(typeof raw["account"] === "string" ? { account: raw["account"] } : {}),
    format: raw["format"] === "table" ? "table" : "json",
    timeoutSeconds: typeof raw["timeout"] === "number" ? raw["timeout"] : 120,
  };
}

/** Recover a recognized format even when parsing stops before reaching that flag. */
function selectedFormat(argv: readonly string[], program: Command, ctx: RunContext): OutputFormat {
  let format: OutputFormat = ctx.io.stdoutIsTTY ? "table" : "json";
  let command = program;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") break;
    if (arg === "--format" || arg.startsWith("--format=")) {
      const value = arg === "--format" ? argv[++index] : arg.slice("--format=".length);
      if (value === "json" || value === "table") format = value;
      continue;
    }
    // Only options of this command and its parents consume values. Another command may have
    // an option with the same name as an invalid flag here (e.g. request accept's --unknown).
    let owner: Command | null = command;
    let option: Option | undefined;
    while (owner && !option) {
      option = owner.options.find((candidate) => candidate.long === arg || candidate.short === arg);
      owner = owner.parent;
    }
    if (option?.required || (option?.optional && !argv[index + 1]?.startsWith("-"))) {
      index++;
    } else if (!arg.startsWith("-")) {
      command = command.commands.find((child) => child.name() === arg) ?? command;
    }
  }
  return format;
}

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw usageError(`Not a positive integer: ${value}`);
  return parsed;
}

function cleanMessage(message: string): string {
  return message.replace(/^error:\s*/i, "");
}
