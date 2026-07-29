import { describe, expect, it } from "vitest";
import {
  activateObservedRelease,
  beginActivation,
  beginDecommission,
  observePromotion,
  requestPromotion,
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
      site: activeSite,
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
