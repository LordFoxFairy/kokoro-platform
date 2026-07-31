import type {
  ArtifactDeliveryAuditRecord,
  ArtifactDeliveryAuditRepository,
  ArtifactDeliveryAuthorizationRepository,
  StoredArtifactDeliveryAuthorization,
} from "../../application/contracts.js";
import type { PlatformSqlTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";

export type ArtifactDeliveryDatabaseOperation =
  | "artifact.delivery.authorization.create"
  | "artifact.delivery.authorization.read"
  | "artifact.delivery.authorization.revoke"
  | "artifact.delivery.audit.begin"
  | "artifact.delivery.audit.complete-stream"
  | "artifact.delivery.audit.fail";

export interface ArtifactDeliveryPostgresDatabase {
  transaction<Result>(operation: ArtifactDeliveryDatabaseOperation,
    work: (sql: PlatformSqlTransaction) => Promise<Result>): Promise<Result>;
}

interface AuthorizationRow extends Record<string, unknown> {
  authorizationRef: string;
  capabilityDigest: string;
  siteRef: string;
  subjectRef: string;
  subjectGeneration: bigint | string;
  projectRef: string;
  artifactRef: string;
  artifactVersionRef: string;
  purpose: StoredArtifactDeliveryAuthorization["purpose"];
  suggestedFileName: string | null;
  audience: StoredArtifactDeliveryAuthorization["audience"];
  siteReleaseRef: string;
  workloadIdentityRef: string;
  workloadBindingEpoch: bigint | string;
  siteSecurityEpoch: bigint | string;
  issuedAt: Date | string;
  expiresAt: Date | string;
  revocationEpoch: bigint | string;
  revokedAt: Date | string | null;
}

/**
 * Durable Artifact owner adapter. The data-plane login receives only the read
 * and audit routine grants; issue/revoke are the same adapter under Platform
 * Public's separate database identity.
 */
export class PostgresArtifactDeliveryRepository
implements ArtifactDeliveryAuthorizationRepository, ArtifactDeliveryAuditRepository {
  constructor(private readonly database: ArtifactDeliveryPostgresDatabase) {}

  create(record: StoredArtifactDeliveryAuthorization): Promise<void> {
    return this.database.transaction("artifact.delivery.authorization.create", async (sql) => {
      const rows = await sql.query<Record<string, unknown>>(
        `SELECT platform.create_artifact_delivery_authorization(
          $1,$2,$3,$4,$5::bigint,$6,$7,$8,$9,$10,$11,$12,$13,$14::bigint,$15::bigint,
          $16::timestamptz,$17::timestamptz,$18::bigint
        ) AS created`,
        [record.authorizationRef, record.capabilityDigest, record.ownerScope.siteRef,
          record.ownerScope.subjectRef, record.ownerScope.subjectGeneration,
          record.ownerScope.projectRef, record.artifactRef, record.artifactVersionRef,
          record.purpose, record.audience, record.suggestedFileName ?? null,
          record.workload.siteReleaseRef, record.workload.workloadIdentityRef,
          record.workload.workloadBindingEpoch,
          record.workload.siteSecurityEpoch, record.issuedAt, record.expiresAt,
          record.revocationEpoch],
      );
      if (rows.length !== 1 || rows[0]?.created !== true) {
        throw new Error("ARTIFACT_DELIVERY_AUTHORIZATION_CREATE_UNCONFIRMED");
      }
    });
  }

  findByCapabilityDigest(capabilityDigest: string): Promise<StoredArtifactDeliveryAuthorization | null> {
    return this.find("artifact.delivery.authorization.read",
      "platform.find_artifact_delivery_authorization_by_capability($1)", [capabilityDigest]);
  }

  findByReference(authorizationRef: string): Promise<StoredArtifactDeliveryAuthorization | null> {
    return this.find("artifact.delivery.authorization.read",
      "platform.find_artifact_delivery_authorization_by_reference($1)", [authorizationRef]);
  }

  revoke(input: Parameters<ArtifactDeliveryAuthorizationRepository["revoke"]>[0]):
  Promise<StoredArtifactDeliveryAuthorization | null> {
    return this.database.transaction("artifact.delivery.authorization.revoke", async (sql) => {
      const rows = await sql.query<AuthorizationRow>(
        `${AUTHORIZATION_COLUMNS}
         FROM platform.revoke_artifact_delivery_authorization($1,$2::timestamptz,$3::bigint) item`,
        [input.authorizationRef, input.revokedAt, input.expectedRevocationEpoch],
      );
      return oneAuthorization(rows);
    });
  }

  begin(record: ArtifactDeliveryAuditRecord): Promise<void> {
    if (record.state !== "pending") throw new Error("ARTIFACT_DELIVERY_AUDIT_STATE_INVALID");
    return this.database.transaction("artifact.delivery.audit.begin", async (sql) => {
      const rows = await sql.query<Record<string, unknown>>(
        `SELECT platform.begin_artifact_delivery_redemption(
          $1,$2,$3,$4,$5,$6,$7::bigint,$8::bigint,$9
        ) AS started`,
        [record.redemptionRef, record.authorizationRef, record.requestRef,
          record.workload.siteRef, record.workload.siteReleaseRef,
          record.workload.workloadIdentityRef, record.workload.workloadBindingEpoch,
          record.workload.siteSecurityEpoch, record.rangeHeader ?? null],
      );
      if (rows.length !== 1 || rows[0]?.started !== true) {
        throw new Error("ARTIFACT_DELIVERY_AUDIT_BEGIN_UNCONFIRMED");
      }
    });
  }

  completeStream(input: Parameters<ArtifactDeliveryAuditRepository["completeStream"]>[0]): Promise<void> {
    return this.terminal("artifact.delivery.audit.complete-stream",
      "platform.complete_artifact_delivery_stream($1,$2::bigint)",
      [input.redemptionRef, input.bytesEmitted]);
  }

  fail(input: Parameters<ArtifactDeliveryAuditRepository["fail"]>[0]): Promise<void> {
    return this.terminal("artifact.delivery.audit.fail",
      "platform.fail_artifact_delivery_stream($1,$2)",
      [input.redemptionRef, input.failureCode]);
  }

  private find(operation: ArtifactDeliveryDatabaseOperation, routine: string,
    values: readonly unknown[]): Promise<StoredArtifactDeliveryAuthorization | null> {
    return this.database.transaction(operation, async (sql) => {
      const rows = await sql.query<AuthorizationRow>(
        `${AUTHORIZATION_COLUMNS} FROM ${routine} item`, values,
      );
      return oneAuthorization(rows);
    });
  }

  private terminal(operation: ArtifactDeliveryDatabaseOperation, routine: string,
    values: readonly unknown[]): Promise<void> {
    return this.database.transaction(operation, async (sql) => {
      const rows = await sql.query<Record<string, unknown>>(`SELECT ${routine} AS changed`, values);
      if (rows.length !== 1 || rows[0]?.changed !== true) {
        throw new Error("ARTIFACT_DELIVERY_AUDIT_TERMINAL_CONFLICT");
      }
    });
  }
}

const AUTHORIZATION_COLUMNS = `SELECT
  item.authorization_ref AS "authorizationRef",item.capability_digest AS "capabilityDigest",
  item.site_ref AS "siteRef",item.subject_ref AS "subjectRef",
  item.subject_generation AS "subjectGeneration",item.project_ref AS "projectRef",
  item.artifact_ref AS "artifactRef",item.artifact_version_ref AS "artifactVersionRef",
  item.purpose,item.suggested_file_name AS "suggestedFileName",item.audience,
  item.site_release_ref AS "siteReleaseRef",
  item.workload_identity_ref AS "workloadIdentityRef",
  item.workload_binding_epoch AS "workloadBindingEpoch",
  item.site_security_epoch AS "siteSecurityEpoch",item.issued_at AS "issuedAt",
  item.expires_at AS "expiresAt",item.revocation_epoch AS "revocationEpoch",
  item.revoked_at AS "revokedAt"`;

function oneAuthorization(rows: readonly AuthorizationRow[]): StoredArtifactDeliveryAuthorization | null {
  if (rows.length > 1) throw new Error("ARTIFACT_DELIVERY_AUTHORIZATION_AMBIGUOUS");
  const row = rows[0];
  if (row === undefined) return null;
  return Object.freeze({
    authorizationRef: text(row.authorizationRef), capabilityDigest: digest(row.capabilityDigest),
    ownerScope: Object.freeze({ siteRef: text(row.siteRef), subjectRef: text(row.subjectRef),
      subjectGeneration: positive(row.subjectGeneration), projectRef: text(row.projectRef) }),
    artifactRef: text(row.artifactRef), artifactVersionRef: text(row.artifactVersionRef),
    purpose: purpose(row.purpose), audience: audience(row.audience),
    ...(row.suggestedFileName === null ? {} : {
      suggestedFileName: suggestedFileName(row.suggestedFileName),
    }),
    workload: Object.freeze({ siteRef: text(row.siteRef), siteReleaseRef: text(row.siteReleaseRef),
      workloadIdentityRef: text(row.workloadIdentityRef),
      workloadBindingEpoch: positive(row.workloadBindingEpoch),
      siteSecurityEpoch: positive(row.siteSecurityEpoch) }),
    issuedAt: instant(row.issuedAt), expiresAt: instant(row.expiresAt),
    revocationEpoch: positive(row.revocationEpoch),
    ...(row.revokedAt === null ? {} : { revokedAt: instant(row.revokedAt) }),
  });
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.trim() !== value ||
      [...value].some((character) => (character.codePointAt(0) ?? 0) < 32)) {
    throw new Error("ARTIFACT_DELIVERY_DATABASE_RECORD_INVALID");
  }
  return value;
}
function digest(value: unknown): string {
  const parsed = text(value);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) throw new Error("ARTIFACT_DELIVERY_DATABASE_RECORD_INVALID");
  return parsed;
}
function positive(value: unknown): bigint {
  const parsed = typeof value === "bigint" ? value : typeof value === "string" && /^[0-9]+$/u.test(value)
    ? BigInt(value) : 0n;
  if (parsed < 1n || parsed > 9_223_372_036_854_775_807n) {
    throw new Error("ARTIFACT_DELIVERY_DATABASE_RECORD_INVALID");
  }
  return parsed;
}
function instant(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (!Number.isFinite(date.getTime())) throw new Error("ARTIFACT_DELIVERY_DATABASE_RECORD_INVALID");
  return date.toISOString();
}
function purpose(value: unknown): StoredArtifactDeliveryAuthorization["purpose"] {
  if (value !== "preview" && value !== "download" && value !== "export") {
    throw new Error("ARTIFACT_DELIVERY_DATABASE_RECORD_INVALID");
  }
  return value;
}
function audience(value: unknown): StoredArtifactDeliveryAuthorization["audience"] {
  if (value !== "site-bff.artifact-delivery") throw new Error("ARTIFACT_DELIVERY_DATABASE_RECORD_INVALID");
  return value;
}

function suggestedFileName(value: unknown): string {
  const parsed = text(value);
  if (parsed.length > 255 || parsed.includes("/") || parsed.includes("\\") ||
      hasControlCharacter(parsed)) {
    throw new Error("ARTIFACT_DELIVERY_DATABASE_RECORD_INVALID");
  }
  return parsed;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}
