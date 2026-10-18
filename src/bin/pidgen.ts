import { runCli } from "../cli.js";
import { defaultContext, ignoreClosedPipe } from "../core/context.js";

ignoreClosedPipe(process.stdout);
ignoreClosedPipe(process.stderr);
process.exitCode = await runCli(process.argv.slice(2), defaultContext());
