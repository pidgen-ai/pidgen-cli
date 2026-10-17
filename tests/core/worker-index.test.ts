import { describe, expect, it } from "vitest";
import { chooseWheel, packageIndex, PYPI, TEST_PYPI } from "../../src/core/worker-index.js";
import { trustFor } from "../../src/core/worker-install.js";
import {
  WORKER_REHEARSAL_IDENTITIES,
  WORKER_RELEASE_IDENTITIES,
} from "../../src/core/worker-release-identities.js";
import { compareVersions, seriesOf } from "../../src/core/worker-releases.js";

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

  it("orders numerically, a development build before its release", () => {
    expect(compareVersions("2.10.0", "2.9.4")).toBe(1);
    expect(compareVersions("2.10.0.dev3", "2.10.0")).toBe(-1);
    expect(compareVersions("2.10.0.dev3", "2.10.0.dev12")).toBe(-1);
    expect(compareVersions("2.10", "2.9")).toBe(1);
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
