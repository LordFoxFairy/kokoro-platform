import { beforeAll, describe, expect, it } from "vitest";
import {
  evaluateOperationPolicy,
  type CallerOperationPolicy,
  type EffectAuthorizationFacts,
} from "../../src/modules/policy/domain/operation-policy.js";
import { verifyRequestSecurityContext, type VerifiedRequestSecurityContext } from "../../src/shared/security-context/request-security-context.js";
import { verifyRiskDecisionSnapshot, type VerifiedRiskDecisionSnapshot } from "../../src/modules/policy/domain/verified-risk-decision.js";

const policy: CallerOperationPolicy = {
  operation: "site.release.activate",
  allowedWorkloadKinds: ["admin_workload"],
  requiredAudience: "platform-admin",
  allowedActorKinds: ["operator"],
  requiredOperations: ["site.release.activate"],
  scopeRule: "same_site",
  requiredAssurance: "phishing_resistant",
  maxStepUpAgeSeconds: 300,
  managedDeviceRequired: true,
  allowedEnvironments: ["production"],
  allowedRegions: ["us-east-1"],
  riskClass: "irreversible",
  restrictionChecks: ["site_active", "subject_active", "session_current", "policy_current"],
  effectPoint: "site.release.pointer.commit",
};

const contextInput = {
  requestId: "req-1",
  correlationId: "corr-1",
  trustedCaller: {
    kind: "admin_workload",
    workloadIdentityId: "workload-1",
    environment: "production",
    region: "us-east-1",
    audience: "platform-admin",
    allowedOperations: ["site.release.activate"],
    bindingEpoch: "4",
    issuedAt: "2026-07-28T12:00:00.000Z",
    expiresAt: "2026-07-28T12:10:00.000Z",
  },
  actor: {
    kind: "operator",
    subjectId: "operator-1",
    subjectGeneration: "9",
    sessionId: "operator-session-1",
    assuranceLevel: "phishing_resistant",
    factorClasses: ["webauthn"],
    authenticatedAt: "2026-07-28T11:50:00.000Z",
    stepUpAt: "2026-07-28T11:59:00.000Z",
    managedDeviceRef: "device-1",
    environment: "production",
    region: "us-east-1",
    sessionEpoch: "7",
    restrictionEpoch: "5",
  },
  delegatedGrant: null,
  target: {
    siteId: "site-1",
    workspaceId: null,
    projectId: "project-1",
    purpose: "site_release",
    scopes: ["site:write"],
  },
  audience: "platform-admin",
  environment: "production",
  region: "us-east-1",
  evidence: [{ kind: "oidc", evidenceId: "ev-1", issuer: "https://id.example" }],
  policyEpoch: "12",
  issuedAt: "2026-07-28T12:00:00.000Z",
  expiresAt: "2026-07-28T12:05:00.000Z",
};
let context: VerifiedRequestSecurityContext;
let verifiedRisk: VerifiedRiskDecisionSnapshot;

const facts: EffectAuthorizationFacts = {
  now: "2026-07-28T12:01:00.000Z",
  resourceSiteId: "site-1",
  resourceWorkspaceId: null,
  resourceProjectId: "project-1",
  resourceDigest: "c".repeat(64),
  requestDigest: "b".repeat(64),
  currentGrantEpoch: "1",
  currentRiskEpoch: "3",
  siteStatus: "active",
  subjectStatus: "active",
  sessionStatus: "active",
  currentSubjectGeneration: "9",
  currentSessionEpoch: "7",
  currentBindingEpoch: "4",
  currentPolicyEpoch: "12",
  currentRestrictionEpoch: "5",
  restrictions: [],
};

describe("operation policy", () => {
  beforeAll(async () => {
    context = await verifyRequestSecurityContext(contextInput, { now: "2026-07-28T12:00:30.000Z", operation: policy.operation, expectedAudience: "platform-admin", expectedEnvironment: "production", expectedRegion: "us-east-1", callerVerifier: { verify: async () => ({ workloadIdentityId: "workload-1", kind: "admin_workload", audience: "platform-admin", environment: "production", region: "us-east-1", allowedOperations: [policy.operation], siteId: null, bindingEpoch: "4", issuedAt: "2026-07-28T12:00:00.000Z", expiresAt: "2026-07-28T12:10:00.000Z", issuer: "https://id.example", keyVersion: "oidc-4" }) } });
    verifiedRisk = await verifyRiskDecisionSnapshot({
      riskDecisionId: "risk-1", policyRevision: "risk-policy-2", decision: "allow", operation: policy.operation,
      environment: "production", region: "us-east-1", siteId: "site-1", subjectId: "operator-1", subjectGeneration: "9",
      resourceDigest: "c".repeat(64), requestDigest: "b".repeat(64), riskEpoch: "3", issuedAt: "2026-07-28T12:00:30.000Z",
      expiresAt: "2026-07-28T12:02:00.000Z", issuer: "https://risk.example", signatureKeyVersion: "risk-key-4", signature: "signed-risk-evidence",
    }, { now: "2026-07-28T12:01:00.000Z", verifier: { verify: async () => ({ riskDecisionId: "risk-1", issuer: "https://risk.example", signatureKeyVersion: "risk-key-4" }) } });
  });

  it("allows an exact, fresh, risk-approved effect", () => {
    expect(evaluateOperationPolicy(policy, context, facts, verifiedRisk)).toEqual({ allowed: true });
  });

  it("rejects a structurally identical but unverified Risk snapshot", () => {
    expect(evaluateOperationPolicy(policy, context, facts, { ...verifiedRisk } as VerifiedRiskDecisionSnapshot)).toEqual({
      allowed: false,
      code: "RISK_SNAPSHOT_NOT_VERIFIED",
    });
  });

  it.each([
    ["site", { resourceSiteId: "site-2" }],
    ["subject generation", { currentSubjectGeneration: "10" }],
    ["session epoch", { currentSessionEpoch: "8" }],
    ["policy epoch", { currentPolicyEpoch: "13" }],
    ["restriction epoch", { currentRestrictionEpoch: "6" }],
    ["suspension", { siteStatus: "suspended" as const }],
  ])("denies a stale or mismatched %s at the effect point", (_axis, override) => {
    expect(evaluateOperationPolicy(policy, context, { ...facts, ...override }, null)).toMatchObject({
      allowed: false,
    });
  });
});
