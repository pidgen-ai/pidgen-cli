import { describe, expect, it } from "vitest";
import {
  chooseWheel,
  packageIndex,
  PYPI,
  resolveRelease,
  resolveUpdate,
  TEST_PYPI,
} from "../../src/core/worker-index.js";
import { trustFor } from "../../src/core/worker-install.js";
import {
  WORKER_REHEARSAL_IDENTITIES,
  WORKER_RELEASE_IDENTITIES,
} from "../../src/core/worker-release-identities.js";
import { compareVersions, seriesOf, type WorkerRelease } from "../../src/core/worker-releases.js";

const VERSION = "2.10.0";
const TAGS = [
  "cp312-cp312-macosx_11_0_arm64",
  "cp312-cp312-macosx_11_0_x86_64",
  "cp312-cp312-manylinux2014_aarch64.manylinux_2_17_aarch64.manylinux_2_28_aarch64",
  "cp312-cp312-manylinux2014_x86_64.manylinux_2_17_x86_64.manylinux_2_28_x86_64",
  "cp313-cp313-macosx_11_0_arm64",
  "cp313-cp313-manylinux2014_x86_64.manylinux_2_17_x86_64.manylinux_2_28_x86_64",
  "cp314-cp314-macosx_11_0_x86_64",
];
/** A release's files as the index lists them: the compiled wheels, one per Python and platform. */
const RELEASE = TAGS.map((tags) => ({
  filename: `pidgen_worker-${VERSION}-${tags}.whl`,
  url: `https://files.pythonhosted.org/${tags}.whl`,
  digests: { sha256: "a".repeat(64) },
}));

describe("choosing the wheel for this machine", () => {
  it.each([
    ["linux", "x64", "cp312-cp312-manylinux2014_x86_64"],
    ["linux", "arm64", "cp312-cp312-manylinux2014_aarch64"],
    ["darwin", "arm64", "cp312-cp312-macosx_11_0_arm64"],
    ["darwin", "x64", "cp312-cp312-macosx_11_0_x86_64"],
  ] as const)("picks the cp312 wheel for %s %s", (platform, arch, expected) => {
    const wheel = chooseWheel(RELEASE, { platform, arch });
    expect(wheel?.filename).toContain(`-${expected}`);
  });

  it("never picks another interpreter's wheel, and finds nothing on an unsupported platform", () => {
    const only313 = RELEASE.filter((file) => file.filename.includes("-cp313-"));
    expect(chooseWheel(only313, { platform: "linux", arch: "x64" })).toBeNull();
    expect(chooseWheel(RELEASE, { platform: "win32", arch: "x64" })).toBeNull();
  });

  it("skips a yanked file and falls back to a pure-Python wheel", () => {
    const yanked = RELEASE.map((file) => ({ ...file, yanked: true }));
    const pure = {
      filename: `pidgen_worker-${VERSION}-py3-none-any.whl`,
      url: "https://files.pythonhosted.org/pure.whl",
      digests: { sha256: "b".repeat(64) },
    };
    expect(chooseWheel(yanked, { platform: "linux", arch: "x64" })).toBeNull();
    expect(chooseWheel([...yanked, pure], { platform: "linux", arch: "x64" })).toBe(pure);
  });
});

describe("versions and series", () => {
  it("names a version's series, development builds included", () => {
    expect(seriesOf("2.10.3")).toBe("2.10");
    expect(seriesOf("2.10.0.dev4")).toBe("2.10");
  });

  it("names a pre-release's series", () => {
    expect(seriesOf("2.11.0b1")).toBe("2.11");
    expect(seriesOf("2.11b1")).toBe("2.11");
  });

  it("orders numerically, a development build before its release", () => {
    expect(compareVersions("2.10.0", "2.9.4")).toBe(1);
    expect(compareVersions("2.10.0.dev3", "2.10.0")).toBe(-1);
    expect(compareVersions("2.10.0.dev3", "2.10.0.dev12")).toBe(-1);
    expect(compareVersions("2.10", "2.9")).toBe(1);
  });

  it("orders development builds, alphas, betas and candidates before their release", () => {
    const ordered = [
      "2.11.0.dev1",
      "2.11.0a1",
      "2.11.0a2",
      "2.11.0b1.dev3",
      "2.11.0b1",
      "2.11.0b2",
      "2.11.0rc1",
      "2.11.0",
      "2.11.1b1",
    ];
    expect([...ordered].reverse().sort(compareVersions)).toEqual(ordered);
    expect(compareVersions("2.11.0b1", "2.11.0b1")).toBe(0);
  });

  // AC-b42540024705: the 2.11.1 sequence, a pre-release's development builds before it.
  it("orders the 2.11.1 pre-releases before 2.11.1, each pre-release's development builds first", () => {
    const ordered = [
      "2.11.0",
      "2.11.1.dev1",
      "2.11.1a1.dev2",
      "2.11.1a1",
      "2.11.1a2",
      "2.11.1b1.dev1",
      "2.11.1b1",
      "2.11.1b2",
      "2.11.1rc1.dev1",
      "2.11.1rc1",
      "2.11.1",
      "2.11.2b1",
    ];
    expect([...ordered].reverse().sort(compareVersions)).toEqual(ordered);
  });
});

describe("resolving a release from the index", () => {
  const SERIES: WorkerRelease = {
    series: "2.11",
    protocol: "2.11",
    status: "current",
    wheel: { project: "pidgen-worker", requirement: "pidgen-worker~=2.11.0" },
    container: { reference: "ghcr.io/example-org/worker:2.11" },
  };
  const files = (version: string) => [
    {
      filename: `pidgen_worker-${version}-py3-none-any.whl`,
      url: `https://files.pythonhosted.org/${version}.whl`,
      digests: { sha256: "c".repeat(64) },
    },
  ];
  const ctxFor = (versions: string[]) => ({
    workerRuntime: { platform: "linux", arch: "x64" } as const,
    fetch: async () =>
      new Response(
        JSON.stringify({
          releases: Object.fromEntries(versions.map((version) => [version, files(version)])),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  it("installs a beta from PyPI only when --version names it", async () => {
    const ctx = ctxFor(["2.11.0b1"]);
    const release = await resolveRelease(ctx, SERIES, PYPI, "2.11.0b1");
    expect(release.version).toBe("2.11.0b1");
    expect(release.wheel?.requirement).toBe("pidgen-worker==2.11.0b1");
  });

  it("refuses a series with only a beta without --version, and names the beta", async () => {
    const ctx = ctxFor(["2.10.4", "2.11.0a1", "2.11.0b1", "2.11.0.dev2"]);
    await expect(resolveRelease(ctx, SERIES, PYPI)).rejects.toMatchObject({
      code: "RELEASE_UNSUPPORTED",
      message: expect.stringContaining("--version 2.11.0b1"),
      details: { series: "2.11", version: null, index: "pypi", pre_release: "2.11.0b1" },
    });
  });

  it("takes the newest final release without --version, past a newer beta", async () => {
    const ctx = ctxFor(["2.11.0", "2.11.1b1"]);
    expect((await resolveRelease(ctx, SERIES, PYPI)).version).toBe("2.11.0");
  });

  it("never installs a development build from PyPI, even when named", async () => {
    const ctx = ctxFor(["2.11.0.dev2"]);
    await expect(resolveRelease(ctx, SERIES, PYPI, "2.11.0.dev2")).rejects.toMatchObject({
      code: "RELEASE_UNSUPPORTED",
      details: { version: "2.11.0.dev2", pre_release: null },
    });
  });
});

describe("choosing an update for the installed version", () => {
  const SERIES: WorkerRelease = {
    series: "2.11",
    protocol: "2.11",
    status: "current",
    wheel: { project: "pidgen-worker", requirement: "pidgen-worker~=2.11.0" },
    container: { reference: "ghcr.io/example-org/worker:2.11" },
  };
  const ctxFor = (versions: string[]) => ({
    workerRuntime: { platform: "linux", arch: "x64" } as const,
    fetch: async () =>
      new Response(
        JSON.stringify({
          releases: Object.fromEntries(
            versions.map((version) => [
              version,
              [
                {
                  filename: `pidgen_worker-${version}-py3-none-any.whl`,
                  url: `https://files.pythonhosted.org/${version}.whl`,
                  digests: { sha256: "d".repeat(64) },
                },
              ],
            ]),
          ),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });
  const update = async (installed: string, versions: string[]) =>
    (await resolveUpdate(ctxFor(versions), SERIES, PYPI, installed))?.version ?? null;

  // AC-354e6e8d93d3: a final release follows final releases only.
  it("from a final release, takes only a newer final release, never a pre-release", async () => {
    expect(await update("2.11.0", ["2.11.0", "2.11.1b1", "2.11.1b2"])).toBeNull();
    expect(await update("2.11.0", ["2.11.0", "2.11.1b1", "2.11.1b2", "2.11.1"])).toBe("2.11.1");
    expect(await update("2.11.0", ["2.11.0", "2.11.1rc1", "2.11.1a1"])).toBeNull();
  });

  // AC-459320f81622: a pre-release follows newer pre-releases and final releases.
  it("from a pre-release, takes the newest newer pre-release or final release", async () => {
    const published = ["2.11.0", "2.11.1a1", "2.11.1b2"];
    expect(await update("2.11.1b1", published)).toBe("2.11.1b2");
    expect(await update("2.11.1b1", [...published, "2.11.1rc1"])).toBe("2.11.1rc1");
    expect(await update("2.11.1b1", [...published, "2.11.1rc1", "2.11.1"])).toBe("2.11.1");
    // Development builds stay TestPyPI's.
    expect(await update("2.11.1b1", [...published, "2.11.1rc1.dev1", "2.11.2.dev1"])).toBe(
      "2.11.1b2",
    );
  });

  // AC-6dc48c17df0b: never older than, or equal to, the installed version.
  it("never chooses a version older than or equal to the installed one", async () => {
    expect(await update("2.11.1b1", ["2.11.0", "2.11.0b1", "2.11.1a1"])).toBeNull();
    expect(await update("2.11.1b1", ["2.11.0", "2.11.1b1"])).toBeNull();
    expect(await update("2.11.1", ["2.11.0", "2.11.1", "2.11.1b2"])).toBeNull();
  });

  // AC-36b3cb5005d0: once on a final release, later updates follow final releases only.
  it("after a pre-release is updated to a final release, follows final releases only", async () => {
    const installed = await update("2.11.1b2", ["2.11.1b2", "2.11.1"]);
    expect(installed).toBe("2.11.1");
    expect(await update(installed!, ["2.11.1b2", "2.11.1", "2.11.2b1"])).toBeNull();
    expect(await update(installed!, ["2.11.1b2", "2.11.1", "2.11.2b1", "2.11.2"])).toBe("2.11.2");
  });

  it("on TestPyPI, a development build newer than the installed version is a candidate", async () => {
    const release = await resolveUpdate(
      ctxFor(["2.11.0", "2.11.1.dev3"]),
      SERIES,
      TEST_PYPI,
      "2.11.0",
    );
    expect(release?.version).toBe("2.11.1.dev3");
    expect(
      await resolveUpdate(ctxFor(["2.11.0", "2.11.1.dev3"]), SERIES, TEST_PYPI, "2.11.1"),
    ).toBeNull();
  });

  // AC-5134f68c3ab6: --version installs exactly what it names, older or a pre-release.
  it("leaves --version to resolveRelease, which names an older release or a pre-release exactly", async () => {
    const ctx = ctxFor(["2.11.0", "2.11.1a1", "2.11.1b1", "2.11.1b2"]);
    expect((await resolveRelease(ctx, SERIES, PYPI, "2.11.0")).version).toBe("2.11.0");
    expect((await resolveRelease(ctx, SERIES, PYPI, "2.11.1a1")).version).toBe("2.11.1a1");
  });
});

describe("the index and its trust", () => {
  it("is PyPI unless --test, and only TestPyPI offers development builds", () => {
    expect(packageIndex(false)).toBe(PYPI);
    expect(packageIndex(true)).toBe(TEST_PYPI);
    expect(PYPI.devReleases).toBe(false);
    expect(TEST_PYPI.devReleases).toBe(true);
  });

  it("accepts a rehearsal signature (the release workflow run from a branch) only from TestPyPI", () => {
    const production = { identities: WORKER_RELEASE_IDENTITIES, trustedRoot: async () => ({}) };
    expect(trustFor(production, PYPI).identities).toBe(WORKER_RELEASE_IDENTITIES);
    expect(trustFor(production, TEST_PYPI).identities).toBe(WORKER_REHEARSAL_IDENTITIES);
    expect(WORKER_RELEASE_IDENTITIES.map((identity) => identity.subject)).not.toContainEqual(
      expect.stringContaining("refs/heads/"),
    );
    expect(WORKER_REHEARSAL_IDENTITIES.map((identity) => identity.subject)).toContain(
      "https://github.com/pidgen-ai/*/.github/workflows/release.yml@refs/heads/*",
    );
  });
});
