import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError } from "../../src/core/errors.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import {
  cosignRunner,
  fetchWheelProvenance,
  identityMatches,
  sigstorePublicGoodTrust,
  subjectRegexp,
  verifyImage,
  verifyWheel,
  type CosignResult,
  type CosignRunner,
  type ProvenanceTrust,
} from "../../src/core/provenance.js";
import {
  WORKER_RELEASE_IDENTITIES,
  type PublisherIdentity,
} from "../../src/core/worker-release-identities.js";

// Recorded fixtures written by scripts/provenance-fixtures.mjs: a test Sigstore trust root and a
// fixture wheel whose PEP 740 attestation was signed by a test identity. Nothing here reaches
// PyPI, GHCR or Sigstore.
const FIXTURES = join(import.meta.dirname, "..", "fixtures", "provenance");
const WHEEL = "pidgen_worker-1.0.0-py3-none-any.whl";
const WHEEL_PATH = join(FIXTURES, WHEEL);
const WHEEL_SHA256 = "3254892dd2b00a6c9251218bee059ada42be1920e549e74047cf99528f883c07";
const TEST_ISSUER = "https://issuer.test.example";
const TEST_SUBJECT =
  "https://github.com/example-org/example-worker/.github/workflows/release.yml@refs/tags/v1.0.0";
const TEST_IDENTITY: PublisherIdentity = {
  issuer: TEST_ISSUER,
  subject:
    "https://github.com/example-org/example-worker/.github/workflows/release.yml@refs/tags/v*",
};
const IMAGE = {
  reference: "registry.test.example/example-org/worker",
  digest: "sha256:925955a225a5c7e39cfcc41964a065a7945e7c22a1d27d11976ea928e8c0b4c3",
};

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as unknown;

function testTrust(identities: readonly PublisherIdentity[] = [TEST_IDENTITY]): ProvenanceTrust {
  return { identities, trustedRoot: async () => fixture("trusted-root.json") };
}

interface Attestation {
  envelope: { statement: string; signature: string };
}
interface Provenance {
  attestation_bundles: { attestations: Attestation[] }[];
}
const provenance = (name = "provenance.json") => fixture(name) as Provenance;

async function refusal(promise: Promise<unknown>): Promise<CliError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CliError);
  return error as CliError;
}

async function expectProvenanceInvalid(
  promise: Promise<unknown>,
  check: string,
): Promise<CliError> {
  const error = await refusal(promise);
  expect(error.code).toBe("PROVENANCE_INVALID");
  expect(error.exitCode).toBe(ExitCode.Refused);
  expect(error.details["check"]).toBe(check);
  return error;
}

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pidgen-provenance-"));
  // A unit test that tried to reach PyPI or Sigstore over the network would fail here.
  vi.stubGlobal("fetch", () => {
    throw new Error("provenance tests must not use the network");
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(tmp, { recursive: true, force: true });
});

describe("verifyWheel", () => {
  it("accepts a wheel whose attestation verifies, names an accepted identity and attests its digest", async () => {
    const verified = await verifyWheel(
      { path: WHEEL_PATH, filename: WHEEL },
      provenance(),
      testTrust(),
    );
    expect(verified).toEqual({
      filename: WHEEL,
      sha256: WHEEL_SHA256,
      identity: { issuer: TEST_ISSUER, subject: TEST_SUBJECT },
    });
  });

  it("accepts when the release names the same digest", async () => {
    const verified = await verifyWheel(
      { path: WHEEL_PATH, filename: WHEEL, expectedSha256: WHEEL_SHA256 },
      provenance(),
      testTrust(),
    );
    expect(verified.sha256).toBe(WHEEL_SHA256);
  });

  it("accepts when one of several accepted identities signed it", async () => {
    const other = { issuer: TEST_ISSUER, subject: "https://github.com/example-org/other/*" };
    await expect(
      verifyWheel(
        { path: WHEEL_PATH, filename: WHEEL },
        provenance(),
        testTrust([other, TEST_IDENTITY]),
      ),
    ).resolves.toMatchObject({ sha256: WHEEL_SHA256 });
  });

  it.each([
    ["no provenance at all", null],
    ["no attestation bundles", { version: 1, attestation_bundles: [] }],
    ["a bundle with no attestations", { version: 1, attestation_bundles: [{ attestations: [] }] }],
    ["something that is not a provenance object", { hello: "world" }],
  ])("refuses %s as a missing attestation", async (_name, value) => {
    const error = await expectProvenanceInvalid(
      verifyWheel({ path: WHEEL_PATH, filename: WHEEL }, value, testTrust()),
      "attestation",
    );
    expect(error.message).toContain(WHEEL);
    expect(error.details["artifact"]).toBe(WHEEL);
  });

  it("refuses an attestation signed by an identity it does not accept, naming that identity", async () => {
    const error = await expectProvenanceInvalid(
      verifyWheel(
        { path: WHEEL_PATH, filename: WHEEL },
        provenance("provenance-wrong-identity.json"),
        testTrust(),
      ),
      "identity",
    );
    expect(error.message).toContain(
      "https://github.com/example-org/impostor/.github/workflows/release.yml@refs/tags/v1.0.0",
    );
    expect(error.details["accepted"]).toEqual([TEST_IDENTITY]);
  });

  it("refuses the test-signed release against the production identities", async () => {
    await expectProvenanceInvalid(
      verifyWheel(
        { path: WHEEL_PATH, filename: WHEEL },
        provenance(),
        testTrust(WORKER_RELEASE_IDENTITIES),
      ),
      "identity",
    );
  });

  it("refuses a tampered file: the attested digest is not the downloaded file's", async () => {
    const tampered = join(tmp, WHEEL);
    const bytes = await readFile(WHEEL_PATH);
    await writeFile(tampered, Buffer.concat([bytes, Buffer.from("import os\n")]));

    const error = await expectProvenanceInvalid(
      verifyWheel({ path: tampered, filename: WHEEL }, provenance(), testTrust()),
      "digest",
    );
    expect(error.message).toContain(WHEEL_SHA256);
    expect(error.details["attested"]).toEqual([WHEEL_SHA256]);
    expect(error.details["sha256"]).not.toBe(WHEEL_SHA256);
  });

  it("refuses a digest that does not match the one the release names", async () => {
    const error = await expectProvenanceInvalid(
      verifyWheel(
        { path: WHEEL_PATH, filename: WHEEL, expectedSha256: "0".repeat(64) },
        provenance(),
        testTrust(),
      ),
      "digest",
    );
    expect(error.message).toContain("0".repeat(64));
  });

  it("refuses an attestation for another file name", async () => {
    await expectProvenanceInvalid(
      verifyWheel(
        { path: WHEEL_PATH, filename: "pidgen_worker-9.9.9-py3-none-any.whl" },
        provenance(),
        testTrust(),
      ),
      "digest",
    );
  });

  it("refuses a tampered attestation whose signature no longer covers its statement", async () => {
    const forged = provenance();
    const attestation = forged.attestation_bundles[0]!.attestations[0]!;
    const statement = JSON.parse(
      Buffer.from(attestation.envelope.statement, "base64").toString("utf8"),
    ) as { subject: { digest: { sha256: string } }[] };
    statement.subject[0]!.digest.sha256 = "1".repeat(64);
    attestation.envelope.statement = Buffer.from(JSON.stringify(statement)).toString("base64");

    const error = await expectProvenanceInvalid(
      verifyWheel({ path: WHEEL_PATH, filename: WHEEL }, forged, testTrust()),
      "signature",
    );
    expect(error.message).toContain("does not verify");
  });

  it("refuses an attestation that does not chain to the injected trust root", async () => {
    const root = fixture("trusted-root.json") as { certificateAuthorities: unknown[] };
    root.certificateAuthorities = [];
    await expectProvenanceInvalid(
      verifyWheel({ path: WHEEL_PATH, filename: WHEEL }, provenance(), {
        identities: [TEST_IDENTITY],
        trustedRoot: async () => root,
      }),
      "signature",
    );
  });

  it("has no way to skip verification", async () => {
    const tampered = join(tmp, WHEEL);
    await writeFile(tampered, "not the wheel");
    const lenient = {
      path: tampered,
      filename: WHEEL,
      skip: true,
      skipVerification: true,
      insecure: true,
    };
    await expectProvenanceInvalid(verifyWheel(lenient, provenance(), testTrust()), "digest");

    const source = await readFile(
      join(import.meta.dirname, "..", "..", "src", "core", "provenance.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/skip|insecure|no-verify|PIDGEN_[A-Z_]*VERIFY/i);
  });
});

describe("fetchWheelProvenance", () => {
  const release = { project: "pidgen-worker", version: "1.0.0", filename: WHEEL };

  it("asks PyPI's integrity API for the exact file and returns the provenance", async () => {
    const fetchFn = vi.fn(async () => Response.json(provenance()));
    await expect(fetchWheelProvenance(fetchFn, release)).resolves.toEqual(provenance());
    expect(fetchFn).toHaveBeenCalledWith(
      `https://pypi.org/integrity/pidgen-worker/1.0.0/${WHEEL}/provenance`,
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/vnd.pypi.integrity.v1+json" }),
      }),
    );
  });

  it("refuses a file with no attestation", async () => {
    const fetchFn = vi.fn(async () => new Response("not found", { status: 404 }));
    const error = await expectProvenanceInvalid(
      fetchWheelProvenance(fetchFn, release),
      "attestation",
    );
    expect(error.message).toContain(WHEEL);
  });

  it("reports a network failure as exit 8", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const error = await refusal(fetchWheelProvenance(fetchFn, release));
    expect(error.code).toBe("NETWORK");
    expect(error.exitCode).toBe(ExitCode.Network);
  });
});

describe("verifyImage", () => {
  const recorded = readFileSync(join(FIXTURES, "cosign-verify.json"), "utf8");

  function fakeCosign(...results: CosignResult[]): CosignRunner & { calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      run: async (args) => {
        calls.push([...args]);
        const result = results.shift();
        if (!result) throw new Error("unexpected cosign call");
        return result;
      },
    };
  }

  it("runs cosign verify with the accepted issuer and identity against reference@digest", async () => {
    const cosign = fakeCosign({ exitCode: 0, stdout: recorded, stderr: "" });
    const verified = await verifyImage(IMAGE, [TEST_IDENTITY], cosign);
    expect(cosign.calls).toEqual([
      [
        "verify",
        "--certificate-oidc-issuer",
        TEST_ISSUER,
        "--certificate-identity-regexp",
        subjectRegexp(TEST_IDENTITY.subject),
        "--output",
        "json",
        `${IMAGE.reference}@${IMAGE.digest}`,
      ],
    ]);
    expect(verified).toEqual({
      reference: IMAGE.reference,
      digest: IMAGE.digest,
      pullReference: `${IMAGE.reference}@${IMAGE.digest}`,
      identity: TEST_IDENTITY,
      // The signer the recorded cosign output names, not the accepted pattern.
      signer: { issuer: TEST_ISSUER, subject: TEST_SUBJECT },
    });
  });

  it("tries each accepted identity until one passes", async () => {
    const other = { issuer: "https://other-issuer.test.example", subject: "https://example.com/*" };
    const cosign = fakeCosign(
      { exitCode: 1, stdout: "", stderr: "Error: none of the expected identities matched" },
      { exitCode: 0, stdout: recorded, stderr: "" },
    );
    const verified = await verifyImage(IMAGE, [other, TEST_IDENTITY], cosign);
    expect(cosign.calls).toHaveLength(2);
    expect(cosign.calls[0]).toContain("https://other-issuer.test.example");
    expect(verified.identity).toEqual(TEST_IDENTITY);
  });

  it("refuses an image signed by another identity", async () => {
    const cosign = fakeCosign({
      exitCode: 1,
      stdout: "",
      stderr:
        "Error: no matching signatures: none of the expected identities matched what was in the certificate",
    });
    const error = await expectProvenanceInvalid(
      verifyImage(IMAGE, [TEST_IDENTITY], cosign),
      "identity",
    );
    expect(error.message).toContain(IMAGE.reference);
    expect(error.details["cosign"]).toContain("none of the expected identities matched");
  });

  it("refuses an unsigned image as a missing signature", async () => {
    const cosign = fakeCosign({
      exitCode: 1,
      stdout: "",
      stderr: "Error: no signatures found",
    });
    await expectProvenanceInvalid(verifyImage(IMAGE, [TEST_IDENTITY], cosign), "attestation");
  });

  it("refuses any other failing cosign result", async () => {
    const cosign = fakeCosign({ exitCode: 1, stdout: "", stderr: "Error: invalid signature" });
    await expectProvenanceInvalid(verifyImage(IMAGE, [TEST_IDENTITY], cosign), "signature");
  });

  it("refuses a passing result that does not cover the digest it was asked about", async () => {
    const other = { ...IMAGE, digest: `sha256:${"2".repeat(64)}` };
    const cosign = fakeCosign({ exitCode: 0, stdout: recorded, stderr: "" });
    await expectProvenanceInvalid(verifyImage(other, [TEST_IDENTITY], cosign), "digest");
  });

  it("refuses a passing result with unreadable output", async () => {
    const cosign = fakeCosign({ exitCode: 0, stdout: "Verification OK", stderr: "" });
    await expectProvenanceInvalid(verifyImage(IMAGE, [TEST_IDENTITY], cosign), "signature");
  });

  it.each([
    ["a tag instead of a digest", { ...IMAGE, digest: "latest" }, "digest"],
    ["a short digest", { ...IMAGE, digest: "sha256:abc" }, "digest"],
    ["a reference that is a flag", { ...IMAGE, reference: "--insecure-ignore-tlog" }, "reference"],
    [
      "a reference that already pins",
      { ...IMAGE, reference: `${IMAGE.reference}@${IMAGE.digest}` },
      "reference",
    ],
  ])("refuses %s without running cosign", async (_name, image, check) => {
    const cosign = fakeCosign();
    await expectProvenanceInvalid(verifyImage(image, [TEST_IDENTITY], cosign), check);
    expect(cosign.calls).toEqual([]);
  });

  it("reports a missing cosign as a prerequisite error", async () => {
    const cosign: CosignRunner = {
      run: async () => {
        throw Object.assign(new Error("spawn cosign ENOENT"), { code: "ENOENT" });
      },
    };
    const error = await refusal(verifyImage(IMAGE, [TEST_IDENTITY], cosign));
    expect(error.code).toBe("COSIGN_NOT_FOUND");
    expect(error.exitCode).toBe(ExitCode.Usage);
    expect(error.message).toMatch(/cosign/);
  });

  it("finds no cosign on an empty PATH with the real runner", async () => {
    const error = await refusal(verifyImage(IMAGE, [TEST_IDENTITY], cosignRunner({ PATH: tmp })));
    expect(error.code).toBe("COSIGN_NOT_FOUND");
  });
});

describe("identities", () => {
  const workflow = (repository: string) =>
    `https://github.com/${repository}/.github/workflows/release.yml`;

  it("match a release workflow in any repository of the organization, from a v* tag", () => {
    const identity = WORKER_RELEASE_IDENTITIES[0]!;
    const signer = (subject: string) => ({ issuer: identity.issuer, subject });
    expect(
      identityMatches(identity, signer(`${workflow("pidgen-ai/any-repo")}@refs/tags/v1.2.3`)),
    ).toBe(true);
    expect(
      identityMatches(identity, signer(`${workflow("pidgen-ai/any-repo")}@refs/heads/main`)),
    ).toBe(false);
    expect(
      identityMatches(
        identity,
        signer(`${workflow("pidgen-ai/any-repo")}@refs/tags/v1/../../heads/main`),
      ),
    ).toBe(false);
    expect(
      identityMatches(identity, signer(`${workflow("pidgen-ai/any-repo")}x@refs/tags/v1`)),
    ).toBe(false);
    // Another owner, a look-alike owner, or a deeper path is not the organization.
    expect(
      identityMatches(identity, signer(`${workflow("example-org/any-repo")}@refs/tags/v1`)),
    ).toBe(false);
    expect(
      identityMatches(identity, signer(`${workflow("pidgen-aix/any-repo")}@refs/tags/v1`)),
    ).toBe(false);
    expect(identityMatches(identity, signer(`${workflow("pidgen-ai/a/b")}@refs/tags/v1`))).toBe(
      false,
    );
    expect(
      identityMatches(identity, {
        issuer: "https://issuer.test.example",
        subject: `${workflow("pidgen-ai/any-repo")}@refs/tags/v1.2.3`,
      }),
    ).toBe(false);
  });

  it("gives cosign an anchored regular expression for the same pattern", () => {
    const regexp = new RegExp(subjectRegexp(WORKER_RELEASE_IDENTITIES[0]!.subject));
    expect(regexp.source.startsWith("^")).toBe(true);
    expect(regexp.source.endsWith("$")).toBe(true);
    expect(regexp.test(`${workflow("pidgen-ai/any-repo")}@refs/tags/v2.0.0`)).toBe(true);
    expect(
      regexp.test(
        "https://github.com/pidgen-ai/any-repo/.github/workflows/releaseXyml@refs/tags/v2",
      ),
    ).toBe(false);
  });

  it("are a short production list naming the organization, never a repository", () => {
    expect(WORKER_RELEASE_IDENTITIES.length).toBeGreaterThanOrEqual(1);
    expect(WORKER_RELEASE_IDENTITIES.length).toBeLessThanOrEqual(3);
    expect(WORKER_RELEASE_IDENTITIES).toContainEqual({
      issuer: "https://token.actions.githubusercontent.com",
      subject: "https://github.com/pidgen-ai/*/.github/workflows/release.yml@refs/tags/v*",
    });
    for (const identity of WORKER_RELEASE_IDENTITIES) {
      expect(identity.issuer).toBe("https://token.actions.githubusercontent.com");
      expect(identity.subject).toMatch(
        /^https:\/\/github\.com\/pidgen-ai\/\*\/\.github\/workflows\/[\w.-]+@refs\/tags\/v\*$/,
      );
    }
  });

  it("leave the worker's repository unnamed everywhere in this repository", async () => {
    // Built from parts, so this file does not name it either.
    const repository = ["pidgen-ai", "pidgen-worker"].join("/");
    const root = join(import.meta.dirname, "..", "..");
    const naming: string[] = [];
    for (const dir of ["src", "docs", "skills", "scripts", "tests", ".github"]) {
      for (const file of await readdir(join(root, dir), { recursive: true })) {
        const path = join(root, dir, file);
        if (!/\.(ts|mts|mjs|js|json|md|ya?ml|txt|stderr)$/.test(file)) continue;
        if ((await readFile(path, "utf8").catch(() => "")).includes(repository))
          naming.push(join(dir, file));
      }
    }
    for (const file of [
      "AGENTS.md",
      "README.md",
      "CONTRIBUTING.md",
      "CHANGELOG.md",
      "package.json",
    ]) {
      if ((await readFile(join(root, file), "utf8")).includes(repository)) naming.push(file);
    }
    expect(naming).toEqual([]);
  });

  it("stay out of the docs, which name the worker by its PyPI location only", async () => {
    const root = join(import.meta.dirname, "..", "..");
    const docs = (await readdir(join(root, "docs"))).filter((file) => file.endsWith(".md"));
    const pages = [...docs.map((file) => join("docs", file)), "README.md", "CHANGELOG.md"];
    for (const page of pages) {
      const text = await readFile(join(root, page), "utf8");
      // No signer issuer, and no pidgen-ai GitHub location but this CLI's own repository.
      expect(text, page).not.toMatch(/token\.actions\.githubusercontent\.com/);
      expect(text, page).not.toMatch(/github\.com\/pidgen-ai\/(?!pidgen-cli\b)/);
    }
    expect(await readFile(join(root, "docs", "workers.md"), "utf8")).toContain(
      "https://pypi.org/project/pidgen-worker/",
    );
  });

  it("are the identities the production trust carries", () => {
    const trust = sigstorePublicGoodTrust({ cacheDir: tmp });
    expect(trust.identities).toBe(WORKER_RELEASE_IDENTITIES);
  });

  it("are described in AGENTS.md by organization", async () => {
    const agents = await readFile(join(import.meta.dirname, "..", "..", "AGENTS.md"), "utf8");
    expect(agents).toContain("src/core/worker-release-identities.ts");
    expect(agents).toMatch(/names only the\s+`pidgen-ai` GitHub organization/);
  });
});

describe("test fixtures", () => {
  it("use only test hosts in their trust root", () => {
    const text = readFileSync(join(FIXTURES, "trusted-root.json"), "utf8");
    const urls = text.match(/https:\/\/[^"]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(new URL(url).hostname).toMatch(/\.test\.example$/);
  });
});

describe("runtime dependencies", () => {
  it("are each justified in CONTRIBUTING.md", async () => {
    const root = join(import.meta.dirname, "..", "..");
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const contributing = await readFile(join(root, "CONTRIBUTING.md"), "utf8");
    for (const name of Object.keys(pkg.dependencies)) {
      expect(contributing, name).toContain(`\`${name}\``);
    }
    expect(contributing).toMatch(/sigstore[^\n]*(provenance|attestation)/i);
  });
});
