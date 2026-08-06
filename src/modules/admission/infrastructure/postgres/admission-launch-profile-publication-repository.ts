import type { AdmissionLaunchProfilePublicationRepository } from
  "../../application/contracts/admission-launch-profile-publication.js";
import {
  canonicalAdmissionLaunchProfileJson,
  type PublishedAdmissionLaunchProfile,
} from "../../domain/admission-launch-profile-publication.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";

interface ProfileRow extends Record<string, unknown> {
  launchProfileRef: string;
  siteId: string;
  siteReleaseRef: string;
  snapshotDigest: string;
  snapshot: unknown;
  publishedAt: Date | string;
}

export class PostgresAdmissionLaunchProfilePublicationRepository
implements AdmissionLaunchProfilePublicationRepository {
  async publish(
    transaction: Parameters<AdmissionLaunchProfilePublicationRepository["publish"]>[0],
    candidate: PublishedAdmissionLaunchProfile,
  ) {
    const sql = resolvePlatformTransaction(transaction);
    const changed = await sql.execute(
      `INSERT INTO platform.admission_launch_profile_snapshot
       (launch_profile_ref,site_ref,site_release_ref,snapshot_digest,snapshot,published_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz)
       ON CONFLICT DO NOTHING`,
      [candidate.launchProfileRef, candidate.siteId, candidate.siteReleaseRef,
        candidate.snapshotDigest, canonicalAdmissionLaunchProfileJson(candidate.snapshot),
        candidate.publishedAt],
    );
    if (changed === 1) {
      return Object.freeze({ kind: "published" as const, publication: candidate });
    }
    if (changed !== 0) throw new Error("ADMISSION_LAUNCH_PROFILE_PERSIST_FAILED");
    const rows = await sql.query<ProfileRow>(
      `SELECT launch_profile_ref AS "launchProfileRef",site_ref AS "siteId",
              site_release_ref AS "siteReleaseRef",snapshot_digest AS "snapshotDigest",
              snapshot,published_at AS "publishedAt"
         FROM platform.admission_launch_profile_snapshot
        WHERE site_ref=$1 AND (site_release_ref=$2 OR launch_profile_ref=$3 OR snapshot_digest=$4)
        LIMIT 3`,
      [candidate.siteId, candidate.siteReleaseRef, candidate.launchProfileRef, candidate.snapshotDigest],
    );
    const existing = rows.length === 1 ? rows[0] : undefined;
    if (existing === undefined || existing.launchProfileRef !== candidate.launchProfileRef ||
        existing.siteId !== candidate.siteId || existing.siteReleaseRef !== candidate.siteReleaseRef ||
        existing.snapshotDigest !== candidate.snapshotDigest ||
        canonicalAdmissionLaunchProfileJson(existing.snapshot) !==
          canonicalAdmissionLaunchProfileJson(candidate.snapshot)) {
      throw new Error("ADMISSION_LAUNCH_PROFILE_PUBLICATION_CONFLICT");
    }
    return Object.freeze({
      kind: "replayed" as const,
      publication: Object.freeze({ ...candidate, publishedAt: instant(existing.publishedAt) }),
    });
  }
}

function instant(value: Date | string): string {
  const result = value instanceof Date ? value.toISOString() : value;
  const date = new Date(result);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("ADMISSION_LAUNCH_PROFILE_PERSISTED_AT_INVALID");
  }
  return date.toISOString();
}
