/**
 * The publishers the CLI accepts as the builder of a Pidgen worker release.
 *
 * Every worker release is built by a GitHub Actions workflow and signed through Sigstore with that
 * workflow's identity: the wheel's PEP 740 attestation on PyPI and the image's cosign signature.
 * The CLI installs only what one of these identities signed; release data from the App Service
 * names versions and artifacts but is never trusted on its own.
 *
 * The identity names the `pidgen-ai` GitHub organization, never a repository (AGENTS.md,
 * "Boundaries"): a `release.yml` workflow in any of its repositories, run from a `v*` tag. Writing
 * to the organization's repositories is the trust being placed; a fork belongs to another owner and
 * never matches. The signature must still cover exactly the file the package index serves.
 *
 * Keep this list short. It holds more than one entry only while the release workflow moves, so the
 * old and new identities overlap for a release.
 */
export interface PublisherIdentity {
  /** The OIDC issuer the signing certificate must name, compared exactly. */
  issuer: string;
  /**
   * The certificate's subject (its SAN URI). `*` stands for any run of characters within one path
   * segment (no `/`); everything else is compared literally.
   */
  subject: string;
}

const GITHUB_ACTIONS = "https://token.actions.githubusercontent.com";
const RELEASE_WORKFLOW = "https://github.com/pidgen-ai/*/.github/workflows/release.yml";

/** A release: `release.yml` in a `pidgen-ai` repository, run from a `v*` tag. */
export const WORKER_RELEASE_IDENTITIES: readonly PublisherIdentity[] = Object.freeze([
  Object.freeze({ issuer: GITHUB_ACTIONS, subject: `${RELEASE_WORKFLOW}@refs/tags/v*` }),
]);

/**
 * What `--test` (TestPyPI) also accepts: a rehearsal, the same workflow run from a branch. Never
 * accepted for an install from PyPI.
 */
export const WORKER_REHEARSAL_IDENTITIES: readonly PublisherIdentity[] = Object.freeze([
  ...WORKER_RELEASE_IDENTITIES,
  Object.freeze({ issuer: GITHUB_ACTIONS, subject: `${RELEASE_WORKFLOW}@refs/heads/*` }),
]);
