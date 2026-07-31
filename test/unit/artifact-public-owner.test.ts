import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ArtifactDeliveryCapabilityCodec,
  ArtifactPublicOwnerService,
  HmacArtifactOwnerCursorCodec,
} from "../../src/modules/artifact/index.js";
import type { VerifiedRequestSecurityContext } from "../../src/shared/security-context/index.js";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";

const transaction = Object.freeze({}) as PlatformTransaction;
const key = Buffer.alloc(32, 7);
const now = new Date("2026-08-11T12:00:00.000Z");

describe("ArtifactPublicOwnerService", () => {
  it("returns a bounded page and rejects a cursor replayed under a different owner", async () => {
    const repository = repositoryStub({
      listArtifacts: vi.fn(async () => [summary("artifact_02"), summary("artifact_01")]),
    });
    const service = owner(repository);

    const first = await service.listArtifacts({ context: context(), limit: 1 });

    expect(first.items).toEqual([expect.objectContaining({ artifactRef: "artifact_02" })]);
    expect(first.pageInfo).toEqual({ hasMore: true, nextCursor: expect.any(String) });
    await expect(service.listArtifacts({
      context: context({ subjectRef: "subject_02" }),
      ...(first.pageInfo.nextCursor === null ? {} : { cursor: first.pageInfo.nextCursor }),
      limit: 1,
    })).rejects.toThrow("PAGE_CURSOR_INVALID");
  });

  it("projects ready immutable image metadata without exposing storage authority", async () => {
    const repository = repositoryStub({
      getVersion: vi.fn(async () => ({
        artifactRef: "artifact_01", artifactVersionRef: "artifact_version_01",
        availability: "ready", ownerVersion: 7n, versionNumber: 2n,
        sourceArtifactVersionRefs: ["artifact_version_source_01"], byteSize: 1_024n,
        mediaType: "image/webp", width: 1024, height: 768, createdAt: now,
      })),
    });

    await expect(owner(repository).getArtifactVersion({
      context: context(), artifactRef: "artifact_01", artifactVersionRef: "artifact_version_01",
    })).resolves.toEqual({ version: {
      artifactRef: "artifact_01", artifactVersionRef: "artifact_version_01",
      availability: "ready", mediaClass: "image", ownerVersion: "7", versionNumber: "2",
      sourceArtifactVersionRefs: ["artifact_version_source_01"],
      display: { byteSize: "1024", format: "webp", width: 1024, height: 768 },
      createdAt: now.toISOString(),
    } });
  });

  it("binds a version page cursor to the parent Artifact", async () => {
    const version = {
      artifactRef: "artifact_01", artifactVersionRef: "artifact_version_02",
      availability: "processing", ownerVersion: 2n, versionNumber: 2n,
      sourceArtifactVersionRefs: [], byteSize: null, mediaType: null,
      width: null, height: null, createdAt: now,
    };
    const service = owner(repositoryStub({
      listVersions: vi.fn(async () => [version, {
        ...version, artifactVersionRef: "artifact_version_01", ownerVersion: 1n, versionNumber: 1n,
      }]),
    }));
    const first = await service.listArtifactVersions({
      context: context(), artifactRef: "artifact_01", limit: 1,
    });

    await expect(service.listArtifactVersions({
      context: context(), artifactRef: "artifact_02", limit: 1,
      ...(first.pageInfo.nextCursor === null ? {} : { cursor: first.pageInfo.nextCursor }),
    })).rejects.toThrow("PAGE_CURSOR_INVALID");
  });

  it("issues an owner/workload-bound five-minute capability whose digest matches persistence", async () => {
    const createAuthorization = vi.fn(async () => undefined);
    const service = owner(repositoryStub({ createAuthorization }));

    const response = await service.issueDeliveryAuthorization({
      context: context(), artifactRef: "artifact_01", artifactVersionRef: "artifact_version_01",
      request: { purpose: "download", suggestedFileName: "result.webp" },
    });

    const [, bearer, digest] = response.authorization.deliveryCapability.split(".");
    expect(response.authorization).toMatchObject({
      authorizationRef: "artifact-delivery-authorization:auth_01",
      audience: "site-bff.artifact-delivery", purpose: "download",
      issuedAt: now.toISOString(), expiresAt: "2026-08-11T12:05:00.000Z",
    });
    expect(digest).toBe(createHmac("sha256", key)
      .update("kokoro.platform.artifact-delivery.v1\0").update(bearer!).digest("hex"));
    expect(createAuthorization).toHaveBeenCalledWith(transaction, expect.objectContaining({
      capabilityDigest: digest,
      ownerScope: { siteRef: "site_01", subjectRef: "subject_01",
        subjectGeneration: 4n, projectRef: "project_01" },
      workload: { siteRef: "site_01", siteReleaseRef: "release_01",
        workloadIdentityRef: "site_bff_01", workloadBindingEpoch: 7n, siteSecurityEpoch: 9n },
      suggestedFileName: "result.webp",
    }));
  });

  it("returns durable idempotent revocation state without a bearer capability", async () => {
    const revokeAuthorization = vi.fn(async () => ({
      state: "already_revoked" as const, revokedAt: "2026-08-11T11:59:00.000Z",
    }));

    await expect(owner(repositoryStub({ revokeAuthorization })).revokeDeliveryAuthorization({
      context: context(), authorizationRef: "authorization_01", reason: "user_requested",
    })).resolves.toEqual({ receipt: {
      authorizationRef: "authorization_01", state: "already_revoked",
      revokedAt: "2026-08-11T11:59:00.000Z",
    } });
    expect(revokeAuthorization).toHaveBeenCalledWith(transaction, expect.objectContaining({
      reason: "user_requested",
    }));
  });
});

function owner(repository: ReturnType<typeof repositoryStub>) {
  return new ArtifactPublicOwnerService({
    unitOfWork: { execute: async (_fence, work) => work(transaction) },
    repository: repository as never,
    deliveryCapabilities: new ArtifactDeliveryCapabilityCodec(key, () => Buffer.alloc(32, 8)),
    cursors: new HmacArtifactOwnerCursorCodec(Buffer.alloc(32, 6)),
    clock: () => now,
    reference: () => "auth_01",
  });
}

function repositoryStub(overrides: Record<string, unknown> = {}) {
  return Object.freeze({
    listArtifacts: async () => [], getArtifact: async () => null,
    listVersions: async () => [], getVersion: async () => null,
    createAuthorization: async () => undefined, revokeAuthorization: async () => null,
    ...overrides,
  });
}

function summary(artifactRef: string) {
  return Object.freeze({ artifactRef, currentArtifactVersionRef: `${artifactRef}_version`,
    availability: "ready", title: "Generated image", createdAt: now, updatedAt: now });
}

function context(change: Readonly<{ subjectRef?: string }> = {}): VerifiedRequestSecurityContext {
  return Object.freeze({
    trustedCaller: { kind: "site_product", workloadIdentityId: "site_bff_01", siteId: "site_01",
      siteReleaseRef: "release_01", siteSecurityEpoch: "9", bindingEpoch: "7" },
    actor: { kind: "user", subjectId: change.subjectRef ?? "subject_01", subjectGeneration: "4" },
    target: { siteId: "site_01", projectId: "project_01" },
  }) as unknown as VerifiedRequestSecurityContext;
}
