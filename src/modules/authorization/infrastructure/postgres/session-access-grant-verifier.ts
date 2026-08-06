import { signedCredentialDigest } from "../../application/contracts/authorization-digest.js";
import type {
  SessionAccessGrantVerifierPort,
  VerifiedSessionAccessGrantAuthority,
} from "../../application/contracts/session-access-grant-verifier.js";
import { SESSION_ACCESS_AUDIENCES, type SessionGrantResource } from "../../domain/session-access-grant.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";

const MAX_CREDENTIAL_BYTES = 16 * 1024;

interface GrantAuthorityRow extends Record<string, unknown> {
  readonly siteId: unknown;
  readonly siteReleaseRef: unknown;
  readonly projectRef: unknown;
  readonly subjectRef: unknown;
  readonly subjectGeneration: unknown;
  readonly identitySessionRef: unknown;
  readonly resource: unknown;
}

/**
 * Resolves the opaque delivered credential against every current Authorization
 * owner. Consumers receive derived facts only; no caller-supplied owner axis is
 * accepted as authority.
 */
export class PostgresSessionAccessGrantVerifier implements SessionAccessGrantVerifierPort {
  async verify(
    transaction: Parameters<SessionAccessGrantVerifierPort["verify"]>[0],
    input: Parameters<SessionAccessGrantVerifierPort["verify"]>[1],
  ): ReturnType<SessionAccessGrantVerifierPort["verify"]> {
    if (!boundedCredential(input.credential) || !ownerRef(input.siteId)) return null;
    const audience = SESSION_ACCESS_AUDIENCES[input.purpose];
    if (audience === undefined) return null;
    const rows = await resolvePlatformTransaction(transaction).query<GrantAuthorityRow>(
      `SELECT access_grant.site_ref AS "siteId",binding.release_ref AS "siteReleaseRef",
              access_grant.project_ref AS "projectRef",access_grant.subject_ref AS "subjectRef",
              access_grant.subject_generation AS "subjectGeneration",
              access_grant.identity_session_ref AS "identitySessionRef",access_grant.resource
         FROM platform.authorization_session_access_grant AS access_grant
         JOIN platform.authorization_product_binding AS binding
           ON binding.binding_ref=access_grant.binding_ref
          AND binding.site_ref=access_grant.site_ref
          AND binding.state='active'
          AND binding.environment=$5
          AND binding.region=$6
         JOIN platform.authorization_site_release AS release
           ON release.release_ref=binding.release_ref
          AND release.site_ref=binding.site_ref
          AND release.state='active'
         JOIN platform.authorization_site AS site
           ON site.site_ref=access_grant.site_ref
          AND site.state='active'
          AND site.security_epoch=access_grant.site_security_epoch
          AND site.policy_epoch=access_grant.policy_epoch
          AND site.revocation_epoch=access_grant.revocation_epoch
         JOIN platform.authorization_subject AS subject
           ON subject.subject_ref=access_grant.subject_ref
          AND subject.site_ref=access_grant.site_ref
          AND subject.state='active'
          AND subject.subject_generation=access_grant.subject_generation
          AND subject.restriction_epoch=access_grant.restriction_epoch
         JOIN platform.authorization_identity_session AS identity_session
           ON identity_session.session_ref=access_grant.identity_session_ref
          AND identity_session.subject_ref=access_grant.subject_ref
          AND identity_session.site_ref=access_grant.site_ref
          AND identity_session.state='active'
          AND identity_session.session_epoch=access_grant.identity_session_epoch
          AND identity_session.credential_epoch=access_grant.credential_epoch
          AND identity_session.expires_at>statement_timestamp()
         JOIN platform.authorization_project AS project
           ON project.project_ref=access_grant.project_ref
          AND project.site_ref=access_grant.site_ref
          AND project.state='active'
         JOIN platform.authorization_project_membership AS membership
           ON membership.project_ref=access_grant.project_ref
          AND membership.subject_ref=access_grant.subject_ref
          AND membership.state='active'
          AND membership.membership_epoch=access_grant.membership_epoch
          AND membership.authorization_epoch=access_grant.authorization_epoch
        WHERE access_grant.credential_digest=$1 AND access_grant.site_ref=$2
          AND access_grant.purpose=$3 AND access_grant.audience=$4
          AND access_grant.delivery_state='delivered'
          AND access_grant.not_before<=statement_timestamp()
          AND access_grant.expires_at>statement_timestamp()
        LIMIT 2`,
      [signedCredentialDigest(input.credential), input.siteId, input.purpose, audience,
        input.environment, input.region],
    );
    if (rows.length > 1) throw new Error("SESSION_ACCESS_GRANT_OWNER_AMBIGUOUS");
    const row = rows[0];
    if (row === undefined) return null;
    return authority(row, input.siteId);
  }
}

function authority(row: GrantAuthorityRow, expectedSiteId: string): VerifiedSessionAccessGrantAuthority {
  const subjectGeneration = positiveBigint(row.subjectGeneration);
  const resource = sessionGrantResource(row.resource);
  if (
    row.siteId !== expectedSiteId || !ownerRef(row.siteId) || !ownerRef(row.siteReleaseRef) ||
    !ownerRef(row.projectRef) || !ownerRef(row.subjectRef) || subjectGeneration === undefined ||
    !ownerRef(row.identitySessionRef) || resource === null
  ) throw new Error("SESSION_ACCESS_GRANT_OWNER_CORRUPT");
  return Object.freeze({
    siteId: row.siteId,
    siteReleaseRef: row.siteReleaseRef,
    projectRef: row.projectRef,
    subjectRef: row.subjectRef,
    subjectGeneration,
    identitySessionRef: row.identitySessionRef,
    resource,
  });
}

function sessionGrantResource(value: unknown): SessionGrantResource | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const resource = value as Record<string, unknown>;
  const keys = Object.keys(resource).sort();
  if (resource.kind === "project" && keys.length === 1 && keys[0] === "kind") {
    return Object.freeze({ kind: "project" });
  }
  if (
    resource.kind === "session" && keys.length === 2 && keys[0] === "kind" &&
    keys[1] === "sessionRef" && ownerRef(resource.sessionRef)
  ) return Object.freeze({ kind: "session", sessionRef: resource.sessionRef });
  if (
    resource.kind === "run" && keys.length === 3 && keys[0] === "kind" &&
    keys[1] === "runRef" && keys[2] === "sessionRef" &&
    ownerRef(resource.sessionRef) && ownerRef(resource.runRef)
  ) return Object.freeze({ kind: "run", sessionRef: resource.sessionRef, runRef: resource.runRef });
  return null;
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
