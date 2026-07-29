import type { SiteAggregate, SiteDeploymentBinding } from "./site-lifecycle.js";

export type SiteTrafficStopAction = "suspend" | "decommission";
export type SiteTrafficStopState =
  | "requested"
  | "stop_requested"
  | "observing"
  | "succeeded"
  | "failed"
  | "unknown";

export interface SiteTrafficStopAttempt {
  readonly attemptRef: string;
  readonly siteRef: string;
  readonly action: SiteTrafficStopAction;
  readonly releaseRef: string;
  readonly deploymentRef: string;
  readonly bindingRef: string;
  readonly runtimeBindingEpoch: bigint;
  readonly providerNamespace: string;
  readonly environment: "development" | "preview" | "production";
  readonly region: string;
  readonly state: SiteTrafficStopState;
  readonly requestedAt: string;
  readonly providerOperationKey: string | null;
  readonly observedAt: string | null;
  readonly failureCode: string | null;
}

export interface SiteTrafficStopObservation {
  readonly observationRef: string;
  readonly attemptRef: string;
  readonly providerOperationKey: string;
  readonly deploymentRef: string;
  readonly status: "serving" | "stopped" | "unknown";
  readonly observedAt: string;
  readonly payloadDigest: string;
}

export function beginSiteTrafficStop(input: Readonly<{
  attemptRef: string;
  action: SiteTrafficStopAction;
  site: SiteAggregate;
  deployment: SiteDeploymentBinding;
  providerNamespace: string;
  requestedAt: string;
}>): Readonly<{ site: SiteAggregate; attempt: SiteTrafficStopAttempt }> {
  identifier(input.attemptRef, "SITE_TRAFFIC_STOP_REF_INVALID");
  providerNamespace(input.providerNamespace);
  instant(input.requestedAt, "SITE_TRAFFIC_STOP_TIME_INVALID");
  if (input.site.state !== "active" || input.site.activeReleaseRef === null) {
    throw new Error("SITE_TRAFFIC_STOP_STATE_INVALID");
  }
  if (
    input.deployment.state !== "active" || input.deployment.siteRef !== input.site.siteRef ||
    input.deployment.releaseRef !== input.site.activeReleaseRef ||
    input.deployment.bindingEpoch !== input.site.runtimeBindingEpoch
  ) throw new Error("SITE_TRAFFIC_STOP_DEPLOYMENT_MISMATCH");
  const fencedSite = Object.freeze({
    ...input.site,
    state: input.action === "suspend" ? "suspending" as const : "decommissioning" as const,
    securityEpoch: increment(input.site.securityEpoch),
    revocationEpoch: increment(input.site.revocationEpoch),
  });
  return Object.freeze({
    site: fencedSite,
    attempt: Object.freeze({
      attemptRef: input.attemptRef, siteRef: input.site.siteRef, action: input.action,
      releaseRef: input.deployment.releaseRef, deploymentRef: input.deployment.deploymentRef,
      bindingRef: input.deployment.bindingRef, runtimeBindingEpoch: input.deployment.bindingEpoch,
      providerNamespace: input.providerNamespace, environment: input.deployment.environment,
      region: input.deployment.region, state: "requested" as const, requestedAt: input.requestedAt,
      providerOperationKey: null, observedAt: null, failureCode: null,
    }),
  });
}

export function requestSiteTrafficStopEffect(
  attempt: SiteTrafficStopAttempt,
  providerOperationKey: string,
): SiteTrafficStopAttempt {
  verifyAttempt(attempt);
  identifier(providerOperationKey, "SITE_PROVIDER_OPERATION_KEY_INVALID");
  if (attempt.state !== "requested") throw new Error("SITE_TRAFFIC_STOP_TRANSITION_INVALID");
  return Object.freeze({ ...attempt, state: "stop_requested", providerOperationKey });
}

export function recordSiteTrafficStopEffectFailure(
  attempt: SiteTrafficStopAttempt,
  outcome: "failed" | "unknown",
  failureCode: string,
): SiteTrafficStopAttempt {
  verifyAttempt(attempt);
  identifier(failureCode, "SITE_TRAFFIC_STOP_FAILURE_CODE_INVALID");
  if (!attempt.providerOperationKey || !["stop_requested", "observing", "unknown"].includes(attempt.state)) {
    throw new Error("SITE_TRAFFIC_STOP_TRANSITION_INVALID");
  }
  return Object.freeze({ ...attempt, state: outcome, failureCode });
}

export function observeSiteTrafficStop(
  attempt: SiteTrafficStopAttempt,
  observation: Omit<SiteTrafficStopObservation, "attemptRef">,
): Readonly<{ attempt: SiteTrafficStopAttempt; site: Pick<SiteAggregate, "state" | "activeReleaseRef"> }> {
  verifyAttempt(attempt);
  observationValue({ ...observation, attemptRef: attempt.attemptRef });
  if (!["stop_requested", "observing", "unknown"].includes(attempt.state)) {
    throw new Error("SITE_TRAFFIC_STOP_TRANSITION_INVALID");
  }
  if (observation.providerOperationKey !== attempt.providerOperationKey ||
      observation.deploymentRef !== attempt.deploymentRef) {
    throw new Error("SITE_TRAFFIC_STOP_OBSERVATION_MISMATCH");
  }
  const state = observation.status === "stopped" ? "succeeded" :
    observation.status === "serving" ? "observing" : "unknown";
  const next = Object.freeze({
    ...attempt, state, observedAt: observation.observedAt,
    failureCode: state === "unknown" ? "PROVIDER_OBSERVATION_UNKNOWN" : null,
  });
  return Object.freeze({
    attempt: next,
    site: Object.freeze({
      state: observation.status === "stopped"
        ? attempt.action === "suspend" ? "suspended" as const : "decommissioned" as const
        : attempt.action === "suspend" ? "suspending" as const : "decommissioning" as const,
      activeReleaseRef: observation.status === "stopped" && attempt.action === "decommission"
        ? null : attempt.releaseRef,
    }),
  });
}

export function verifySiteTrafficStopAttempt(value: SiteTrafficStopAttempt): SiteTrafficStopAttempt {
  verifyAttempt(value);
  return Object.freeze({ ...value });
}

function verifyAttempt(value: SiteTrafficStopAttempt): void {
  identifier(value.attemptRef, "SITE_TRAFFIC_STOP_REF_INVALID");
  identifier(value.siteRef, "SITE_REF_INVALID");
  identifier(value.releaseRef, "SITE_RELEASE_REF_INVALID");
  identifier(value.deploymentRef, "SITE_DEPLOYMENT_REF_INVALID");
  identifier(value.bindingRef, "SITE_PROJECT_BINDING_REF_INVALID");
  providerNamespace(value.providerNamespace);
  if (value.runtimeBindingEpoch < 1n) throw new Error("SITE_EPOCH_INVALID");
  instant(value.requestedAt, "SITE_TRAFFIC_STOP_TIME_INVALID");
  if (value.providerOperationKey !== null) identifier(value.providerOperationKey, "SITE_PROVIDER_OPERATION_KEY_INVALID");
  if (value.observedAt !== null) instant(value.observedAt, "SITE_TRAFFIC_STOP_TIME_INVALID");
  if (value.failureCode !== null) identifier(value.failureCode, "SITE_TRAFFIC_STOP_FAILURE_CODE_INVALID");
  if (!(["development", "preview", "production"] as const).includes(value.environment)) {
    throw new Error("SITE_ENVIRONMENT_INVALID");
  }
  if ((value.state === "requested") !== (value.providerOperationKey === null)) {
    throw new Error("SITE_TRAFFIC_STOP_STATE_INVALID");
  }
}

function observationValue(value: SiteTrafficStopObservation): void {
  if (!/^[0-9a-f-]{36}$/u.test(value.observationRef)) throw new Error("SITE_OBSERVATION_REF_INVALID");
  identifier(value.providerOperationKey, "SITE_PROVIDER_OPERATION_KEY_INVALID");
  identifier(value.deploymentRef, "SITE_DEPLOYMENT_REF_INVALID");
  instant(value.observedAt, "SITE_TRAFFIC_STOP_TIME_INVALID");
  if (!/^[a-f0-9]{64}$/u.test(value.payloadDigest)) throw new Error("SITE_OBSERVATION_DIGEST_INVALID");
}

function providerNamespace(value: string): void {
  if (!/^[a-z][a-z0-9.-]{1,63}$/u.test(value)) throw new Error("SITE_PROVIDER_NAMESPACE_INVALID");
}

function identifier(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value)) throw new Error(code);
}

function instant(value: string, code: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(code);
}

function increment(value: bigint): bigint {
  if (value >= 9_223_372_036_854_775_807n) throw new Error("SITE_EPOCH_EXHAUSTED");
  return value + 1n;
}
