import { describe, expect, it } from "vitest";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";
import type { PlatformInternalOperation } from "../../src/infrastructure/postgres/client.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";
import {
  createPostgresSiteRuntimeTransactionRunner,
  PostgresSiteRuntimeStateStore,
} from "../../src/modules/site/infrastructure/postgres/site-runtime-state-store.js";
import type { SiteRuntimeRepository } from "../../src/modules/site/application/contracts/site-runtime-state.js";
import type { ActivationAttempt, SiteAggregate, SiteRelease } from "../../src/modules/site/domain/site-lifecycle.js";
import type { SiteTrafficStopAttempt } from "../../src/modules/site/domain/site-traffic-stop.js";

describe("PostgresSiteRuntimeStateStore", () => {
  it("runs production state transitions only through the worker-owned internal operation", async () => {
    let operation = "";
    const transactionRunner = createPostgresSiteRuntimeTransactionRunner({
      internalTransaction: async <Result>(
        value: PlatformInternalOperation,
        work: (transaction: PlatformTransaction) => Promise<Result>,
      ): Promise<Result> => {
        operation = value;
        const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
        try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); }
      },
    } as never);
    await transactionRunner.execute(async () => undefined);
    expect(operation).toBe("site.runtime.consume");
  });

  it("atomically accepts ready provider evidence, projects activation, and returns the exact drain command", async () => {
    let attempt = activation("promote_requested");
    const calls: string[] = [];
    const repository: SiteRuntimeRepository = {
      loadActivationForUpdate: async () => attempt,
      updateActivation: async (_tx, value) => { attempt = value; calls.push(`attempt:${value.state}`); },
      loadRuntimeProjectBindingForUpdate: async () => providerBinding,
      recordObservationAndCandidateDeployment: async (_tx, observation) => {
        calls.push(`observation:${observation.payloadDigest}`);
      },
      loadSiteForUpdate: async () => activeSite,
      loadReleaseForUpdate: async () => readyRelease,
      commitActivation: async (_tx, value) => { attempt = value.attempt; calls.push(`commit:${value.attempt.state}`); },
      loadDrainingRuntimeDeploymentForUpdate: async () => ({
        deploymentRef: "deployment_01", webArtifactDigest: "f".repeat(64),
        providerNamespace: "vercel", providerProjectRef: "project_01",
        environment: "production", region: "us-east-1",
      }),
      recordDrainObservationAndComplete: async () => { throw new Error("unexpected"); },
      loadTrafficStopForUpdate: async () => null,
      updateTrafficStop: async () => { throw new Error("unexpected"); },
      recordTrafficStopObservation: async () => { throw new Error("unexpected"); },
    };
    const store = new PostgresSiteRuntimeStateStore(runner(), repository, authorization());
    const next = await store.acceptPromotion("activation_02", {
      status: "ready", deploymentRef: "deployment_02",
      observedAt: "2026-07-30T10:01:00.000Z", payloadDigest: "d".repeat(64),
    });
    expect(calls).toEqual([`observation:${"d".repeat(64)}`, "attempt:pointer_committing", "commit:draining"]);
    expect(next).toMatchObject({ kind: "stop_activation_drain", providerNamespace: "vercel",
      command: { deploymentRef: "deployment_01", providerProjectRef: "project_01" } });
  });

  it("keeps a rejected traffic stop reconcilable and finalizes only stopped evidence", async () => {
    let current: SiteTrafficStopAttempt = trafficStop("stop_requested");
    const completed: string[] = [];
    const repository: SiteRuntimeRepository = {
      loadActivationForUpdate: async () => null,
      updateActivation: async () => { throw new Error("unexpected"); },
      loadRuntimeProjectBindingForUpdate: async () => providerBinding,
      recordObservationAndCandidateDeployment: async () => { throw new Error("unexpected"); },
      loadSiteForUpdate: async () => activeSite,
      loadReleaseForUpdate: async () => readyRelease,
      commitActivation: async () => { throw new Error("unexpected"); },
      loadDrainingRuntimeDeploymentForUpdate: async () => null,
      recordDrainObservationAndComplete: async () => { throw new Error("unexpected"); },
      loadTrafficStopForUpdate: async () => current,
      updateTrafficStop: async (_tx, value) => { current = value; },
      recordTrafficStopObservation: async (_tx, _observation, value, site) => {
        current = value; completed.push(`${value.state}:${site.state}`);
      },
    };
    const store = new PostgresSiteRuntimeStateStore(runner(), repository, authorization());
    await expect(store.acceptTrafficStop("traffic_stop_01", {
      status: "rejected", observedAt: "2026-07-30T10:01:00.000Z", payloadDigest: "e".repeat(64),
    })).resolves.toMatchObject({ kind: "observe_site_traffic" });
    expect(current).toMatchObject({ state: "failed", failureCode: "PROVIDER_REJECTED" });
    await expect(store.acceptTrafficStop("traffic_stop_01", {
      status: "stopped", observedAt: "2026-07-30T10:02:00.000Z", payloadDigest: "f".repeat(64),
    })).resolves.toEqual({ kind: "complete" });
    expect(completed).toEqual(["succeeded:suspended"]);
  });
});

function runner() {
  return { async execute<Result>(work: (transaction: PlatformTransaction) => Promise<Result>) {
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 1 });
    try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); }
  } };
}

function authorization() {
  return { async execute(_transaction: unknown, _input: unknown, mutate: () => Promise<void>) {
    await mutate();
    return {};
  } } as never;
}

const activeSite: SiteAggregate = { siteRef: "site_01", state: "active", activeReleaseRef: "release_01",
  securityEpoch: 4n, policyEpoch: 7n, revocationEpoch: 3n, runtimeBindingEpoch: 8n };
const readyRelease: SiteRelease = { releaseRef: "release_02", siteRef: "site_01", state: "ready",
  webArtifactDigest: "a".repeat(64), releaseManifestDigest: "b".repeat(64),
  certificationDigest: "c".repeat(64) };
const providerBinding = { providerNamespace: "vercel", providerProjectRef: "project_01" };
function activation(state: ActivationAttempt["state"]): ActivationAttempt {
  return { attemptRef: "activation_02", siteRef: "site_01", candidateReleaseRef: "release_02",
    expectedActiveReleaseRef: "release_01", candidateWebArtifactDigest: "a".repeat(64),
    candidateManifestDigest: "b".repeat(64), candidateCertificationDigest: "c".repeat(64),
    siteProjectBindingRef: "binding_01", siteProjectBindingEpoch: 3n, runtimeBindingEpoch: 8n,
    environment: "production", region: "us-east-1", audience: "site-product",
    sessionContractRevision: "browser-v3", state, requestedAt: "2026-07-30T10:00:00.000Z",
    providerOperationKey: "site-promote-operation", deploymentRef: null, observedAt: null,
    failureCode: null };
}
function trafficStop(state: "stop_requested" | "failed"): SiteTrafficStopAttempt {
  return { attemptRef: "traffic_stop_01", siteRef: "site_01", action: "suspend" as const,
    releaseRef: "release_01", deploymentRef: "deployment_01", bindingRef: "binding_01",
    runtimeBindingEpoch: 8n, providerNamespace: "vercel", environment: "production" as const,
    region: "us-east-1", state, requestedAt: "2026-07-30T10:00:00.000Z",
    providerOperationKey: "site-traffic-operation", observedAt: null, failureCode: null };
}
