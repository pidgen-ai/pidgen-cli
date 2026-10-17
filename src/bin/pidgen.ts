import { runCli } from "../cli.js";
import { defaultContext } from "../core/context.js";

process.exitCode = await runCli(process.argv.slice(2), defaultContext());
