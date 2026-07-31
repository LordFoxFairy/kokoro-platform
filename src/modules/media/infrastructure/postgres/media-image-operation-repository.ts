import { createHash, randomBytes } from "node:crypto";
import type {
  MediaImageCommandBegin,
  MediaImageCommandIdentity,
  MediaCommandDurableReceipt,
  MediaImageOperationRecord,
  MediaImageOperationRepository,
} from "../../application/index.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";

interface BeginRow extends Record<string, unknown> {
  outcome: "started" | "replayed";
  callerRequestFingerprint: string;
  operationRef: string | null;
  receiptVersion: bigint | string;
  receiptRecordedAt: Date | string;
  receiptKind: string;
  receiptOutcome: string;
}

interface CommitRow extends Record<string, unknown> {
  operationRef: string;
  callerRequestFingerprint: string;
  receiptVersion: bigint | string;
  receiptRecordedAt: Date | string;
  receiptKind: string;
  receiptOutcome: string;
}

/** Durable submit journal and aggregate writer. All writes share one owner-scoped transaction. */
export class PostgresMediaImageOperationRepository implements MediaImageOperationRepository {
  async begin(
    transaction: Parameters<MediaImageOperationRepository["begin"]>[0],
    command: MediaImageCommandIdentity & Readonly<{
      callerRequestFingerprint: string;
      ownerRequestDigest: string;
    }>,
  ): Promise<MediaImageCommandBegin> {
    const sql = resolvePlatformTransaction(transaction);
    const leaseToken = randomBytes(32).toString("base64url");
    if (command.source === "direct_studio") {
      const authority = command.directStudioAuthority;
      const rows = await sql.query<BeginRow>(
        `SELECT outcome,operation_ref AS "operationRef",
                caller_request_fingerprint AS "callerRequestFingerprint",
                receipt_version AS "receiptVersion",receipt_recorded_at AS "receiptRecordedAt",
                receipt_kind AS "receiptKind",receipt_outcome AS "receiptOutcome"
           FROM platform.begin_direct_media_image_command(
             $1,$2,$3,$4::bigint,$5,$6,$7,$8,$9,$10,$11,$12,$13::bigint,$14::bigint,$15::bigint,
             $16,$17::bigint,$18::bigint,$19::bigint,$20::bigint,$21
           )`,
        [command.callerAudience, command.siteRef, command.subjectRef, command.subjectGeneration.toString(),
          command.projectRef, command.workloadRef, command.definitionRevisionRef, command.modelOptionRevisionRef,
          command.commandRef, command.callerRequestFingerprint, command.ownerRequestDigest,
          authority.siteReleaseRef, authority.siteSecurityEpoch.toString(), authority.policyEpoch.toString(),
          authority.workloadBindingEpoch.toString(), authority.identitySessionRef,
          authority.identitySessionEpoch.toString(), authority.restrictionEpoch.toString(),
          authority.membershipEpoch.toString(), authority.authorizationEpoch.toString(), digest(leaseToken)],
      );
      return beginResult(rows, leaseToken, "create_direct_studio_image_operation");
    }
    const authorization = command.agentCommandAuthorization;
    const rows = await sql.query<BeginRow>(
      `SELECT outcome,operation_ref AS "operationRef",
              caller_request_fingerprint AS "callerRequestFingerprint",
              receipt_version AS "receiptVersion",receipt_recorded_at AS "receiptRecordedAt",
              receipt_kind AS "receiptKind",receipt_outcome AS "receiptOutcome"
         FROM platform.begin_media_image_command(
           $1,$2,$3,$4,$5,$6::bigint,$7,$8,$9,$10,$11,$12,$13,$14,$15
         )`,
      [command.callerAudience, authorization.accessAuthorizationHandleDigest,
        authorization.projectionReservationDigest, command.siteRef, command.subjectRef,
        command.subjectGeneration.toString(), command.projectRef, command.workloadRef,command.source,
        command.definitionRevisionRef,command.modelOptionRevisionRef,command.commandRef,
        command.callerRequestFingerprint, command.ownerRequestDigest, digest(leaseToken)],
    );
    return beginResult(rows, leaseToken, "create_agent_image_operation");
  }

  async complete(
    transaction: Parameters<MediaImageOperationRepository["complete"]>[0],
    leaseToken: string,
    record: MediaImageOperationRecord,
  ): Promise<MediaCommandDurableReceipt> {
    const sql = resolvePlatformTransaction(transaction);
    const binding = record.ownerBinding;
    if ((binding.source === "agent_runtime") !== (record.credit.kind === "agent_child") ||
        binding.source !== record.command.source) {
      throw new Error("MEDIA_CREDIT_OWNER_BINDING_INVALID");
    }
    const operation = record.plan.operation;
    const modelInvocationCommandRef = record.modelInvocationCommandRefs[0];
    if (modelInvocationCommandRef === undefined || record.artifactRefs.length !== record.plan.candidates.length ||
        record.artifactVersionRefs.length !== record.plan.candidates.length) {
      throw new Error("MEDIA_RECORD_ALLOCATION_INVALID");
    }
    const payload = JSON.stringify({
      owner: persistOwnerBinding(binding),
      command: persistCommand(record.command),
      protectedInput: record.protectedInput,
      definitionPolicy: record.definitionPolicy,
      operation: { operationRef: operation.operationRef, ownerVersion: operation.expectedVersion.toString(),
        definitionRevisionRef: binding.definitionRevisionRef,
        modelOptionRevisionRef: binding.modelOptionRevisionRef },
      credit: persistCredit(record.credit),
      trustInputDecisionRef: record.trustInputDecisionRef,
      modelInvocationCommandRef,
      candidates: record.plan.candidates.map((candidate, index) => ({
        candidateRef: candidate.candidateRef, definitionStepKey: candidate.definitionStepKey,
        outputSlot: candidate.outputSlot, required: candidate.required,
        ownerVersion: candidate.expectedVersion.toString(), artifactRef: record.artifactRefs[index],
        artifactVersionRef: record.artifactVersionRefs[index],
      })),
      outbox: record.dispatchOutbox,
      createdAt: record.createdAt,
    });
    const commitFunction = binding.source === "direct_studio"
      ? "platform.commit_direct_media_image_operation"
      : "platform.commit_media_image_operation";
    const rows = await sql.query<CommitRow>(
      `SELECT operation_ref AS "operationRef",
              caller_request_fingerprint AS "callerRequestFingerprint",
              receipt_version AS "receiptVersion",receipt_recorded_at AS "receiptRecordedAt",
              receipt_kind AS "receiptKind",receipt_outcome AS "receiptOutcome"
         FROM ${commitFunction}($1::jsonb,$2)`,
      [payload, digest(leaseToken)],
    );
    if (rows.length !== 1) throw new Error("MEDIA_COMMAND_COMMIT_INVALID");
    const result = rows[0]!;
    if (result.operationRef !== operation.operationRef ||
        result.callerRequestFingerprint !== record.command.callerRequestFingerprint) {
      throw new Error("MEDIA_COMMAND_COMMIT_INVALID");
    }
    const receipt = parseReceipt(result, "MEDIA_COMMAND_COMMIT_INVALID",
      binding.source === "direct_studio"
        ? "create_direct_studio_image_operation" : "create_agent_image_operation");
    if (receipt.outcome !== "submit_accepted") throw new Error("MEDIA_COMMAND_COMMIT_INVALID");
    return receipt;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseReceipt(
  row: Pick<BeginRow, "receiptVersion" | "receiptRecordedAt" | "receiptKind" | "receiptOutcome">,
  errorCode: string,
  expectedKind?: MediaCommandDurableReceipt["commandKind"],
): MediaCommandDurableReceipt {
  let version: bigint;
  try { version = BigInt(row.receiptVersion); } catch { throw new Error(errorCode); }
  const recordedAt = row.receiptRecordedAt instanceof Date
    ? row.receiptRecordedAt : new Date(row.receiptRecordedAt);
  if (version < 1n || !Number.isFinite(recordedAt.getTime()) ||
      (row.receiptKind !== "create_agent_image_operation" &&
       row.receiptKind !== "create_direct_studio_image_operation") ||
      (expectedKind !== undefined && row.receiptKind !== expectedKind) ||
      (row.receiptOutcome !== "submit_outcome_unknown" && row.receiptOutcome !== "submit_accepted")) {
    throw new Error(errorCode);
  }
  return Object.freeze({ version, recordedAt: recordedAt.toISOString(),
    commandKind: row.receiptKind, outcome: row.receiptOutcome });
}

function beginResult(
  rows: readonly BeginRow[],
  leaseToken: string,
  expectedKind: MediaCommandDurableReceipt["commandKind"],
): MediaImageCommandBegin {
  if (rows.length !== 1) throw new Error("MEDIA_COMMAND_RESULT_INVALID");
  const result = rows[0]!;
  const receipt = parseReceipt(result, "MEDIA_COMMAND_RESULT_INVALID", expectedKind);
  if (result.outcome === "started" && result.operationRef === null) {
    if (receipt.outcome !== "submit_outcome_unknown") throw new Error("MEDIA_COMMAND_RESULT_INVALID");
    return Object.freeze({ kind: "started" as const, leaseToken, receipt });
  }
  if (result.outcome !== "replayed" || result.operationRef === null || receipt.outcome !== "submit_accepted") {
    throw new Error("MEDIA_COMMAND_RESULT_INVALID");
  }
  return Object.freeze({ kind: "replayed" as const, operationRef: result.operationRef,
    callerRequestFingerprint: result.callerRequestFingerprint, receipt });
}

function persistOwnerBinding(binding: MediaImageOperationRecord["ownerBinding"]): Readonly<Record<string, unknown>> {
  const base = { ...binding, subjectGeneration: binding.subjectGeneration.toString() };
  return binding.source === "agent_runtime" ? base : { ...base, authority: persistDirectAuthority(binding.authority) };
}

function persistCommand(command: MediaImageOperationRecord["command"]): Readonly<Record<string, unknown>> {
  const base = { ...command, subjectGeneration: command.subjectGeneration.toString() };
  return command.source === "agent_runtime" ? base
    : { ...base, directStudioAuthority: persistDirectAuthority(command.directStudioAuthority) };
}

function persistDirectAuthority(authority: Extract<MediaImageOperationRecord["ownerBinding"], {
  source: "direct_studio";
}>["authority"]): Readonly<Record<string, string>> {
  return { siteReleaseRef: authority.siteReleaseRef, siteSecurityEpoch: authority.siteSecurityEpoch.toString(),
    policyEpoch: authority.policyEpoch.toString(), workloadBindingEpoch: authority.workloadBindingEpoch.toString(),
    identitySessionRef: authority.identitySessionRef, identitySessionEpoch: authority.identitySessionEpoch.toString(),
    restrictionEpoch: authority.restrictionEpoch.toString(), membershipEpoch: authority.membershipEpoch.toString(),
    authorizationEpoch: authority.authorizationEpoch.toString() };
}

function persistCredit(credit: MediaImageOperationRecord["credit"]): Readonly<Record<string, unknown>> {
  const base = { ...credit, reservedCeiling: credit.reservedCeiling.toString(),
    authorizationSegmentVersion: credit.authorizationSegmentVersion.toString() };
  return credit.kind === "agent_child" ? base : { ...base,
    rootAllocationRevision: credit.rootAllocationRevision.toString(),
    rootAllocationEpoch: credit.rootAllocationEpoch.toString(),
    authorizationSegmentVersion: credit.authorizationSegmentVersion.toString() };
}
