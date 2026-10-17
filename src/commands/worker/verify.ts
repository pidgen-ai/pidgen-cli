import { CliError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import { isHealthy } from "../../core/doctor.js";
import type { CommandSpec } from "../../core/registry.js";
import { assertSupportedPlatform } from "../../core/worker.js";
import { adapterFor, noInstallRecord, readInstallRecord } from "../../core/worker-install.js";

/**
 * `pidgen worker verify`: re-checks the installed worker against its install record — the
 * installed file (or the pinned image) is still there with the recorded digest, and its
 * attestation (or cosign signature) still verifies against an accepted publisher identity. `data` is `checks` in the doctor's shape plus the `record`. A
 * failed check exits 5 with `PROVENANCE_INVALID`; no install record exits 4 with
 * `WORKER_NOT_INSTALLED`.
 */
export const workerVerify: CommandSpec = {
  path: ["worker", "verify"],
  summary: "Re-check the installed worker's digest and provenance",
  async run(ctx) {
    assertSupportedPlatform(ctx.workerRuntime);
    const record = await readInstallRecord(ctx);
    if (record === null) throw noInstallRecord();
    const checks = await adapterFor(ctx, record.form).verify(record);
    if (!isHealthy(checks)) {
      const failed = checks.filter((check) => check.status === "fail").map((check) => check.id);
      throw new CliError(
        "PROVENANCE_INVALID",
        `The installed worker failed verification: ${failed.join(", ")}.`,
        ExitCode.Refused,
        { checks, record },
      );
    }
    return { data: { checks, record } };
  },
};
