import { describe, expect, it } from "vitest";
import {
  SITE_EVIDENCE_ADMISSION_AUDIENCE,
  SITE_EVIDENCE_ADMISSION_RPC_OPERATION,
  SiteEvidencePeerRegistry,
} from "../../src/modules/site/infrastructure/security/site-evidence-peer-registry.js";

const digest = `sha256:${"a".repeat(64)}`;
const fingerprint256 = Array.from({ length: 32 }, () => "AA").join(":");

describe("SiteEvidencePeerRegistry", () => {
  it("binds an authorized certificate and SPIFFE SAN to immutable EvidenceAdmission axes", () => {
    const registry = SiteEvidencePeerRegistry.parse(document());

    expect(registry.authenticateCertificate({
      authorized: true,
      authorizationError: null,
      fingerprint256,
      sanUris: ["spiffe://kokoro/site-evidence-attestor"],
      validFrom: "2026-08-01T00:00:00.000Z",
      validTo: "2026-08-03T00:00:00.000Z",
    }, new Date("2026-08-02T00:00:00.000Z"))).toMatchObject({
      workloadIdentityRef: "spiffe://kokoro/site-evidence-attestor",
      siteProjectBindingRef: "site-project-binding.alpha",
      siteRef: "site:alpha",
      environment: "production",
      region: "us-east-1",
      audience: SITE_EVIDENCE_ADMISSION_AUDIENCE,
      operation: SITE_EVIDENCE_ADMISSION_RPC_OPERATION,
      producerIdentityRef: "producer.web-attestor",
      producerRole: "web-artifact-provenance-attestor",
      producerRegistration: { ref: "producer-registration.alpha", revision: 2n, digest },
      workloadAttestation: { ref: "workload-attestation.alpha", revision: 4n, digest },
    });
  });

  it("fails closed for certificate drift and non-canonical registry fields", () => {
    const registry = SiteEvidencePeerRegistry.parse(document());
    expect(registry.authenticateCertificate({
      authorized: true,
      authorizationError: null,
      fingerprint256: fingerprint256.replace(/^AA/u, "BB"),
      sanUris: ["spiffe://kokoro/site-evidence-attestor"],
      validFrom: "2026-08-01T00:00:00.000Z",
      validTo: "2026-08-03T00:00:00.000Z",
    }, new Date("2026-08-02T00:00:00.000Z"))).toBeNull();

    const invalid = document() as { peers: Array<Record<string, unknown>> };
    invalid.peers[0]!.legacyRole = "attestor";
    expect(() => SiteEvidencePeerRegistry.parse(invalid))
      .toThrow("PLATFORM_SITE_EVIDENCE_MTLS_PEERS_INVALID");
  });

  it("rejects a SPIFFE SAN that is ambiguous in Node's comma-delimited certificate field", () => {
    const invalid = document() as { peers: Array<Record<string, unknown>> };
    invalid.peers[0]!.sanUri = "spiffe://kokoro/site-evidence,attestor";

    expect(() => SiteEvidencePeerRegistry.parse(invalid))
      .toThrow("PLATFORM_SITE_EVIDENCE_MTLS_PEERS_INVALID");
  });
});

function document() {
  return {
    version: 1,
    peers: [{
      fingerprint256,
      sanUri: "spiffe://kokoro/site-evidence-attestor",
      siteProjectBindingRef: "site-project-binding.alpha",
      siteRef: "site:alpha",
      environment: "production",
      region: "us-east-1",
      audience: SITE_EVIDENCE_ADMISSION_AUDIENCE,
      operation: SITE_EVIDENCE_ADMISSION_RPC_OPERATION,
      producerIdentityRef: "producer.web-attestor",
      producerRegistration: { ref: "producer-registration.alpha", revision: "2", digest },
      producerRole: "web-artifact-provenance-attestor",
      workloadAttestation: { ref: "workload-attestation.alpha", revision: "4", digest },
    }],
  };
}
