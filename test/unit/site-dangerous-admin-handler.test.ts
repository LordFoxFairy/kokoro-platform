import { describe, expect, it } from "vitest";
import { SiteDangerousAdminHandler } from "../../src/modules/site/application/site-dangerous-admin-handler.js";
import { siteActivationEffectDigest } from "../../src/modules/site/application/contracts/site-effect-approval.js";
import { SiteEffectApprovalService } from "../../src/modules/site/application/services/site-effect-approval-service.js";
import type { SiteEffectApprovalAdministration } from "../../src/modules/site/application/contracts/site-effect-approval.js";
import { verifyRequestSecurityContext } from "../../src/shared/security-context/request-security-context.js";
import type { VerifiedRequestSecurityContext } from "../../src/shared/security-context/index.js";
import { issuePlatformTransaction, revokePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import { PlatformUnitOfWork } from "../../src/shared/unit-of-work/unit-of-work.js";

describe("Site dangerous-effect administration", () => {
  it("approves the exact activation effect before invoking the local owner service", async () => {
    const calls: Array<{ name: string; value: unknown }> = [];
    const handler = new SiteDangerousAdminHandler({
      request: async () => ({ approvalRef: "approval_01", state: "pending" }),
      approve: async (input) => {
        calls.push({ name: "approve", value: input });
        return { approvalRef: input.approvalRef, state: "approved" };
      },
    }, {
      beginActivation: async (input) => {
        calls.push({ name: "activate", value: input });
        return { attemptRef: input.attemptRef, state: "preparing", replayed: false };
      },
    }, {
      requestTrafficStop: async () => { throw new Error("unexpected"); },
    });
    const input = {
      commandId: "01983f57-8cf1-7000-8000-000000000001",
      idempotencyKey: "activation-command-01",
      attemptRef: "activation_02",
      approvalRef: "approval_01",
      siteRef: "site_01",
      candidateReleaseRef: "release_02",
      expectedActiveReleaseRef: "release_01",
      activationFactsDigest: `sha256:${"f".repeat(64)}`,
      audience: "site-product",
      sessionContractRevision: "browser-v3",
      reason: "launch approved",
    } as const;

    await expect(handler.approveAndActivate(input, {} as VerifiedRequestSecurityContext))
      .resolves.toEqual({ attemptRef: "activation_02", state: "preparing", replayed: false });
    expect(calls.map(({ name }) => name)).toEqual(["approve", "activate"]);
    expect(calls[0]?.value).toEqual({
      approvalRef: "approval_01",
      siteRef: "site_01",
      operation: "site.activation.begin",
      effectDigest: siteActivationEffectDigest(input),
    });
  });

  it("binds maker and checker to separate verified local transactions", async () => {
    const calls: Array<{ name: string; actor: string; operation: string }> = [];
    const authority: SiteEffectApprovalAdministration = {
      request: async (_transaction, input) => {
        calls.push({ name: "request", actor: input.makerSubjectRef, operation: input.operation });
        return { approvalRef: input.approvalRef, state: "pending", recordedAt: input.requestedAt,
          expiresAt: input.expiresAt };
      },
      approve: async (_transaction, input) => {
        calls.push({ name: "approve", actor: input.checkerSubjectRef, operation: input.operation });
      },
      consume: async () => undefined,
    };
    const unitOfWork = new PlatformUnitOfWork({
      async transaction(fence, work) {
        calls.push({ name: "transaction", actor: fence.context.actor.subjectId,
          operation: fence.operation });
        const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 1 });
        try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); }
      },
    }, () => "2026-07-30T10:00:30.000Z");
    const service = new SiteEffectApprovalService(unitOfWork, authority, {
      now: () => "2026-07-30T10:00:30.000Z",
    });
    const identity = {
      approvalRef: "approval_01", siteRef: "site_01", operation: "site.activation.begin",
      effectDigest: "a".repeat(64), reason: "launch approved",
      commandId: "01983f57-8cf1-7000-8000-000000000001",
      idempotencyKey: "activation-approval-01", requestDigest: "b".repeat(64),
    } as const;

    await service.request(identity, await context("operator_maker", ["site.approval.request"]));
    await service.approve(identity, await context("operator_checker", ["site.approval.approve"]));

    expect(calls).toEqual([
      { name: "transaction", actor: "operator_maker", operation: "site.approval.request" },
      { name: "request", actor: "operator_maker", operation: "site.activation.begin" },
      { name: "transaction", actor: "operator_checker", operation: "site.approval.approve" },
      { name: "approve", actor: "operator_checker", operation: "site.activation.begin" },
    ]);
  });
});

async function context(subjectId: string, allowedOperations: readonly string[]) {
  const issuer = "spiffe://kokoro.test";
  const operation = allowedOperations[0]!;
  return verifyRequestSecurityContext({
    requestId: `request-${subjectId}`, correlationId: "correlation-01",
    trustedCaller: { kind: "admin_workload", workloadIdentityId: "admin-01",
      environment: "production", region: "us-east-1", audience: "platform-admin",
      allowedOperations, bindingEpoch: "1", issuedAt: "2026-07-30T10:00:00.000Z",
      expiresAt: "2026-07-30T10:10:00.000Z" },
    actor: { kind: "operator", subjectId, subjectGeneration: "1" }, delegatedGrant: null,
    target: { siteId: "site_01", workspaceId: null, projectId: null, purpose: operation,
      scopes: allowedOperations }, audience: "platform-admin", environment: "production",
    region: "us-east-1", evidence: [{ kind: "workload_attestation", evidenceId: "attestation-01",
      issuer }], policyEpoch: "1", issuedAt: "2026-07-30T10:00:00.000Z",
    expiresAt: "2026-07-30T10:10:00.000Z",
  }, { now: "2026-07-30T10:00:30.000Z", operation, expectedAudience: "platform-admin",
    expectedEnvironment: "production", expectedRegion: "us-east-1", callerVerifier: { verify: async () => ({
      workloadIdentityId: "admin-01", kind: "admin_workload", audience: "platform-admin",
      environment: "production", region: "us-east-1", allowedOperations, siteId: null,
      bindingEpoch: "1", issuedAt: "2026-07-30T10:00:00.000Z",
      expiresAt: "2026-07-30T10:10:00.000Z", issuer, keyVersion: "test-1",
    }) } });
}
