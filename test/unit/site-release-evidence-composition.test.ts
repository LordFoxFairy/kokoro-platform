import { describe, expect, it, vi } from "vitest";
import { createSiteReleaseEvidenceOwnerUnitOfWork } from
  "../../src/process/site-publication-authority-composition.js";
import { verifyRequestSecurityContext } from
  "../../src/shared/security-context/request-security-context.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

describe("Site release Evidence production transaction host", () => {
  it("maps the workload-owner command to one leased Admission record transaction with exact axes", async () => {
    const events: string[] = [];
    const sql: PlatformSqlTransaction = {
      async query(statement, values = []) {
        events.push(`sql:${statement}:${JSON.stringify(values)}`);
        return [];
      },
      async execute() { return 0; },
    };
    const internalTransaction = vi.fn(async (operation, work) => {
      events.push(`internal:${operation}`);
      const lease = issuePlatformTransaction(sql);
      try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); }
    });
    const forbiddenTransaction = vi.fn();
    const unitOfWork = createSiteReleaseEvidenceOwnerUnitOfWork({
      internalTransaction,
      transaction: forbiddenTransaction,
    } as never, () => NOW);
    const context = await workloadContext();

    await expect(unitOfWork.execute({
      context,
      operation: "site.release-evidence.publish",
    }, async () => { events.push("work"); return "recorded"; })).resolves.toBe("recorded");

    expect(internalTransaction).toHaveBeenCalledTimes(1);
    expect(internalTransaction.mock.calls[0]?.[0]).toBe("site.evidence.record");
    expect(forbiddenTransaction).not.toHaveBeenCalled();
    expect(events[0]).toBe("internal:site.evidence.record");
    expect(events[1]).toContain("set_config('app.site_id',$1,true)");
    expect(events[1]).toContain("set_config('app.workload_identity_ref',$4,true)");
    expect(events[1]).toContain("set_config('app.workload_binding_epoch',$5,true)");
    expect(events[1]).toContain("set_config('app.workload_kind','platform_worker',true)");
    expect(events[1]).toContain(JSON.stringify([
      SITE_REF, "production", "us-east-1", WORKLOAD_REF, "7",
    ]));
    expect(events[2]).toBe("work");
  });

  it("does not map any other domain command into the privileged record operation", async () => {
    const internalTransaction = vi.fn();
    const unitOfWork = createSiteReleaseEvidenceOwnerUnitOfWork({ internalTransaction } as never,
      () => NOW);
    await expect(unitOfWork.execute({
      context: await workloadContext(["site.release-evidence.publish", "site.register"]),
      operation: "site.register",
    }, async () => undefined)).rejects.toThrow("SITE_EVIDENCE_OWNER_OPERATION_INVALID");
    expect(internalTransaction).not.toHaveBeenCalled();
  });
});

const NOW = "2026-08-08T12:00:00.000Z";
const SITE_REF = "site.alpha";
const WORKLOAD_REF = "spiffe://kokoro/site-evidence-attestor";

async function workloadContext(
  operations: readonly string[] = ["site.release-evidence.publish"],
) {
  const input = {
    requestId: "018f1212-1212-7212-8212-121212121212",
    correlationId: "018f1212-1212-7212-8212-121212121212",
    trustedCaller: {
      kind: "platform_worker",
      workloadIdentityId: WORKLOAD_REF,
      siteId: SITE_REF,
      environment: "production",
      region: "us-east-1",
      audience: "kokoro.site-release-evidence-admission.v1",
      allowedOperations: operations,
      bindingEpoch: "7",
      issuedAt: "2026-08-08T11:59:55.000Z",
      expiresAt: "2026-08-08T12:00:05.000Z",
    },
    actor: { kind: "workload", subjectId: WORKLOAD_REF, subjectGeneration: "7",
      environment: "production", region: "us-east-1" },
    delegatedGrant: null,
    target: { siteId: SITE_REF, workspaceId: null, projectId: null,
      purpose: "site.release-evidence.publish", scopes: ["site.release-evidence.publish"] },
    audience: "kokoro.site-release-evidence-admission.v1",
    environment: "production", region: "us-east-1",
    evidence: [{ kind: "workload-attestation", evidenceId: "attestation.alpha",
      issuer: "kokoro:site-evidence-mtls-peer-registry" }],
    policyEpoch: "7", issuedAt: "2026-08-08T11:59:55.000Z",
    expiresAt: "2026-08-08T12:00:05.000Z",
  } as const;
  return verifyRequestSecurityContext(input, {
    now: NOW,
    operation: "site.release-evidence.publish",
    expectedAudience: input.audience,
    expectedEnvironment: input.environment,
    expectedRegion: input.region,
    callerVerifier: { verify: async () => ({
      workloadIdentityId: WORKLOAD_REF, kind: "platform_worker" as const,
      audience: input.audience, environment: input.environment, region: input.region,
      allowedOperations: operations, siteId: SITE_REF, bindingEpoch: "7",
      issuedAt: input.issuedAt, expiresAt: input.expiresAt,
      issuer: "kokoro:site-evidence-mtls-peer-registry", keyVersion: "7",
    }) },
  });
}
