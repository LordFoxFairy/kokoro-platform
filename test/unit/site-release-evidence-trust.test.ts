import { create } from "@bufbuild/protobuf";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  releaseEvidenceDecisionCanonicalPayload,
  releaseEvidenceDecisionPayloadDigest,
  releaseEvidenceDecisionSignaturePreimage,
} from
  "../../src/generated/contracts/platform-site-evidence-admission@v1/digest.js";
import { ImmutableContractRevisionBindingSchema } from
  "../../src/generated/proto/kokoro/platform/publication/v1/publication_common_pb.js";
import {
  DetachedReleaseEvidenceDecisionAttestationSchema,
  DetachedReleaseEvidenceAttestationSchema,
  ReleaseEvidenceCheckerRole,
  ReleaseEvidenceDecisionMaterialSchema,
  ReleaseEvidenceDecisionState,
  ReleaseEvidenceKind,
  ReleaseEvidenceSignatureAlgorithm,
  SignedReleaseEvidenceDecisionSchema,
  type SignedReleaseEvidenceDecision,
} from "../../src/generated/proto/kokoro/platform/site/v1/site_publication_pb.js";
import { Ed25519SiteReleaseEvidenceTrust } from
  "../../src/modules/site/infrastructure/crypto/ed25519-site-release-evidence-trust.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const binding = (ref: string, value = digest("a")) =>
  Object.freeze({ ref, revision: 1n, digest: value });
const candidate = Object.freeze({
  binding: Object.freeze({
    ref: "candidate.alpha", version: 3n, authorizationEpoch: 7n, digest: digest("b"),
  }),
  siteRef: "site.alpha",
  environment: "production" as const,
  launchProductProfile: binding("profile.alpha"),
  productSurfaceCatalog: binding("catalog.alpha"),
  businessBindingsDigest: digest("c"),
  state: "authorized" as const,
  document: Object.freeze({}),
  canonicalBytes: new Uint8Array([123, 125]),
});
const evidence = Object.freeze({
  artifactInspection: binding("inspection.alpha", digest("d")),
  journey: binding("journey.alpha", digest("e")),
  security: binding("security.alpha", digest("f")),
});
const observedAt = "2026-08-08T12:00:00.000Z";

describe("Ed25519SiteReleaseEvidenceTrust", () => {
  it("verifies one exact in-toto payload and three generated decision preimages with DB keys", async () => {
    const fixture = signedFixture();
    const trust = verifier(fixture);

    await expect(trust.verify({} as never, fixture.input)).resolves.toMatchObject({
      producer: {
        producerIdentityRef: "producer.web.alpha",
        signingKeyFingerprint: fixture.keys.producer.fingerprint,
      },
      decisions: [
        { kind: "artifact-inspection", checkerIdentityRef: "checker.inspection.alpha" },
        { kind: "journey", checkerIdentityRef: "checker.journey.alpha" },
        { kind: "security", checkerIdentityRef: "checker.security.alpha" },
      ],
      verifiedAt: observedAt,
    });
  });

  it("rejects a one-byte provenance mutation without re-stringifying the verified canonical bytes", async () => {
    const fixture = signedFixture();
    const mutated = new Uint8Array(fixture.input.provenanceCanonicalBytes);
    mutated[mutated.length - 2] = mutated[mutated.length - 2]! ^ 1;

    await expect(verifier(fixture).verify({} as never, {
      ...fixture.input,
      provenanceCanonicalBytes: mutated,
    })).rejects.toThrow(/SITE_EVIDENCE_PROVENANCE_(?:DIGEST|SIGNATURE)_INVALID/u);
  });

  it("rejects decision domain, canonical bytes, digest, signature, role, duplicate identity and FAILED mutations", async () => {
    const mutations: readonly ((fixture: ReturnType<typeof signedFixture>) => void)[] = [
      ({ input }) => { input.evidenceDecisions[0]!.attestation!.payloadType = "application/json"; },
      ({ input }) => {
        input.evidenceDecisions[0]!.attestation!.canonicalPayload[0] =
          input.evidenceDecisions[0]!.attestation!.canonicalPayload[0]! ^ 1;
      },
      ({ input }) => { input.evidenceDecisions[0]!.attestation!.payloadDigest = digest("0"); },
      ({ input }) => {
        input.evidenceDecisions[0]!.attestation!.signature[0] =
          input.evidenceDecisions[0]!.attestation!.signature[0]! ^ 1;
      },
      ({ input }) => {
        input.evidenceDecisions[0]!.material!.checkerTrust!.role = ReleaseEvidenceCheckerRole.JOURNEY;
      },
      ({ input }) => {
        input.evidenceDecisions[1]!.material!.checkerTrust!.checkerIdentityRef =
          input.evidenceDecisions[0]!.material!.checkerTrust!.checkerIdentityRef;
      },
      ({ input }) => {
        input.evidenceDecisions[0]!.material!.state = ReleaseEvidenceDecisionState.FAILED;
      },
    ];
    for (const mutate of mutations) {
      const fixture = signedFixture();
      mutate(fixture);
      await expect(verifier(fixture).verify({} as never, fixture.input)).rejects.toThrow(
        /(?:SITE_EVIDENCE|release_evidence_)/u,
      );
    }
  });
});

function verifier(fixture: ReturnType<typeof signedFixture>) {
  return new Ed25519SiteReleaseEvidenceTrust({
    resolveProducer: async () => fixture.producerTrust,
    resolveCheckers: async () => fixture.checkerTrust,
  }, () => observedAt);
}

function signedFixture() {
  const producer = key();
  const inspection = key();
  const journey = key();
  const security = key();
  const provenanceCanonicalBytes = new TextEncoder().encode(
    '{"_type":"https://in-toto.io/Statement/v1","subject":[]}',
  );
  const provenanceDigest = `sha256:${createHash("sha256")
    .update(provenanceCanonicalBytes).digest("hex")}`;
  const producerRegistration = binding("producer-registration.alpha", digest("1"));
  const producerTrust = Object.freeze({
    producerIdentityRef: "producer.web.alpha",
    producerRole: "web-artifact-provenance-attestor" as const,
    producerRegistration,
    producerRegistryEpoch: 9n,
    trustPolicy: binding("trust.producer.alpha", digest("2")),
    trustPolicyEpoch: 11n,
    signingKeyId: "key.producer.alpha",
    signingKeyVersion: 2n,
    signingKeyFingerprint: producer.fingerprint,
    signatureDomain: "application/vnd.in-toto+json" as const,
    environment: "production" as const,
    keyStatus: "active" as const,
    keyValidFrom: "2026-08-08T00:00:00.000Z",
    keyValidUntil: "2026-08-09T00:00:00.000Z",
    publicKeySpkiPem: producer.publicKeyPem,
    configurationDigest: "a".repeat(64),
  });
  const checkerTrust = Object.freeze([
    checker("artifact-inspection", "checker.inspection.alpha", "key.checker.inspection", inspection, "3"),
    checker("journey", "checker.journey.alpha", "key.checker.journey", journey, "4"),
    checker("security", "checker.security.alpha", "key.checker.security", security, "5"),
  ] as const);
  const evidenceDecisions = [
    decision(ReleaseEvidenceKind.ARTIFACT_INSPECTION, ReleaseEvidenceCheckerRole.ARTIFACT_INSPECTION,
      evidence.artifactInspection, checkerTrust[0], inspection.privateKey),
    decision(ReleaseEvidenceKind.JOURNEY, ReleaseEvidenceCheckerRole.JOURNEY,
      evidence.journey, checkerTrust[1], journey.privateKey),
    decision(ReleaseEvidenceKind.SECURITY, ReleaseEvidenceCheckerRole.SECURITY,
      evidence.security, checkerTrust[2], security.privateKey),
  ];
  const provenanceSignature = sign(null, pae("application/vnd.in-toto+json", provenanceCanonicalBytes),
    producer.privateKey);
  return {
    keys: { producer, inspection, journey, security },
    producerTrust,
    checkerTrust,
    input: {
      candidate,
      siteRef: candidate.siteRef,
      producerIdentityRef: producerTrust.producerIdentityRef,
      producerRegistration,
      provenanceBinding: binding("provenance.alpha", provenanceDigest),
      provenanceCanonicalBytes,
      provenanceAttestation: create(DetachedReleaseEvidenceAttestationSchema, {
        payloadType: "application/vnd.in-toto+json",
        keyId: producerTrust.signingKeyId,
        keyVersion: producerTrust.signingKeyVersion,
        signatureAlgorithm: ReleaseEvidenceSignatureAlgorithm.ED25519,
        signature: new Uint8Array(provenanceSignature),
      }),
      webArtifactDigest: digest("6"),
      artifactInspectionEvidence: evidence.artifactInspection,
      journeyEvidence: evidence.journey,
      securityEvidence: evidence.security,
      evidenceDecisions,
    },
  };
}

function checker(
  role: "artifact-inspection" | "journey" | "security",
  identity: string,
  keyId: string,
  material: ReturnType<typeof key>,
  digestCharacter: string,
) {
  return Object.freeze({
    environment: "production" as const,
    role,
    checkerIdentityRef: identity,
    checkerRegistration: binding(`registration.${role}`, digest(digestCharacter)),
    trustPolicy: binding(`trust.${role}`, digest(digestCharacter)),
    trustPolicyEpoch: 13n,
    signingKeyId: keyId,
    signingKeyVersion: 1n,
    signingKeyFingerprint: material.fingerprint,
    signatureDomain: "application/vnd.kokoro.release-evidence-decision.v1+json" as const,
    keyStatus: "active" as const,
    keyValidFrom: "2026-08-08T00:00:00.000Z",
    keyValidUntil: "2026-08-09T00:00:00.000Z",
    publicKeySpkiPem: material.publicKeyPem,
    configurationDigest: "b".repeat(64),
  });
}

function decision(
  kind: ReleaseEvidenceKind,
  role: ReleaseEvidenceCheckerRole,
  evidenceBinding: ReturnType<typeof binding>,
  trust: ReturnType<typeof checker>,
  privateKey: KeyObject,
): SignedReleaseEvidenceDecision {
  const material = create(ReleaseEvidenceDecisionMaterialSchema, {
    kind,
    state: ReleaseEvidenceDecisionState.PASSED,
    candidate: {
      candidateRef: candidate.binding.ref,
      candidateVersion: candidate.binding.version,
      candidateAuthorizationEpoch: candidate.binding.authorizationEpoch,
      candidateDigest: candidate.binding.digest,
    },
    siteId: candidate.siteRef,
    environment: candidate.environment,
    webArtifactDigest: digest("6"),
    evidence: create(ImmutableContractRevisionBindingSchema, evidenceBinding),
    checkerTrust: {
      checkerIdentityRef: trust.checkerIdentityRef,
      checkerRegistration: create(ImmutableContractRevisionBindingSchema, trust.checkerRegistration),
      role,
      signingKeyId: trust.signingKeyId,
      signingKeyVersion: trust.signingKeyVersion,
      signingKeyFingerprint: trust.signingKeyFingerprint,
      trustPolicyEpoch: trust.trustPolicyEpoch,
    },
  });
  const value = create(SignedReleaseEvidenceDecisionSchema, {
    material,
    attestation: create(DetachedReleaseEvidenceDecisionAttestationSchema, {
      payloadType: "application/vnd.kokoro.release-evidence-decision.v1+json",
      canonicalPayload: releaseEvidenceDecisionCanonicalPayload(material),
      payloadDigest: releaseEvidenceDecisionPayloadDigest(material),
      keyId: trust.signingKeyId,
      keyVersion: trust.signingKeyVersion,
      signatureAlgorithm: ReleaseEvidenceSignatureAlgorithm.ED25519,
      signature: new Uint8Array(64),
    }),
  });
  value.attestation!.signature = new Uint8Array(sign(null,
    releaseEvidenceDecisionSignaturePreimage(value), privateKey));
  return value;
}

function key() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return Object.freeze({
    privateKey,
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    fingerprint: `sha256:${createHash("sha256").update(der).digest("hex")}`,
  });
}

function pae(type: string, payload: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "utf8");
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${typeBytes.byteLength} `, "ascii"), typeBytes,
    Buffer.from(` ${payload.byteLength} `, "ascii"), payload,
  ]);
}
