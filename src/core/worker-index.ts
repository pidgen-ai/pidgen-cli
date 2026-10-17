import { z } from "zod";
import type { RunContext } from "./context.js";
import { CliError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";
import type { WorkerRuntime } from "./worker.js";
import { compareVersions, seriesOf, type WorkerRelease } from "./worker-releases.js";

/**
 * Where a worker release comes from: the package index, read directly.
 *
 * The App Service names the series to install (`pidgen-worker~=X.Y.0`); the index says which
 * releases of that series exist and which file each publishes per Python and platform. A worker
 * release is a set of compiled wheels, one per interpreter and platform, and no source
 * distribution, so the CLI picks the wheel for this machine and Python 3.12 (the interpreter it
 * asks uv to install the tool with). The index's digest is what the file is checked against after
 * download; the proof that the file is genuine is its PyPI attestation (`provenance.ts`), never
 * the index or the server.
 */

/** The worker's project on the package index. */
export const WORKER_PROJECT = "pidgen-worker";

/** The interpreter the worker tool is installed with, and so the wheel's Python tag. */
export const WORKER_PYTHON = "3.12";
const PYTHON_TAG = `cp${WORKER_PYTHON.replace(".", "")}`;

export type IndexName = "pypi" | "testpypi";

export interface PackageIndex {
  name: IndexName;
  /** The index's base URL: its JSON API, files and integrity (attestation) API hang off it. */
  url: string;
  /** Whether development builds (`X.Y.Z.devN`) are candidates: only on TestPyPI rehearsals. */
  devReleases: boolean;
}

export const PYPI: PackageIndex = Object.freeze({
  name: "pypi",
  url: "https://pypi.org",
  devReleases: false,
});

/** TestPyPI, where the release workflow publishes rehearsals (`--test`). */
export const TEST_PYPI: PackageIndex = Object.freeze({
  name: "testpypi",
  url: "https://test.pypi.org",
  devReleases: true,
});

export function packageIndex(test: boolean): PackageIndex {
  return test ? TEST_PYPI : PYPI;
}

/** One concrete release, resolved from the server's series and the package index. */
export interface ResolvedRelease {
  version: string;
  series: string;
  status: WorkerRelease["status"];
  index: PackageIndex;
  /** The wheel for this machine, or `null` when the release publishes none for it. */
  wheel: {
    requirement: string;
    filename: string;
    /** `sha256:<64 hex>`, as the index states it. */
    digest: string;
    url: string;
  } | null;
  /** The image tag that follows the series' newest release (`<repository>:X.Y`). */
  container: { reference: string } | null;
}

const IndexFileSchema = z.object({
  filename: z.string(),
  url: z.string(),
  digests: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  yanked: z.boolean().optional(),
  packagetype: z.string().optional(),
});
const IndexProjectSchema = z.object({ releases: z.record(z.string(), z.array(IndexFileSchema)) });
type IndexFile = z.infer<typeof IndexFileSchema>;

/** The platform tag suffixes a wheel for this machine may carry, best first. */
export function platformSuffixes(runtime: Pick<WorkerRuntime, "platform" | "arch">): RegExp[] {
  const arch = runtime.arch ?? process.arch;
  if (runtime.platform === "linux") {
    const machine = arch === "arm64" ? "aarch64" : "x86_64";
    return [new RegExp(`manylinux_\\d+_\\d+_${machine}`)];
  }
  if (runtime.platform === "darwin") {
    const machine = arch === "arm64" ? "arm64" : "x86_64";
    return [new RegExp(`macosx_\\d+_\\d+_${machine}`), /macosx_\d+_\d+_universal2/];
  }
  return [];
}

/**
 * The wheel of `files` for this machine: the compiled `cp312` wheel for its platform, else a
 * pure-Python `py3-none-any` wheel, else `null`.
 */
export function chooseWheel(
  files: readonly IndexFile[],
  runtime: Pick<WorkerRuntime, "platform" | "arch">,
): IndexFile | null {
  const wheels = files.filter((file) => file.filename.endsWith(".whl") && file.yanked !== true);
  for (const suffix of platformSuffixes(runtime)) {
    const match = wheels.find((file) => {
      const tags = file.filename.slice(0, -".whl".length).split("-");
      const [python, abi, platform] = tags.slice(-3);
      return python === PYTHON_TAG && abi === PYTHON_TAG && suffix.test(platform ?? "");
    });
    if (match !== undefined) return match;
  }
  return wheels.find((file) => file.filename.endsWith("-py3-none-any.whl")) ?? null;
}

/**
 * Resolves `series` (the server's choice) and an optional exact `version` to the newest release
 * the index publishes for it, and that release's wheel for this machine. Development builds are
 * candidates only on an index that allows them (TestPyPI).
 */
export async function resolveRelease(
  ctx: Pick<RunContext, "fetch"> & { workerRuntime: Pick<WorkerRuntime, "platform" | "arch"> },
  series: WorkerRelease,
  index: PackageIndex,
  version?: string,
): Promise<ResolvedRelease> {
  const project = await readIndexProject(ctx, index);
  const candidates = Object.entries(project.releases)
    .filter(([candidate, files]) => {
      if (seriesOf(candidate) !== series.series) return false;
      if (version !== undefined && candidate !== version) return false;
      if (!index.devReleases && /[a-z]/i.test(candidate)) return false;
      return files.some((file) => file.yanked !== true);
    })
    .sort(([left], [right]) => compareVersions(right, left));
  const chosen = candidates[0];
  if (chosen === undefined) {
    throw new CliError(
      "RELEASE_UNSUPPORTED",
      version === undefined
        ? `${index.url} publishes no ${WORKER_PROJECT} release of series ${series.series}.`
        : `${index.url} does not publish ${WORKER_PROJECT} ${version}.`,
      ExitCode.Refused,
      { series: series.series, version: version ?? null, index: index.name },
    );
  }
  const [resolved, files] = chosen;
  const wheel = chooseWheel(files, ctx.workerRuntime);
  if (wheel !== null && !wheel.url.startsWith("https://")) {
    throw new CliError(
      "DOWNLOAD_FAILED",
      `${index.url} names a download for ${wheel.filename} that is not https.`,
      ExitCode.Unexpected,
      { filename: wheel.filename },
    );
  }
  return {
    version: resolved,
    series: series.series,
    status: series.status,
    index,
    wheel:
      wheel === null
        ? null
        : {
            requirement: `${WORKER_PROJECT}==${resolved}`,
            filename: wheel.filename,
            digest: `sha256:${wheel.digests.sha256}`,
            url: wheel.url,
          },
    container: series.container === null ? null : { reference: series.container.reference },
  };
}

async function readIndexProject(
  ctx: Pick<RunContext, "fetch">,
  index: PackageIndex,
): Promise<z.infer<typeof IndexProjectSchema>> {
  const url = `${index.url}/pypi/${WORKER_PROJECT}/json`;
  let response: Response;
  try {
    response = await ctx.fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new CliError(
      timedOut ? "TIMEOUT" : "NETWORK",
      `Could not read ${WORKER_PROJECT}'s releases from ${index.url}.`,
      ExitCode.Network,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (response.status === 404) {
    throw new CliError(
      "RELEASE_UNSUPPORTED",
      `${index.url} has no ${WORKER_PROJECT} project yet.`,
      ExitCode.Refused,
      { index: index.name },
    );
  }
  if (!response.ok) {
    throw new CliError(
      "DOWNLOAD_FAILED",
      `${index.url} answered ${response.status} for ${WORKER_PROJECT}'s releases.`,
      ExitCode.Unexpected,
      { status: response.status, index: index.name },
    );
  }
  const parsed = IndexProjectSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new CliError(
      "UNEXPECTED_RESPONSE",
      `${index.url} answered with a release listing for ${WORKER_PROJECT} the CLI cannot read.`,
      ExitCode.Unexpected,
      { index: index.name },
    );
  }
  return parsed.data;
}
