import { createHash } from "node:crypto";
import { AdmissionRetryClass } from "../../../../interfaces/connect/generated/kokoro/platform/admission/v1/admission_pb.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import { CreditService } from "../../../credit/application/credit-service.js";
import type {
  CreditAuthorityOutcome,
  RunBudgetAuthority,
  SegmentMutationResult,
} from "../../../credit/application/contracts/run-budget-authority.js";
import { PostgresCreditAuthorityRepository } from "../../../credit/infrastructure/postgres/credit-authority-repository.js";
import type {
  AdmissionAssetOwnerPort,
  AdmissionBudgetOwnerPort,
  AdmissionOwnerResolution,
} from "../../application/platform-admission-owner-authority.js";
import { admissionLaunchProfileSnapshotSchema } from "./admission-runtime-owners.js";

interface LaunchProfileRow extends Record<string, unknown> {
  readonly launchProfileRef: unknown;
  readonly snapshotDigest: unknown;
  readonly payload: unknown;
}

interface BillingAuthorityRow extends Record<string, unknown> {
  readonly billingAccountId: unknown;
  readonly creditAccountId: unknown;
}

interface AssetGrantRow extends Record<string, unknown> {
  readonly assetRef: unknown;
  readonly assetVersionRef: unknown;
  readonly assetGrantRef: unknown;
}

type ReserveResolution = Awaited<ReturnType<AdmissionBudgetOwnerPort["reserveRoot"]>>;

/** Adapts Admission orchestration to the sole native W2A RunBudgetAuthority. */
export class PostgresAdmissionBudgetOwner implements AdmissionBudgetOwnerPort {
  constructor(
    private readonly authority: RunBudgetAuthority = new CreditService({
      repository: new PostgresCreditAuthorityRepository(),
    }),
  ) {}

  async reserveRoot(
    transaction: Parameters<AdmissionBudgetOwnerPort["reserveRoot"]>[0],
    input: Parameters<AdmissionBudgetOwnerPort["reserveRoot"]>[1],
  ): Promise<ReserveResolution> {
    const sql = resolvePlatformTransaction(transaction);
    const profileRows = await sql.query<LaunchProfileRow>(
      `SELECT profile.launch_profile_ref AS "launchProfileRef",
              profile.snapshot_digest AS "snapshotDigest",profile.snapshot AS payload
         FROM platform.admission_launch_profile_snapshot AS profile
         JOIN platform.site_release AS release
           ON release.site_ref=profile.site_ref
          AND release.release_ref=profile.site_release_ref
          AND release.launch_profile_ref=profile.launch_profile_ref
        WHERE profile.site_ref=$1 AND profile.site_release_ref=$2 AND release.state='active'
        LIMIT 1`,
      [input.siteId, input.configurationRevisionId],
    );
    const profileRow = only(profileRows, "ADMISSION_BUDGET_PROFILE_CORRUPT");
    if (profileRow === undefined) return denied("ADMISSION_BUDGET_POLICY_NOT_AVAILABLE");
    const profile = admissionLaunchProfileSnapshotSchema.safeParse(profileRow.payload);
    if (
      !profile.success || profile.data.siteId !== input.siteId ||
      profile.data.siteReleaseRef !== input.configurationRevisionId ||
      typeof profileRow.snapshotDigest !== "string" ||
      snapshotDigest(profile.data) !== profileRow.snapshotDigest ||
      profileRow.launchProfileRef !== `launch-profile:sha256:${profileRow.snapshotDigest}`
    ) throw new Error("ADMISSION_BUDGET_PROFILE_CORRUPT");
    const policy = profile.data.billing;
    const authorities = await sql.query<BillingAuthorityRow>(
      `SELECT bootstrap.billing_account_ref AS "billingAccountId",
              credit.credit_account_ref AS "creditAccountId"
         FROM platform.identity_personal_bootstrap AS bootstrap
         JOIN platform.commerce_billing_account AS billing
           ON billing.site_ref=bootstrap.site_ref
          AND billing.billing_account_ref=bootstrap.billing_account_ref
          AND billing.state='active'
         JOIN platform.credit_account AS credit
           ON credit.site_ref=billing.site_ref
          AND credit.billing_account_ref=billing.billing_account_ref
          AND credit.unit=$3 AND credit.liability_merchant_account_ref=$4
          AND credit.state='active'
        WHERE bootstrap.site_ref=$1 AND bootstrap.project_ref=$2
        LIMIT 2`,
      [input.siteId, input.projectRef, policy.unit, policy.liabilityMerchantAccountRef],
    );
    const billing = only(authorities, "ADMISSION_BILLING_AUTHORITY_AMBIGUOUS");
    if (billing === undefined) return denied("ADMISSION_BILLING_ACCOUNT_NOT_AVAILABLE");
    if (!ownerRef(billing.billingAccountId) || !ownerRef(billing.creditAccountId)) {
      throw new Error("ADMISSION_BILLING_AUTHORITY_CORRUPT");
    }
    const outcome = await this.authority.reserveRootBudget(transaction, {
      siteId: input.siteId,
      billingAccountId: billing.billingAccountId,
      creditAccountId: billing.creditAccountId,
      unit: policy.unit,
      liabilityMerchantAccountId: policy.liabilityMerchantAccountRef,
      executionRootId: input.runId,
      authorizationBudgetRef: `authorization-budget:${input.manifestDigest}`,
      ratingPolicyRevisionRef: policy.ratingPolicyRevisionRef,
      executionManifestRef: input.manifestRef,
      consumptionScope: {
        surfaceRef: policy.surfaceRef,
        capabilityKey: policy.capabilityKey,
        agentRef: input.agentRef ?? null,
      },
      businessOperationKey: input.commandId,
      requestDigest: input.manifestDigest,
      rootCeiling: BigInt(policy.rootCeiling),
      segmentMaximum: BigInt(policy.segmentMaximum),
      expiresAt: input.maximumExpiresAt,
    });
    if (outcome.kind === "insufficient_credit") return denied("ADMISSION_INSUFFICIENT_CREDIT");
    if (outcome.kind !== "accepted" && outcome.kind !== "replayed") {
      throw new Error(`ADMISSION_BUDGET_RESERVATION_${outcome.kind.toUpperCase()}`);
    }
    const value = outcome.value;
    if (value.state !== "reserved" || value.segmentVersion !== 1n) {
      throw new Error("ADMISSION_BUDGET_RESERVATION_CORRUPT");
    }
    return Object.freeze({
      kind: "resolved",
      value: Object.freeze({
        executionBudgetRootRef: value.executionBudgetRootRef,
        rootHoldRef: value.creditHoldRef,
        authorizationSegmentRef: value.authorizationSegmentRef,
        segmentVersion: value.segmentVersion,
        expiresAt: value.expiresAt,
        estimatedCostDisplay: `≤ ${policy.segmentMaximum} ${policy.unit}`,
      }),
    });
  }

  async commitRoot(
    transaction: Parameters<AdmissionBudgetOwnerPort["commitRoot"]>[0],
    input: Parameters<AdmissionBudgetOwnerPort["commitRoot"]>[1],
  ): Promise<void> {
    await assertCreditIdentity(transaction, input);
    requireSegmentOutcome(
      await this.authority.finalizeAuthorizationSegment(transaction, segmentCommand(input)),
      input,
      "committed",
    );
  }

  async releaseRoot(
    transaction: Parameters<AdmissionBudgetOwnerPort["releaseRoot"]>[0],
    input: Parameters<AdmissionBudgetOwnerPort["releaseRoot"]>[1],
  ): Promise<void> {
    await assertCreditIdentity(transaction, input);
    requireSegmentOutcome(
      await this.authority.releaseAuthorizationSegment(transaction, {
        ...segmentCommand(input),
        noDispatchEvidenceRef: input.noDispatchEvidenceRef,
      }),
      input,
      "released",
    );
  }

  async reconcileRoot(
    transaction: Parameters<AdmissionBudgetOwnerPort["reconcileRoot"]>[0],
    input: Parameters<AdmissionBudgetOwnerPort["reconcileRoot"]>[1],
  ): Promise<"settled" | "reconciliation_required"> {
    await assertCreditIdentity(transaction, input);
    if (input.terminalEvidenceRef === undefined) return "reconciliation_required";
    const outcome = await this.authority.reconcileAuthorizationSegment(transaction, {
      ...segmentCommand(input),
      ownerEvidence: { kind: "outcome_unknown", evidenceRef: input.terminalEvidenceRef },
    });
    requireSegmentOutcome(outcome, input, "reconciliation_required");
    return "reconciliation_required";
  }
}

/** Validates exact immutable ready grants in Platform's Asset owner projection. */
export class PostgresAdmissionAssetOwner implements AdmissionAssetOwnerPort {
  async validate(
    transaction: Parameters<AdmissionAssetOwnerPort["validate"]>[0],
    input: Parameters<AdmissionAssetOwnerPort["validate"]>[1],
  ): Promise<AdmissionOwnerResolution<undefined>> {
    const sql = resolvePlatformTransaction(transaction);
    for (const attachment of input.attachments) {
      const rows = await sql.query<AssetGrantRow>(
        `SELECT resource.asset_ref AS "assetRef",version.asset_version_ref AS "assetVersionRef",
                eligibility.eligibility_ref AS "assetGrantRef"
           FROM platform.asset_resource AS resource
           JOIN platform.asset_version AS version
             ON version.site_ref=resource.site_ref AND version.asset_ref=resource.asset_ref
           JOIN platform.asset_eligibility_projection AS eligibility
             ON eligibility.site_ref=version.site_ref
            AND eligibility.asset_version_ref=version.asset_version_ref
            AND eligibility.subject_ref=resource.subject_ref
            AND eligibility.subject_generation=resource.subject_generation
            AND eligibility.project_ref=resource.project_ref
            AND eligibility.purpose=resource.purpose
            AND eligibility.eligibility_epoch=version.eligibility_epoch
          WHERE resource.site_ref=$1 AND resource.project_ref=$2
            AND resource.asset_ref=$3 AND version.asset_version_ref=$4
            AND eligibility.eligibility_ref=$5
            AND resource.purpose='chat_run_input'
            AND resource.state='active' AND version.state='ready' AND eligibility.state='ready'
          LIMIT 2`,
        [input.siteId, input.projectRef, attachment.assetRef,
          attachment.assetVersionRef, attachment.assetGrantRef],
      );
      const grant = only(rows, "ADMISSION_ASSET_GRANT_AMBIGUOUS");
      if (grant === undefined) return denied("ADMISSION_ASSET_GRANT_NOT_ELIGIBLE");
      if (
        grant.assetRef !== attachment.assetRef ||
        grant.assetVersionRef !== attachment.assetVersionRef ||
        grant.assetGrantRef !== attachment.assetGrantRef
      ) throw new Error("ADMISSION_ASSET_GRANT_CORRUPT");
    }
    return Object.freeze({ kind: "resolved", value: undefined });
  }
}

function segmentCommand(input: Readonly<{
  siteId: string; authorizationSegmentRef: string; manifestRef: string;
  expectedSegmentVersion: bigint; commandId: string; requestDigest: string;
}>) {
  return Object.freeze({
    siteId: input.siteId,
    authorizationSegmentRef: input.authorizationSegmentRef,
    executionManifestRef: input.manifestRef,
    expectedSegmentVersion: input.expectedSegmentVersion,
    businessOperationKey: input.commandId,
    requestDigest: input.requestDigest,
  });
}

async function assertCreditIdentity(
  transaction: Parameters<AdmissionBudgetOwnerPort["commitRoot"]>[0],
  input: Readonly<{
    siteId: string; rootHoldRef: string; authorizationSegmentRef: string; manifestRef: string;
  }>,
): Promise<void> {
  const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown>>(
    `SELECT TRUE AS matched
       FROM platform.credit_authorization_segment AS segment
       JOIN platform.credit_execution_budget_root AS root
         ON root.site_ref=segment.site_ref
        AND root.execution_budget_root_ref=segment.execution_budget_root_ref
        AND root.credit_hold_ref=segment.credit_hold_ref
      WHERE segment.site_ref=$1 AND segment.authorization_segment_ref=$2
        AND segment.execution_manifest_ref=$3 AND segment.credit_hold_ref=$4
      LIMIT 2`,
    [input.siteId, input.authorizationSegmentRef, input.manifestRef, input.rootHoldRef],
  );
  if (rows.length !== 1) throw new Error("ADMISSION_CREDIT_OWNER_IDENTITY_MISMATCH");
}

function requireSegmentOutcome(
  outcome: CreditAuthorityOutcome<SegmentMutationResult>,
  input: Readonly<{ authorizationSegmentRef: string; expectedSegmentVersion: bigint }>,
  expectedState: SegmentMutationResult["state"],
): void {
  if (
    (outcome.kind !== "accepted" && outcome.kind !== "replayed" && outcome.kind !== "reconciliation_required") ||
    outcome.value.authorizationSegmentRef !== input.authorizationSegmentRef ||
    outcome.value.segmentVersion !== input.expectedSegmentVersion + 1n ||
    outcome.value.state !== expectedState
  ) throw new Error(`ADMISSION_CREDIT_SEGMENT_${outcome.kind.toUpperCase()}`);
}

function only<Row>(rows: readonly Row[], code: string): Row | undefined {
  if (rows.length > 1) throw new Error(code);
  return rows[0];
}

function denied(code: string): AdmissionOwnerResolution<never> {
  return Object.freeze({ kind: "denied", denial: Object.freeze({
    code, retryClass: AdmissionRetryClass.NEVER,
  }) });
}

function ownerRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value;
}

function snapshotDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}
