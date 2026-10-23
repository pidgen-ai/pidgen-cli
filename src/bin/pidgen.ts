import { runCli } from "../cli.js";
import { defaultContext, ignoreClosedPipe } from "../core/context.js";
import { finishOutput } from "../core/terminal.js";

ignoreClosedPipe(process.stdout);
ignoreClosedPipe(process.stderr);
const code = await runCli(process.argv.slice(2), defaultContext());
process.exitCode = code;
// Output queued for a terminal that is not reading is written before the process ends.
await finishOutput(code);
