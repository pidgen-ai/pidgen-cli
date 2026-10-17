#!/usr/bin/env node
// Writes the recorded provenance fixtures in tests/fixtures/provenance/.
//
// The fixtures stand in for a worker release signed through Sigstore, without reaching PyPI, GHCR
// or Sigstore. This script plays every Sigstore role with throwaway keys: a test certificate
// authority (Fulcio), a test transparency log (Rekor) and a test certificate transparency log. It
// issues short-lived certificates to a test identity and to an impostor, has each sign a PEP 740
// attestation for the fixture wheel, logs the signature, and writes:
//
//   trusted-root.json                       the test trust root (public keys and the CA only)
//   pidgen_worker-1.0.0-py3-none-any.whl    the fixture wheel
//   provenance.json                         PyPI integrity API response, signed by the test identity
//   provenance-wrong-identity.json          the same, signed by an impostor identity
//   cosign-verify.json                      recorded `cosign verify` output for a fixture image
//
// The private keys are discarded, so the recorded fixtures are the only copies. Run it again only
// to change them: `node scripts/provenance-fixtures.mjs`.
import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "provenance");

export const TEST_ISSUER = "https://issuer.test.example";
export const TEST_SUBJECT =
  "https://github.com/example-org/example-worker/.github/workflows/release.yml@refs/tags/v1.0.0";
const IMPOSTOR_SUBJECT =
  "https://github.com/example-org/impostor/.github/workflows/release.yml@refs/tags/v1.0.0";
const REKOR_URL = "https://rekor.test.example";
const REKOR_ORIGIN = "rekor.test.example - 1";
const WHEEL = "pidgen_worker-1.0.0-py3-none-any.whl";
const INTEGRATED_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);
const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";

// --- DER encoding ------------------------------------------------------------------------------

function length(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...parts) => {
  const value = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(value.length), value]);
};
const seq = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
const octets = (value) => tlv(0x04, value);
const utf8 = (text) => tlv(0x0c, Buffer.from(text, "utf8"));
const bool = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const bits = (value, unused = 0) => tlv(0x03, Buffer.from([unused]), value);
const explicit = (n, ...parts) => tlv(0xa0 + n, ...parts);
function integer(value) {
  let bytes = Buffer.isBuffer(value) ? value : Buffer.from([value]);
  while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] & 0x80) === 0) bytes = bytes.subarray(1);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(0x02, bytes);
}
function oid(dotted) {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [40 * a + b];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let v = arc >> 7; v > 0; v >>= 7) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}
function utcTime(ms) {
  const iso = new Date(ms).toISOString();
  const text = iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);
  return tlv(
    0x17,
    Buffer.from(text + iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19) + "Z"),
  );
}
const extension = (id, critical, value) =>
  critical ? seq(oid(id), bool(true), octets(value)) : seq(oid(id), octets(value));

const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const sha256 = (...parts) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

// --- Keys and certificates ---------------------------------------------------------------------

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privateKey, spki: publicKey.export({ type: "spki", format: "der" }) };
}
const signDer = (key, data) => sign("sha256", data, key);
const serial = () => integer(Buffer.concat([Buffer.from([0x01]), randomBytes(15)]));

function certificate(tbs, issuerKey) {
  return seq(tbs, ECDSA_SHA256, bits(signDer(issuerKey, tbs)));
}

const caKey = keyPair();
const caName = seq(
  set(seq(oid("2.5.4.10"), utf8("Example Test Sigstore"))),
  set(seq(oid("2.5.4.3"), utf8("test-fulcio"))),
);
const caKeyId = sha256(caKey.spki).subarray(0, 20);
const caCert = certificate(
  seq(
    explicit(0, integer(2)),
    serial(),
    ECDSA_SHA256,
    caName,
    seq(utcTime(Date.UTC(2025, 0, 1)), utcTime(Date.UTC(2035, 0, 1))),
    caName,
    caKey.spki,
    explicit(
      3,
      seq(
        extension("2.5.29.15", true, bits(Buffer.from([0x06]), 1)),
        extension("2.5.29.19", true, seq(bool(true), integer(1))),
        extension("2.5.29.14", false, octets(caKeyId)),
      ),
    ),
  ),
  caKey.privateKey,
);

const rekorKey = keyPair();
const rekorLogId = sha256(rekorKey.spki);
const ctKey = keyPair();
const ctLogId = sha256(ctKey.spki);

/** A Fulcio-style leaf: empty subject, SAN URI, OIDC issuer extension, and an embedded SCT. */
function leafCertificate(subject, leafKey) {
  const notBefore = INTEGRATED_TIME - 60_000;
  const notAfter = INTEGRATED_TIME + 9 * 60_000;
  const extensions = [
    extension("2.5.29.15", true, bits(Buffer.from([0x80]), 7)),
    extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.3"))),
    extension("2.5.29.14", false, octets(sha256(leafKey.spki).subarray(0, 20))),
    extension("2.5.29.35", false, seq(tlv(0x80, caKeyId))),
    extension("2.5.29.17", true, seq(tlv(0x86, Buffer.from(subject, "ascii")))),
    extension("1.3.6.1.4.1.57264.1.8", false, utf8(TEST_ISSUER)),
  ];
  const certSerial = serial();
  const tbs = (exts) =>
    seq(
      explicit(0, integer(2)),
      certSerial,
      ECDSA_SHA256,
      caName,
      seq(utcTime(notBefore), utcTime(notAfter)),
      seq(),
      leafKey.spki,
      explicit(3, seq(...exts)),
    );

  // RFC 6962 SCT over the precertificate: the TBS without the SCT extension.
  const preCertTbs = tbs(extensions);
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(notBefore + 1_000));
  const u24 = Buffer.from([
    (preCertTbs.length >> 16) & 0xff,
    (preCertTbs.length >> 8) & 0xff,
    preCertTbs.length & 0xff,
  ]);
  const signed = Buffer.concat([
    Buffer.from([0, 0]),
    timestamp,
    Buffer.from([0, 1]),
    sha256(caKey.spki),
    u24,
    preCertTbs,
    Buffer.from([0, 0]),
  ]);
  const signature = signDer(ctKey.privateKey, signed);
  const sigLength = Buffer.alloc(2);
  sigLength.writeUInt16BE(signature.length);
  const sct = Buffer.concat([
    Buffer.from([0]),
    ctLogId,
    timestamp,
    Buffer.from([0, 0, 4, 3]),
    sigLength,
    signature,
  ]);
  const sctLength = Buffer.alloc(2);
  sctLength.writeUInt16BE(sct.length);
  const listLength = Buffer.alloc(2);
  listLength.writeUInt16BE(sct.length + 2);
  const sctList = Buffer.concat([listLength, sctLength, sct]);

  const withSct = [...extensions, extension("1.3.6.1.4.1.11129.2.4.2", false, octets(sctList))];
  return certificate(tbs(withSct), caKey.privateKey);
}

// --- Canonical JSON (RFC 8785 subset: what Rekor signs) ----------------------------------------

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

// --- Attestations ------------------------------------------------------------------------------

function pae(payloadType, payload) {
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.length} `),
    payload,
  ]);
}

function attestation(subject, statement) {
  const leafKey = keyPair();
  const leaf = leafCertificate(subject, leafKey);
  const payload = Buffer.from(JSON.stringify(statement));
  const signature = signDer(leafKey.privateKey, pae(IN_TOTO_PAYLOAD_TYPE, payload));
  const pem =
    `-----BEGIN CERTIFICATE-----\n${leaf.toString("base64").replace(/.{64}/g, "$&\n")}\n-----END CERTIFICATE-----\n`.replace(
      "\n\n",
      "\n",
    );
  const envelope = {
    payload: payload.toString("base64"),
    payloadType: IN_TOTO_PAYLOAD_TYPE,
    signatures: [{ keyid: "", sig: signature.toString("base64") }],
  };
  const body = Buffer.from(
    canonicalize({
      apiVersion: "0.0.1",
      kind: "dsse",
      spec: {
        envelopeHash: {
          algorithm: "sha256",
          value: sha256(canonicalize(envelope)).toString("hex"),
        },
        payloadHash: { algorithm: "sha256", value: sha256(payload).toString("hex") },
        signatures: [
          {
            signature: signature.toString("base64"),
            verifier: Buffer.from(pem).toString("base64"),
          },
        ],
      },
    }),
  );
  const integratedTime = INTEGRATED_TIME / 1000;
  const set = signDer(
    rekorKey.privateKey,
    Buffer.from(
      canonicalize({
        body: body.toString("base64"),
        integratedTime,
        logID: rekorLogId.toString("hex"),
        logIndex: 0,
      }),
    ),
  );
  const rootHash = sha256(Buffer.from([0]), body);
  const note = `${REKOR_ORIGIN}\n1\n${rootHash.toString("base64")}\n`;
  const noteSignature = Buffer.concat([
    rekorLogId.subarray(0, 4),
    signDer(rekorKey.privateKey, Buffer.from(note)),
  ]);
  return {
    version: 1,
    verification_material: {
      certificate: leaf.toString("base64"),
      transparency_entries: [
        {
          logIndex: "0",
          logId: { keyId: rekorLogId.toString("base64") },
          kindVersion: { kind: "dsse", version: "0.0.1" },
          integratedTime: String(integratedTime),
          inclusionPromise: { signedEntryTimestamp: set.toString("base64") },
          inclusionProof: {
            logIndex: "0",
            rootHash: rootHash.toString("base64"),
            treeSize: "1",
            hashes: [],
            checkpoint: {
              envelope: `${note}\n— ${REKOR_URL.replace("https://", "")} ${noteSignature.toString("base64")}\n`,
            },
          },
          canonicalizedBody: body.toString("base64"),
        },
      ],
    },
    envelope: { statement: payload.toString("base64"), signature: signature.toString("base64") },
  };
}

function provenance(subject, repository, wheelDigest) {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: WHEEL, digest: { sha256: wheelDigest } }],
    predicateType: "https://docs.pypi.org/attestations/publish/v1",
    predicate: null,
  };
  return {
    version: 1,
    attestation_bundles: [
      {
        publisher: { kind: "GitHub", repository, workflow: "release.yml", environment: null },
        attestations: [attestation(subject, statement)],
      },
    ],
  };
}

// --- Output ------------------------------------------------------------------------------------

const wheel = Buffer.from("Fixture wheel for provenance tests. It is never installed.\n");
const wheelDigest = sha256(wheel).toString("hex");
const iso = (ms) => new Date(ms).toISOString();
const trustedRoot = {
  mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
  tlogs: [
    {
      baseUrl: REKOR_URL,
      hashAlgorithm: "SHA2_256",
      publicKey: {
        rawBytes: rekorKey.spki.toString("base64"),
        keyDetails: "PKIX_ECDSA_P256_SHA_256",
        validFor: { start: iso(Date.UTC(2025, 0, 1)) },
      },
      logId: { keyId: rekorLogId.toString("base64") },
    },
  ],
  certificateAuthorities: [
    {
      subject: { organization: "Example Test Sigstore", commonName: "test-fulcio" },
      uri: "https://fulcio.test.example",
      certChain: { certificates: [{ rawBytes: caCert.toString("base64") }] },
      validFor: { start: iso(Date.UTC(2025, 0, 1)) },
    },
  ],
  ctlogs: [
    {
      baseUrl: "https://ctlog.test.example",
      hashAlgorithm: "SHA2_256",
      publicKey: {
        rawBytes: ctKey.spki.toString("base64"),
        keyDetails: "PKIX_ECDSA_P256_SHA_256",
        validFor: { start: iso(Date.UTC(2025, 0, 1)) },
      },
      logId: { keyId: ctLogId.toString("base64") },
    },
  ],
  timestampAuthorities: [],
};

const imageDigest = `sha256:${sha256(Buffer.from("fixture image manifest")).toString("hex")}`;
const cosignOutput = [
  {
    critical: {
      identity: { "docker-reference": "registry.test.example/example-org/worker" },
      image: { "docker-manifest-digest": imageDigest },
      type: "cosign container image signature",
    },
    optional: { Issuer: TEST_ISSUER, Subject: TEST_SUBJECT },
  },
];

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, WHEEL), wheel);
writeFileSync(join(OUT, "trusted-root.json"), json(trustedRoot));
writeFileSync(
  join(OUT, "provenance.json"),
  json(provenance(TEST_SUBJECT, "example-org/example-worker", wheelDigest)),
);
writeFileSync(
  join(OUT, "provenance-wrong-identity.json"),
  json(provenance(IMPOSTOR_SUBJECT, "example-org/impostor", wheelDigest)),
);
writeFileSync(join(OUT, "cosign-verify.json"), json(cosignOutput));
console.log(`wrote fixtures to ${OUT}\nwheel sha256 ${wheelDigest}\nimage digest ${imageDigest}`);
