import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ArtifactDeliveryService,
  ArtifactDeliveryCapabilityCodec,
  InMemoryArtifactDeliveryAuditRepository,
  InMemoryArtifactDeliveryAuthorizationRepository,
  InMemoryArtifactObjectStore,
} from "../../src/modules/artifact/index.js";

const scope = Object.freeze({
  siteRef: "site:one",
  subjectRef: "subject:one",
  subjectGeneration: 4n,
  projectRef: "project:one",
});
const workload = Object.freeze({
  siteRef: "site:one", siteReleaseRef: "release:one", workloadIdentityRef: "workload:one",
  workloadBindingEpoch: 1n, siteSecurityEpoch: 1n,
});

describe("Artifact staged/finalized delivery", () => {
  it("promotes exact staged bytes only after a matching trust decision", async () => {
    const store = new InMemoryArtifactObjectStore();
    const staged = await store.stage({
      ownerScope: scope,
      artifactRef: "artifact:one",
      artifactVersionRef: "artifact-version:one",
      bytes: new TextEncoder().encode("image-bytes"),
      mediaType: "image/png",
    });

    await expect(store.promote({
      stagedReceipt: staged,
      trustDecision: { kind: "allow", decisionRef: "trust:one", contentSha256: "0".repeat(64) },
    })).rejects.toThrow("ARTIFACT_TRUST_BINDING_MISMATCH");

    const ready = await store.promote({
      stagedReceipt: staged,
      trustDecision: { kind: "allow", decisionRef: "trust:one", contentSha256: staged.contentSha256 },
    });
    expect(ready.state).toBe("ready_private");
  });

  it("issues a short-lived scope-bound capability and streams one bounded range", async () => {
    const clock = vi.fn(() => new Date("2026-07-31T12:00:00.000Z"));
    const store = new InMemoryArtifactObjectStore();
    const staged = await store.stage({ ownerScope: scope, artifactRef: "artifact:one",
      artifactVersionRef: "artifact-version:one",
      bytes: new TextEncoder().encode("0123456789"), mediaType: "image/png" });
    await store.promote({ stagedReceipt: staged,
      trustDecision: { kind: "allow", decisionRef: "trust:one", contentSha256: staged.contentSha256 } });
    const repository = new InMemoryArtifactDeliveryAuthorizationRepository();
    const service = new ArtifactDeliveryService({
      repository,
      audit: new InMemoryArtifactDeliveryAuditRepository(),
      objectStore: store,
      capabilities: new ArtifactDeliveryCapabilityCodec(randomBytes(32)),
      clock,
      reference: (kind) => `${kind}:one`,
    });
    const issued = await service.issue({
      ownerScope: scope,
      workload,
      artifactRef: "artifact:one",
      artifactVersionRef: "artifact-version:one",
      purpose: "preview",
      audience: "site-bff.artifact-delivery",
      ttlMs: 60_000,
    });
    expect(issued.deliveryCapability).not.toContain("artifact-version:one");

    const response = await service.redeemForWorkload({
      authorizationRef: issued.authorizationRef,
      deliveryCapability: issued.deliveryCapability,
      workload,
      audience: "site-bff.artifact-delivery",
      requestRef: "request:one",
      rangeHeader: "bytes=2-5",
      signal: new AbortController().signal,
    });
    expect(response.status).toBe(206);
    expect(response.headers.contentRange).toBe("bytes 2-5/10");
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) chunks.push(chunk);
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("2345");
  });

  it("fails closed for wrong scope, expired/revoked capability, and multi-range requests", async () => {
    const now = new Date("2026-07-31T12:00:00.000Z");
    const store = new InMemoryArtifactObjectStore();
    const staged = await store.stage({ ownerScope: scope, artifactRef: "artifact:one",
      artifactVersionRef: "artifact-version:one",
      bytes: new Uint8Array(16), mediaType: "image/png" });
    await store.promote({ stagedReceipt: staged,
      trustDecision: { kind: "allow", decisionRef: "trust:one", contentSha256: staged.contentSha256 } });
    const repository = new InMemoryArtifactDeliveryAuthorizationRepository();
    const service = new ArtifactDeliveryService({ repository,
      audit: new InMemoryArtifactDeliveryAuditRepository(), objectStore: store,
      capabilities: new ArtifactDeliveryCapabilityCodec(randomBytes(32)),
      clock: () => now, reference: (kind) => `${kind}:one` });
    const issued = await service.issue({ ownerScope: scope, workload, artifactRef: "artifact:one",
      artifactVersionRef: "artifact-version:one", purpose: "download",
      audience: "site-bff.artifact-delivery", ttlMs: 1_000 });

    await expect(service.redeemForWorkload({ deliveryCapability: issued.deliveryCapability,
      authorizationRef: issued.authorizationRef,
      workload: { ...workload, siteSecurityEpoch: 5n }, audience: "site-bff.artifact-delivery",
      requestRef: "request:scope",
      signal: new AbortController().signal })).rejects.toThrow("ARTIFACT_DELIVERY_WORKLOAD_MISMATCH");
    await expect(service.redeemForWorkload({ deliveryCapability: issued.deliveryCapability, workload,
      authorizationRef: issued.authorizationRef,
      audience: "site-bff.artifact-delivery", rangeHeader: "bytes=0-1,4-5",
      requestRef: "request:range",
      signal: new AbortController().signal })).rejects.toThrow("ARTIFACT_RANGE_MULTIPLE_UNSUPPORTED");
    expect((await service.revoke({ authorizationRef: issued.authorizationRef,
      ownerScope: scope })).state).toBe("revoked");
    await expect(service.redeemForWorkload({ deliveryCapability: issued.deliveryCapability, workload,
      authorizationRef: issued.authorizationRef,
      audience: "site-bff.artifact-delivery", requestRef: "request:revoked",
      signal: new AbortController().signal }))
      .rejects.toThrow("ARTIFACT_DELIVERY_REVOKED");
  });

  it("binds issuance and redemption to exact owner, Artifact, version and path authorization ref", async () => {
    const store = new InMemoryArtifactObjectStore();
    const staged = await store.stage({ ownerScope: scope, artifactRef: "artifact:one",
      artifactVersionRef: "artifact-version:one", bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" });
    await store.promote({ stagedReceipt: staged,
      trustDecision: { kind: "allow", decisionRef: "trust:one", contentSha256: staged.contentSha256 } });
    const service = new ArtifactDeliveryService({
      repository: new InMemoryArtifactDeliveryAuthorizationRepository(), objectStore: store,
      audit: new InMemoryArtifactDeliveryAuditRepository(),
      capabilities: new ArtifactDeliveryCapabilityCodec(randomBytes(32)),
      reference: () => "authorization:one",
    });

    await expect(service.issue({ ownerScope: scope, workload, artifactRef: "artifact:other",
      artifactVersionRef: "artifact-version:one", purpose: "preview",
      audience: "site-bff.artifact-delivery", ttlMs: 1_000 }))
      .rejects.toThrow("ARTIFACT_VERSION_NOT_READY");
    const issued = await service.issue({ ownerScope: scope, workload, artifactRef: "artifact:one",
      artifactVersionRef: "artifact-version:one", purpose: "preview",
      audience: "site-bff.artifact-delivery", ttlMs: 1_000 });
    await expect(service.redeemForWorkload({ authorizationRef: "authorization:wrong",
      deliveryCapability: issued.deliveryCapability, workload,
      audience: "site-bff.artifact-delivery", requestRef: "request:wrong-auth",
      signal: new AbortController().signal }))
      .rejects.toThrow("ARTIFACT_DELIVERY_AUTHORIZATION_MISMATCH");
  });
});
