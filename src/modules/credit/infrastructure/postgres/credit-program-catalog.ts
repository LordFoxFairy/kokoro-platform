import { randomUUID } from "node:crypto";
import { CommandReceiptRepository } from "../../../../shared/outbox-inbox/receipt.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type { CreditProgramCatalogRepository, CreditProgramPublicationCommand } from
  "../../application/contracts/credit-program-catalog.js";
import { advanceCreditProgramCatalogSnapshot, defineCreditProgramRevision,
  type PublishedCreditProgramRevision } from
  "../../domain/credit-program-catalog.js";
import { creditProgramDefinitionFromBytes } from "../protobuf/credit-program-codec.js";

interface HeadRow extends Record<string, unknown> { currentRevision: string }
interface SnapshotRow extends Record<string, unknown> { currentEpoch: string; snapshotDigest: string }
interface RevisionRow extends Record<string, unknown> {
  programRef: string; revision: string; revisionDigest: string; definitionBytes: Uint8Array;
  publishedAt: Date | string;
}

export class PostgresCreditProgramCatalog implements CreditProgramCatalogRepository {
  constructor(private readonly receipts = new CommandReceiptRepository()) {}

  async publishRevision(transaction: Parameters<CreditProgramCatalogRepository["publishRevision"]>[0],
    command: CreditProgramPublicationCommand, candidate: PublishedCreditProgramRevision) {
    const receipt = await this.receipts.begin(transaction, command);
    if (receipt.state === "succeeded") {
      const target = receiptResult(receipt.result);
      if (receipt.resultDigest !== target.revisionDigest.slice("sha256:".length)) {
        throw new Error("CREDIT_PROGRAM_RECEIPT_DIGEST_INVALID");
      }
      const replay = await loadExact(transaction, target);
      return Object.freeze({ kind: "replayed" as const, revision: replay,
        recordedAt: requiredInstant(receipt.recordedAt) });
    }
    if (receipt.state !== "pending") throw new Error("CREDIT_PROGRAM_COMMAND_NOT_RETRYABLE");
    const sql = resolvePlatformTransaction(transaction);
    await sql.execute(`INSERT INTO platform.credit_program_head(program_ref) VALUES ($1)
      ON CONFLICT (program_ref) DO NOTHING`, [candidate.target.programRef]);
    const heads = await sql.query<HeadRow>(`SELECT current_revision::text AS "currentRevision"
      FROM platform.credit_program_head WHERE program_ref=$1 FOR UPDATE`, [candidate.target.programRef]);
    if (heads[0]?.currentRevision !== command.expectedVersion.toString()) {
      throw new Error("CREDIT_PROGRAM_HEAD_CONFLICT");
    }
    const snapshots = await sql.query<SnapshotRow>(`SELECT current_epoch::text AS "currentEpoch",
      snapshot_digest AS "snapshotDigest" FROM platform.credit_program_catalog_snapshot
      WHERE singleton=TRUE FOR UPDATE`);
    const snapshot = snapshots[0];
    if (snapshot === undefined) throw new Error("CREDIT_PROGRAM_SNAPSHOT_MISSING");
    const epoch = BigInt(snapshot.currentEpoch) + 1n;
    const snapshotDigest = advanceCreditProgramCatalogSnapshot(snapshot.snapshotDigest, candidate.target);
    const changed = await sql.execute(`UPDATE platform.credit_program_head
      SET current_revision=$2::numeric(20,0),current_digest=$3,updated_at=$4::timestamptz
      WHERE program_ref=$1 AND current_revision=$5::numeric(20,0)`,
    [candidate.target.programRef, candidate.target.revision.toString(), candidate.target.revisionDigest,
      candidate.publishedAt, command.expectedVersion.toString()]);
    if (changed !== 1) throw new Error("CREDIT_PROGRAM_HEAD_CONFLICT");
    exactlyOne(await sql.execute(`INSERT INTO platform.credit_program_revision
      (program_ref,revision,revision_digest,unit,maximum_program_balance_per_account_minor,reservation_ttl_seconds,
       reconciliation_grace_seconds,allow_negative_balance,accounting_policy_ref,
       definition_bytes,catalog_epoch,published_by,command_id,published_at)
      VALUES ($1,$2::numeric(20,0),$3,$4,$5::numeric(20,0),$6::numeric(20,0),$7::numeric(20,0),
       FALSE,$8,$9,$10::numeric(20,0),$11,$12,$13::timestamptz)`,
    [candidate.target.programRef, candidate.target.revision.toString(), candidate.target.revisionDigest,
      candidate.definition.unit, candidate.definition.maximumProgramBalancePerAccountMinor.toString(),
      candidate.definition.reservationTtlSeconds.toString(), candidate.definition.reconciliationGraceSeconds.toString(),
      candidate.definition.accountingPolicyRef,
      candidate.definitionBytes, epoch.toString(), command.actorSubjectId, command.commandId,
      candidate.publishedAt]), "CREDIT_PROGRAM_REVISION_PERSIST_FAILED");
    for (const grant of candidate.definition.grants) {
      exactlyOne(await sql.execute(`INSERT INTO platform.credit_program_grant_rule
        (program_ref,revision,bucket,amount_minor,burn_priority,liability_merchant_account_ref,scope_policy,window_policy)
        VALUES ($1,$2::numeric(20,0),$3,$4::numeric(20,0),$5,$6,$7::jsonb,$8::jsonb)`,
      [candidate.target.programRef, candidate.target.revision.toString(), grant.bucket,
        grant.amountMinor.toString(), grant.burnPriority, grant.liabilityMerchantAccountRef,
        JSON.stringify(grant.scopePolicy), JSON.stringify(windowPayload(grant.window))]),
      "CREDIT_PROGRAM_RULE_PERSIST_FAILED");
    }
    exactlyOne(await sql.execute(`UPDATE platform.credit_program_catalog_snapshot
      SET current_epoch=$1::numeric(20,0),snapshot_digest=$2,updated_at=$3::timestamptz
      WHERE singleton=TRUE`, [epoch.toString(), snapshotDigest, candidate.publishedAt]),
    "CREDIT_PROGRAM_SNAPSHOT_ADVANCE_FAILED");
    exactlyOne(await sql.execute(`INSERT INTO platform.credit_program_catalog_snapshot_revision
      (epoch,snapshot_ref,snapshot_digest,recorded_at)
      VALUES ($1::numeric(20,0),$2,$3,$4::timestamptz)`, [epoch.toString(),
      `credit-program-snapshot:${epoch.toString()}`, snapshotDigest, candidate.publishedAt]),
    "CREDIT_PROGRAM_SNAPSHOT_REVISION_PERSIST_FAILED");
    exactlyOne(await sql.execute(`INSERT INTO platform.credit_program_publication_audit
      (command_id,program_ref,revision,revision_digest,expected_version,actor_subject_id,environment,region,reason,replayed,recorded_at)
      VALUES ($1,$2,$3::numeric(20,0),$4,$5::numeric(20,0),$6,$7,$8,$9,FALSE,$10::timestamptz)`,
    [command.commandId, candidate.target.programRef, candidate.target.revision.toString(),
      candidate.target.revisionDigest, command.expectedVersion.toString(), command.actorSubjectId,
      command.environment, command.region, command.reason, candidate.publishedAt]),
    "CREDIT_PROGRAM_AUDIT_PERSIST_FAILED");
    exactlyOne(await sql.execute(`INSERT INTO platform.credit_program_outbox
      (event_ref,event_type,program_ref,revision,revision_digest,payload,occurred_at)
      VALUES ($1::uuid,'credit.program.revision-published.v1',$2,$3::numeric(20,0),$4,$5::jsonb,$6::timestamptz)`,
    [randomUUID(), candidate.target.programRef, candidate.target.revision.toString(),
      candidate.target.revisionDigest, JSON.stringify({ target: { programRef: candidate.target.programRef,
        revision: candidate.target.revision.toString(), revisionDigest: candidate.target.revisionDigest }, snapshot: {
        ref: `credit-program-snapshot:${epoch.toString()}`, digest: snapshotDigest } }), candidate.publishedAt]),
    "CREDIT_PROGRAM_OUTBOX_PERSIST_FAILED");
    const completed = await this.receipts.recordOutcome(transaction, command, { state: "succeeded",
      result: { programRef: candidate.target.programRef, revision: candidate.target.revision.toString(),
        revisionDigest: candidate.target.revisionDigest },
      resultDigest: candidate.target.revisionDigest.slice("sha256:".length) });
    return Object.freeze({ kind: "published" as const, revision: candidate,
      recordedAt: requiredInstant(completed.recordedAt) });
  }
}

async function loadExact(transaction: Parameters<CreditProgramCatalogRepository["publishRevision"]>[0],
  target: Readonly<{ programRef: string; revision: bigint; revisionDigest: string }>) {
  const rows = await resolvePlatformTransaction(transaction).query<RevisionRow>(`SELECT program_ref AS "programRef",
    revision::text,revision_digest AS "revisionDigest",definition_bytes AS "definitionBytes",
    published_at AS "publishedAt" FROM platform.credit_program_revision
    WHERE program_ref=$1 AND revision=$2::numeric(20,0) AND revision_digest=$3`,
  [target.programRef, target.revision.toString(), target.revisionDigest]);
  const row = rows[0];
  if (row === undefined) throw new Error("CREDIT_PROGRAM_REPLAY_REVISION_MISSING");
  const revision = defineCreditProgramRevision({ programRef: row.programRef, revision: BigInt(row.revision),
    expectedVersion: BigInt(row.revision) - 1n, definition: creditProgramDefinitionFromBytes(row.definitionBytes),
    definitionBytes: row.definitionBytes, publishedAt: new Date(row.publishedAt).toISOString() });
  if (revision.target.revisionDigest !== row.revisionDigest) throw new Error("CREDIT_PROGRAM_PERSISTED_DIGEST_INVALID");
  return revision;
}

function receiptResult(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("CREDIT_PROGRAM_RECEIPT_INVALID");
  const row = value as Record<string, unknown>;
  if (typeof row.programRef !== "string" || typeof row.revision !== "string" ||
      typeof row.revisionDigest !== "string") throw new Error("CREDIT_PROGRAM_RECEIPT_INVALID");
  return Object.freeze({ programRef: row.programRef, revision: BigInt(row.revision), revisionDigest: row.revisionDigest });
}
function windowPayload(value: PublishedCreditProgramRevision["definition"]["grants"][number]["window"]) {
  return value.kind === "permanent" ? { ...value,
    expiresAfterSeconds: value.expiresAfterSeconds?.toString() ?? null } : { ...value };
}
function exactlyOne(value: number, code: string): void { if (value !== 1) throw new Error(code); }
function requiredInstant(value: string | undefined): string {
  if (value === undefined || !Number.isFinite(Date.parse(value))) throw new Error("CREDIT_PROGRAM_RECEIPT_TIME_INVALID");
  return new Date(value).toISOString();
}
