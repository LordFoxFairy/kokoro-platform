import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from
  "../../src/modules/product-catalog/domain/canonical-product-document.js";
import { Ed25519SiteReleaseEvidenceTrust } from
  "../../src/modules/site/infrastructure/crypto/ed25519-site-release-evidence-trust.js";

const digest = `sha256:${"a".repeat(64)}`;
const binding = (ref: string) => Object.freeze({ ref, revision: 1n, digest });

describe("Ed25519SiteReleaseEvidenceTrust", () => {
  it("admits only a registered active producer with a valid detached DSSE signature and passed checks", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const statement = { _type: "https://in-toto.io/Statement/v1", subject: [] };
    const payload = Buffer.from(canonicalJson(statement));
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const publicKeyFingerprint = `sha256:${createHash("sha256")
      .update(publicKey.export({ format: "der", type: "spki" })).digest("hex")}`;
    const detachedSignature = sign(null, pae(payload), privateKey);
    const evidence = [binding("inspection.alpha"), binding("journey.alpha"), binding("security.alpha")];
    const authority = {
      resolve: async () => ({
        producerIdentityRef: "producer.web-attestor",
        producerRole: "web-artifact-provenance-attestor",
        producerRegistration: binding("producer-registration.alpha"),
        trustPolicy: binding("trust-policy.alpha"),
        signingKeyId: "signing-key.alpha",
        signingKeyVersion: 2n,
        signatureAudience: "kokoro.web-artifact-provenance.v1",
        environment: "production",
        keyStatus: "active",
        keyValidFrom: "2026-08-01T00:00:00.000Z",
        keyValidUntil: "2026-08-02T00:00:00.000Z",
        publicKeyPem,
        publicKeyFingerprint,
        detachedSignature,
        evidenceDecisions: evidence.map((item) => ({ binding: item, decision: "passed" })),
      }),
    };
    const verifier = new Ed25519SiteReleaseEvidenceTrust(authority as never,
      () => "2026-08-01T12:00:00.000Z");
    const input = {
      candidate: { environment: "production" },
      producerIdentityRef: "producer.web-attestor",
      provenanceBinding: binding("provenance.alpha"),
      provenanceStatement: statement,
      webArtifactDigest: digest,
      artifactInspectionEvidence: evidence[0],
      journeyEvidence: evidence[1],
      securityEvidence: evidence[2],
    };

    await expect(verifier.verify({} as never, input as never)).resolves.toMatchObject({
      signingKeyId: "signing-key.alpha",
      signingKeyVersion: 2n,
    });
    await expect(verifier.verify({} as never, {
      ...input,
      provenanceStatement: { ...statement, subject: [{ name: "tampered" }] },
    } as never)).rejects.toThrow("SITE_EVIDENCE_PROVENANCE_SIGNATURE_INVALID");
  });
});

function pae(payload: Uint8Array): Buffer {
  const type = Buffer.from("application/vnd.in-toto+json", "utf8");
  return Buffer.concat([Buffer.from(`DSSEv1 ${type.byteLength} `, "ascii"), type,
    Buffer.from(` ${payload.byteLength} `, "ascii"), payload]);
}
