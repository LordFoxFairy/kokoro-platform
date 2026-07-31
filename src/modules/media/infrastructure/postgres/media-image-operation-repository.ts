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
    const authorization = command.agentCommandAuthorization;
    if (authorization === undefined) throw new Error("MEDIA_AGENT_COMMAND_AUTHORIZATION_REQUIRED");
    const leaseToken = randomBytes(32).toString("base64url");
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
    if (rows.length !== 1) throw new Error("MEDIA_COMMAND_RESULT_INVALID");
    const result = rows[0]!;
    const receipt = parseReceipt(result, "MEDIA_COMMAND_RESULT_INVALID");
    if (result.outcome === "started" && result.operationRef === null) {
      if (receipt.outcome !== "submit_outcome_unknown") throw new Error("MEDIA_COMMAND_RESULT_INVALID");
      return Object.freeze({ kind: "started" as const, leaseToken, receipt });
    }
    if (result.outcome !== "replayed" || result.operationRef === null) {
      throw new Error("MEDIA_COMMAND_RESULT_INVALID");
    }
    if (receipt.outcome !== "submit_accepted") throw new Error("MEDIA_COMMAND_RESULT_INVALID");
    return Object.freeze({ kind: "replayed" as const, operationRef: result.operationRef,
      callerRequestFingerprint: result.callerRequestFingerprint, receipt });
  }

  async complete(
    transaction: Parameters<MediaImageOperationRepository["complete"]>[0],
    leaseToken: string,
    record: MediaImageOperationRecord,
  ): Promise<MediaCommandDurableReceipt> {
    const sql = resolvePlatformTransaction(transaction);
    const binding = record.ownerBinding;
    const operation = record.plan.operation;
    const modelInvocationCommandRef = record.modelInvocationCommandRefs[0];
    if (modelInvocationCommandRef === undefined || record.artifactRefs.length !== record.plan.candidates.length ||
        record.artifactVersionRefs.length !== record.plan.candidates.length) {
      throw new Error("MEDIA_RECORD_ALLOCATION_INVALID");
    }
    const payload = JSON.stringify({
      owner: { ...binding, subjectGeneration: binding.subjectGeneration.toString() },
      command: { ...record.command, subjectGeneration: record.command.subjectGeneration.toString() },
      protectedInput: record.protectedInput,
      operation: { operationRef: operation.operationRef, ownerVersion: operation.expectedVersion.toString(),
        definitionRevisionRef: binding.definitionRevisionRef,
        modelOptionRevisionRef: binding.modelOptionRevisionRef },
      credit: record.credit,
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
    const rows = await sql.query<CommitRow>(
      `SELECT operation_ref AS "operationRef",
              caller_request_fingerprint AS "callerRequestFingerprint",
              receipt_version AS "receiptVersion",receipt_recorded_at AS "receiptRecordedAt",
              receipt_kind AS "receiptKind",receipt_outcome AS "receiptOutcome"
         FROM platform.commit_media_image_operation($1::jsonb,$2)`,
      [payload, digest(leaseToken)],
    );
    if (rows.length !== 1) throw new Error("MEDIA_COMMAND_COMMIT_INVALID");
    const result = rows[0]!;
    if (result.operationRef !== operation.operationRef ||
        result.callerRequestFingerprint !== record.command.callerRequestFingerprint) {
      throw new Error("MEDIA_COMMAND_COMMIT_INVALID");
    }
    const receipt = parseReceipt(result, "MEDIA_COMMAND_COMMIT_INVALID");
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
): MediaCommandDurableReceipt {
  let version: bigint;
  try { version = BigInt(row.receiptVersion); } catch { throw new Error(errorCode); }
  const recordedAt = row.receiptRecordedAt instanceof Date
    ? row.receiptRecordedAt : new Date(row.receiptRecordedAt);
  if (version < 1n || !Number.isFinite(recordedAt.getTime()) ||
      row.receiptKind !== "create_agent_image_operation" ||
      (row.receiptOutcome !== "submit_outcome_unknown" && row.receiptOutcome !== "submit_accepted")) {
    throw new Error(errorCode);
  }
  return Object.freeze({ version, recordedAt: recordedAt.toISOString(),
    commandKind: row.receiptKind, outcome: row.receiptOutcome });
}
