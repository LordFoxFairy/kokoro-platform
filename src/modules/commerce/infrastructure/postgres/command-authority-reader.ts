import type {
  CommerceCommandAuthorityKey,
  CommerceCommandAuthorityReader,
  CommerceCommandAuthoritySnapshot,
} from "../../application/command-authorization.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";

export class PostgresCommerceCommandAuthorityReader implements CommerceCommandAuthorityReader {
  lockCurrent(
    transaction: PlatformTransaction,
    key: CommerceCommandAuthorityKey,
  ): Promise<CommerceCommandAuthoritySnapshot | undefined> {
    return this.#load(transaction, key, AUTHORITY_LOCK_SQL);
  }

  readCurrent(
    transaction: PlatformTransaction,
    key: CommerceCommandAuthorityKey,
  ): Promise<CommerceCommandAuthoritySnapshot | undefined> {
    return this.#load(transaction, key, AUTHORITY_SQL);
  }

  async #load(
    transaction: PlatformTransaction,
    key: CommerceCommandAuthorityKey,
    statement: string,
  ): Promise<CommerceCommandAuthoritySnapshot | undefined> {
    const rows = await resolvePlatformTransaction(transaction).query<AuthorityRow>(
      statement,
      [key.workloadIdentityId, key.siteId, key.subjectId, key.sessionId],
    );
    return rows[0];
  }
}

type AuthorityRow = Record<string, unknown> & CommerceCommandAuthoritySnapshot;

const AUTHORITY_LOCK_SQL = `
  SELECT result_site_ref AS "siteId",result_release_ref AS "releaseRef",
         result_subject_ref AS "subjectId",result_binding_epoch AS "bindingEpoch",
         result_security_epoch AS "securityEpoch",result_policy_epoch AS "policyEpoch",
         result_subject_generation AS "subjectGeneration",result_restriction_epoch AS "restrictionEpoch",
         result_session_epoch AS "sessionEpoch",result_binding_state AS "bindingState",
         result_site_state AS "siteState",result_release_state AS "releaseState",
         result_subject_state AS "subjectState",result_session_state AS "sessionState",
         result_environment AS environment,result_region AS region,result_audience AS audience,
         result_expires_at AS "expiresAt"
  FROM platform.lock_commerce_command_authority($1,$2,$3,$4)`;

const AUTHORITY_SQL = `
  SELECT binding.site_ref AS "siteId", binding.release_ref AS "releaseRef",
         subject.subject_ref AS "subjectId", binding.binding_epoch AS "bindingEpoch",
         site.security_epoch AS "securityEpoch", site.policy_epoch AS "policyEpoch",
         subject.subject_generation AS "subjectGeneration", subject.restriction_epoch AS "restrictionEpoch",
         identity_session.session_epoch AS "sessionEpoch", binding.state AS "bindingState",
         site.state AS "siteState", release.state AS "releaseState", subject.state AS "subjectState",
         identity_session.state AS "sessionState", binding.environment, binding.region, binding.audience,
         identity_session.expires_at AS "expiresAt"
  FROM platform.authorization_product_binding binding
  JOIN platform.authorization_site site ON site.site_ref=binding.site_ref
  JOIN platform.authorization_site_release release
    ON release.release_ref=binding.release_ref AND release.site_ref=binding.site_ref
  JOIN platform.authorization_subject subject
    ON subject.subject_ref=$3 AND subject.site_ref=binding.site_ref
  JOIN platform.authorization_identity_session identity_session
    ON identity_session.session_ref=$4 AND identity_session.subject_ref=subject.subject_ref
      AND identity_session.site_ref=binding.site_ref
  WHERE binding.workload_identity_id=$1 AND binding.site_ref=$2`;
