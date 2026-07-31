import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ArtifactDeliveryService,
  ArtifactDeliveryCapabilityCodec,
  InMemoryArtifactDeliveryAuditRepository,
  InMemoryArtifactDeliveryAuthorizationRepository,
  InMemoryArtifactObjectStore,
  type ArtifactObjectStore,
} from "../../src/modules/artifact/index.js";

const ownerScope = Object.freeze({
  siteRef: "site:one", subjectRef: "subject:one", subjectGeneration: 3n, projectRef: "project:one",
});
const workload = Object.freeze({
  siteRef: "site:one",
  siteReleaseRef: "site-release:one",
  workloadIdentityRef: "workload:site-bff:one",
  workloadBindingEpoch: 4n,
  siteSecurityEpoch: 7n,
});

describe("Artifact workload-bound redemption", () => {
  it("does not accept a capability from a different Site release or workload binding", async () => {
    const fixture = await prepared();
    const issued = await fixture.service.issue({
      ownerScope, workload, artifactRef: "artifact:one", artifactVersionRef: "artifact-version:one",
      purpose: "preview", audience: "site-bff.artifact-delivery", ttlMs: 60_000,
    });

    await expect(fixture.service.redeemForWorkload({
      authorizationRef: issued.authorizationRef,
      deliveryCapability: issued.deliveryCapability,
      workload: { ...workload, siteReleaseRef: "site-release:two" },
      audience: "site-bff.artifact-delivery",
      requestRef: "request:wrong-release",
      signal: new AbortController().signal,
    })).rejects.toThrow("ARTIFACT_DELIVERY_WORKLOAD_MISMATCH");
  });

  it("records every replay as a distinct pending-to-completed audit receipt", async () => {
    const fixture = await prepared();
    const issued = await fixture.service.issue({
      ownerScope, workload, artifactRef: "artifact:one", artifactVersionRef: "artifact-version:one",
      purpose: "download", suggestedFileName: "报告 2026.png",
      audience: "site-bff.artifact-delivery", ttlMs: 60_000,
    });

    for (const requestRef of ["request:one", "request:two"]) {
      const response = await fixture.service.redeemForWorkload({
        authorizationRef: issued.authorizationRef,
        deliveryCapability: issued.deliveryCapability,
        workload,
        audience: "site-bff.artifact-delivery",
        requestRef,
        rangeHeader: "bytes=0-3",
        signal: new AbortController().signal,
      });
      for await (const _chunk of response.body) { /* drain audited stream */ }
      expect(response.headers).toMatchObject({
        contentLength: "4",
        contentRange: "bytes 0-3/10",
        contentDisposition: "attachment; filename=\"__ 2026.png\"; " +
          "filename*=UTF-8''%E6%8A%A5%E5%91%8A%202026.png",
        eTag: expect.stringMatching(/^"[a-f0-9]{64}"$/u),
      });
    }

    expect(fixture.audit.records()).toEqual([
      expect.objectContaining({ requestRef: "request:one", state: "stream_completed", bytesEmitted: 4n }),
      expect.objectContaining({ requestRef: "request:two", state: "stream_completed", bytesEmitted: 4n }),
    ]);
  });

  it.each([
    ["short read", 9],
    ["overrun", 11],
  ])("does not complete the server-stream audit on a storage %s", async (_case, emittedBytes) => {
    const fixture = await prepared((store) => Object.freeze({
      stage: store.stage.bind(store),
      promote: store.promote.bind(store),
      cleanupStaged: store.cleanupStaged.bind(store),
      describeReady: store.describeReady.bind(store),
      openReady: async (input: Parameters<ArtifactObjectStore["openReady"]>[0]) => {
        const opened = await store.openReady(input);
        return Object.freeze({ ...opened, body: chunks(new Uint8Array(emittedBytes)) });
      },
    }));
    const issued = await fixture.service.issue({
      ownerScope, workload, artifactRef: "artifact:one", artifactVersionRef: "artifact-version:one",
      purpose: "preview", audience: "site-bff.artifact-delivery", ttlMs: 60_000,
    });
    const response = await fixture.service.redeemForWorkload({
      authorizationRef: issued.authorizationRef,
      deliveryCapability: issued.deliveryCapability,
      workload,
      audience: "site-bff.artifact-delivery",
      requestRef: `request:${emittedBytes}`,
      signal: new AbortController().signal,
    });

    await expect(drain(response.body)).rejects.toThrow(/ARTIFACT_DELIVERY_BODY_(TRUNCATED|OVERRUN)/u);
    expect(fixture.audit.records()).toEqual([
      expect.objectContaining({ state: "failed", failureCode: "storage_failed" }),
    ]);
  });
});

async function prepared(
  wrapStore: (store: InMemoryArtifactObjectStore) => ArtifactObjectStore = (store) => store,
) {
  const store = new InMemoryArtifactObjectStore();
  const staged = await store.stage({ ownerScope, artifactRef: "artifact:one",
    artifactVersionRef: "artifact-version:one", bytes: new TextEncoder().encode("0123456789"),
    mediaType: "image/png" });
  await store.promote({ stagedReceipt: staged, trustDecision: {
    kind: "allow", decisionRef: "trust:one", contentSha256: staged.contentSha256,
  } });
  const audit = new InMemoryArtifactDeliveryAuditRepository();
  let ordinal = 0;
  const service = new ArtifactDeliveryService({
    repository: new InMemoryArtifactDeliveryAuthorizationRepository(),
    audit,
    objectStore: wrapStore(store),
    capabilities: new ArtifactDeliveryCapabilityCodec(randomBytes(32)),
    reference: (kind) => `${kind}:${++ordinal}`,
  });
  return { service, audit };
}

async function* chunks(...values: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield value;
}

async function drain(body: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const _chunk of body) { /* drain audited stream */ }
}
