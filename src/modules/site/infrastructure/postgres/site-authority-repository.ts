import type { SiteAuthorityRepository } from "../../application/contracts/site-authority-ports.js";
import {
  verifyActivationAttempt,
  verifySiteAggregate,
  verifySiteRelease,
  type ActivationAttempt,
  type SiteAggregate,
  type SiteRelease,
} from "../../domain/site-lifecycle.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";

export class PostgresSiteAuthorityRepository implements SiteAuthorityRepository {
  async loadSiteForUpdate(
    transaction: PlatformTransaction,
    siteRef: string,
  ): Promise<SiteAggregate | null> {
    const rows = await resolvePlatformTransaction(transaction).query<SiteRow>(
      `SELECT site_ref AS "siteRef", state, active_release_ref AS "activeReleaseRef",
              security_epoch AS "securityEpoch", policy_epoch AS "policyEpoch",
              revocation_epoch AS "revocationEpoch"
       FROM platform.site WHERE site_ref=$1 FOR UPDATE`,
      [siteRef],
    );
    const row = rows[0];
    return row === undefined ? null : verifySiteAggregate(siteRow(row));
  }

  async loadReleaseForUpdate(
    transaction: PlatformTransaction,
    siteRef: string,
    releaseRef: string,
  ): Promise<SiteRelease | null> {
    const rows = await resolvePlatformTransaction(transaction).query<ReleaseRow>(
      `SELECT release_ref AS "releaseRef", site_ref AS "siteRef", state,
              web_artifact_digest AS "webArtifactDigest",
              release_manifest_digest AS "releaseManifestDigest",
              certification_digest AS "certificationDigest"
       FROM platform.site_release WHERE site_ref=$1 AND release_ref=$2 FOR UPDATE`,
      [siteRef, releaseRef],
    );
    const row = rows[0];
    return row === undefined ? null : verifySiteRelease(releaseRow(row));
  }

  async loadActivationForUpdate(
    transaction: PlatformTransaction,
    attemptRef: string,
  ): Promise<ActivationAttempt | null> {
    const rows = await resolvePlatformTransaction(transaction).query<ActivationRow>(
      `SELECT attempt_ref AS "attemptRef", site_ref AS "siteRef",
              candidate_release_ref AS "candidateReleaseRef",
              expected_active_release_ref AS "expectedActiveReleaseRef",
              candidate_web_artifact_digest AS "candidateWebArtifactDigest",
              candidate_manifest_digest AS "candidateManifestDigest",
              candidate_certification_digest AS "candidateCertificationDigest",
              state, requested_at AS "requestedAt", provider_operation_key AS "providerOperationKey",
              deployment_ref AS "deploymentRef", observed_at AS "observedAt"
       FROM platform.site_activation_attempt WHERE attempt_ref=$1 FOR UPDATE`,
      [attemptRef],
    );
    const row = rows[0];
    return row === undefined ? null : verifyActivationAttempt(activationRow(row));
  }

  async insertActivation(
    transaction: PlatformTransaction,
    attempt: ActivationAttempt,
  ): Promise<void> {
    const value = verifyActivationAttempt(attempt);
    const changed = await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.site_activation_attempt
       (attempt_ref,site_ref,candidate_release_ref,expected_active_release_ref,
        candidate_web_artifact_digest,candidate_manifest_digest,candidate_certification_digest,
        state,requested_at,provider_operation_key,deployment_ref,observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11,$12::timestamptz)`,
      activationValues(value),
    );
    if (changed !== 1) throw new Error("SITE_ACTIVATION_INSERT_FAILED");
  }

  async updateActivation(
    transaction: PlatformTransaction,
    attempt: ActivationAttempt,
  ): Promise<void> {
    const value = verifyActivationAttempt(attempt);
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.site_activation_attempt
       SET state=$2,provider_operation_key=$3,deployment_ref=$4,observed_at=$5::timestamptz,updated_at=now()
       WHERE attempt_ref=$1 AND site_ref=$6 AND candidate_release_ref=$7
         AND candidate_web_artifact_digest=$8 AND candidate_manifest_digest=$9
         AND candidate_certification_digest=$10`,
      [value.attemptRef, value.state, value.providerOperationKey, value.deploymentRef, value.observedAt,
        value.siteRef, value.candidateReleaseRef, value.candidateWebArtifactDigest,
        value.candidateManifestDigest, value.candidateCertificationDigest],
    );
    if (changed !== 1) throw new Error("SITE_ACTIVATION_UPDATE_CONFLICT");
  }

  async commitActivation(
    transaction: PlatformTransaction,
    input: Parameters<SiteAuthorityRepository["commitActivation"]>[1],
  ): Promise<void> {
    const site = verifySiteAggregate(input.site);
    const candidate = verifySiteRelease(input.candidate);
    const attempt = verifyActivationAttempt(input.attempt);
    const sql = resolvePlatformTransaction(transaction);
    const pointer = await sql.execute(
      `UPDATE platform.site
       SET state=$1,active_release_ref=$2,policy_epoch=$4,updated_at=now()
       WHERE site_ref=$5 AND active_release_ref IS NOT DISTINCT FROM $3
         AND state IN ('preview_ready','active')`,
      [site.state, site.activeReleaseRef, input.expectedActiveReleaseRef, site.policyEpoch, site.siteRef],
    );
    if (pointer !== 1) throw new Error("SITE_ACTIVE_POINTER_CONFLICT");

    const activated = await sql.execute(
      `UPDATE platform.site_release SET state='active',updated_at=now()
       WHERE release_ref=$1 AND site_ref=$2 AND state='ready'
         AND web_artifact_digest=$3 AND release_manifest_digest=$4 AND certification_digest=$5`,
      [candidate.releaseRef, candidate.siteRef, candidate.webArtifactDigest,
        candidate.releaseManifestDigest, candidate.certificationDigest],
    );
    if (activated !== 1) throw new Error("SITE_RELEASE_ACTIVATION_CONFLICT");

    if (input.drainingReleaseRef !== null) {
      const draining = await sql.execute(
        `UPDATE platform.site_release SET state='draining',updated_at=now()
         WHERE release_ref=$1 AND site_ref=$2 AND state='active'`,
        [input.drainingReleaseRef, site.siteRef],
      );
      if (draining !== 1) throw new Error("SITE_DRAINING_RELEASE_CONFLICT");
    }

    const committed = await sql.execute(
      `UPDATE platform.site_activation_attempt SET state=$2,updated_at=now()
       WHERE attempt_ref=$1 AND site_ref=$3 AND state='pointer_committing'
         AND candidate_release_ref=$4`,
      [attempt.attemptRef, attempt.state, attempt.siteRef, attempt.candidateReleaseRef],
    );
    if (committed !== 1) throw new Error("SITE_ACTIVATION_COMMIT_CONFLICT");
  }

  async updateSite(transaction: PlatformTransaction, site: SiteAggregate): Promise<void> {
    const value = verifySiteAggregate(site);
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.site SET state=$2,active_release_ref=$3,security_epoch=$4,
         policy_epoch=$5,revocation_epoch=$6,updated_at=now() WHERE site_ref=$1`,
      [value.siteRef, value.state, value.activeReleaseRef, value.securityEpoch,
        value.policyEpoch, value.revocationEpoch],
    );
    if (changed !== 1) throw new Error("SITE_UPDATE_CONFLICT");
  }
}

type SiteRow = Record<string, unknown> & {
  siteRef: string; state: string; activeReleaseRef: string | null;
  securityEpoch: bigint; policyEpoch: bigint; revocationEpoch: bigint;
};
type ReleaseRow = Record<string, unknown> & {
  releaseRef: string; siteRef: string; state: string; webArtifactDigest: string;
  releaseManifestDigest: string; certificationDigest: string;
};
type ActivationRow = Record<string, unknown> & {
  attemptRef: string; siteRef: string; candidateReleaseRef: string;
  expectedActiveReleaseRef: string | null; candidateWebArtifactDigest: string;
  candidateManifestDigest: string; candidateCertificationDigest: string; state: string;
  requestedAt: Date | string; providerOperationKey: string | null; deploymentRef: string | null;
  observedAt: Date | string | null;
};

function siteRow(row: SiteRow): SiteAggregate {
  if (!siteState(row.state)) throw new Error("SITE_PERSISTED_STATE_INVALID");
  return { ...row, state: row.state };
}

function releaseRow(row: ReleaseRow): SiteRelease {
  if (!releaseState(row.state)) throw new Error("SITE_RELEASE_PERSISTED_STATE_INVALID");
  return { ...row, state: row.state };
}

function activationRow(row: ActivationRow): ActivationAttempt {
  if (!activationState(row.state)) throw new Error("SITE_ACTIVATION_PERSISTED_STATE_INVALID");
  return { ...row, state: row.state, requestedAt: instant(row.requestedAt),
    observedAt: row.observedAt === null ? null : instant(row.observedAt) };
}

function activationValues(value: ActivationAttempt): readonly unknown[] {
  return [value.attemptRef, value.siteRef, value.candidateReleaseRef,
    value.expectedActiveReleaseRef, value.candidateWebArtifactDigest, value.candidateManifestDigest,
    value.candidateCertificationDigest, value.state, value.requestedAt, value.providerOperationKey,
    value.deploymentRef, value.observedAt];
}

function siteState(value: string): value is SiteAggregate["state"] {
  return ["preview_ready", "active", "suspended", "decommissioning", "decommissioned"].includes(value);
}
function releaseState(value: string): value is SiteRelease["state"] {
  return ["ready", "active", "draining", "retired"].includes(value);
}
function activationState(value: string): value is ActivationAttempt["state"] {
  return ["preparing", "promote_requested", "observing", "pointer_committing", "draining",
    "succeeded", "failed", "unknown"].includes(value);
}
function instant(value: Date | string): string {
  const result = value instanceof Date ? value.toISOString() : value;
  if (!Number.isFinite(Date.parse(result))) throw new Error("SITE_PERSISTED_TIME_INVALID");
  return result;
}
