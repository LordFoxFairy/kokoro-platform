import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  PostgresAdmissionAssetOwner,
  PostgresAdmissionBudgetOwner,
} from "../../src/modules/admission/infrastructure/postgres/admission-credit-asset-owners.js";
import type { RunBudgetAuthority } from "../../src/modules/credit/application/contracts/run-budget-authority.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

const profile = {
  schemaVersion: 1,
  siteId: "site-a",
  siteReleaseRef: "release-a",
  backend: "state",
  permissions: { approval_tools: [], review_tools: [], subagent_create: "deny", filesystem: "read_only" },
  billing: {
    unit: "credit_micros", liabilityMerchantAccountRef: "merchant-a",
    ratingPolicyRevisionRef: "rating-a", rootCeiling: "100000", segmentMaximum: "75000",
    surfaceRef: "chat", capabilityKey: "chat.general",
  },
} as const;

class OwnerSql implements PlatformSqlTransaction {
  readonly calls: Array<Readonly<{ statement: string; values: readonly unknown[] }>> = [];
  async query<Row extends Record<string, unknown>>(
    statement: string,
    values: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.calls.push({ statement, values });
    if (statement.includes("admission_launch_profile_snapshot")) return [{
      launchProfileRef: `launch-profile:sha256:${digest(profile)}`,
      snapshotDigest: digest(profile), payload: profile,
    }] as unknown as Row[];
    if (statement.includes("identity_personal_bootstrap")) return [{
      billingAccountId: "billing-a", creditAccountId: "credit-a",
    }] as unknown as Row[];
    if (statement.includes("asset_eligibility_projection")) return [{
      assetRef: "asset-a", assetVersionRef: "asset-version-a", assetGrantRef: "grant-a",
    }] as unknown as Row[];
    if (statement.includes("credit_attempt_usage_evidence")) return [{
      evidenceRef: "11111111-1111-4111-8111-111111111111",
    }] as unknown as Row[];
    if (statement.includes("credit_usage_segment_closure")) return [];
    if (statement.includes("credit_usage_settlement")) return [{
      settlementRef: "22222222-2222-4222-8222-222222222222",
      closureRef: "33333333-3333-4333-8333-333333333333",
      ratedAmount: "125", unit: "credit_micros",
      ratingSnapshotRef: "44444444-4444-4444-8444-444444444444",
    }] as unknown as Row[];
    if (statement.includes("set_config('app.subject_id'")) return [];
    if (statement.includes("credit_authorization_segment")) return [{ matched: true }] as unknown as Row[];
    throw new Error(`unexpected query: ${statement}`);
  }
  async execute(): Promise<number> { throw new Error("not used"); }
}

function fakeCredit(): RunBudgetAuthority {
  return {
    reserveRootBudget: vi.fn(async () => ({
      kind: "accepted" as const,
      value: {
        executionBudgetRootRef: "budget-a", creditHoldRef: "hold-a",
        authorizationSegmentRef: "segment-a", segmentVersion: 1n,
        state: "reserved" as const, expiresAt: "2026-07-29T12:05:00.000Z",
      },
    })),
    finalizeAuthorizationSegment: vi.fn(async () => ({
      kind: "accepted" as const,
      value: { authorizationSegmentRef: "segment-a", segmentVersion: 2n,
        state: "committed" as const, observedAt: "2026-07-29T12:01:00.000Z" },
    })),
    releaseAuthorizationSegment: vi.fn(async () => ({
      kind: "accepted" as const,
      value: { authorizationSegmentRef: "segment-a", segmentVersion: 2n,
        state: "released" as const, observedAt: "2026-07-29T12:01:00.000Z" },
    })),
    reconcileAuthorizationSegment: vi.fn(async () => ({
      kind: "reconciliation_required" as const,
      value: { authorizationSegmentRef: "segment-a", segmentVersion: 2n,
        state: "reconciliation_required" as const, observedAt: "2026-07-29T12:01:00.000Z" },
    })),
    deriveChildAllocation: vi.fn(async () => ({ kind: "not_found" as const })),
    returnChildAllocation: vi.fn(async () => ({ kind: "not_found" as const })),
  };
}

describe("native Admission Credit and Asset owners", () => {
  it("maps the exact SiteRelease billing policy into RunBudgetAuthority", async () => {
    const sql = new OwnerSql();
    const lease = issuePlatformTransaction(sql);
    const credit = fakeCredit();
    try {
      const owner = new PostgresAdmissionBudgetOwner(credit);
      await expect(owner.reserveRoot(lease.transaction, {
        siteId: "site-a", projectRef: "project-a", launchId: "launch-a", runId: "run-a",
        modelOptionRevisionRef: "model-a", commandId: "command-a",
        manifestRef: "manifest-a", manifestDigest: "c".repeat(64),
        requestDigest: "d".repeat(64),
        maximumExpiresAt: "2026-07-29T12:05:00.000Z", configurationRevisionId: "release-a",
        subjectRef: "subject-a", subjectGeneration: 3n,
        agentRef: "general-v3",
      })).resolves.toEqual({
        kind: "resolved",
        value: {
          executionBudgetRootRef: "budget-a", rootHoldRef: "hold-a",
          authorizationSegmentRef: "segment-a", segmentVersion: 1n,
          expiresAt: "2026-07-29T12:05:00.000Z", estimatedCostDisplay: "≤ 75000 credit_micros",
        },
      });
      expect(vi.mocked(credit.reserveRootBudget)).toHaveBeenCalledWith(lease.transaction, expect.objectContaining({
        siteId: "site-a", billingAccountId: "billing-a", creditAccountId: "credit-a",
        unit: "credit_micros", liabilityMerchantAccountId: "merchant-a",
        ratingPolicyRevisionRef: "rating-a", rootCeiling: 100000n, segmentMaximum: 75000n,
        executionManifestRef: "manifest-a", requestDigest: "d".repeat(64),
        consumptionScope: { surfaceRef: "chat", capabilityKey: "chat.general", agentRef: "general-v3" },
      }));
      expect(sql.calls.find(({ statement }) => statement.includes("identity_personal_bootstrap"))?.values)
        .toEqual(["site-a", "project-a", "subject-a", 3n, "credit_micros", "merchant-a"]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("delegates authorization CAS and terminal rating to the canonical Credit owners", async () => {
    const lease = issuePlatformTransaction(new OwnerSql());
    const credit = fakeCredit();
    const usageSettlement = { settleUsageSegment: vi.fn(async () => ({
      kind: "accepted" as const,
      value: {
        settlementRef: "22222222-2222-4222-8222-222222222222",
        authorizationSegmentRef: "segment-a",
        closureRef: "33333333-3333-4333-8333-333333333333",
        closureRevision: 1n,
        state: "settled" as const,
        customerAmount: 125n,
        platformExposureAmount: 0n,
      },
    })) };
    const owner = new PostgresAdmissionBudgetOwner(credit, usageSettlement);
    const base = {
      siteId: "site-a", rootHoldRef: "hold-a", authorizationSegmentRef: "segment-a",
      manifestRef: "manifest-a", expectedSegmentVersion: 1n, commandId: "command-a",
      requestDigest: "d".repeat(64),
    };
    try {
      await owner.commitRoot(lease.transaction, base);
      await owner.releaseRoot(lease.transaction, {
        ...base, reasonCode: "CANCELED", noDispatchEvidenceRef: "no-dispatch-a",
      });
      await expect(owner.reconcileRoot(lease.transaction, {
        ...base, terminalEvidenceRef: "terminal-a",
      })).resolves.toEqual({
        kind: "settled",
        settlement: {
          settlementRef: "22222222-2222-4222-8222-222222222222",
          closureRef: "33333333-3333-4333-8333-333333333333",
          ratedAmount: "125",
          currencyOrCreditUnit: "credit_micros",
          ratingSnapshotRef: "44444444-4444-4444-8444-444444444444",
          usageEvidenceRefs: ["11111111-1111-4111-8111-111111111111"],
        },
      });
      expect(credit.finalizeAuthorizationSegment).toHaveBeenCalledOnce();
      expect(credit.releaseAuthorizationSegment).toHaveBeenCalledWith(lease.transaction,
        expect.objectContaining({ noDispatchEvidenceRef: "no-dispatch-a" }));
      expect(usageSettlement.settleUsageSegment).toHaveBeenCalledWith(
        lease.transaction,
        expect.objectContaining({
          evidenceRefs: ["11111111-1111-4111-8111-111111111111"],
          executionManifestRef: "manifest-a",
        }),
      );
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("validates every attachment against the trusted ready AssetGrant projection", async () => {
    const sql = new OwnerSql();
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAdmissionAssetOwner().validate(lease.transaction, {
        siteId: "site-a", projectRef: "project-a", sessionId: "session-a",
        subjectRef: "subject-a", subjectGeneration: 3n,
        attachments: [{ assetRef: "asset-a", assetVersionRef: "asset-version-a", assetGrantRef: "grant-a" }],
      })).resolves.toEqual({ kind: "resolved", value: undefined });
      expect(sql.calls.find(({ statement }) => statement.includes("asset_eligibility_projection"))?.values)
        .toEqual(["site-a", "project-a", "subject-a", 3n, "asset-a", "asset-version-a", "grant-a",
          "chat.attachment"]);
      expect(sql.calls.find(({ statement }) => statement.includes("asset_eligibility_projection"))?.statement)
        .toContain("resource.purpose=$8");
      expect(sql.calls.find(({ statement }) => statement.includes("set_config('app.subject_id'"))?.values)
        .toEqual(["site-a", "subject-a", "3", "project-a", "chat.attachment"]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
}
