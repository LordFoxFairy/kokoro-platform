import { AdmissionRetryClass } from "../../../../interfaces/connect/generated/kokoro/platform/admission/v1/admission_pb.js";
import { signedCredentialDigest } from "../../../authorization/application/contracts/authorization-digest.js";
import type { SessionGrantResource } from "../../../authorization/domain/session-access-grant.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type {
  AdmissionOwnerResolution,
  AdmissionSessionGrantOwnerPort,
} from "../../application/platform-admission-owner-authority.js";

const MAX_CREDENTIAL_BYTES = 16 * 1024;

interface GrantAuthorityRow extends Record<string, unknown> {
  readonly siteId: unknown;
  readonly projectRef: unknown;
  readonly subjectRef: unknown;
  readonly subjectGeneration: unknown;
  readonly resource: unknown;
}

/**
 * Verifies possession of the exact delivered SessionAccessGrant against
 * Platform's current authorization owners. No identity or project claim is
 * accepted from Session's RPC response.
 */
export class PostgresAdmissionSessionGrantOwner implements AdmissionSessionGrantOwnerPort {
  async resolve(
    transaction: Parameters<AdmissionSessionGrantOwnerPort["resolve"]>[0],
    input: Parameters<AdmissionSessionGrantOwnerPort["resolve"]>[1],
  ): ReturnType<AdmissionSessionGrantOwnerPort["resolve"]> {
    if (!boundedCredential(input.credential)) {
      return denied("ADMISSION_SESSION_ACCESS_GRANT_INVALID");
    }
    const rows = await resolvePlatformTransaction(transaction).query<GrantAuthorityRow>(
      `SELECT grant.site_ref AS "siteId",grant.project_ref AS "projectRef",
              grant.subject_ref AS "subjectRef",grant.subject_generation AS "subjectGeneration",
              grant.resource
         FROM platform.authorization_session_access_grant AS grant
         JOIN platform.authorization_product_binding AS binding
           ON binding.binding_ref=grant.binding_ref
          AND binding.site_ref=grant.site_ref
          AND binding.release_ref=$4
          AND binding.state='active'
         JOIN platform.authorization_site_release AS release
           ON release.release_ref=binding.release_ref
          AND release.site_ref=binding.site_ref
          AND release.state='active'
         JOIN platform.authorization_site AS site
           ON site.site_ref=grant.site_ref
          AND site.state='active'
          AND site.security_epoch=grant.site_security_epoch
          AND site.policy_epoch=grant.policy_epoch
          AND site.revocation_epoch=grant.revocation_epoch
         JOIN platform.authorization_subject AS subject
           ON subject.subject_ref=grant.subject_ref
          AND subject.site_ref=grant.site_ref
          AND subject.state='active'
          AND subject.subject_generation=grant.subject_generation
          AND subject.restriction_epoch=grant.restriction_epoch
         JOIN platform.authorization_identity_session AS identity_session
           ON identity_session.session_ref=grant.identity_session_ref
          AND identity_session.subject_ref=grant.subject_ref
          AND identity_session.site_ref=grant.site_ref
          AND identity_session.state='active'
          AND identity_session.session_epoch=grant.identity_session_epoch
          AND identity_session.credential_epoch=grant.credential_epoch
          AND identity_session.expires_at>statement_timestamp()
         JOIN platform.authorization_project AS project
           ON project.project_ref=grant.project_ref
          AND project.site_ref=grant.site_ref
          AND project.state='active'
         JOIN platform.authorization_project_membership AS membership
           ON membership.project_ref=grant.project_ref
          AND membership.subject_ref=grant.subject_ref
          AND membership.state='active'
          AND membership.membership_epoch=grant.membership_epoch
          AND membership.authorization_epoch=grant.authorization_epoch
        WHERE grant.credential_digest=$1
          AND grant.site_ref=$2 AND grant.project_ref=$3
          AND grant.delivery_state='delivered'
          AND grant.purpose='write' AND grant.audience='session.write'
          AND grant.not_before<=statement_timestamp()
          AND grant.expires_at>statement_timestamp()
        LIMIT 2
        FOR SHARE OF grant,binding,release,site,subject,identity_session,project,membership`,
      [signedCredentialDigest(input.credential), input.siteId, input.projectRef,
        input.configurationRevisionId],
    );
    if (rows.length > 1) throw new Error("ADMISSION_SESSION_ACCESS_GRANT_AMBIGUOUS");
    const row = rows[0];
    if (row === undefined) return denied("ADMISSION_SESSION_ACCESS_GRANT_NOT_AUTHORIZED");
    const subjectGeneration = positiveBigint(row.subjectGeneration);
    if (
      row.siteId !== input.siteId || row.projectRef !== input.projectRef ||
      !ownerRef(row.subjectRef) || subjectGeneration === undefined ||
      !resourceAuthorizes(row.resource, input.sessionId, input.runId)
    ) return denied("ADMISSION_SESSION_ACCESS_GRANT_NOT_AUTHORIZED");
    return Object.freeze({
      kind: "resolved",
      value: Object.freeze({ subjectRef: row.subjectRef, subjectGeneration }),
    });
  }
}

function resourceAuthorizes(value: unknown, sessionId: string, runId: string): value is SessionGrantResource {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const resource = value as Record<string, unknown>;
  const keys = Object.keys(resource).sort();
  if (resource.kind === "project") return keys.length === 1 && keys[0] === "kind";
  if (resource.kind === "session") {
    return keys.length === 2 && keys[0] === "kind" && keys[1] === "sessionRef" &&
      resource.sessionRef === sessionId;
  }
  return resource.kind === "run" && keys.length === 3 && keys[0] === "kind" &&
    keys[1] === "runRef" && keys[2] === "sessionRef" &&
    resource.sessionRef === sessionId && resource.runRef === runId;
}

function boundedCredential(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_CREDENTIAL_BYTES;
}

function ownerRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value;
}

function positiveBigint(value: unknown): bigint | undefined {
  try {
    const parsed = BigInt(value as bigint | string | number);
    return parsed > 0n ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function denied(code: string): AdmissionOwnerResolution<never> {
  return Object.freeze({ kind: "denied", denial: Object.freeze({
    code,
    retryClass: AdmissionRetryClass.NEVER,
  }) });
}
