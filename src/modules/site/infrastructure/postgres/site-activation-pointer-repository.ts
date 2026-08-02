import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type {
  SiteActivationAuthoritySnapshot,
  SiteActivationPointerRepository,
  SiteActiveReleasePointer,
} from "../../application/contracts/site-activation-authority.js";

interface PointerRow extends Record<string, unknown> {
  siteRef: string; environment: string; generation: string;
  activeReleaseRef: string | null; activeReleaseRevision: string | null;
  activeReleaseDigest: string | null; authorizationEpoch: string;
}
interface SnapshotRow extends Record<string, unknown> {
  attemptRef: string; phase: "begin" | "pre-cas"; siteRef: string; environment: string;
  candidateRef: string; candidateVersion: string; candidateAuthorizationEpoch: string;
  candidateDigest: string; releaseRef: string; releaseRevision: string; releaseDigest: string;
  certificationRevocationEpoch: string; producerRegistryHeadDigest: string;
  trustPolicyHeadDigest: string; signingKeyHeadDigest: string; activePointerGeneration: string;
  attemptDigest: string; snapshotDigest: string; observedAt: string;
}

export class PostgresSiteActivationPointerRepository implements SiteActivationPointerRepository {
  async loadPointerForUpdate(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string; environment: string;
  }>): Promise<SiteActiveReleasePointer> {
    const sql = resolvePlatformTransaction(transaction);
    await sql.execute(
      `INSERT INTO platform.site_active_release_pointer
       (site_ref,environment,generation,authorization_epoch)
       VALUES ($1,$2,0,1) ON CONFLICT (site_ref,environment) DO NOTHING`,
      [input.siteRef, input.environment],
    );
    const rows = await sql.query<PointerRow>(
      `SELECT site_ref AS "siteRef",environment,generation::text,
              active_release_ref AS "activeReleaseRef",
              active_release_revision::text AS "activeReleaseRevision",
              active_release_digest AS "activeReleaseDigest",authorization_epoch::text AS "authorizationEpoch"
       FROM platform.site_active_release_pointer
       WHERE site_ref=$1 AND environment=$2 FOR UPDATE`, [input.siteRef, input.environment],
    );
    if (rows[0] === undefined) throw new Error("SITE_ACTIVE_RELEASE_POINTER_MISSING");
    return pointer(rows[0]);
  }

  async loadSnapshot(transaction: PlatformTransaction, attemptRef: string, phase: "begin" | "pre-cas") {
    const rows = await resolvePlatformTransaction(transaction).query<SnapshotRow>(
      `SELECT attempt_ref AS "attemptRef",phase,site_ref AS "siteRef",environment,
              candidate_ref AS "candidateRef",candidate_version::text AS "candidateVersion",
              candidate_authorization_epoch::text AS "candidateAuthorizationEpoch",
              candidate_digest AS "candidateDigest",release_ref AS "releaseRef",
              release_revision::text AS "releaseRevision",release_digest AS "releaseDigest",
              certification_revocation_epoch::text AS "certificationRevocationEpoch",
              producer_registry_head_digest AS "producerRegistryHeadDigest",
              trust_policy_head_digest AS "trustPolicyHeadDigest",
              signing_key_head_digest AS "signingKeyHeadDigest",
              active_pointer_generation::text AS "activePointerGeneration",
              attempt_digest AS "attemptDigest",snapshot_digest AS "snapshotDigest",
              to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt"
       FROM platform.site_activation_authority_snapshot WHERE attempt_ref=$1 AND phase=$2`,
      [attemptRef, phase],
    );
    return rows[0] === undefined ? null : snapshot(rows[0]);
  }

  async insertSnapshot(transaction: PlatformTransaction, value: SiteActivationAuthoritySnapshot) {
    await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.site_activation_authority_snapshot
       (attempt_ref,phase,site_ref,environment,candidate_ref,candidate_version,
        candidate_authorization_epoch,candidate_digest,release_ref,release_revision,release_digest,
        certification_revocation_epoch,producer_registry_head_digest,trust_policy_head_digest,
        signing_key_head_digest,active_pointer_generation,attempt_digest,snapshot_digest,observed_at)
       VALUES ($1,$2,$3,$4,$5,$6::numeric(20,0),$7::numeric(20,0),$8,$9,$10::numeric(20,0),$11,
               $12::numeric(20,0),$13,$14,$15,$16::numeric(20,0),$17,$18,$19::timestamptz)`,
      [value.attemptRef, value.phase, value.siteRef, value.environment, value.candidate.ref,
        value.candidate.version.toString(), value.candidate.authorizationEpoch.toString(),
        value.candidate.digest, value.release.ref, value.release.revision.toString(), value.release.digest,
        value.certificationRevocationEpoch.toString(), value.producerRegistryHeadDigest,
        value.trustPolicyHeadDigest, value.signingKeyHeadDigest, value.activePointerGeneration.toString(),
        value.attemptDigest, value.snapshotDigest, value.observedAt],
    );
  }

  async commitPointer(
    transaction: PlatformTransaction,
    input: Parameters<SiteActivationPointerRepository["commitPointer"]>[1],
  ): Promise<SiteActiveReleasePointer> {
    const sql = resolvePlatformTransaction(transaction);
    const inserted = await sql.execute(
      `INSERT INTO platform.site_activation_eligibility_evidence
       (attempt_ref,begin_snapshot_digest,pre_cas_snapshot_digest,eligibility_digest,evaluated_at)
       SELECT begin_snapshot.attempt_ref,$1,$2,$3,$4::timestamptz
       FROM platform.site_activation_authority_snapshot begin_snapshot
       JOIN platform.site_activation_authority_snapshot pre_cas_snapshot
         ON pre_cas_snapshot.attempt_ref=begin_snapshot.attempt_ref
        AND pre_cas_snapshot.phase='pre-cas' AND pre_cas_snapshot.snapshot_digest=$2
       WHERE begin_snapshot.snapshot_digest=$1 AND begin_snapshot.phase='begin'`,
      [input.beginSnapshotDigest, input.preCasSnapshotDigest, input.eligibilityDigest, input.evaluatedAt],
    );
    if (inserted !== 1) throw new Error("SITE_ACTIVATION_ELIGIBILITY_EVIDENCE_INVALID");
    const changed = await sql.execute(
      `UPDATE platform.site_active_release_pointer
       SET generation=generation+1,active_release_ref=$1,active_release_revision=$2::numeric(20,0),
           active_release_digest=$3,authorization_epoch=$4::numeric(20,0),
           updated_by_command_id=$5,updated_at=clock_timestamp()
       WHERE site_ref=$6 AND environment=$7 AND generation=$8::numeric(20,0)
         AND active_release_ref IS NOT DISTINCT FROM $9
         AND active_release_revision IS NOT DISTINCT FROM $10::numeric(20,0)
         AND active_release_digest IS NOT DISTINCT FROM $11`,
      [input.release.ref, input.release.revision.toString(), input.release.digest,
        input.authorizationEpoch.toString(), input.commandId, input.pointer.siteRef,
        input.pointer.environment, input.pointer.generation.toString(),
        input.pointer.activeRelease?.ref ?? null,
        input.pointer.activeRelease?.revision.toString() ?? null,
        input.pointer.activeRelease?.digest ?? null],
    );
    if (changed !== 1) throw new Error("SITE_ACTIVATION_POINTER_CAS_CONFLICT");
    return Object.freeze({ ...input.pointer, generation: input.pointer.generation + 1n,
      activeRelease: input.release, authorizationEpoch: input.authorizationEpoch });
  }
}

function pointer(row: PointerRow): SiteActiveReleasePointer {
  const activeRelease = row.activeReleaseRef === null ? null : Object.freeze({
    ref: row.activeReleaseRef,
    revision: decimal(required(row.activeReleaseRevision)),
    digest: required(row.activeReleaseDigest),
  });
  return Object.freeze({ siteRef: row.siteRef, environment: row.environment,
    generation: decimal(row.generation), activeRelease,
    authorizationEpoch: decimal(row.authorizationEpoch) });
}
function snapshot(row: SnapshotRow): SiteActivationAuthoritySnapshot {
  return Object.freeze({ attemptRef: row.attemptRef, phase: row.phase, siteRef: row.siteRef,
    environment: row.environment, candidate: Object.freeze({ ref: row.candidateRef,
      version: decimal(row.candidateVersion), authorizationEpoch: decimal(row.candidateAuthorizationEpoch),
      digest: row.candidateDigest }), release: Object.freeze({ ref: row.releaseRef,
      revision: decimal(row.releaseRevision), digest: row.releaseDigest }),
    certificationRevocationEpoch: decimal(row.certificationRevocationEpoch),
    producerRegistryHeadDigest: row.producerRegistryHeadDigest,
    trustPolicyHeadDigest: row.trustPolicyHeadDigest, signingKeyHeadDigest: row.signingKeyHeadDigest,
    activePointerGeneration: decimal(row.activePointerGeneration), attemptDigest: row.attemptDigest,
    snapshotDigest: row.snapshotDigest, observedAt: row.observedAt });
}
function decimal(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error("SITE_ACTIVATION_DECIMAL_INVALID");
  return BigInt(value);
}
function required(value: string | null): string {
  if (value === null) throw new Error("SITE_ACTIVE_RELEASE_POINTER_CORRUPT");
  return value;
}
