export type SiteState =
  | "preview_ready"
  | "active"
  | "suspending"
  | "suspended"
  | "decommissioning"
  | "decommissioned";

export type SiteReleaseState = "ready" | "active" | "draining" | "retired";

export interface SiteAggregate {
  readonly siteRef: string;
  readonly state: SiteState;
  readonly activeReleaseRef: string | null;
  readonly securityEpoch: bigint;
  readonly policyEpoch: bigint;
  readonly revocationEpoch: bigint;
  /** Monotonic Site-owned generation fencing every runtime deployment identity. */
  readonly runtimeBindingEpoch: bigint;
}

export interface SiteRelease {
  readonly releaseRef: string;
  readonly siteRef: string;
  readonly state: SiteReleaseState;
  readonly webArtifactDigest: string;
  readonly releaseManifestDigest: string;
  readonly certificationDigest: string;
}

export type ActivationState =
  | "preparing"
  | "promote_requested"
  | "observing"
  | "pointer_committing"
  | "draining"
  | "succeeded"
  | "failed"
  | "unknown";

export interface ActivationAttempt {
  readonly attemptRef: string;
  readonly siteRef: string;
  readonly candidateReleaseRef: string;
  readonly expectedActiveReleaseRef: string | null;
  readonly candidateWebArtifactDigest: string;
  readonly candidateManifestDigest: string;
  readonly candidateCertificationDigest: string;
  readonly siteProjectBindingRef: string;
  readonly siteProjectBindingEpoch: bigint;
  readonly runtimeBindingEpoch: bigint;
  readonly environment: "development" | "preview" | "production";
  readonly region: string;
  readonly audience: string;
  readonly sessionContractRevision: string;
  readonly state: ActivationState;
  readonly requestedAt: string;
  readonly providerOperationKey: string | null;
  readonly deploymentRef: string | null;
  readonly observedAt: string | null;
  readonly failureCode: string | null;
}

export interface SiteDeploymentBinding {
  readonly deploymentRef: string;
  readonly bindingRef: string;
  readonly siteRef: string;
  readonly releaseRef: string;
  readonly environment: "development" | "preview" | "production";
  readonly region: string;
  readonly audience: string;
  readonly sessionContractRevision: string;
  readonly webArtifactDigest: string;
  readonly bindingEpoch: bigint;
  readonly state: "candidate" | "active" | "draining" | "revoked";
}

export interface SiteDeploymentObservation {
  readonly observationRef: string;
  readonly attemptRef: string;
  readonly providerOperationKey: string;
  readonly deploymentRef: string;
  readonly releaseRef: string;
  readonly webArtifactDigest: string;
  readonly healthy: boolean;
  readonly trafficReady: boolean;
  readonly observedAt: string;
  readonly payloadDigest: string;
}

export function verifySiteAggregate(value: SiteAggregate): SiteAggregate {
  site(value);
  return Object.freeze({ ...value });
}

export function verifySiteRelease(value: SiteRelease): SiteRelease {
  release(value);
  return Object.freeze({ ...value });
}

export function verifyActivationAttempt(value: ActivationAttempt): ActivationAttempt {
  activation(value);
  return Object.freeze({ ...value });
}

export function beginActivation(input: Readonly<{
  attemptRef: string;
  site: SiteAggregate;
  candidate: SiteRelease;
  expectedActiveReleaseRef: string | null;
  siteProjectBindingRef: string;
  siteProjectBindingEpoch: bigint;
  runtimeBindingEpoch: bigint;
  environment: "development" | "preview" | "production";
  region: string;
  audience: string;
  sessionContractRevision: string;
  requestedAt: string;
}>): ActivationAttempt {
  identifier(input.attemptRef, "SITE_ACTIVATION_REF_INVALID");
  site(input.site);
  release(input.candidate);
  instant(input.requestedAt, "SITE_ACTIVATION_TIME_INVALID");
  identifier(input.siteProjectBindingRef, "SITE_PROJECT_BINDING_REF_INVALID");
  epoch(input.siteProjectBindingEpoch);
  epoch(input.runtimeBindingEpoch);
  if (input.runtimeBindingEpoch !== nextEpoch(input.site.runtimeBindingEpoch)) {
    throw new Error("SITE_RUNTIME_BINDING_EPOCH_STALE");
  }
  bounded(input.region, "SITE_REGION_INVALID");
  bounded(input.audience, "SITE_AUDIENCE_INVALID");
  bounded(input.sessionContractRevision, "SITE_SESSION_CONTRACT_REVISION_INVALID");
  if (input.site.state === "decommissioned" || input.site.state === "decommissioning") {
    throw new Error("SITE_NOT_ACTIVATABLE");
  }
  if (input.site.state === "suspended") throw new Error("SITE_RESUME_REQUIRED");
  if (input.candidate.siteRef !== input.site.siteRef) throw new Error("SITE_RELEASE_SCOPE_MISMATCH");
  if (input.candidate.state !== "ready") throw new Error("SITE_RELEASE_NOT_READY");
  if (input.expectedActiveReleaseRef !== input.site.activeReleaseRef) {
    throw new Error("SITE_ACTIVE_POINTER_CONFLICT");
  }
  return Object.freeze({
    attemptRef: input.attemptRef,
    siteRef: input.site.siteRef,
    candidateReleaseRef: input.candidate.releaseRef,
    expectedActiveReleaseRef: input.expectedActiveReleaseRef,
    candidateWebArtifactDigest: input.candidate.webArtifactDigest,
    candidateManifestDigest: input.candidate.releaseManifestDigest,
    candidateCertificationDigest: input.candidate.certificationDigest,
    siteProjectBindingRef: input.siteProjectBindingRef,
    siteProjectBindingEpoch: input.siteProjectBindingEpoch,
    runtimeBindingEpoch: input.runtimeBindingEpoch,
    environment: input.environment,
    region: input.region,
    audience: input.audience,
    sessionContractRevision: input.sessionContractRevision,
    state: "preparing",
    requestedAt: input.requestedAt,
    providerOperationKey: null,
    deploymentRef: null,
    observedAt: null,
    failureCode: null,
  });
}

export function requestPromotion(
  attempt: ActivationAttempt,
  providerOperationKey: string,
): ActivationAttempt {
  activation(attempt);
  identifier(providerOperationKey, "SITE_PROVIDER_OPERATION_KEY_INVALID");
  if (attempt.state !== "preparing") throw new Error("SITE_ACTIVATION_TRANSITION_INVALID");
  return Object.freeze({ ...attempt, state: "promote_requested", providerOperationKey });
}

export function observePromotion(
  attempt: ActivationAttempt,
  observation: Readonly<{
    providerOperationKey: string;
    deploymentRef: string;
    releaseRef: string;
    webArtifactDigest: string;
    observedAt: string;
    healthy: boolean;
    trafficReady: boolean;
  }>,
): ActivationAttempt {
  activation(attempt);
  identifier(observation.deploymentRef, "SITE_DEPLOYMENT_REF_INVALID");
  instant(observation.observedAt, "SITE_DEPLOYMENT_OBSERVED_AT_INVALID");
  if (!["promote_requested", "observing", "unknown", "failed"].includes(attempt.state)) {
    throw new Error("SITE_ACTIVATION_TRANSITION_INVALID");
  }
  if (
    attempt.providerOperationKey !== observation.providerOperationKey ||
    attempt.candidateReleaseRef !== observation.releaseRef ||
    attempt.candidateWebArtifactDigest !== observation.webArtifactDigest
  ) throw new Error("SITE_DEPLOYMENT_OBSERVATION_MISMATCH");
  if (attempt.deploymentRef !== null && attempt.deploymentRef !== observation.deploymentRef) {
    throw new Error("SITE_DEPLOYMENT_REF_CONFLICT");
  }
  if (!observation.healthy || !observation.trafficReady) {
    return Object.freeze({ ...attempt, state: "observing", deploymentRef: observation.deploymentRef,
      observedAt: observation.observedAt, failureCode: null });
  }
  return Object.freeze({ ...attempt, state: "pointer_committing",
    deploymentRef: observation.deploymentRef, observedAt: observation.observedAt, failureCode: null });
}

export function recordActivationEffectFailure(
  attempt: ActivationAttempt,
  outcome: "failed" | "unknown",
  failureCode: string,
): ActivationAttempt {
  activation(attempt);
  identifier(failureCode, "SITE_ACTIVATION_FAILURE_CODE_INVALID");
  if (!["promote_requested", "observing", "unknown", "failed"].includes(attempt.state)) {
    throw new Error("SITE_ACTIVATION_TRANSITION_INVALID");
  }
  return Object.freeze({ ...attempt, state: outcome, failureCode });
}

export function deploymentBindingForObservation(
  attempt: ActivationAttempt,
  observation: SiteDeploymentObservation,
): SiteDeploymentBinding {
  activation(attempt);
  deploymentObservation(observation);
  if (
    observation.attemptRef !== attempt.attemptRef ||
    observation.providerOperationKey !== attempt.providerOperationKey ||
    observation.releaseRef !== attempt.candidateReleaseRef ||
    observation.webArtifactDigest !== attempt.candidateWebArtifactDigest ||
    (attempt.deploymentRef !== null && attempt.deploymentRef !== observation.deploymentRef)
  ) throw new Error("SITE_DEPLOYMENT_OBSERVATION_MISMATCH");
  return Object.freeze({
    deploymentRef: observation.deploymentRef,
    bindingRef: attempt.siteProjectBindingRef,
    siteRef: attempt.siteRef,
    releaseRef: attempt.candidateReleaseRef,
    environment: attempt.environment,
    region: attempt.region,
    audience: attempt.audience,
    sessionContractRevision: attempt.sessionContractRevision,
    webArtifactDigest: attempt.candidateWebArtifactDigest,
    bindingEpoch: attempt.runtimeBindingEpoch,
    state: "candidate",
  });
}

export function activateObservedRelease(input: Readonly<{
  site: SiteAggregate;
  candidate: SiteRelease;
  attempt: ActivationAttempt;
  currentActiveReleaseRef: string | null;
  committedAt: string;
}>): Readonly<{
  site: SiteAggregate;
  candidate: SiteRelease;
  attempt: ActivationAttempt;
  drainingReleaseRef: string | null;
}> {
  site(input.site);
  release(input.candidate);
  activation(input.attempt);
  instant(input.committedAt, "SITE_ACTIVATION_TIME_INVALID");
  if (input.attempt.state !== "pointer_committing" || input.attempt.deploymentRef === null ||
      input.attempt.observedAt === null) throw new Error("SITE_ACTIVATION_NOT_OBSERVED");
  if (input.site.siteRef !== input.attempt.siteRef || input.candidate.siteRef !== input.site.siteRef ||
      input.candidate.releaseRef !== input.attempt.candidateReleaseRef ||
      input.candidate.webArtifactDigest !== input.attempt.candidateWebArtifactDigest ||
      input.candidate.releaseManifestDigest !== input.attempt.candidateManifestDigest ||
      input.candidate.certificationDigest !== input.attempt.candidateCertificationDigest) {
    throw new Error("SITE_ACTIVATION_CANDIDATE_MISMATCH");
  }
  if (input.currentActiveReleaseRef !== input.attempt.expectedActiveReleaseRef ||
      input.site.activeReleaseRef !== input.attempt.expectedActiveReleaseRef) {
    throw new Error("SITE_ACTIVE_POINTER_CONFLICT");
  }
  if (input.attempt.runtimeBindingEpoch !== input.site.runtimeBindingEpoch) {
    throw new Error("SITE_RUNTIME_BINDING_EPOCH_STALE");
  }
  const drainingReleaseRef = input.site.activeReleaseRef;
  return Object.freeze({
    site: Object.freeze({ ...input.site, state: "active", activeReleaseRef: input.candidate.releaseRef,
      policyEpoch: increment(input.site.policyEpoch) }),
    candidate: Object.freeze({ ...input.candidate, state: "active" }),
    attempt: Object.freeze({ ...input.attempt, state: drainingReleaseRef === null ? "succeeded" : "draining" }),
    drainingReleaseRef,
  });
}

export function completeActivationDrain(
  attempt: ActivationAttempt,
  observation: SiteDeploymentObservation,
): ActivationAttempt {
  activation(attempt);
  deploymentObservation(observation);
  if (attempt.state !== "draining" || attempt.expectedActiveReleaseRef === null) {
    throw new Error("SITE_ACTIVATION_DRAIN_STATE_INVALID");
  }
  if (
    observation.attemptRef !== attempt.attemptRef ||
    observation.releaseRef !== attempt.expectedActiveReleaseRef ||
    observation.trafficReady || observation.healthy
  ) throw new Error("SITE_DRAIN_OBSERVATION_MISMATCH");
  return Object.freeze({ ...attempt, state: "succeeded" });
}

export function suspendSite(value: SiteAggregate): SiteAggregate {
  site(value);
  if (value.state !== "active") throw new Error("SITE_SUSPEND_STATE_INVALID");
  return Object.freeze({ ...value, state: "suspended", securityEpoch: increment(value.securityEpoch),
    revocationEpoch: increment(value.revocationEpoch) });
}

/** Resume only returns the Site to a non-serving state; a fresh ActivationAttempt is mandatory. */
export function resumeSite(value: SiteAggregate): SiteAggregate {
  site(value);
  if (value.state === "decommissioned") throw new Error("SITE_DECOMMISSIONED");
  if (value.state !== "suspended") throw new Error("SITE_RESUME_STATE_INVALID");
  return Object.freeze({ ...value, state: "preview_ready", activeReleaseRef: null,
    policyEpoch: increment(value.policyEpoch) });
}

export function beginDecommission(value: SiteAggregate): SiteAggregate {
  site(value);
  if (value.state !== "active" && value.state !== "suspended" && value.state !== "preview_ready") {
    throw new Error(value.state === "decommissioned" ? "SITE_DECOMMISSIONED" : "SITE_DECOMMISSION_STATE_INVALID");
  }
  return Object.freeze({ ...value, state: "decommissioning", activeReleaseRef: null,
    securityEpoch: increment(value.securityEpoch), revocationEpoch: increment(value.revocationEpoch) });
}

function site(value: SiteAggregate): void {
  identifier(value.siteRef, "SITE_REF_INVALID");
  epoch(value.securityEpoch);
  epoch(value.policyEpoch);
  epoch(value.revocationEpoch);
  epoch(value.runtimeBindingEpoch);
  if (value.state === "active" && value.activeReleaseRef === null) throw new Error("SITE_ACTIVE_RELEASE_REQUIRED");
  if (value.activeReleaseRef !== null) identifier(value.activeReleaseRef, "SITE_RELEASE_REF_INVALID");
}

function release(value: SiteRelease): void {
  identifier(value.releaseRef, "SITE_RELEASE_REF_INVALID");
  identifier(value.siteRef, "SITE_REF_INVALID");
  digest(value.webArtifactDigest);
  digest(value.releaseManifestDigest);
  digest(value.certificationDigest);
}

function activation(value: ActivationAttempt): void {
  identifier(value.attemptRef, "SITE_ACTIVATION_REF_INVALID");
  identifier(value.siteRef, "SITE_REF_INVALID");
  identifier(value.candidateReleaseRef, "SITE_RELEASE_REF_INVALID");
  if (value.expectedActiveReleaseRef !== null) identifier(value.expectedActiveReleaseRef, "SITE_RELEASE_REF_INVALID");
  digest(value.candidateWebArtifactDigest);
  digest(value.candidateManifestDigest);
  digest(value.candidateCertificationDigest);
  identifier(value.siteProjectBindingRef, "SITE_PROJECT_BINDING_REF_INVALID");
  epoch(value.siteProjectBindingEpoch);
  epoch(value.runtimeBindingEpoch);
  bounded(value.region, "SITE_REGION_INVALID");
  bounded(value.audience, "SITE_AUDIENCE_INVALID");
  bounded(value.sessionContractRevision, "SITE_SESSION_CONTRACT_REVISION_INVALID");
  instant(value.requestedAt, "SITE_ACTIVATION_TIME_INVALID");
  if (value.environment !== "development" && value.environment !== "preview" && value.environment !== "production") {
    throw new Error("SITE_ENVIRONMENT_INVALID");
  }
  if (value.providerOperationKey !== null) identifier(value.providerOperationKey, "SITE_PROVIDER_OPERATION_KEY_INVALID");
  if (value.deploymentRef !== null) identifier(value.deploymentRef, "SITE_DEPLOYMENT_REF_INVALID");
  if (value.observedAt !== null) instant(value.observedAt, "SITE_DEPLOYMENT_OBSERVED_AT_INVALID");
  if (value.failureCode !== null) identifier(value.failureCode, "SITE_ACTIVATION_FAILURE_CODE_INVALID");
  if (value.state === "preparing" && (value.providerOperationKey !== null || value.deploymentRef !== null || value.observedAt !== null)) {
    throw new Error("SITE_ACTIVATION_STATE_INVALID");
  }
  if (value.state !== "preparing" && value.providerOperationKey === null) throw new Error("SITE_ACTIVATION_STATE_INVALID");
  if (["pointer_committing", "draining", "succeeded"].includes(value.state) &&
      (value.deploymentRef === null || value.observedAt === null)) throw new Error("SITE_ACTIVATION_STATE_INVALID");
  if ((value.deploymentRef === null) !== (value.observedAt === null)) throw new Error("SITE_ACTIVATION_STATE_INVALID");
}

function deploymentObservation(value: SiteDeploymentObservation): void {
  identifier(value.attemptRef, "SITE_ACTIVATION_REF_INVALID");
  identifier(value.providerOperationKey, "SITE_PROVIDER_OPERATION_KEY_INVALID");
  identifier(value.deploymentRef, "SITE_DEPLOYMENT_REF_INVALID");
  identifier(value.releaseRef, "SITE_RELEASE_REF_INVALID");
  digest(value.webArtifactDigest);
  digest(value.payloadDigest);
  instant(value.observedAt, "SITE_DEPLOYMENT_OBSERVED_AT_INVALID");
  if (!/^[0-9a-f-]{36}$/u.test(value.observationRef)) throw new Error("SITE_OBSERVATION_REF_INVALID");
}

function identifier(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value)) throw new Error(code);
}

function bounded(value: string, code: string): void {
  if (value.length < 1 || value.length > 255 || Array.from(value).some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  })) throw new Error(code);
}

function digest(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("SITE_RELEASE_DIGEST_INVALID");
}

function instant(value: string, code: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(code);
}

function epoch(value: bigint): void {
  if (value < 1n) throw new Error("SITE_EPOCH_INVALID");
}

function increment(value: bigint): bigint {
  if (value >= 9_223_372_036_854_775_807n) throw new Error("SITE_EPOCH_EXHAUSTED");
  return value + 1n;
}

function nextEpoch(value: bigint): bigint {
  return increment(value);
}
