import { createHash } from "node:crypto";
import {
  CommandReceiptRepository,
  canonicalCommandId,
  type CommandIdentity,
  type JsonValue,
} from "../../../../shared/outbox-inbox/receipt.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { ProductCatalogPublicationJournal } from
  "../../application/contracts/product-catalog-publication-journal.js";
import type { CompletedProductPublication } from
  "../../application/contracts/product-catalog-publication-journal.js";
import type {
  ProductPublicationCommand,
  ProductPublicationReceipt,
} from "../../application/product-publication-command.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";

export class PostgresProductCatalogPublicationJournal
  implements ProductCatalogPublicationJournal {
  constructor(
    private readonly receipts: Pick<CommandReceiptRepository, "begin" | "recordOutcome"> =
      new CommandReceiptRepository(),
  ) {}

  async findSucceeded(
    transaction: PlatformTransaction,
    command: ProductPublicationCommand,
  ): Promise<CompletedProductPublication | null> {
    return findAttestedPublication(transaction, command);
  }

  async begin(
    transaction: PlatformTransaction,
    command: ProductPublicationCommand,
  ): Promise<CompletedProductPublication | null> {
    const receipt = await this.receipts.begin(transaction, identity(command));
    if (receipt.state === "failed") throw new Error("PRODUCT_PUBLICATION_COMMAND_TERMINAL");
    if (receipt.state !== "succeeded") return null;
    const attested = await findAttestedPublication(transaction, command);
    if (attested === null) throw new Error("PRODUCT_PUBLICATION_OWNER_RECEIPT_MISSING");
    return attested;
  }

  async succeed(
    transaction: PlatformTransaction,
    command: ProductPublicationCommand,
    receipt: ProductPublicationReceipt,
  ): Promise<CompletedProductPublication> {
    const result: JsonValue = {
      schemaVersion: 1,
      commandId: command.commandId,
      requestDigest: command.requestDigest,
      operation: command.operation,
      binding: {
        ref: receipt.binding.ref,
        revision: receipt.binding.revision.toString(),
        digest: receipt.binding.digest,
      },
      publicationReplayed: receipt.replayed,
    };
    const sql = resolvePlatformTransaction(transaction);
    await sql.execute(
      `INSERT INTO platform.product_catalog_publication_receipt
       (command_id,operation,environment,region,caller_identity,idempotency_key,request_digest,
        revision_ref,revision,digest,catalog_revision_ref,catalog_revision,catalog_digest,
        publication_replayed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric(20,0),$10,$11,$12::numeric(20,0),$13,$14)
       ON CONFLICT (environment,caller_identity,operation,idempotency_key) DO NOTHING`,
      [command.commandId, command.operation, command.security.environment, command.security.region,
        command.security.callerIdentity, command.idempotencyKey, command.requestDigest,
        receipt.binding.ref, receipt.binding.revision.toString(), receipt.binding.digest,
        command.catalogBinding?.ref ?? null, command.catalogBinding?.revision.toString() ?? null,
        command.catalogBinding?.digest ?? null, receipt.replayed],
    );
    const attested = await findAttestedPublication(transaction, command);
    if (attested === null || attested.publicationReplayed !== receipt.replayed) {
      throw new Error("PRODUCT_PUBLICATION_OWNER_RECEIPT_NOT_PERSISTED");
    }
    await this.receipts.recordOutcome(transaction, identity(command), {
      state: "succeeded",
      result,
      resultDigest: createHash("sha256").update(stableJson(result)).digest("hex"),
    });
    return attested;
  }
}

interface AttestedPublicationRow extends Record<string, unknown> {
  commandId: string;
  operation: string;
  environment: string;
  region: string;
  callerIdentity: string;
  idempotencyKey: string;
  requestDigest: string;
  revisionRef: string;
  revision: string;
  digest: string;
  catalogRevisionRef: string | null;
  catalogRevision: string | null;
  catalogDigest: string | null;
  publicationReplayed: boolean;
  recordedAt: string | Date;
  auditOperation: string;
  auditRevisionRef: string;
  auditRevision: string;
  auditDigest: string;
  auditCatalogRevisionRef: string | null;
  auditCatalogRevision: string | null;
  auditCatalogDigest: string | null;
  auditExpectedHeadRevision: string;
  auditReason: string;
  auditActorSubjectId: string;
  auditEnvironment: string;
  auditRegion: string;
  auditReplayed: boolean;
  catalogRevisionPresent: boolean;
  profileRevisionPresent: boolean;
}

async function findAttestedPublication(
  transaction: PlatformTransaction,
  command: ProductPublicationCommand,
): Promise<CompletedProductPublication | null> {
  const expected = identity(command);
  const rows = await resolvePlatformTransaction(transaction).query<AttestedPublicationRow>(
    `SELECT receipt.command_id AS "commandId",receipt.operation,receipt.environment,receipt.region,
            receipt.caller_identity AS "callerIdentity",receipt.idempotency_key AS "idempotencyKey",
            receipt.request_digest AS "requestDigest",receipt.revision_ref AS "revisionRef",
            receipt.revision::text,receipt.digest,
            receipt.catalog_revision_ref AS "catalogRevisionRef",
            receipt.catalog_revision::text AS "catalogRevision",receipt.catalog_digest AS "catalogDigest",
            receipt.publication_replayed AS "publicationReplayed",receipt.recorded_at AS "recordedAt",
            audit.operation AS "auditOperation",audit.revision_ref AS "auditRevisionRef",
            audit.revision::text AS "auditRevision",audit.digest AS "auditDigest",
            audit.catalog_revision_ref AS "auditCatalogRevisionRef",
            audit.catalog_revision::text AS "auditCatalogRevision",
            audit.catalog_digest AS "auditCatalogDigest",
            audit.expected_head_revision::text AS "auditExpectedHeadRevision",
            audit.reason AS "auditReason",audit.actor_subject_id AS "auditActorSubjectId",
            audit.environment AS "auditEnvironment",audit.region AS "auditRegion",
            audit.replayed AS "auditReplayed",
            catalog.catalog_revision_ref IS NOT NULL AS "catalogRevisionPresent",
            profile.profile_revision_ref IS NOT NULL AS "profileRevisionPresent"
     FROM platform.product_catalog_publication_receipt receipt
     JOIN platform.product_catalog_publication_audit audit ON audit.command_id=receipt.command_id
     LEFT JOIN platform.product_surface_catalog_revision catalog
       ON receipt.operation='product.catalog.publish'
      AND catalog.catalog_revision_ref=receipt.revision_ref
      AND catalog.revision=receipt.revision AND catalog.digest=receipt.digest
     LEFT JOIN platform.launch_product_profile_revision profile
       ON receipt.operation='product.launch-profile.publish'
      AND profile.profile_revision_ref=receipt.revision_ref
      AND profile.revision=receipt.revision AND profile.digest=receipt.digest
      AND profile.catalog_revision_ref=receipt.catalog_revision_ref
      AND profile.catalog_revision=receipt.catalog_revision AND profile.catalog_digest=receipt.catalog_digest
     WHERE receipt.environment=$1 AND receipt.caller_identity=$2
       AND receipt.operation=$3 AND receipt.idempotency_key=$4`,
    [expected.environment, expected.callerIdentity, expected.operation, expected.idempotencyKey],
  );
  const row = rows[0];
  if (row === undefined) return null;
  assertAttestation(row, command);
  return Object.freeze({
    binding: command.binding,
    publicationReplayed: row.publicationReplayed,
    recordedAt: canonicalInstant(row.recordedAt),
  });
}

function assertAttestation(row: AttestedPublicationRow, command: ProductPublicationCommand): void {
  const catalog = command.catalogBinding;
  const catalogRevision = catalog?.revision.toString() ?? null;
  const revision = command.binding.revision.toString();
  if (canonicalCommandId(row.commandId) !== command.commandId || row.operation !== command.operation ||
      row.environment !== command.security.environment || row.region !== command.security.region ||
      row.callerIdentity !== command.security.callerIdentity || row.idempotencyKey !== command.idempotencyKey ||
      row.requestDigest !== command.requestDigest || row.revisionRef !== command.binding.ref ||
      row.revision !== revision || row.digest !== command.binding.digest ||
      row.catalogRevisionRef !== (catalog?.ref ?? null) || row.catalogRevision !== catalogRevision ||
      row.catalogDigest !== (catalog?.digest ?? null) ||
      row.auditOperation !== command.operation || row.auditRevisionRef !== command.binding.ref ||
      row.auditRevision !== revision || row.auditDigest !== command.binding.digest ||
      row.auditCatalogRevisionRef !== (catalog?.ref ?? null) ||
      row.auditCatalogRevision !== catalogRevision || row.auditCatalogDigest !== (catalog?.digest ?? null) ||
      row.auditExpectedHeadRevision !== command.expectedHeadRevision.toString() ||
      row.auditReason !== command.reason || row.auditActorSubjectId !== command.security.actorSubjectId ||
      row.auditEnvironment !== command.security.environment || row.auditRegion !== command.security.region ||
      row.auditReplayed !== row.publicationReplayed ||
      (command.operation === "product.catalog.publish" ? !row.catalogRevisionPresent : !row.profileRevisionPresent)) {
    throw new Error("PRODUCT_PUBLICATION_OWNER_ATTESTATION_INVALID");
  }
}

function canonicalInstant(value: string | Date): string {
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error("PRODUCT_PUBLICATION_RECEIPT_TIME_INVALID");
  return instant.toISOString();
}

function identity(command: ProductPublicationCommand): CommandIdentity {
  return {
    commandId: command.commandId,
    environment: command.security.environment,
    region: command.security.region,
    callerIdentity: command.security.callerIdentity,
    operation: command.operation,
    idempotencyKey: command.idempotencyKey,
    requestDigest: command.requestDigest,
  };
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}
