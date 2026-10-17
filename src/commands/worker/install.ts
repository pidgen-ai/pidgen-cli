import { Option, type Command } from "commander";
import { usageError } from "../../core/errors.js";
import type { CommandSpec } from "../../core/registry.js";
import { assertSupportedPlatform } from "../../core/worker.js";
import { installWorker, WORKER_FORMS, type WorkerForm } from "../../core/worker-install.js";

/**
 * `pidgen worker install [--runtime wheel|container] [--version <version>] [--force] [--test]`:
 * installs the worker without enrolling it. It reads the server's worker release list with no
 * credential for the series to install (`current`, or the series of `--version`), finds that
 * series' newest release on PyPI (TestPyPI with `--test`, where rehearsals are published) and the
 * wheel for this machine, and verifies it against the worker's release identity before anything
 * runs: the wheel's PyPI attestation, then `uv tool install --python 3.12` of that verified file;
 * or the image's cosign signature over the digest its tag names, then
 * `docker pull <reference>@<digest>`.
 * Without `--runtime` the install record's form is kept, else `uv` selects the wheel and `docker`
 * with `cosign` the container. The licence notice is printed first; installing accepts it, and
 * nothing asks. Every command it runs is printed to standard error before it runs.
 * `pidgen worker enroll` runs the same install (wheel only).
 *
 * `data` is the install record, written to `<worker home>/run/pidgen-install.json`, plus
 * `installed`. Installing the recorded version again is a no-op (`installed: false`) unless
 * `--force`.
 */
export const workerInstall: CommandSpec = {
  path: ["worker", "install"],
  summary: "Install the worker the server names, from PyPI, verified before anything runs",
  configure(command: Command) {
    command
      .addOption(
        new Option(
          "--runtime <runtime>",
          "the form to install: wheel (uv) or container (docker and cosign)",
        ).choices([...WORKER_FORMS]),
      )
      .option("--version <version>", "a release of a series the server accepts")
      .option("--force", "reinstall the recorded version", false)
      .option("--test", "install from TestPyPI, where release rehearsals are published", false);
  },
  async run(ctx, { options, global }) {
    assertSupportedPlatform(ctx.workerRuntime);
    const version = optionalVersion(options["version"]);
    const { record, installed, meta } = await installWorker(ctx, global, {
      runtime: options["runtime"] as WorkerForm | undefined,
      version,
      force: options["force"] === true,
      test: options["test"] === true,
      detect: WORKER_FORMS,
    });
    return { data: { ...record, installed }, meta };
  },
};

export function optionalVersion(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw usageError("--version needs a release version, such as 1.2.0.");
  }
  return value.trim();
}
