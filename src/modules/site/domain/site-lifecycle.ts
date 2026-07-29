export type SiteState =
  | "preview_ready"
  | "active"
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
  readonly state: ActivationState;
  readonly requestedAt: string;
  readonly providerOperationKey: string | null;
  readonly deploymentRef: string | null;
  readonly observedAt: string | null;
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
  requestedAt: string;
}>): ActivationAttempt {
  identifier(input.attemptRef, "SITE_ACTIVATION_REF_INVALID");
  site(input.site);
  release(input.candidate);
  instant(input.requestedAt, "SITE_ACTIVATION_TIME_INVALID");
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
    state: "preparing",
    requestedAt: input.requestedAt,
    providerOperationKey: null,
    deploymentRef: null,
    observedAt: null,
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
  if (attempt.state !== "promote_requested" && attempt.state !== "observing" && attempt.state !== "unknown") {
    throw new Error("SITE_ACTIVATION_TRANSITION_INVALID");
  }
  if (
    attempt.providerOperationKey !== observation.providerOperationKey ||
    attempt.candidateReleaseRef !== observation.releaseRef ||
    attempt.candidateWebArtifactDigest !== observation.webArtifactDigest
  ) throw new Error("SITE_DEPLOYMENT_OBSERVATION_MISMATCH");
  if (!observation.healthy || !observation.trafficReady) {
    return Object.freeze({ ...attempt, state: "observing", deploymentRef: observation.deploymentRef,
      observedAt: observation.observedAt });
  }
  return Object.freeze({ ...attempt, state: "pointer_committing",
    deploymentRef: observation.deploymentRef, observedAt: observation.observedAt });
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
  const drainingReleaseRef = input.site.activeReleaseRef;
  return Object.freeze({
    site: Object.freeze({ ...input.site, state: "active", activeReleaseRef: input.candidate.releaseRef,
      policyEpoch: increment(input.site.policyEpoch) }),
    candidate: Object.freeze({ ...input.candidate, state: "active" }),
    attempt: Object.freeze({ ...input.attempt, state: drainingReleaseRef === null ? "succeeded" : "draining" }),
    drainingReleaseRef,
  });
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
  digest(value.candidateWebArtifactDigest);
  digest(value.candidateManifestDigest);
  digest(value.candidateCertificationDigest);
  instant(value.requestedAt, "SITE_ACTIVATION_TIME_INVALID");
}

function identifier(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value)) throw new Error(code);
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
