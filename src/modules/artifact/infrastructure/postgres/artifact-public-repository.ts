import type { PlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type {
  ArtifactPublicRepository,
  ArtifactSummaryRecord,
  ArtifactVersionRecord,
  StoredArtifactDeliveryAuthorization,
} from "../../application/contracts.js";

export class PostgresArtifactPublicRepository implements ArtifactPublicRepository {
  async listArtifacts(transaction: PlatformTransaction, input: Readonly<{
    createdBefore: string | null;
    artifactRefBefore: string | null;
    limit: number;
  }>): Promise<readonly ArtifactSummaryRecord[]> {
    return resolvePlatformTransaction(transaction).query<ArtifactSummaryRecord>(
      `SELECT artifact_ref AS "artifactRef",current_artifact_version_ref AS "currentArtifactVersionRef",
              availability,title,created_at AS "createdAt",updated_at AS "updatedAt"
       FROM platform.list_owned_artifacts($1::timestamptz,$2,$3)`,
      [input.createdBefore, input.artifactRefBefore, input.limit],
    );
  }

  async getArtifact(transaction: PlatformTransaction, artifactRef: string):
  Promise<ArtifactSummaryRecord | null> {
    const rows = await resolvePlatformTransaction(transaction).query<ArtifactSummaryRecord>(
      `SELECT artifact_ref AS "artifactRef",current_artifact_version_ref AS "currentArtifactVersionRef",
              availability,title,created_at AS "createdAt",updated_at AS "updatedAt"
       FROM platform.get_owned_artifact($1)`, [artifactRef],
    );
    return one(rows, "ARTIFACT_QUERY_AMBIGUOUS");
  }

  async listVersions(transaction: PlatformTransaction, input: Readonly<{
    artifactRef: string;
    createdBefore: string | null;
    artifactVersionRefBefore: string | null;
    limit: number;
  }>): Promise<readonly ArtifactVersionRecord[]> {
    return resolvePlatformTransaction(transaction).query<ArtifactVersionRecord>(
      `${VERSION_SELECT} FROM platform.list_owned_artifact_versions($1,$2::timestamptz,$3,$4) item`,
      [input.artifactRef, input.createdBefore, input.artifactVersionRefBefore, input.limit],
    );
  }

  async getVersion(transaction: PlatformTransaction, artifactRef: string, artifactVersionRef: string):
  Promise<ArtifactVersionRecord | null> {
    const rows = await resolvePlatformTransaction(transaction).query<ArtifactVersionRecord>(
      `${VERSION_SELECT} FROM platform.get_owned_artifact_version($1,$2) item`,
      [artifactRef, artifactVersionRef],
    );
    return one(rows, "ARTIFACT_VERSION_QUERY_AMBIGUOUS");
  }

  async createAuthorization(transaction: PlatformTransaction,
    record: StoredArtifactDeliveryAuthorization): Promise<void> {
    const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown>>(
      `SELECT platform.create_artifact_delivery_authorization(
        $1,$2,$3,$4,$5::bigint,$6,$7,$8,$9,$10,$11,$12,$13,$14::bigint,$15::bigint,
        $16::timestamptz,$17::timestamptz,$18::bigint
      ) AS created`,
      [record.authorizationRef, record.capabilityDigest, record.ownerScope.siteRef,
        record.ownerScope.subjectRef, record.ownerScope.subjectGeneration, record.ownerScope.projectRef,
        record.artifactRef, record.artifactVersionRef, record.purpose, record.audience,
        record.suggestedFileName ?? null, record.workload.siteReleaseRef,
        record.workload.workloadIdentityRef,
        record.workload.workloadBindingEpoch, record.workload.siteSecurityEpoch,
        record.issuedAt, record.expiresAt, record.revocationEpoch],
    );
    if (rows.length !== 1 || rows[0]?.created !== true) {
      throw new Error("ARTIFACT_DELIVERY_AUTHORIZATION_CREATE_UNCONFIRMED");
    }
  }

  async revokeAuthorization(transaction: PlatformTransaction, input: Readonly<{
    authorizationRef: string;
    revokedAt: string;
    reason?: string | undefined;
  }>): Promise<Readonly<{ state: "revoked" | "already_revoked" | "expired"; revokedAt: string }> | null> {
    const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown>>(
      `SELECT state,revoked_at AS "revokedAt"
       FROM platform.revoke_owned_artifact_delivery_authorization($1,$2::timestamptz,$3)`,
      [input.authorizationRef, input.revokedAt, input.reason ?? null],
    );
    const row = one(rows, "ARTIFACT_DELIVERY_REVOCATION_AMBIGUOUS");
    if (row === null) return null;
    if (row.state !== "revoked" && row.state !== "already_revoked" && row.state !== "expired") {
      throw new Error("ARTIFACT_DELIVERY_REVOCATION_RECORD_INVALID");
    }
    return Object.freeze({ state: row.state, revokedAt: instant(row.revokedAt) });
  }
}

const VERSION_SELECT = `SELECT item.artifact_ref AS "artifactRef",
  item.artifact_version_ref AS "artifactVersionRef",item.availability,
  item.owner_version AS "ownerVersion",item.version_number AS "versionNumber",
  item.source_artifact_version_refs AS "sourceArtifactVersionRefs",item.byte_size AS "byteSize",
  item.media_type AS "mediaType",item.width,item.height,item.created_at AS "createdAt"`;

function one<Row>(rows: readonly Row[], code: string): Row | null {
  if (rows.length > 1) throw new Error(code);
  return rows[0] ?? null;
}
function instant(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (!Number.isFinite(date.getTime())) throw new Error("ARTIFACT_DELIVERY_REVOCATION_RECORD_INVALID");
  return date.toISOString();
}
