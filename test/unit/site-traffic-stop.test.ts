import { describe, expect, it } from "vitest";
import {
  beginSiteTrafficStop,
  observeSiteTrafficStop,
  recordSiteTrafficStopEffectFailure,
  requestSiteTrafficStopEffect,
} from "../../src/modules/site/domain/site-traffic-stop.js";
import type { SiteAggregate, SiteDeploymentBinding } from "../../src/modules/site/domain/site-lifecycle.js";

const site: SiteAggregate = Object.freeze({
  siteRef: "site_01", state: "active", activeReleaseRef: "release_01",
  securityEpoch: 4n, policyEpoch: 7n, revocationEpoch: 3n, runtimeBindingEpoch: 8n,
});
const deployment: SiteDeploymentBinding = Object.freeze({
  deploymentRef: "deployment_01", bindingRef: "binding_01", siteRef: "site_01",
  releaseRef: "release_01", environment: "staging", region: "us-east-1",
  audience: "site-product", sessionContractRevision: "browser-v3",
  webArtifactDigest: "a".repeat(64), bindingEpoch: 8n, state: "active",
});

describe("Site traffic stop", () => {
  it("fences admission immediately but requires provider stop evidence before suspension completes", () => {
    const begun = beginSiteTrafficStop({
      attemptRef: "traffic_stop_01", action: "suspend", site, deployment,
      providerNamespace: "vercel", requestedAt: "2026-07-29T13:00:00.000Z",
    });
    expect(begun.site).toMatchObject({ state: "suspending", securityEpoch: 5n, revocationEpoch: 4n });
    expect(begun.attempt).toMatchObject({ state: "requested", deploymentRef: "deployment_01" });

    const armed = requestSiteTrafficStopEffect(begun.attempt, "vercel:traffic-stop:01");
    const observed = observeSiteTrafficStop(armed, {
      observationRef: "01983f57-8cf1-7000-8000-000000000021",
      providerOperationKey: "vercel:traffic-stop:01", deploymentRef: "deployment_01",
      status: "stopped", observedAt: "2026-07-29T13:01:00.000Z",
      payloadDigest: "b".repeat(64),
    });
    expect(observed.attempt.state).toBe("succeeded");
    expect(observed.site).toMatchObject({ state: "suspended", activeReleaseRef: "release_01" });
  });

  it("keeps an ambiguous provider effect reconcilable and later accepts authoritative evidence", () => {
    const begun = beginSiteTrafficStop({
      attemptRef: "traffic_stop_01", action: "decommission", site, deployment,
      providerNamespace: "vercel", requestedAt: "2026-07-29T13:00:00.000Z",
    });
    const armed = requestSiteTrafficStopEffect(begun.attempt, "vercel:traffic-stop:01");
    const unknown = recordSiteTrafficStopEffectFailure(armed, "unknown", "PROVIDER_TIMEOUT");
    expect(unknown.state).toBe("unknown");
    const reconciled = observeSiteTrafficStop(unknown, {
      observationRef: "01983f57-8cf1-7000-8000-000000000022",
      providerOperationKey: "vercel:traffic-stop:01", deploymentRef: "deployment_01",
      status: "stopped", observedAt: "2026-07-29T13:02:00.000Z",
      payloadDigest: "c".repeat(64),
    });
    expect(reconciled.site).toMatchObject({ state: "decommissioned", activeReleaseRef: null });
    expect(reconciled.attempt.state).toBe("succeeded");
  });

  it("keeps definitive rejection fenced and reconcilable without claiming traffic stopped", () => {
    const begun = beginSiteTrafficStop({
      attemptRef: "traffic_stop_01", action: "suspend", site, deployment,
      providerNamespace: "vercel", requestedAt: "2026-07-29T13:00:00.000Z",
    });
    const failed = recordSiteTrafficStopEffectFailure(
      requestSiteTrafficStopEffect(begun.attempt, "vercel:traffic-stop:01"),
      "failed",
      "PROVIDER_REJECTED",
    );
    expect(failed).toMatchObject({ state: "failed", failureCode: "PROVIDER_REJECTED" });
    const reconciled = observeSiteTrafficStop(failed, {
      observationRef: "01983f57-8cf1-7000-8000-000000000023",
      providerOperationKey: "vercel:traffic-stop:01", deploymentRef: "deployment_01",
      status: "stopped", observedAt: "2026-07-29T13:02:00.000Z",
      payloadDigest: "d".repeat(64),
    });
    expect(reconciled.attempt).toMatchObject({ state: "succeeded", failureCode: null });
  });
});
