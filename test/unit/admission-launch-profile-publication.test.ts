import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AdmissionLaunchProfilePublicationService } from
  "../../src/modules/admission/application/admission-launch-profile-publication-service.js";
import { defineAdmissionLaunchProfilePublication } from
  "../../src/modules/admission/domain/admission-launch-profile-publication.js";
import { PostgresAdmissionLaunchProfilePublicationRepository } from
  "../../src/modules/admission/infrastructure/postgres/admission-launch-profile-publication-repository.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import { PlatformUnitOfWork } from "../../src/shared/unit-of-work/unit-of-work.js";
import { verifyRequestSecurityContext } from
  "../../src/shared/security-context/request-security-context.js";

const publishedAt = "2026-08-05T12:00:00.000Z";

describe("Admission launch-profile publication", () => {
  it("publishes one canonical Site-bound runtime policy through the Admin owner UoW", async () => {
    const publish = vi.fn(async (_transaction, candidate) => Object.freeze({
      kind: "published" as const, publication: candidate,
    }));
    const transaction = vi.fn(async (_fence, work) => {
      const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
      try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); }
    });
    const service = new AdmissionLaunchProfilePublicationService({
      unitOfWork: new PlatformUnitOfWork({ transaction }, () => publishedAt),
      repository: { publish }, clock: () => publishedAt,
    });

    const result = await service.publish({
      siteId: "site_01", siteReleaseRef: "release_01", snapshot: snapshot(),
    }, await context());

    expect(result.kind).toBe("published");
    expect(transaction).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    const candidate = publish.mock.calls[0]?.[1];
    expect(candidate).toMatchObject({
      siteId: "site_01", siteReleaseRef: "release_01", publishedAt,
      launchProfileRef: expect.stringMatching(/^launch-profile:sha256:[a-f0-9]{64}$/u),
      snapshotDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(candidate?.launchProfileRef).toBe(`launch-profile:sha256:${candidate?.snapshotDigest}`);
    expect(Object.isFrozen(candidate?.snapshot)).toBe(true);
    expect(Object.isFrozen(candidate?.snapshot.permissions)).toBe(true);
    expect(candidate?.snapshotDigest).toBe(createHash("sha256")
      .update(canonical(candidate?.snapshot)).digest("hex"));
  });

  it("rejects a mismatched Site binding before opening a transaction", async () => {
    const transaction = vi.fn();
    const service = new AdmissionLaunchProfilePublicationService({
      unitOfWork: new PlatformUnitOfWork({ transaction }, () => publishedAt),
      repository: { publish: vi.fn() }, clock: () => publishedAt,
    });
    await expect(service.publish({ siteId: "site_other", siteReleaseRef: "release_01",
      snapshot: snapshot() }, await context("site_other"))).rejects
      .toThrow("ADMISSION_LAUNCH_PROFILE_SITE_BINDING_INVALID");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("persists only the immutable canonical projection", async () => {
    const candidate = publication();
    const calls: { statement: string; values: readonly unknown[] }[] = [];
    const lease = issuePlatformTransaction({ query: async () => [],
      execute: async (statement, values = []) => { calls.push({ statement, values }); return 1; } });
    try {
      await expect(new PostgresAdmissionLaunchProfilePublicationRepository()
        .publish(lease.transaction, candidate)).resolves.toMatchObject({ kind: "published" });
    } finally { revokePlatformTransaction(lease); }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.statement).toContain("INSERT INTO platform.admission_launch_profile_snapshot");
    expect(calls[0]?.statement).toContain("ON CONFLICT DO NOTHING");
    expect(calls[0]?.statement).not.toMatch(/UPDATE|DELETE/u);
  });

  it("replays the exact immutable Site/release/digest and preserves first publication time", async () => {
    const candidate = publication();
    const lease = issuePlatformTransaction({ execute: async () => 0,
      query: async <Row extends Record<string, unknown>>() => [{
        launchProfileRef: candidate.launchProfileRef, siteId: candidate.siteId,
        siteReleaseRef: candidate.siteReleaseRef, snapshotDigest: candidate.snapshotDigest,
        snapshot: candidate.snapshot, publishedAt: "2026-08-05T11:00:00.000Z",
      }] as unknown as readonly Row[] });
    try {
      await expect(new PostgresAdmissionLaunchProfilePublicationRepository()
        .publish(lease.transaction, candidate)).resolves.toMatchObject({
          kind: "replayed", publication: { publishedAt: "2026-08-05T11:00:00.000Z" },
        });
    } finally { revokePlatformTransaction(lease); }
  });

  it("fails closed when an existing release projection has drifted", async () => {
    const candidate = publication();
    const lease = issuePlatformTransaction({ execute: async () => 0,
      query: async <Row extends Record<string, unknown>>() => [{
        launchProfileRef: candidate.launchProfileRef, siteId: candidate.siteId,
        siteReleaseRef: candidate.siteReleaseRef, snapshotDigest: "f".repeat(64),
        snapshot: { ...candidate.snapshot, backend: "docker" }, publishedAt,
      }] as unknown as readonly Row[] });
    try {
      await expect(new PostgresAdmissionLaunchProfilePublicationRepository()
        .publish(lease.transaction, candidate)).rejects
        .toThrow("ADMISSION_LAUNCH_PROFILE_PUBLICATION_CONFLICT");
    } finally { revokePlatformTransaction(lease); }
  });
});

function publication() {
  return defineAdmissionLaunchProfilePublication({
    siteId: "site_01", siteReleaseRef: "release_01", snapshot: snapshot(), publishedAt,
  });
}

function snapshot() {
  return {
    schemaVersion: 1 as const,
    siteId: "site_01",
    siteReleaseRef: "release_01",
    backend: "state" as const,
    permissions: {
      approval_tools: [], review_tools: [], subagent_create: "deny" as const,
      filesystem: "read_only" as const,
    },
    billing: {
      unit: "credit_micros", liabilityMerchantAccountRef: "merchant:platform-runtime",
      ratingPolicyRevisionRef: "site_01:rating-policy:chat-v1", rootCeiling: "1000",
      segmentMaximum: "500", surfaceRef: "chat", capabilityKey: "model.chat",
    },
  };
}

async function context(siteId = "site_01") {
  const operation = "admission.launch-profile.publish";
  const issuer = "spiffe://kokoro.test";
  const input = {
    requestId: "request-01", correlationId: "correlation-01",
    trustedCaller: { kind: "admin_workload", workloadIdentityId: "fixture-owner",
      environment: "production", region: "us-east-1", audience: "platform-admin",
      allowedOperations: [operation], bindingEpoch: "1", issuedAt: publishedAt,
      expiresAt: "2026-08-05T12:10:00.000Z" },
    actor: { kind: "operator", subjectId: "operator-01", subjectGeneration: "1" },
    delegatedGrant: null,
    target: { siteId, workspaceId: null, projectId: null,
      purpose: operation, scopes: [operation] },
    audience: "platform-admin", environment: "production", region: "us-east-1",
    evidence: [{ kind: "workload_attestation", evidenceId: "attestation-01", issuer }],
    policyEpoch: "1", issuedAt: publishedAt, expiresAt: "2026-08-05T12:10:00.000Z",
  } as const;
  return verifyRequestSecurityContext(input, { now: publishedAt, operation,
    expectedAudience: "platform-admin", expectedEnvironment: "production", expectedRegion: "us-east-1",
    callerVerifier: { verify: async () => ({ workloadIdentityId: "fixture-owner", kind: "admin_workload",
      audience: "platform-admin", environment: "production", region: "us-east-1",
      allowedOperations: [operation], siteId: null, bindingEpoch: "1", issuedAt: publishedAt,
      expiresAt: "2026-08-05T12:10:00.000Z", issuer, keyVersion: "test-1" }) } });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
