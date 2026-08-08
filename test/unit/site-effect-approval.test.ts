import { describe, expect, it } from "vitest";
import { PostgresSiteEffectApprovalAuthority } from "../../src/modules/site/infrastructure/postgres/site-effect-approval-authority.js";
import { issuePlatformTransaction, revokePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";

describe("PostgresSiteEffectApprovalAuthority", () => {
  it("returns the persisted approval expiry on an exact request replay", async () => {
    const lease = issuePlatformTransaction({
      execute: async () => 0,
      query: async <Row extends Record<string, unknown>>() => ([{
        exact: true, state: "pending", recordedAt: new Date("2026-07-30T10:00:00.000Z"),
        expiresAt: new Date("2026-07-30T10:10:00.000Z"),
      }] as unknown as readonly Row[]),
    });
    try {
      await expect(new PostgresSiteEffectApprovalAuthority().request(lease.transaction, {
        approvalRef: "10000000-0000-4000-8000-000000000001", siteRef: "site_01",
        environment: "production", region: "us-east-1", operation: "site.activation.begin",
        effectDigest: "a".repeat(64), reason: "launch approved", makerSubjectRef: "operator_maker",
        commandId: "01983f57-8cf1-7000-8000-000000000001",
        idempotencyKey: "activation-approval-01", requestDigest: "b".repeat(64),
        requestedAt: "2026-07-30T10:03:00.000Z", expiresAt: "2026-07-30T10:13:00.000Z",
      })).resolves.toEqual({ approvalRef: "10000000-0000-4000-8000-000000000001", state: "pending",
        recordedAt: "2026-07-30T10:00:00.000Z",
        expiresAt: "2026-07-30T10:10:00.000Z" });
    } finally { revokePlatformTransaction(lease); }
  });

  it("requires a distinct approved checker and consumes the exact effect once", async () => {
    const calls: { statement: string; values: readonly unknown[] }[] = [];
    const lease = issuePlatformTransaction({ query: async () => [], execute: async (statement, values = []) => {
      calls.push({ statement, values }); return 1;
    } });
    const authority = new PostgresSiteEffectApprovalAuthority();
    try {
      await authority.request(lease.transaction, {
        approvalRef: "10000000-0000-4000-8000-000000000001", siteRef: "site_01",
        environment: "production", region: "us-east-1", operation: "site.activation.begin",
        effectDigest: "a".repeat(64), reason: "launch approved", makerSubjectRef: "operator_maker",
        commandId: "01983f57-8cf1-7000-8000-000000000001",
        idempotencyKey: "activation-approval-01", requestDigest: "b".repeat(64),
        requestedAt: "2026-07-30T10:00:00.000Z", expiresAt: "2026-07-30T10:10:00.000Z",
      });
      await authority.approve(lease.transaction, {
        approvalRef: "10000000-0000-4000-8000-000000000001", siteRef: "site_01",
        environment: "production", region: "us-east-1", operation: "site.activation.begin",
        effectDigest: "a".repeat(64), checkerSubjectRef: "operator_checker",
        decidedAt: "2026-07-30T10:01:00.000Z",
      });
      await authority.consume(lease.transaction, {
        approvalRef: "10000000-0000-4000-8000-000000000001", siteRef: "site_01",
        environment: "production", region: "us-east-1", operation: "site.activation.begin",
        effectDigest: "a".repeat(64),
      }, { actor: { kind: "operator", subjectId: "operator_checker" }, environment: "production",
        region: "us-east-1", requestId: "request-consume" } as never);
      const sql = calls.map(({ statement }) => statement).join("\n");
      expect(sql).toContain("maker_subject_ref<>$8");
      expect(sql).toContain("checker_subject_ref=$8");
      expect(sql).toContain("environment=$3 AND region=$4");
      expect(sql).toContain("state='consumed'");
      expect(sql).toContain("expires_at>now()");
    } finally { revokePlatformTransaction(lease); }
  });

  it("fails closed when approval CAS does not change exactly one row", async () => {
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
    try {
      await expect(new PostgresSiteEffectApprovalAuthority().approve(lease.transaction, {
        approvalRef: "10000000-0000-4000-8000-000000000001", siteRef: "site_01",
        environment: "production", region: "us-east-1", operation: "site.traffic-stop.suspend",
        effectDigest: "a".repeat(64), checkerSubjectRef: "operator_checker",
        decidedAt: "2026-07-30T10:01:00.000Z",
      })).rejects.toThrow("SITE_EFFECT_APPROVAL_DECISION_CONFLICT");
    } finally { revokePlatformTransaction(lease); }
  });
});
