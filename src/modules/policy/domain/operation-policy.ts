import { assertVerifiedRequestSecurityContext, type VerifiedRequestSecurityContext, type WorkloadKind, type ActorKind } from "../../../shared/security-context/index.js";
import { isVerifiedRiskDecisionSnapshot, type VerifiedRiskDecisionSnapshot } from "./verified-risk-decision.js";

export type RestrictionCheck = "site_active" | "subject_active" | "session_current" | "policy_current";
export interface CallerOperationPolicy {
  readonly operation: string; readonly allowedWorkloadKinds: readonly WorkloadKind[]; readonly requiredAudience: string;
  readonly allowedActorKinds: readonly ActorKind[]; readonly requiredOperations: readonly string[];
  readonly scopeRule: "same_site" | "same_workspace" | "explicit_global" | "explicit_breakglass";
  readonly requiredAssurance: "anonymous" | "password" | "mfa" | "phishing_resistant";
  readonly maxStepUpAgeSeconds: number | null; readonly managedDeviceRequired: boolean;
  readonly allowedEnvironments: readonly string[]; readonly allowedRegions: readonly string[];
  readonly riskClass: "normal" | "sensitive" | "irreversible"; readonly restrictionChecks: readonly RestrictionCheck[];
  readonly effectPoint: string;
}
export interface EffectAuthorizationFacts {
  readonly now: string; readonly resourceSiteId: string | null; readonly resourceWorkspaceId: string | null; readonly resourceProjectId: string | null;
  readonly resourceDigest: string; readonly requestDigest: string; readonly currentGrantEpoch: string; readonly currentRiskEpoch: string;
  readonly siteStatus: "active" | "suspended" | "decommissioning"; readonly subjectStatus: "active" | "disabled";
  readonly sessionStatus: "active" | "revoked" | "absent"; readonly currentSubjectGeneration: string;
  readonly currentSessionEpoch: string; readonly currentBindingEpoch: string; readonly currentPolicyEpoch: string;
  readonly currentRestrictionEpoch: string; readonly restrictions: readonly string[];
}
export type OperationPolicyDecision = { readonly allowed: true } | { readonly allowed: false; readonly code: string };

export function evaluateOperationPolicy(policy: CallerOperationPolicy | undefined, context: VerifiedRequestSecurityContext, facts: EffectAuthorizationFacts, risk: VerifiedRiskDecisionSnapshot | null): OperationPolicyDecision {
  try { assertVerifiedRequestSecurityContext(context, facts.now); } catch { return deny("REQUEST_SECURITY_CONTEXT_NOT_VERIFIED"); }
  if (!policy) return deny("OPERATION_POLICY_MISSING");
  const now = Date.parse(facts.now);
  if (!Number.isFinite(now) || now < Date.parse(context.issuedAt) || now >= Date.parse(context.expiresAt)) return deny("SECURITY_CONTEXT_EXPIRED");
  if (policy.operation.length === 0 || !policy.allowedWorkloadKinds.includes(context.trustedCaller.kind) || !policy.allowedActorKinds.includes(context.actor.kind)) return deny("CALLER_NOT_ALLOWED");
  if (context.audience !== policy.requiredAudience || context.trustedCaller.audience !== policy.requiredAudience) return deny("AUDIENCE_MISMATCH");
  if (!policy.allowedEnvironments.includes(context.environment) || !policy.allowedRegions.includes(context.region)) return deny("DEPLOYMENT_AXIS_MISMATCH");
  if (!context.trustedCaller.allowedOperations.includes(policy.operation) || !policy.requiredOperations.every((operation) => context.trustedCaller.allowedOperations.includes(operation))) return deny("WORKLOAD_OPERATION_DENIED");
  if (context.trustedCaller.bindingEpoch !== facts.currentBindingEpoch || context.policyEpoch !== facts.currentPolicyEpoch) return deny("SECURITY_EPOCH_STALE");
  if (context.actor.subjectGeneration !== facts.currentSubjectGeneration || (context.actor.sessionEpoch ?? "0") !== facts.currentSessionEpoch || (context.actor.restrictionEpoch ?? "0") !== facts.currentRestrictionEpoch) return deny("SUBJECT_EPOCH_STALE");
  if (policy.scopeRule === "same_site" && (context.target.siteId === null || context.target.siteId !== facts.resourceSiteId)) return deny("SITE_SCOPE_MISMATCH");
  if (policy.scopeRule === "same_workspace" && (context.target.workspaceId === null || context.target.workspaceId !== facts.resourceWorkspaceId)) return deny("WORKSPACE_SCOPE_MISMATCH");
  if (context.target.workspaceId !== null && context.target.workspaceId !== facts.resourceWorkspaceId) return deny("WORKSPACE_SCOPE_MISMATCH");
  if (context.target.projectId !== null && context.target.projectId !== facts.resourceProjectId) return deny("PROJECT_SCOPE_MISMATCH");
  if (facts.siteStatus !== "active" || facts.subjectStatus !== "active" || (context.actor.kind !== "anonymous" && facts.sessionStatus !== "active")) return deny("RESOURCE_RESTRICTED");
  if (facts.restrictions.length > 0) return deny("ACTIVE_RESTRICTION");
  if (!assuranceSatisfies(context.actor.assuranceLevel, policy.requiredAssurance)) return deny("ASSURANCE_INSUFFICIENT");
  if (policy.managedDeviceRequired && !context.actor.managedDeviceRef) return deny("MANAGED_DEVICE_REQUIRED");
  if (policy.maxStepUpAgeSeconds !== null && (!context.actor.stepUpAt || now - Date.parse(context.actor.stepUpAt) > policy.maxStepUpAgeSeconds * 1_000)) return deny("STEP_UP_REQUIRED");
  if (context.delegatedGrant) {
    const grant = context.delegatedGrant;
    if (now >= Date.parse(grant.expiresAt) || grant.subjectId !== context.actor.subjectId || grant.subjectGeneration !== facts.currentSubjectGeneration || grant.operation !== policy.operation || grant.audience !== context.audience || grant.resourceDigest !== facts.resourceDigest || grant.epoch !== facts.currentGrantEpoch) return deny("DELEGATED_GRANT_INVALID");
  }
  if (policy.riskClass !== "normal") {
    if (!risk || !isVerifiedRiskDecisionSnapshot(risk)) return deny("RISK_SNAPSHOT_NOT_VERIFIED");
    if (risk.decision !== "allow") return deny("RISK_ALLOW_REQUIRED");
    if (risk.operation !== policy.operation || risk.environment !== context.environment || risk.region !== context.region || risk.siteId !== facts.resourceSiteId || risk.subjectId !== context.actor.subjectId || risk.subjectGeneration !== facts.currentSubjectGeneration || risk.resourceDigest !== facts.resourceDigest || risk.requestDigest !== facts.requestDigest || risk.riskEpoch !== facts.currentRiskEpoch || now < Date.parse(risk.issuedAt) || now >= Date.parse(risk.expiresAt) || risk.signature.length === 0 || risk.signatureKeyVersion.length === 0) return deny("RISK_SNAPSHOT_INVALID");
  }
  return Object.freeze({ allowed: true });
}
function deny(code: string): OperationPolicyDecision { return Object.freeze({ allowed: false, code }); }
function assuranceSatisfies(actual: string | undefined, required: CallerOperationPolicy["requiredAssurance"]): boolean { const levels = { anonymous: 0, password: 1, mfa: 2, phishing_resistant: 3 } as const; return (levels[actual as keyof typeof levels] ?? 0) >= levels[required]; }
