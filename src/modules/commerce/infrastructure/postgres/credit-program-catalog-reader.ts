import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type { CreditProgramCatalogReader, CreditProgramCatalogSnapshot,
  CreditProgramCatalogReadPermit, CreditProgramCatalogReadTransactionHost } from
  "../../application/contracts/credit-program-catalog-reader.js";
import { defineCreditProgramRevision } from "../../domain/credit-program-catalog.js";
import { canonicalCreditProgramDefinitionFromBytes } from "../protobuf/credit-program-codec.js";

interface RevisionRow extends Record<string, unknown> {
  programRef: string; revision: string; revisionDigest: string; definitionBytes: Uint8Array;
  publishedAt: Date | string; catalogEpoch: string;
}
interface SnapshotRow extends Record<string, unknown> { currentEpoch: string; snapshotDigest: string }
interface SnapshotRevisionRow extends Record<string, unknown> {
  epoch: string; snapshotRef: string; snapshotDigest: string;
}
interface ReceiptRow extends Record<string, unknown> {
  commandId: string; idempotencyKey: string; requestDigest: string; operation: string;
  state: string; result: unknown; recordedAt: Date | string;
}

export class PostgresCreditProgramCatalogReader implements CreditProgramCatalogReader {
  constructor(private readonly host: CreditProgramCatalogReadTransactionHost) {}

  get(permit: CreditProgramCatalogReadPermit, target: Parameters<CreditProgramCatalogReader["get"]>[1]) {
    requireGlobal(permit);
    return this.host.read(permit, async (transaction) => {
      const rows = await resolvePlatformTransaction(transaction).query<RevisionRow>(`${projection()}
        WHERE program_ref=$1 AND revision=$2::numeric(20,0) AND revision_digest=$3`,
      [target.programRef, target.revision.toString(), target.revisionDigest]);
      return rows[0] === undefined ? null : revision(rows[0]);
    });
  }

  list(permit: CreditProgramCatalogReadPermit, input: Parameters<CreditProgramCatalogReader["list"]>[1]) {
    requireGlobal(permit);
    return this.host.read(permit, async (transaction) => {
      const sql = resolvePlatformTransaction(transaction);
      const snapshots = await sql.query<SnapshotRow>(`SELECT current_epoch::text AS "currentEpoch",
        snapshot_digest AS "snapshotDigest" FROM platform.commerce_credit_program_catalog_snapshot WHERE singleton=TRUE`);
      const observed = snapshot(snapshots[0]);
      const selected = input.snapshot ?? observed;
      if (selected.epoch > observed.epoch) {
        throw new Error("CREDIT_PROGRAM_SNAPSHOT_INVALID");
      }
      const historical = await sql.query<SnapshotRevisionRow>(`SELECT epoch::text,snapshot_ref AS "snapshotRef",
        snapshot_digest AS "snapshotDigest" FROM platform.commerce_credit_program_catalog_snapshot_revision
        WHERE epoch=$1::numeric(20,0)`, [selected.epoch.toString()]);
      const persisted = historical[0];
      if (persisted === undefined || persisted.epoch !== selected.epoch.toString() ||
          persisted.snapshotRef !== selected.ref || persisted.snapshotDigest !== selected.digest) {
        throw new Error("CREDIT_PROGRAM_SNAPSHOT_INVALID");
      }
      const rows = await sql.query<RevisionRow>(`${projection()} WHERE catalog_epoch>$1::numeric(20,0)
        AND catalog_epoch<=$2::numeric(20,0) AND ($3::text IS NULL OR program_ref=$3)
        AND ($4::timestamptz IS NULL OR published_at>$4::timestamptz)
        AND ($5::timestamptz IS NULL OR published_at<$5::timestamptz)
        ORDER BY catalog_epoch ASC LIMIT $6`, [input.afterEpoch.toString(), selected.epoch.toString(),
        input.programRef, input.publishedAfter, input.publishedBefore, input.limit]);
      return Object.freeze({ revisions: Object.freeze(rows.map(revision)),
        epochs: Object.freeze(rows.map((row) => BigInt(row.catalogEpoch))), snapshot: selected });
    });
  }

  getCommandReceipt(permit: CreditProgramCatalogReadPermit,
    input: Parameters<CreditProgramCatalogReader["getCommandReceipt"]>[1]) {
    requireGlobal(permit);
    return this.host.read(permit, async (transaction) => {
      const rows = await resolvePlatformTransaction(transaction).query<ReceiptRow>(`SELECT command_id AS "commandId",
        idempotency_key AS "idempotencyKey",request_digest AS "requestDigest",operation,state,result,
        updated_at AS "recordedAt" FROM platform.command_receipt
        WHERE command_id=$1 AND environment=$2 AND region=$3 AND operation='credit.program.publish'`,
      [input.commandId, permit.environment, permit.region]);
      const row = rows[0];
      if (row === undefined) return null;
      if (row.idempotencyKey !== input.idempotencyKey || row.requestDigest !== input.requestDigest ||
          row.operation !== "credit.program.publish") throw new Error("CREDIT_PROGRAM_COMMAND_RECEIPT_MISMATCH");
      if (row.state !== "succeeded") throw new Error("CREDIT_PROGRAM_COMMAND_RECEIPT_NOT_COMMITTED");
      const target = receiptTarget(row.result);
      const found = await resolvePlatformTransaction(transaction).query<RevisionRow>(`${projection()}
        WHERE program_ref=$1 AND revision=$2::numeric(20,0) AND revision_digest=$3`,
      [target.programRef, target.revision.toString(), target.revisionDigest]);
      if (found[0] === undefined) throw new Error("CREDIT_PROGRAM_COMMAND_RECEIPT_REVISION_MISSING");
      return Object.freeze({ operation: "credit.program.publish" as const,
        recordedAt: new Date(row.recordedAt).toISOString(), revision: revision(found[0]) });
    });
  }
}

function projection() {
  return `SELECT program_ref AS "programRef",revision::text,revision_digest AS "revisionDigest",
    definition_bytes AS "definitionBytes",published_at AS "publishedAt",catalog_epoch::text AS "catalogEpoch"
    FROM platform.commerce_credit_program_catalog_revision`;
}
function revision(row: RevisionRow) {
  const value = defineCreditProgramRevision({ programRef: row.programRef, revision: BigInt(row.revision),
    expectedVersion: BigInt(row.revision) - 1n,
    canonicalDefinition: canonicalCreditProgramDefinitionFromBytes(row.definitionBytes),
    publishedAt: new Date(row.publishedAt).toISOString() });
  if (value.target.revisionDigest !== row.revisionDigest) throw new Error("CREDIT_PROGRAM_PERSISTED_DIGEST_INVALID");
  return value;
}
function snapshot(row: SnapshotRow | undefined): CreditProgramCatalogSnapshot {
  if (row === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(row.currentEpoch) ||
      !/^sha256:[0-9a-f]{64}$/u.test(row.snapshotDigest)) throw new Error("CREDIT_PROGRAM_SNAPSHOT_INVALID");
  const epoch = BigInt(row.currentEpoch);
  return Object.freeze({ ref: `credit-program-snapshot:${epoch.toString()}`,
    digest: row.snapshotDigest, epoch });
}
function requireGlobal(permit: CreditProgramCatalogReadPermit): void {
  if (permit.operation !== "credit.program.read" ||
      (permit.scope !== "global" && permit.scope !== "breakglass")) {
    throw new Error("CREDIT_PROGRAM_GLOBAL_QUERY_REQUIRED");
  }
}
function receiptTarget(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CREDIT_PROGRAM_COMMAND_RECEIPT_INVALID");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.programRef !== "string" || typeof row.revision !== "string" ||
      typeof row.revisionDigest !== "string") throw new Error("CREDIT_PROGRAM_COMMAND_RECEIPT_INVALID");
  return Object.freeze({ programRef: row.programRef, revision: BigInt(row.revision),
    revisionDigest: row.revisionDigest });
}
