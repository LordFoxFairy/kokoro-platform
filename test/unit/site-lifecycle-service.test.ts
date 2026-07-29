import { describe, expect, it } from "vitest";
import { SiteLifecycleService } from "../../src/modules/site/application/services/site-lifecycle-service.js";
import type {
  SiteAuthorityJournal,
  SiteAuthorityRepository,
} from "../../src/modules/site/application/contracts/site-authority-ports.js";
import type { ActivationAttempt, SiteAggregate, SiteRelease } from "../../src/modules/site/domain/site-lifecycle.js";
import { verifyRequestSecurityContext } from "../../src/shared/security-context/request-security-context.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";
import { PlatformUnitOfWork } from "../../src/shared/unit-of-work/unit-of-work.js";

const site: SiteAggregate = Object.freeze({
  siteRef: "site_01", state: "active", activeReleaseRef: "release_01",
  securityEpoch: 2n, policyEpoch: 5n, revocationEpoch: 1n,
  runtimeBindingEpoch: 3n,
});
const release: SiteRelease = Object.freeze({
  releaseRef: "release_02", siteRef: "site_01", state: "ready",
  webArtifactDigest: "a".repeat(64), releaseManifestDigest: "b".repeat(64),
  certificationDigest: "c".repeat(64),
});

describe("SiteLifecycleService", () => {
  it("persists an exact activation intent with its receipt and outbox in one owner transaction", async () => {
    const calls: string[] = [];
    let saved: ActivationAttempt | null = null;
    const repository: SiteAuthorityRepository = {
      loadActiveProjectBindingForUpdate: async () => ({ bindingRef: "binding_01", bindingEpoch: 1n }),
      reserveRuntimeBindingEpoch: async () => 4n,
      loadSiteForUpdate: async (transaction) => { calls.push(`site:${token(transaction)}`); return site; },
      loadReleaseForUpdate: async (transaction) => { calls.push(`release:${token(transaction)}`); return release; },
      loadActivationForUpdate: async () => null,
      insertActivation: async (transaction, attempt) => { calls.push(`insert:${token(transaction)}`); saved = attempt; },
      updateActivation: async () => { throw new Error("unexpected"); },
      recordObservationAndCandidateDeployment: async () => { throw new Error("unexpected"); },
      loadDrainingDeploymentForUpdate: async () => { throw new Error("unexpected"); },
      recordDrainObservationAndComplete: async () => { throw new Error("unexpected"); },
      commitActivation: async () => { throw new Error("unexpected"); },
      updateSite: async () => { throw new Error("unexpected"); },
    };
    const journal: SiteAuthorityJournal = {
      begin: async (transaction) => { calls.push(`begin:${token(transaction)}`); return "fresh"; },
      succeed: async (transaction) => { calls.push(`succeed:${token(transaction)}`); },
    };
    const service = new SiteLifecycleService(unitOfWork(), repository, journal, {
      now: () => "2026-07-28T12:00:00.000Z",
      approvalAuthority: { consume: async (transaction) => { calls.push(`approval:${token(transaction)}`); } },
    });

    const receipt = await service.beginActivation({
      commandId: "01983f57-8cf1-7000-8000-000000000001",
      idempotencyKey: "activation-command-01",
      approvalRef: "approval_01",
      attemptRef: "activation_02",
      siteRef: "site_01",
      candidateReleaseRef: "release_02",
      expectedActiveReleaseRef: "release_01",
      audience: "site-product",
      sessionContractRevision: "browser-v3",
    }, await context("site.activation.begin", "site_01", "admin_workload"));

    expect(receipt).toEqual({ attemptRef: "activation_02", state: "preparing", replayed: false });
    expect(saved).toMatchObject({ candidateReleaseRef: "release_02", expectedActiveReleaseRef: "release_01" });
    expect(saved).toMatchObject({ runtimeBindingEpoch: 4n });
    expect(new Set(calls.map((value) => value.split(":")[1]))).toEqual(new Set(["one"]));
    expect(calls.map((value) => value.split(":")[0])).toEqual([
      "begin", "approval", "site", "release", "insert", "succeed",
    ]);
  });

  it("fails closed when an operator targets a different Site", async () => {
    const service = new SiteLifecycleService(unitOfWork(), emptyRepository(), emptyJournal(), {
      now: () => "2026-07-28T12:00:00.000Z",
    });
    const wrongSite = await context("site.activation.begin", "site_other", "admin_workload");
    expect(() => service.beginActivation({
      commandId: "01983f57-8cf1-7000-8000-000000000001",
      idempotencyKey: "activation-command-01",
      approvalRef: "approval_01",
      attemptRef: "activation_02",
      siteRef: "site_01",
      candidateReleaseRef: "release_02",
      expectedActiveReleaseRef: "release_01",
      audience: "site-product",
      sessionContractRevision: "browser-v3",
    }, wrongSite)).toThrow(
      "SITE_ADMIN_SCOPE_MISMATCH",
    );
  });

  it("lets only the Platform worker advance provider observations", async () => {
    const service = new SiteLifecycleService(unitOfWork(), emptyRepository(), emptyJournal(), {
      now: () => "2026-07-28T12:00:00.000Z",
    });
    const admin = await context("site.activation.observe", "site_01", "admin_workload");
    expect(() => service.observeActivation({
      commandId: "01983f57-8cf1-7000-8000-000000000002",
      idempotencyKey: "observe-command-01",
      attemptRef: "activation_02",
      providerOperationKey: "provider-operation-activation-02",
      deploymentRef: "deployment_02",
      releaseRef: "release_02",
      webArtifactDigest: "a".repeat(64),
      observedAt: "2026-07-28T12:01:00.000Z", providerPayloadDigest: "d".repeat(64),
      healthy: true,
      trafficReady: true,
    }, admin)).toThrow(
      "SITE_WORKER_REQUIRED",
    );
  });

  it("persists ambiguous promotion effects for worker reconciliation", async () => {
    let saved: ActivationAttempt | null = null;
    const current: ActivationAttempt = Object.freeze({
      attemptRef: "activation_02", siteRef: "site_01", candidateReleaseRef: "release_02",
      expectedActiveReleaseRef: "release_01", candidateWebArtifactDigest: "a".repeat(64),
      candidateManifestDigest: "b".repeat(64), candidateCertificationDigest: "c".repeat(64),
      siteProjectBindingRef: "binding_01", siteProjectBindingEpoch: 3n, runtimeBindingEpoch: 4n,
      environment: "production", region: "us-east-1", audience: "site-product",
      sessionContractRevision: "browser-v3", state: "promote_requested",
      requestedAt: "2026-07-28T12:00:00.000Z", providerOperationKey: "provider-operation-activation-02",
      deploymentRef: null, observedAt: null, failureCode: null,
    });
    const repository: SiteAuthorityRepository = {
      ...emptyRepository(), loadActivationForUpdate: async () => current,
      updateActivation: async (_transaction, value) => { saved = value; },
    };
    const service = new SiteLifecycleService(unitOfWork(), repository, emptyJournal());
    await service.recordActivationProviderFailure({
      commandId: "01983f57-8cf1-7000-8000-000000000004", idempotencyKey: "effect-failure-command-01",
      attemptRef: "activation_02", siteRef: "site_01", outcome: "unknown", failureCode: "PROVIDER_TIMEOUT",
    }, await context("site.activation.effect-failure", "site_01", "platform_worker"));
    expect(saved).toMatchObject({ state: "unknown", failureCode: "PROVIDER_TIMEOUT" });
  });

  it("persists the immutable provider observation and candidate deployment before pointer commit", async () => {
    const saved: unknown[] = [];
    const activation: ActivationAttempt = Object.freeze({
      attemptRef: "activation_02", siteRef: "site_01", candidateReleaseRef: "release_02",
      expectedActiveReleaseRef: "release_01", candidateWebArtifactDigest: "a".repeat(64),
      candidateManifestDigest: "b".repeat(64), candidateCertificationDigest: "c".repeat(64),
      siteProjectBindingRef: "binding_01", siteProjectBindingEpoch: 3n,
      runtimeBindingEpoch: 4n,
      environment: "production", region: "us-east-1", audience: "site-product",
      sessionContractRevision: "browser-v3", state: "promote_requested",
      requestedAt: "2026-07-28T12:00:00.000Z",
      providerOperationKey: "provider-operation-activation-02", deploymentRef: null, observedAt: null,
      failureCode: null,
    });
    const repository: SiteAuthorityRepository = {
      ...emptyRepository(),
      loadActivationForUpdate: async () => activation,
      recordObservationAndCandidateDeployment: async (_transaction, observation, deployment) => {
        saved.push(observation, deployment);
      },
      updateActivation: async (_transaction, value) => { saved.push(value); },
    };
    const service = new SiteLifecycleService(unitOfWork(), repository, emptyJournal(), {
      now: () => "2026-07-28T12:01:00.000Z",
    });
    const receipt = await service.observeActivation({
      commandId: "01983f57-8cf1-7000-8000-000000000002",
      idempotencyKey: "observe-command-01", attemptRef: "activation_02",
      providerOperationKey: "provider-operation-activation-02", deploymentRef: "deployment_02",
      releaseRef: "release_02", webArtifactDigest: "a".repeat(64), healthy: true, trafficReady: true,
      observedAt: "2026-07-28T12:01:00.000Z", providerPayloadDigest: "d".repeat(64),
    }, await context("site.activation.observe", "site_01", "platform_worker"));

    expect(receipt).toEqual({ attemptRef: "activation_02", state: "pointer_committing", replayed: false });
    expect(saved[0]).toMatchObject({ observationRef: "01983f57-8cf1-7000-8000-000000000002",
      deploymentRef: "deployment_02", healthy: true, trafficReady: true });
    expect(saved[1]).toMatchObject({ deploymentRef: "deployment_02", bindingRef: "binding_01",
      releaseRef: "release_02", bindingEpoch: 4n, state: "candidate" });
    expect(saved[2]).toMatchObject({ state: "pointer_committing", deploymentRef: "deployment_02" });
  });

  it("retires the exact drained deployment and release before completing activation", async () => {
    let completed: unknown = null;
    const draining: ActivationAttempt = Object.freeze({
      attemptRef: "activation_02", siteRef: "site_01", candidateReleaseRef: "release_02",
      expectedActiveReleaseRef: "release_01", candidateWebArtifactDigest: "a".repeat(64),
      candidateManifestDigest: "b".repeat(64), candidateCertificationDigest: "c".repeat(64),
      siteProjectBindingRef: "binding_01", siteProjectBindingEpoch: 3n,
      runtimeBindingEpoch: 4n,
      environment: "production", region: "us-east-1", audience: "site-product",
      sessionContractRevision: "browser-v3", state: "draining",
      requestedAt: "2026-07-28T12:00:00.000Z",
      providerOperationKey: "provider-operation-activation-02", deploymentRef: "deployment_02",
      observedAt: "2026-07-28T12:01:00.000Z", failureCode: null,
    });
    const repository: SiteAuthorityRepository = {
      ...emptyRepository(),
      loadActivationForUpdate: async () => draining,
      loadDrainingDeploymentForUpdate: async () => ({
        deploymentRef: "deployment_01", webArtifactDigest: "f".repeat(64),
      }),
      recordDrainObservationAndComplete: async (_transaction, observation, value) => {
        completed = { observation, value };
      },
    };
    const service = new SiteLifecycleService(unitOfWork(), repository, emptyJournal(), {
      now: () => "2026-07-28T12:03:00.000Z",
    });
    const receipt = await service.completeActivationDrain({
      commandId: "01983f57-8cf1-7000-8000-000000000003",
      idempotencyKey: "drain-command-0001", attemptRef: "activation_02", siteRef: "site_01",
      providerOperationKey: "provider-drain-operation-01", deploymentRef: "deployment_01",
      releaseRef: "release_01", webArtifactDigest: "f".repeat(64), trafficStatus: "stopped",
      observedAt: "2026-07-28T12:02:45.000Z", providerPayloadDigest: "9".repeat(64),
    }, await context("site.activation.complete-drain", "site_01", "platform_worker"));

    expect(receipt).toEqual({ attemptRef: "activation_02", state: "succeeded", replayed: false });
    expect(completed).toMatchObject({ observation: { deploymentRef: "deployment_01",
      releaseRef: "release_01", healthy: false, trafficReady: false,
      observedAt: "2026-07-28T12:02:45.000Z", payloadDigest: "9".repeat(64) },
    value: { state: "succeeded" } });
  });
});

function unitOfWork(): PlatformUnitOfWork {
  return new PlatformUnitOfWork({
    async transaction(_fence, work) {
      const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
      transactionNames.set(lease.transaction, "one");
      try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); }
    },
  }, () => "2026-07-28T12:00:30.000Z");
}

const transactionNames = new WeakMap<PlatformTransaction, string>();
function token(transaction: PlatformTransaction): string {
  return transactionNames.get(transaction) ?? "unknown";
}

function emptyRepository(): SiteAuthorityRepository {
  return {
    loadActiveProjectBindingForUpdate: async () => null,
    reserveRuntimeBindingEpoch: async () => { throw new Error("unexpected"); },
    loadSiteForUpdate: async () => null,
    loadReleaseForUpdate: async () => null,
    loadActivationForUpdate: async () => null,
    insertActivation: async () => undefined,
    updateActivation: async () => undefined,
    recordObservationAndCandidateDeployment: async () => undefined,
    loadDrainingDeploymentForUpdate: async () => null,
    recordDrainObservationAndComplete: async () => undefined,
    commitActivation: async () => undefined,
    updateSite: async () => undefined,
  };
}

function emptyJournal(): SiteAuthorityJournal {
  return { begin: async () => "fresh", succeed: async () => undefined };
}

async function context(operation: string, siteId: string, kind: "admin_workload" | "platform_worker") {
  const issuer = "spiffe://kokoro.test";
  const input = {
    requestId: "request-01", correlationId: "correlation-01",
    trustedCaller: {
      kind, workloadIdentityId: `${kind}-01`, environment: "production", region: "us-east-1",
      audience: "platform-admin", allowedOperations: [operation], bindingEpoch: "1",
      issuedAt: "2026-07-28T12:00:00.000Z", expiresAt: "2026-07-28T12:10:00.000Z",
    },
    actor: { kind: kind === "admin_workload" ? "operator" : "workload", subjectId: "actor-01", subjectGeneration: "1" },
    delegatedGrant: null,
    target: { siteId, workspaceId: null, projectId: null, purpose: operation, scopes: [operation] },
    audience: "platform-admin", environment: "production", region: "us-east-1",
    evidence: [{ kind: "workload_attestation", evidenceId: "attestation-01", issuer }],
    policyEpoch: "1", issuedAt: "2026-07-28T12:00:00.000Z", expiresAt: "2026-07-28T12:10:00.000Z",
  } as const;
  return verifyRequestSecurityContext(input, {
    now: "2026-07-28T12:00:30.000Z", operation,
    expectedAudience: "platform-admin", expectedEnvironment: "production", expectedRegion: "us-east-1",
    callerVerifier: { verify: async () => ({
      workloadIdentityId: `${kind}-01`, kind, audience: "platform-admin", environment: "production",
      region: "us-east-1", allowedOperations: [operation], siteId: null, bindingEpoch: "1",
      issuedAt: "2026-07-28T12:00:00.000Z", expiresAt: "2026-07-28T12:10:00.000Z",
      issuer, keyVersion: "test-1",
    }) },
  });
}
