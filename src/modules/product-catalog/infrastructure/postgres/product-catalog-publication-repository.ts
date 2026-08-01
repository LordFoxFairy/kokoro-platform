import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type {
  ProductCatalogPublicationRepository,
  ProductPublicationAuditFacts,
} from "../../application/contracts/product-catalog-publication-repository.js";
import {
  resolveLaunchProductProfileRevision,
  resolveProductSurfaceCatalogRevision,
  type ImmutableRevisionBinding,
  type PublishedLaunchProductProfileRevision,
  type PublishedProductSurfaceCatalogRevision,
  type PublicationStateSnapshot,
} from "../../domain/product-publication.js";

interface HeadRow extends Record<string, unknown> { headRevision: string }
interface RevisionRow extends Record<string, unknown> {
  ref: string;
  revision: string;
  digest: string;
  canonicalPayload: unknown;
  canonicalBytes: Uint8Array;
  catalogRevisionRef?: string;
  catalogRevision?: string;
  catalogDigest?: string;
}

export class PostgresProductCatalogPublicationRepository
  implements ProductCatalogPublicationRepository {
  async loadCatalogStateForUpdate(
    transaction: PlatformTransaction,
    binding: ImmutableRevisionBinding,
  ): Promise<PublicationStateSnapshot<PublishedProductSurfaceCatalogRevision>> {
    const sql = resolvePlatformTransaction(transaction);
    const head = await lockHead(sql, "catalog");
    const rows = await sql.query<RevisionRow>(
      `SELECT catalog_revision_ref AS ref, revision::text, digest,
              canonical_payload AS "canonicalPayload", canonical_bytes AS "canonicalBytes"
       FROM platform.product_surface_catalog_revision
       WHERE catalog_revision_ref=$1 AND revision=$2::numeric(20,0)`,
      [binding.ref, binding.revision.toString()],
    );
    return Object.freeze({ headRevision: head, existing: rows[0] === undefined
      ? null : catalogRevision(rows[0]) });
  }

  async loadProfileStateForUpdate(
    transaction: PlatformTransaction,
    binding: ImmutableRevisionBinding,
  ): Promise<PublicationStateSnapshot<PublishedLaunchProductProfileRevision>> {
    const sql = resolvePlatformTransaction(transaction);
    const head = await lockHead(sql, "profile");
    const rows = await sql.query<RevisionRow>(
      `SELECT profile_revision_ref AS ref, revision::text, digest,
              canonical_payload AS "canonicalPayload", canonical_bytes AS "canonicalBytes",
              catalog_revision_ref AS "catalogRevisionRef",catalog_revision::text AS "catalogRevision",
              catalog_digest AS "catalogDigest"
       FROM platform.launch_product_profile_revision
       WHERE profile_revision_ref=$1 AND revision=$2::numeric(20,0)`,
      [binding.ref, binding.revision.toString()],
    );
    return Object.freeze({ headRevision: head, existing: rows[0] === undefined
      ? null : profileRevision(rows[0]) });
  }

  async loadPublishedCatalog(
    transaction: PlatformTransaction,
    binding: ImmutableRevisionBinding,
  ): Promise<PublishedProductSurfaceCatalogRevision | null> {
    const rows = await resolvePlatformTransaction(transaction).query<RevisionRow>(
      `SELECT catalog_revision_ref AS ref, revision::text, digest,
              canonical_payload AS "canonicalPayload", canonical_bytes AS "canonicalBytes"
       FROM platform.product_surface_catalog_revision
       WHERE catalog_revision_ref=$1 AND revision=$2::numeric(20,0) AND digest=$3`,
      [binding.ref, binding.revision.toString(), binding.digest],
    );
    return rows[0] === undefined ? null : catalogRevision(rows[0]);
  }

  async persistCatalog(
    transaction: PlatformTransaction,
    revision: PublishedProductSurfaceCatalogRevision,
    audit: ProductPublicationAuditFacts,
  ): Promise<void> {
    const sql = resolvePlatformTransaction(transaction);
    await sql.execute(
      `INSERT INTO platform.product_surface_catalog_revision
       (catalog_revision_ref,revision,digest,canonical_payload,canonical_bytes,published_at,published_by,command_id)
       VALUES ($1,$2::numeric(20,0),$3,$4::jsonb,$5,$6::timestamptz,$7,$8)`,
      [revision.binding.ref, revision.binding.revision.toString(), revision.binding.digest,
        JSON.stringify(revision.document), revision.canonicalBytes, revision.publishedAt,
        audit.actorSubjectId, audit.commandId],
    );
    await advanceHead(sql, "catalog", revision.binding, audit.expectedHeadRevision);
    await recordAudit(sql, revision.binding, null, audit);
  }

  async persistProfile(
    transaction: PlatformTransaction,
    revision: PublishedLaunchProductProfileRevision,
    audit: ProductPublicationAuditFacts,
  ): Promise<void> {
    const sql = resolvePlatformTransaction(transaction);
    await sql.execute(
      `INSERT INTO platform.launch_product_profile_revision
       (profile_revision_ref,revision,digest,canonical_payload,canonical_bytes,
        catalog_revision_ref,catalog_revision,catalog_digest,target_site_kind_ref,
        published_at,published_by,command_id)
       VALUES ($1,$2::numeric(20,0),$3,$4::jsonb,$5,$6,$7::numeric(20,0),$8,$9,$10::timestamptz,$11,$12)`,
      [revision.binding.ref, revision.binding.revision.toString(), revision.binding.digest,
        JSON.stringify(revision.document), revision.canonicalBytes,
        revision.productSurfaceCatalog.ref, revision.productSurfaceCatalog.revision.toString(),
        revision.productSurfaceCatalog.digest, revision.document.targetSiteKindRef,
        revision.publishedAt, audit.actorSubjectId, audit.commandId],
    );
    await advanceHead(sql, "profile", revision.binding, audit.expectedHeadRevision);
    await recordAudit(sql, revision.binding, revision.productSurfaceCatalog, audit);
  }

  async recordReplay(
    transaction: PlatformTransaction,
    binding: ImmutableRevisionBinding,
    catalogBinding: ImmutableRevisionBinding | null,
    audit: ProductPublicationAuditFacts,
  ): Promise<void> {
    await recordAudit(resolvePlatformTransaction(transaction), binding, catalogBinding, audit);
  }
}

type Sql = ReturnType<typeof resolvePlatformTransaction>;

async function lockHead(sql: Sql, kind: "catalog" | "profile"): Promise<bigint> {
  const rows = await sql.query<HeadRow>(
    `SELECT head_revision::text AS "headRevision"
     FROM platform.product_catalog_publication_head WHERE publication_kind=$1 FOR UPDATE`, [kind],
  );
  if (rows[0] === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(rows[0].headRevision)) {
    throw new Error("PRODUCT_PUBLICATION_HEAD_MISSING");
  }
  return BigInt(rows[0].headRevision);
}

async function advanceHead(
  sql: Sql,
  kind: "catalog" | "profile",
  binding: ImmutableRevisionBinding,
  expected: bigint,
): Promise<void> {
  const changed = await sql.execute(
    `UPDATE platform.product_catalog_publication_head
     SET head_revision=$1::numeric(20,0),head_ref=$2,head_digest=$3,updated_at=clock_timestamp()
     WHERE publication_kind=$4 AND head_revision=$5::numeric(20,0)`,
    [binding.revision.toString(), binding.ref, binding.digest, kind, expected.toString()],
  );
  if (changed !== 1) throw new Error("PRODUCT_PUBLICATION_HEAD_CONFLICT");
}

async function recordAudit(
  sql: Sql,
  binding: ImmutableRevisionBinding,
  catalog: ImmutableRevisionBinding | null,
  audit: ProductPublicationAuditFacts,
): Promise<void> {
  await sql.execute(
    `INSERT INTO platform.product_catalog_publication_audit
     (command_id,operation,revision_ref,revision,digest,catalog_revision_ref,catalog_revision,
      catalog_digest,expected_head_revision,reason,actor_subject_id,environment,region,replayed)
     VALUES ($1,$2,$3,$4::numeric(20,0),$5,$6,$7::numeric(20,0),$8,
             $9::numeric(20,0),$10,$11,$12,$13,$14)
     ON CONFLICT (command_id) DO NOTHING`,
    [audit.commandId, audit.operation, binding.ref, binding.revision.toString(), binding.digest,
      catalog?.ref ?? null, catalog?.revision.toString() ?? null, catalog?.digest ?? null,
      audit.expectedHeadRevision.toString(), audit.reason, audit.actorSubjectId,
      audit.environment, audit.region, audit.replayed],
  );
  const rows = await sql.query<AuditRow>(
    `SELECT operation,revision_ref AS "revisionRef",revision::text,digest,
            catalog_revision_ref AS "catalogRevisionRef",catalog_revision::text AS "catalogRevision",
            catalog_digest AS "catalogDigest",expected_head_revision::text AS "expectedHeadRevision",
            reason,actor_subject_id AS "actorSubjectId",environment,region,replayed
     FROM platform.product_catalog_publication_audit WHERE command_id=$1`,
    [audit.commandId],
  );
  const row = rows[0];
  if (row === undefined || row.operation !== audit.operation || row.revisionRef !== binding.ref ||
      row.revision !== binding.revision.toString() || row.digest !== binding.digest ||
      row.catalogRevisionRef !== (catalog?.ref ?? null) ||
      row.catalogRevision !== (catalog?.revision.toString() ?? null) ||
      row.catalogDigest !== (catalog?.digest ?? null) ||
      row.expectedHeadRevision !== audit.expectedHeadRevision.toString() ||
      row.reason !== audit.reason || row.actorSubjectId !== audit.actorSubjectId ||
      row.environment !== audit.environment || row.region !== audit.region ||
      row.replayed !== audit.replayed) {
    throw new Error("PRODUCT_PUBLICATION_AUDIT_CONFLICT");
  }
}

interface AuditRow extends Record<string, unknown> {
  operation: string;
  revisionRef: string;
  revision: string;
  digest: string;
  catalogRevisionRef: string | null;
  catalogRevision: string | null;
  catalogDigest: string | null;
  expectedHeadRevision: string;
  reason: string;
  actorSubjectId: string;
  environment: string;
  region: string;
  replayed: boolean;
}

function catalogRevision(row: RevisionRow): PublishedProductSurfaceCatalogRevision {
  return resolveProductSurfaceCatalogRevision(binding(row), {
    canonicalBytes: bytes(row.canonicalBytes), parsedDocument: row.canonicalPayload, digest: row.digest,
  });
}

function profileRevision(row: RevisionRow): PublishedLaunchProductProfileRevision {
  if (typeof row.catalogRevisionRef !== "string" || typeof row.catalogRevision !== "string" ||
      !/^[1-9][0-9]*$/u.test(row.catalogRevision) || typeof row.catalogDigest !== "string") {
    throw new Error("PRODUCT_PUBLICATION_PERSISTED_CATALOG_BINDING_INVALID");
  }
  return resolveLaunchProductProfileRevision(binding(row), Object.freeze({
    ref: row.catalogRevisionRef, revision: BigInt(row.catalogRevision), digest: row.catalogDigest,
  }), {
    canonicalBytes: bytes(row.canonicalBytes), parsedDocument: row.canonicalPayload, digest: row.digest,
  });
}

function binding(row: RevisionRow): ImmutableRevisionBinding {
  if (typeof row.ref !== "string" || !/^[1-9][0-9]*$/u.test(row.revision) ||
      typeof row.digest !== "string") throw new Error("PRODUCT_PUBLICATION_PERSISTED_REVISION_INVALID");
  return Object.freeze({ ref: row.ref, revision: BigInt(row.revision), digest: row.digest });
}

function bytes(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error("PRODUCT_PUBLICATION_PERSISTED_BYTES_INVALID");
  return new Uint8Array(value);
}
