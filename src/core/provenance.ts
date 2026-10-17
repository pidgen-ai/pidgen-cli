import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { z } from "zod";
import { CliError, type ErrorDetails } from "./errors.js";
import { ExitCode } from "./exit-codes.js";
import { WORKER_RELEASE_IDENTITIES, type PublisherIdentity } from "./worker-release-identities.js";

/**
 * Decides whether a worker artifact was built by the worker's release workflow.
 *
 * The trust root is a publisher identity the CLI carries (`worker-release-identities.ts`), never
 * the App Service: release data names an artifact and its digest, and this module accepts the
 * artifact only when a Sigstore signature by an accepted identity covers exactly that digest.
 *
 * - A wheel carries a PEP 740 attestation on PyPI. Each attestation is verified as a Sigstore
 *   bundle against the trust root, its signer is matched against the accepted identities, and the
 *   digest it attests must be the digest of the downloaded file.
 * - An image carries a cosign signature in its registry. `cosign verify` checks it against an
 *   accepted identity at `<reference>@<digest>`; the image is then pulled by that digest.
 *
 * Every failure is a refusal: `PROVENANCE_INVALID`, exit 5, with `details.check` naming what
 * failed (`attestation`, `signature`, `identity`, `digest` or `reference`). Verification is not
 * optional and nothing here turns it off.
 */

export type { PublisherIdentity } from "./worker-release-identities.js";

/** The signer a verified Sigstore certificate names. */
export interface SignerIdentity {
  issuer: string;
  subject: string;
}

/**
 * What the wheel verifier trusts. Production uses `sigstorePublicGoodTrust`; tests inject a
 * recorded trust root and test identities, so they never reach PyPI or Sigstore.
 */
export interface ProvenanceTrust {
  /** The publishers whose signatures are accepted. */
  identities: readonly PublisherIdentity[];
  /**
   * The Sigstore trust root, in its JSON form (`application/vnd.dev.sigstore.trustedroot+json`):
   * the certificate authorities, transparency logs and certificate transparency logs a bundle
   * must chain to.
   */
  trustedRoot(): Promise<unknown>;
}

export interface WheelArtifact {
  /** The downloaded wheel. */
  path: string;
  /** The distribution file name the release and PyPI publish it under. */
  filename: string;
  /** The sha256 the release data names, when it names one; it must equal the file's. */
  expectedSha256?: string;
}

export interface VerifiedWheel {
  filename: string;
  sha256: string;
  identity: SignerIdentity;
}

export interface ImageArtifact {
  /** The image repository, without a tag or digest: `registry.example.com/org/worker`. */
  reference: string;
  /** The manifest digest the release names: `sha256:<64 hex>`. */
  digest: string;
}

export interface VerifiedImage {
  reference: string;
  digest: string;
  /** What to pull: the reference pinned to the verified digest. */
  pullReference: string;
  /** The accepted publisher identity cosign verified the signature against. */
  identity: PublisherIdentity;
  /**
   * The signer the verified signature's certificate names (cosign's `Issuer` and `Subject`), or
   * the accepted identity when cosign did not report them.
   */
  signer: SignerIdentity;
}

export interface CosignResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs `cosign` with an argument list. Rejects with `code: "ENOENT"` when cosign is missing. */
export interface CosignRunner {
  run(args: readonly string[]): Promise<CosignResult>;
}

export const PYPI_URL = "https://pypi.org";
const PYPI_INTEGRITY_MEDIA_TYPE = "application/vnd.pypi.integrity.v1+json";
const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";
const PYPI_PUBLISH_PREDICATE = "https://docs.pypi.org/attestations/publish/v1";
const BUNDLE_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json";
const SHA256_HEX = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
// A registry host (with an optional port) and one or more lowercase path components; no tag.
const IMAGE_REFERENCE =
  /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)+$/;
const COSIGN_DETAIL_LIMIT = 2_000;

type Check = "attestation" | "signature" | "identity" | "digest" | "reference";

export function provenanceInvalid(
  artifact: string,
  check: Check,
  message: string,
  details: ErrorDetails = {},
): CliError {
  return new CliError("PROVENANCE_INVALID", message, ExitCode.Refused, {
    artifact,
    check,
    ...details,
  });
}

// ---------------------------------------------------------------------------------------------
// Identities

/** The anchored regular expression for a subject pattern; `*` matches within one path segment. */
export function subjectRegexp(pattern: string): string {
  const literal = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^${pattern.split("*").map(literal).join("[^/]*")}$`;
}

export function identityMatches(accepted: PublisherIdentity, signer: SignerIdentity): boolean {
  return (
    accepted.issuer === signer.issuer &&
    new RegExp(subjectRegexp(accepted.subject)).test(signer.subject)
  );
}

// ---------------------------------------------------------------------------------------------
// Trust

/**
 * The production trust: the worker's release identities, and Sigstore's public-good trust root
 * fetched and verified through Sigstore's TUF repository, cached in `cacheDir`.
 */
export function sigstorePublicGoodTrust(options: { cacheDir: string }): ProvenanceTrust {
  return {
    identities: WORKER_RELEASE_IDENTITIES,
    trustedRoot: async () => {
      const [{ getTrustedRoot }, { TrustedRoot }] = await Promise.all([
        import("@sigstore/tuf"),
        import("@sigstore/protobuf-specs"),
      ]);
      try {
        return TrustedRoot.toJSON(await getTrustedRoot({ cachePath: options.cacheDir }));
      } catch (error) {
        throw new CliError(
          "NETWORK",
          "Could not load Sigstore's trust root, so the worker's provenance cannot be checked.",
          ExitCode.Network,
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Wheels (PEP 740)

const AttestationSchema = z.object({
  version: z.literal(1),
  verification_material: z.object({
    certificate: z.string().min(1),
    transparency_entries: z.array(z.record(z.string(), z.unknown())).min(1),
  }),
  envelope: z.object({ statement: z.string().min(1), signature: z.string().min(1) }),
});
type Attestation = z.infer<typeof AttestationSchema>;

const ProvenanceSchema = z.object({
  attestation_bundles: z.array(z.object({ attestations: z.array(z.unknown()) })),
});

const StatementSchema = z.object({
  _type: z.string(),
  predicateType: z.string(),
  subject: z.array(z.object({ name: z.string(), digest: z.record(z.string(), z.string()) })),
});

/**
 * Fetches the PEP 740 provenance PyPI publishes for one file of a release. A file with none is
 * refused here; what comes back is unverified until `verifyWheel` accepts it.
 */
export async function fetchWheelProvenance(
  fetchFn: typeof fetch,
  release: { project: string; version: string; filename: string },
  indexUrl: string = PYPI_URL,
): Promise<unknown> {
  const path = [release.project, release.version, release.filename].map(encodeURIComponent);
  const url = `${indexUrl.replace(/\/+$/, "")}/integrity/${path.join("/")}/provenance`;
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: { Accept: PYPI_INTEGRITY_MEDIA_TYPE },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new CliError(
      timedOut ? "TIMEOUT" : "NETWORK",
      `Could not fetch the provenance of ${release.filename} from ${new URL(url).origin}.`,
      ExitCode.Network,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (response.status === 404) {
    throw provenanceInvalid(
      release.filename,
      "attestation",
      `${release.filename} has no provenance attestation on ${new URL(url).origin}, so it cannot be shown to come from the worker's release workflow.`,
    );
  }
  if (!response.ok) {
    throw new CliError(
      "UNEXPECTED_RESPONSE",
      `${new URL(url).origin} answered ${response.status} for the provenance of ${release.filename}.`,
      ExitCode.Unexpected,
      { status: response.status },
    );
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new CliError(
      "UNEXPECTED_RESPONSE",
      `${new URL(url).origin} returned provenance for ${release.filename} that is not JSON.`,
      ExitCode.Unexpected,
    );
  }
}

/**
 * Accepts a downloaded wheel only when one of its PEP 740 attestations verifies against the trust
 * root, was signed by an accepted identity, and attests this file's name and sha256. Otherwise
 * throws `PROVENANCE_INVALID`.
 */
export async function verifyWheel(
  wheel: WheelArtifact,
  provenance: unknown,
  trust: ProvenanceTrust,
): Promise<VerifiedWheel> {
  const { filename } = wheel;
  const sha256 = await fileSha256(wheel.path);
  if (wheel.expectedSha256 !== undefined && wheel.expectedSha256.toLowerCase() !== sha256) {
    throw provenanceInvalid(
      filename,
      "digest",
      `The release names sha256 ${wheel.expectedSha256} for ${filename}, but the downloaded file's sha256 is ${sha256}.`,
      { sha256, expected: wheel.expectedSha256 },
    );
  }

  const attestations = readAttestations(provenance);
  if (attestations.length === 0) {
    throw provenanceInvalid(
      filename,
      "attestation",
      `${filename} has no provenance attestation, so it cannot be shown to come from the worker's release workflow.`,
    );
  }

  const verify = await bundleVerifier(trust);
  const failures: CliError[] = [];
  for (const attestation of attestations) {
    const result = checkAttestation(attestation, verify, wheel.filename, sha256, trust.identities);
    if (!(result instanceof CliError)) return { filename, sha256, identity: result };
    failures.push(result);
  }
  const [first] = failures as [CliError, ...CliError[]];
  if (failures.length > 1) {
    first.details["failures"] = failures.map((failure) => ({
      check: failure.details["check"],
      message: failure.message,
    }));
  }
  throw first;
}

function readAttestations(provenance: unknown): unknown[] {
  const parsed = ProvenanceSchema.safeParse(provenance);
  if (!parsed.success) return [];
  return parsed.data.attestation_bundles.flatMap((bundle) => bundle.attestations);
}

type BundleVerifier = (bundle: unknown) => SignerIdentity;

/** Builds a Sigstore verifier for the trust root; `@sigstore/*` loads only when it is needed. */
async function bundleVerifier(trust: ProvenanceTrust): Promise<BundleVerifier> {
  const [{ Verifier, toSignedEntity, toTrustMaterial }, { bundleFromJSON }, { TrustedRoot }] =
    await Promise.all([
      import("@sigstore/verify"),
      import("@sigstore/bundle"),
      import("@sigstore/protobuf-specs"),
    ]);
  const verifier = new Verifier(toTrustMaterial(TrustedRoot.fromJSON(await trust.trustedRoot())));
  return (json) => {
    const signer = verifier.verify(toSignedEntity(bundleFromJSON(json)));
    return {
      issuer: signer.identity?.extensions?.issuer ?? "",
      subject: signer.identity?.subjectAlternativeName ?? "",
    };
  };
}

function checkAttestation(
  candidate: unknown,
  verify: BundleVerifier,
  filename: string,
  sha256: string,
  identities: readonly PublisherIdentity[],
): SignerIdentity | CliError {
  const parsed = AttestationSchema.safeParse(candidate);
  if (!parsed.success) {
    return provenanceInvalid(
      filename,
      "attestation",
      `The provenance of ${filename} holds an attestation that is not a PEP 740 attestation.`,
    );
  }
  const attestation = parsed.data;

  let signer: SignerIdentity;
  try {
    signer = verify(toSigstoreBundle(attestation));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return provenanceInvalid(
      filename,
      "signature",
      `The attestation for ${filename} does not verify against Sigstore's trust root: ${reason}.`,
      { reason },
    );
  }

  if (!identities.some((identity) => identityMatches(identity, signer))) {
    return provenanceInvalid(
      filename,
      "identity",
      `The attestation for ${filename} was signed by ${signer.subject} (issuer ${signer.issuer}), which is not an accepted publisher of the Pidgen worker.`,
      { ...signer, accepted: identities.map((identity) => ({ ...identity })) },
    );
  }

  return checkStatement(attestation, filename, sha256) ?? signer;
}

/** A PEP 740 attestation is a DSSE envelope plus its verification material: a Sigstore bundle. */
function toSigstoreBundle(attestation: Attestation): unknown {
  return {
    mediaType: BUNDLE_MEDIA_TYPE,
    verificationMaterial: {
      certificate: { rawBytes: attestation.verification_material.certificate },
      tlogEntries: attestation.verification_material.transparency_entries,
      timestampVerificationData: { rfc3161Timestamps: [] },
    },
    dsseEnvelope: {
      payload: attestation.envelope.statement,
      payloadType: IN_TOTO_PAYLOAD_TYPE,
      signatures: [{ sig: attestation.envelope.signature, keyid: "" }],
    },
  };
}

/** The signed statement must be a PyPI publish attestation naming this file and its digest. */
function checkStatement(
  attestation: Attestation,
  filename: string,
  sha256: string,
): CliError | null {
  let statement: z.infer<typeof StatementSchema> | undefined;
  try {
    const json = JSON.parse(Buffer.from(attestation.envelope.statement, "base64").toString("utf8"));
    const parsed = StatementSchema.safeParse(json);
    if (parsed.success) statement = parsed.data;
  } catch {
    statement = undefined;
  }
  if (
    statement === undefined ||
    statement._type !== IN_TOTO_STATEMENT_V1 ||
    statement.predicateType !== PYPI_PUBLISH_PREDICATE
  ) {
    return provenanceInvalid(
      filename,
      "attestation",
      `The attestation for ${filename} is not a PyPI publish attestation.`,
    );
  }

  const named = statement.subject.filter((subject) => subject.name === filename);
  const attested = named
    .map((subject) => subject.digest["sha256"]?.toLowerCase())
    .filter((digest): digest is string => digest !== undefined && SHA256_HEX.test(digest));
  if (attested.includes(sha256)) return null;
  return provenanceInvalid(
    filename,
    "digest",
    attested.length === 0
      ? `The attestation does not attest a file named ${filename}; it names ${statement.subject.map((s) => s.name).join(", ") || "nothing"}.`
      : `The attestation for ${filename} covers sha256 ${attested.join(", ")}, but the downloaded file's sha256 is ${sha256}.`,
    { sha256, attested },
  );
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Images (cosign)

/** The real `cosign`, found on `env.PATH` and run with an argument list, never a shell. */
export function cosignRunner(env: Record<string, string | undefined> = process.env): CosignRunner {
  return {
    run: (args) =>
      new Promise((resolve, reject) => {
        execFile(
          "cosign",
          [...args],
          { env, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
          (error, stdout, stderr) => {
            if (error && typeof error.code === "string") {
              reject(error);
              return;
            }
            const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
            resolve({ exitCode, stdout, stderr });
          },
        );
      }),
  };
}

function cosignNotFound(): CliError {
  return new CliError(
    "COSIGN_NOT_FOUND",
    "cosign is required to verify the worker image's signature and was not found on PATH. Install cosign (https://docs.sigstore.dev/cosign/system_config/installation/) and run the command again.",
    ExitCode.Usage,
  );
}

/**
 * Accepts an image only when `cosign verify` passes for an accepted identity at
 * `<reference>@<digest>` and reports a signature over that digest. Otherwise throws
 * `PROVENANCE_INVALID`, or `COSIGN_NOT_FOUND` (exit 2) when cosign is not installed.
 */
export async function verifyImage(
  image: ImageArtifact,
  identities: readonly PublisherIdentity[],
  cosign: CosignRunner = cosignRunner(),
): Promise<VerifiedImage> {
  const { reference, digest } = image;
  if (!IMAGE_REFERENCE.test(reference)) {
    throw provenanceInvalid(
      reference,
      "reference",
      `${JSON.stringify(reference)} is not an image repository reference without a tag or digest.`,
    );
  }
  if (!IMAGE_DIGEST.test(digest)) {
    throw provenanceInvalid(
      reference,
      "digest",
      `${JSON.stringify(digest)} is not a sha256 image digest, so ${reference} cannot be verified by digest.`,
    );
  }
  const pinned = `${reference}@${digest}`;

  const failures: CosignResult[] = [];
  for (const identity of identities) {
    let result: CosignResult;
    try {
      result = await cosign.run([
        "verify",
        "--certificate-oidc-issuer",
        identity.issuer,
        "--certificate-identity-regexp",
        subjectRegexp(identity.subject),
        "--output",
        "json",
        pinned,
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") throw cosignNotFound();
      throw error;
    }
    if (result.exitCode === 0) {
      const signer = checkCosignOutput(result.stdout, reference, digest) ?? { ...identity };
      return { reference, digest, pullReference: pinned, identity, signer };
    }
    failures.push(result);
  }

  const cosignErrors = failures.map((failure) => failure.stderr.trim().slice(-COSIGN_DETAIL_LIMIT));
  const kinds = cosignErrors.map(classifyCosignError);
  const details = { digest, cosign: cosignErrors.join("\n") };
  if (kinds.length > 0 && kinds.every((kind) => kind === "attestation")) {
    throw provenanceInvalid(
      reference,
      "attestation",
      `${pinned} has no cosign signature, so it cannot be shown to come from the worker's release workflow.`,
      details,
    );
  }
  if (kinds.includes("identity")) {
    throw provenanceInvalid(
      reference,
      "identity",
      `${pinned} is not signed by an accepted publisher of the Pidgen worker.`,
      { ...details, accepted: identities.map((identity) => ({ ...identity })) },
    );
  }
  throw provenanceInvalid(
    reference,
    "signature",
    `The signature of ${pinned} does not verify.`,
    details,
  );
}

function classifyCosignError(stderr: string): Check {
  if (/no signatures found|no matching signatures:? .*not found/i.test(stderr))
    return "attestation";
  if (/expected identit|certificate identity|oidc issuer/i.test(stderr)) return "identity";
  return "signature";
}

const CosignOutputSchema = z.array(
  z.object({
    critical: z.object({
      image: z.object({ "docker-manifest-digest": z.string() }),
    }),
    optional: z.object({ Issuer: z.string().optional(), Subject: z.string().optional() }).nullish(),
  }),
);

/**
 * cosign printed the payloads it verified; one must be a signature over this digest. Returns the
 * signer that payload names, when cosign reported one.
 */
function checkCosignOutput(
  stdout: string,
  reference: string,
  digest: string,
): SignerIdentity | null {
  let payloads: z.infer<typeof CosignOutputSchema> | undefined;
  try {
    const parsed = CosignOutputSchema.safeParse(JSON.parse(stdout));
    if (parsed.success) payloads = parsed.data;
  } catch {
    payloads = undefined;
  }
  if (payloads === undefined || payloads.length === 0) {
    throw provenanceInvalid(
      reference,
      "signature",
      `cosign accepted ${reference}@${digest} but reported no verified signature.`,
    );
  }
  const signed = payloads.map((payload) => payload.critical.image["docker-manifest-digest"]);
  const covering = payloads.find(
    (payload) => payload.critical.image["docker-manifest-digest"] === digest,
  );
  if (covering === undefined) {
    throw provenanceInvalid(
      reference,
      "digest",
      `The verified signature of ${reference} covers ${signed.join(", ")}, not ${digest}.`,
      { digest, signed },
    );
  }
  const issuer = covering.optional?.Issuer;
  const subject = covering.optional?.Subject;
  return issuer !== undefined && subject !== undefined ? { issuer, subject } : null;
}
