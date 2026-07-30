import { describe, expect, it } from "vitest";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";
import type { VerifiedRequestSecurityContext } from
  "../../src/shared/security-context/index.js";
import { AdminPostEffectReviewService } from
  "../../src/modules/admin-control/application/admin-post-effect-review-service.js";

const transaction = Object.freeze({}) as PlatformTransaction;
const now = "2026-07-29T12:00:00.000Z";
const review = Object.freeze({
  reviewRef: "review_0001", commandId: "command_0001", operation: "site.emergency-revoke",
  requiredPermission: "site.lifecycle.emergency-revoke",
  makerRef: "maker_01", makerGeneration: 2n, makerAuthorizationEpoch: 8n,
  siteRef: "site_01", environment: "production", region: "us-east-1",
  state: "pending" as const, revision: 1n, expiresAt: "2026-07-30T11:00:00.000Z",
});
const reviewer = Object.freeze({
  operatorRef: "reviewer_01", operatorGeneration: 4n, state: "active" as const,
  permissions: ["admin.break-glass.review", "site.lifecycle.emergency-revoke"],
  siteScopes: ["site_01"], globalScopes: ["grant_global_01"], environments: ["production"], regions: ["us-east-1"],
  authorizationEpoch: 11n, expiresAt: "2026-07-30T12:00:00.000Z",
  breakGlassExpiresAt: null,
});

describe("Admin post-effect review", () => {
  it("durably acknowledges a break-glass effect with an independent current reviewer", async () => {
    const transitions: unknown[] = [];
    const service = new AdminPostEffectReviewService({
      unitOfWork: { async execute(_fence, work) { return work(transaction); } },
      repository: {
        async lockReview() { return review; },
        async lockOperatorAuthority() { return reviewer; },
        async transitionReview(_current, input) { transitions.push(input); return true; },
      },
      clock: () => new Date(now),
    });
    await expect(service.decide({ context: context(), reviewRef: review.reviewRef,
      decision: "acknowledge", reason: "reviewed incident evidence" })).resolves.toEqual({
        disposition: "acknowledged", reviewRef: review.reviewRef,
      });
    expect(transitions).toMatchObject([{ state: "acknowledged", expectedRevision: 1n,
      reviewerRef: "reviewer_01", reviewerAuthorizationEpoch: 11n }]);
  });

  it("rejects maker self-review", async () => {
    const service = new AdminPostEffectReviewService({
      unitOfWork: { async execute(_fence, work) { return work(transaction); } },
      repository: {
        async lockReview() { return review; },
        async lockOperatorAuthority() { return { ...reviewer, operatorRef: review.makerRef }; },
        async transitionReview() { throw new Error("must not transition"); },
      },
      clock: () => new Date(now),
    });
    await expect(service.decide({ context: context({ subjectId: review.makerRef }),
      reviewRef: review.reviewRef, decision: "acknowledge", reason: "self" }))
      .rejects.toThrow("ADMIN_POST_EFFECT_REVIEW_INDEPENDENCE_REQUIRED");
  });
});

function context(actor: { subjectId: string } = { subjectId: reviewer.operatorRef }): VerifiedRequestSecurityContext {
  return {
    requestId: "request_0001", correlationId: "correlation_0001",
    trustedCaller: { kind: "admin_workload", workloadIdentityId: "admin-web",
      environment: "production", region: "us-east-1", audience: "platform-admin",
      allowedOperations: ["admin.break-glass.review"], bindingEpoch: "1",
      issuedAt: "2026-07-29T11:00:00.000Z", expiresAt: "2026-07-29T13:00:00.000Z" },
    actor: { kind: "operator", subjectId: actor.subjectId, subjectGeneration: "4",
      assuranceLevel: "phishing_resistant", stepUpAt: "2026-07-29T11:59:00.000Z" },
    delegatedGrant: null,
    target: { siteId: "site_01", workspaceId: null, projectId: null,
      purpose: "admin.break-glass.review", scopes: ["admin:break-glass-review"] },
    audience: "platform-admin", environment: "production", region: "us-east-1",
    evidence: [{ kind: "workload_attestation", evidenceId: "evidence_0001", issuer: "spiffe://admin-web" }],
    policyEpoch: "1", issuedAt: "2026-07-29T11:00:00.000Z",
    expiresAt: "2026-07-29T13:00:00.000Z",
  } as unknown as VerifiedRequestSecurityContext;
}
