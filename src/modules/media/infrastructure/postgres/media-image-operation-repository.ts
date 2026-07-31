import { createHash, randomBytes } from "node:crypto";
import type {
  MediaImageCommandBegin,
  MediaImageCommandIdentity,
  MediaImageOperationRecord,
  MediaImageOperationRepository,
} from "../../application/index.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";

interface BeginRow extends Record<string, unknown> {
  outcome: "started" | "replayed";
  callerRequestFingerprint: string;
  operationRef: string | null;
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
    const rows = await sql.query<BeginRow>(
      `SELECT outcome,operation_ref AS "operationRef",
              caller_request_fingerprint AS "callerRequestFingerprint"
         FROM platform.begin_media_image_command($1,$2,$3,$4::bigint,$5,$6,$7,$8,$9)`,
      [command.callerAudience, command.siteRef, command.subjectRef,
        command.subjectGeneration.toString(), command.projectRef, command.commandRef,
        command.callerRequestFingerprint, command.ownerRequestDigest, digest(leaseToken)],
    );
    if (rows.length !== 1) throw new Error("MEDIA_COMMAND_RESULT_INVALID");
    const result = rows[0]!;
    if (result.outcome === "started" && result.operationRef === null) {
      return Object.freeze({ kind: "started" as const, leaseToken });
    }
    if (result.outcome !== "replayed" || result.operationRef === null) {
      throw new Error("MEDIA_COMMAND_RESULT_INVALID");
    }
    return Object.freeze({ kind: "replayed" as const, operationRef: result.operationRef,
      callerRequestFingerprint: result.callerRequestFingerprint });
  }

  async complete(
    transaction: Parameters<MediaImageOperationRepository["complete"]>[0],
    leaseToken: string,
    record: MediaImageOperationRecord,
  ): Promise<void> {
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
    const rows = await sql.query<Record<string, unknown>>(
      `SELECT platform.commit_media_image_operation($1::jsonb,$2) AS committed`,
      [payload, digest(leaseToken)],
    );
    if (rows.length !== 1) throw new Error("MEDIA_COMMAND_COMMIT_INVALID");
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
