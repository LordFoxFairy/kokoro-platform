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
  async query<Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> {
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
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("delegates every segment CAS to RunBudgetAuthority and never mutates Credit tables", async () => {
    const lease = issuePlatformTransaction(new OwnerSql());
    const credit = fakeCredit();
    const owner = new PostgresAdmissionBudgetOwner(credit);
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
      })).resolves.toBe("reconciliation_required");
      expect(credit.finalizeAuthorizationSegment).toHaveBeenCalledOnce();
      expect(credit.releaseAuthorizationSegment).toHaveBeenCalledWith(lease.transaction,
        expect.objectContaining({ noDispatchEvidenceRef: "no-dispatch-a" }));
      expect(credit.reconcileAuthorizationSegment).toHaveBeenCalledWith(lease.transaction,
        expect.objectContaining({ ownerEvidence: { kind: "outcome_unknown", evidenceRef: "terminal-a" } }));
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("validates every attachment against the trusted ready AssetGrant projection", async () => {
    const lease = issuePlatformTransaction(new OwnerSql());
    try {
      await expect(new PostgresAdmissionAssetOwner().validate(lease.transaction, {
        siteId: "site-a", projectRef: "project-a", sessionId: "session-a",
        attachments: [{ assetRef: "asset-a", assetVersionRef: "asset-version-a", assetGrantRef: "grant-a" }],
      })).resolves.toEqual({ kind: "resolved", value: undefined });
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
