import { canonicalRatingPolicyJson, type PublishedRatingPolicyRevision } from
  "../../domain/rating-policy-publication.js";
import type { RatingPolicyPublicationRepository } from
  "../../application/contracts/rating-policy-publication.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";

interface PolicyRow extends Record<string, unknown> {
  ratingPolicyRevisionRef: string;
  unit: string;
  policy: unknown;
  policyDigest: string;
  state: string;
  publishedAt: Date | string;
}

export class PostgresRatingPolicyPublicationRepository implements RatingPolicyPublicationRepository {
  async publish(transaction: Parameters<RatingPolicyPublicationRepository["publish"]>[0],
    candidate: PublishedRatingPolicyRevision) {
    const sql = resolvePlatformTransaction(transaction);
    const changed = await sql.execute(
      `INSERT INTO platform.credit_rating_policy_revision
       (rating_policy_revision_ref,site_ref,unit,policy,policy_digest,state,published_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::timestamptz)
       ON CONFLICT DO NOTHING`,
      [candidate.ratingPolicyRevisionRef, candidate.siteId, candidate.unit,
        canonicalRatingPolicyJson(candidate.policyDocument), candidate.policyDigest,
        candidate.state, candidate.publishedAt],
    );
    if (changed === 1) {
      return Object.freeze({ kind: "published" as const, publication: candidate });
    }
    if (changed !== 0) throw new Error("CREDIT_RATING_POLICY_PERSIST_FAILED");
    const rows = await sql.query<PolicyRow>(
      `SELECT rating_policy_revision_ref AS "ratingPolicyRevisionRef",unit,policy,
              policy_digest AS "policyDigest",state,published_at AS "publishedAt"
         FROM platform.credit_rating_policy_revision
        WHERE site_ref=$1 AND (rating_policy_revision_ref=$2 OR policy_digest=$3)
        LIMIT 3`,
      [candidate.siteId, candidate.ratingPolicyRevisionRef, candidate.policyDigest],
    );
    const existing = rows.length === 1 ? rows[0] : undefined;
    if (existing === undefined || existing.ratingPolicyRevisionRef !== candidate.ratingPolicyRevisionRef ||
        existing.unit !== candidate.unit || existing.policyDigest !== candidate.policyDigest ||
        existing.state !== "published" || canonicalRatingPolicyJson(existing.policy) !==
          canonicalRatingPolicyJson(candidate.policyDocument)) {
      throw new Error("CREDIT_RATING_POLICY_PUBLICATION_CONFLICT");
    }
    const originalPublishedAt = instant(existing.publishedAt);
    return Object.freeze({ kind: "replayed" as const,
      publication: Object.freeze({ ...candidate, publishedAt: originalPublishedAt }) });
  }
}

function instant(value: Date | string): string {
  const result = value instanceof Date ? value.toISOString() : value;
  if (!Number.isFinite(Date.parse(result))) throw new Error("CREDIT_RATING_POLICY_PERSISTED_AT_INVALID");
  return new Date(result).toISOString();
}
