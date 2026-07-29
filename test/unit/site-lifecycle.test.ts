import { describe, expect, it } from "vitest";
import {
  activateObservedRelease,
  beginActivation,
  beginDecommission,
  deploymentBindingForObservation,
  observePromotion,
  requestPromotion,
  recordActivationEffectFailure,
  resumeSite,
  suspendSite,
  type SiteAggregate,
  type SiteRelease,
} from "../../src/modules/site/domain/site-lifecycle.js";

const activeSite: SiteAggregate = Object.freeze({
  siteRef: "site_01",
  state: "active",
  activeReleaseRef: "release_01",
  securityEpoch: 4n,
  policyEpoch: 7n,
  revocationEpoch: 3n,
  runtimeBindingEpoch: 7n,
});

const candidate: SiteRelease = Object.freeze({
  releaseRef: "release_02",
  siteRef: "site_01",
  state: "ready",
  webArtifactDigest: "a".repeat(64),
  releaseManifestDigest: "b".repeat(64),
  certificationDigest: "c".repeat(64),
});
const activationBinding = Object.freeze({
  siteProjectBindingRef: "binding_01",
  siteProjectBindingEpoch: 1n,
  runtimeBindingEpoch: 8n,
  environment: "production" as const,
  region: "us-east-1",
  audience: "site-product",
  sessionContractRevision: "browser-v3",
});

describe("Site lifecycle", () => {
  it("promotes an observed immutable release with an exact active-pointer CAS", () => {
    const preparing = beginActivation({
      ...activationBinding,
      attemptRef: "activation_02",
      site: activeSite,
      candidate,
      expectedActiveReleaseRef: "release_01",
      requestedAt: "2026-07-28T12:00:00.000Z",
    });
    const requested = requestPromotion(preparing, "provider-operation-activation-02");
    const observed = observePromotion(requested, {
      providerOperationKey: "provider-operation-activation-02",
      deploymentRef: "deployment_02",
      releaseRef: "release_02",
      webArtifactDigest: "a".repeat(64),
      observedAt: "2026-07-28T12:01:00.000Z",
      healthy: true,
      trafficReady: true,
    });

    const activated = activateObservedRelease({
      site: { ...activeSite, runtimeBindingEpoch: 8n },
      candidate,
      attempt: observed,
      currentActiveReleaseRef: "release_01",
      committedAt: "2026-07-28T12:02:00.000Z",
    });

    expect(activated.site.activeReleaseRef).toBe("release_02");
    expect(activated.site.policyEpoch).toBe(8n);
    expect(activated.candidate.state).toBe("active");
    expect(activated.drainingReleaseRef).toBe("release_01");
    expect(activated.attempt.state).toBe("draining");
  });

  it("uses the Site-reserved monotonic runtime epoch for every observed deployment", () => {
    const attempt = requestPromotion(beginActivation({
      ...activationBinding,
      attemptRef: "activation_02",
      site: activeSite,
      candidate,
      expectedActiveReleaseRef: "release_01",
      requestedAt: "2026-07-28T12:00:00.000Z",
    }), "provider-operation-activation-02");
    const observation = {
      observationRef: "01983f57-8cf1-7000-8000-000000000002",
      attemptRef: "activation_02",
      providerOperationKey: "provider-operation-activation-02",
      deploymentRef: "deployment_02",
      releaseRef: "release_02",
      webArtifactDigest: "a".repeat(64),
      healthy: true,
      trafficReady: true,
      observedAt: "2026-07-28T12:01:00.000Z",
      payloadDigest: "d".repeat(64),
    } as const;

    expect(deploymentBindingForObservation(attempt, observation).bindingEpoch).toBe(8n);
    expect(() => beginActivation({
      ...activationBinding,
      runtimeBindingEpoch: 7n,
      attemptRef: "activation_stale",
      site: activeSite,
      candidate,
      expectedActiveReleaseRef: "release_01",
      requestedAt: "2026-07-28T12:00:00.000Z",
    })).toThrow("SITE_RUNTIME_BINDING_EPOCH_STALE");
  });

  it("never overwrites a pointer changed by another activation", () => {
    const attempt = observePromotion(
      requestPromotion(beginActivation({
        ...activationBinding,
        attemptRef: "activation_02",
        site: activeSite,
        candidate,
        expectedActiveReleaseRef: "release_01",
        requestedAt: "2026-07-28T12:00:00.000Z",
      }), "provider-operation-activation-02"),
      {
        providerOperationKey: "provider-operation-activation-02",
        deploymentRef: "deployment_02",
        releaseRef: "release_02",
        webArtifactDigest: "a".repeat(64),
        observedAt: "2026-07-28T12:01:00.000Z",
        healthy: true,
        trafficReady: true,
      },
    );

    expect(() => activateObservedRelease({
      site: activeSite,
      candidate,
      attempt,
      currentActiveReleaseRef: "release_other",
      committedAt: "2026-07-28T12:02:00.000Z",
    })).toThrow("SITE_ACTIVE_POINTER_CONFLICT");
  });

  it("never activates an older runtime generation after a newer one was reserved", () => {
    const attempt = observePromotion(
      requestPromotion(beginActivation({
        ...activationBinding,
        attemptRef: "activation_02",
        site: activeSite,
        candidate,
        expectedActiveReleaseRef: "release_01",
        requestedAt: "2026-07-28T12:00:00.000Z",
      }), "provider-operation-activation-02"),
      {
        providerOperationKey: "provider-operation-activation-02",
        deploymentRef: "deployment_02",
        releaseRef: "release_02",
        webArtifactDigest: "a".repeat(64),
        observedAt: "2026-07-28T12:01:00.000Z",
        healthy: true,
        trafficReady: true,
      },
    );

    expect(() => activateObservedRelease({
      site: { ...activeSite, runtimeBindingEpoch: 9n },
      candidate,
      attempt,
      currentActiveReleaseRef: "release_01",
      committedAt: "2026-07-28T12:02:00.000Z",
    })).toThrow("SITE_RUNTIME_BINDING_EPOCH_STALE");
  });

  it("rejects unobserved, unhealthy, mismatched, and uncertified candidates", () => {
    const preparing = beginActivation({
      ...activationBinding,
      attemptRef: "activation_02",
      site: activeSite,
      candidate,
      expectedActiveReleaseRef: "release_01",
      requestedAt: "2026-07-28T12:00:00.000Z",
    });
    expect(() => activateObservedRelease({
      site: activeSite,
      candidate,
      attempt: preparing,
      currentActiveReleaseRef: "release_01",
      committedAt: "2026-07-28T12:02:00.000Z",
    })).toThrow("SITE_ACTIVATION_NOT_OBSERVED");
    expect(() => observePromotion(requestPromotion(preparing, "provider-operation-activation-02"), {
      providerOperationKey: "provider-operation-activation-02",
      deploymentRef: "deployment_02",
      releaseRef: "release_02",
      webArtifactDigest: "f".repeat(64),
      observedAt: "2026-07-28T12:01:00.000Z",
      healthy: true,
      trafficReady: true,
    })).toThrow("SITE_DEPLOYMENT_OBSERVATION_MISMATCH");
    expect(() => beginActivation({
      ...activationBinding,
      attemptRef: "activation_03",
      site: activeSite,
      candidate: { ...candidate, certificationDigest: "" },
      expectedActiveReleaseRef: "release_01",
      requestedAt: "2026-07-28T12:00:00.000Z",
    })).toThrow("SITE_RELEASE_DIGEST_INVALID");
  });

  it("keeps ambiguous promotion effects reconcilable but definitive rejection terminal", () => {
    const armed = requestPromotion(beginActivation({
      ...activationBinding, attemptRef: "activation_02", site: activeSite, candidate,
      expectedActiveReleaseRef: "release_01", requestedAt: "2026-07-28T12:00:00.000Z",
    }), "provider-operation-activation-02");
    const unknown = recordActivationEffectFailure(armed, "unknown", "PROVIDER_TIMEOUT");
    expect(observePromotion(unknown, {
      providerOperationKey: "provider-operation-activation-02", deploymentRef: "deployment_02",
      releaseRef: "release_02", webArtifactDigest: "a".repeat(64),
      observedAt: "2026-07-28T12:01:00.000Z", healthy: true, trafficReady: true,
    }).state).toBe("pointer_committing");
    const failed = recordActivationEffectFailure(armed, "failed", "PROVIDER_REJECTED");
    expect(failed).toMatchObject({ state: "failed", failureCode: "PROVIDER_REJECTED" });
    expect(() => observePromotion(failed, {
      providerOperationKey: "provider-operation-activation-02", deploymentRef: "deployment_02",
      releaseRef: "release_02", webArtifactDigest: "a".repeat(64),
      observedAt: "2026-07-28T12:01:00.000Z", healthy: true, trafficReady: true,
    })).toThrow("SITE_ACTIVATION_TRANSITION_INVALID");
  });

  it("requires a fresh activation after suspension and makes decommission irreversible", () => {
    const suspended = suspendSite(activeSite);
    expect(suspended.state).toBe("suspended");
    expect(suspended.securityEpoch).toBe(5n);
    expect(suspended.revocationEpoch).toBe(4n);

    const resumed = resumeSite(suspended);
    expect(resumed.state).toBe("preview_ready");
    expect(resumed.activeReleaseRef).toBeNull();

    const decommissioning = beginDecommission(suspended);
    expect(decommissioning.state).toBe("decommissioning");
    expect(() => resumeSite({ ...decommissioning, state: "decommissioned" })).toThrow(
      "SITE_DECOMMISSIONED",
    );
  });
});
