import type { SiteAuthorityRepository } from "../../application/contracts/site-authority-ports.js";
import type { SitePublicationRepository } from "../../application/contracts/site-publication-ports.js";
import type {
  PublishedSiteRelease,
  SiteAuthorityDefinition,
  SiteProjectBinding,
} from "../../domain/site-publication.js";
import {
  verifyActivationAttempt,
  verifySiteAggregate,
  verifySiteRelease,
  type ActivationAttempt,
  type SiteAggregate,
  type SiteDeploymentBinding,
  type SiteDeploymentObservation,
  type SiteRelease,
} from "../../domain/site-lifecycle.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";

export class PostgresSiteAuthorityRepository implements SiteAuthorityRepository, SitePublicationRepository {
  async loadActiveProjectBindingForUpdate(
    transaction: PlatformTransaction,
    siteRef: string,
    environment: "development" | "preview" | "production",
  ): Promise<Readonly<{ bindingRef: string; bindingEpoch: bigint }> | null> {
    const rows = await resolvePlatformTransaction(transaction).query<{
      bindingRef: string; bindingEpoch: bigint;
    }>(
      `SELECT binding_ref AS "bindingRef", binding_epoch AS "bindingEpoch"
       FROM platform.site_project_binding
       WHERE site_ref=$1 AND environment=$2 AND state='active' FOR UPDATE`,
      [siteRef, environment],
    );
    return rows[0] === undefined ? null : Object.freeze({ ...rows[0] });
  }

  async insertSiteWithProjectBinding(
    transaction: PlatformTransaction,
    site: SiteAuthorityDefinition,
    binding: SiteProjectBinding,
  ): Promise<void> {
    const sql = resolvePlatformTransaction(transaction);
    const insertedSite = await sql.execute(
      `INSERT INTO platform.site
       (site_ref,site_key,state,active_release_ref,security_epoch,policy_epoch,revocation_epoch)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [site.siteRef, site.siteKey, site.state, site.activeReleaseRef, site.securityEpoch,
        site.policyEpoch, site.revocationEpoch],
    );
    if (insertedSite !== 1) throw new Error("SITE_INSERT_FAILED");
    const insertedBinding = await sql.execute(
      `INSERT INTO platform.site_project_binding
       (binding_ref,site_ref,repository_ref,provider_project_ref,environment,
        workload_identity_id,binding_epoch,state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [binding.bindingRef, binding.siteRef, binding.repositoryRef, binding.providerProjectRef,
        binding.environment, binding.workloadIdentityId, binding.bindingEpoch, binding.state],
    );
    if (insertedBinding !== 1) throw new Error("SITE_PROJECT_BINDING_INSERT_FAILED");
  }

  async insertRelease(
    transaction: PlatformTransaction,
    release: PublishedSiteRelease,
  ): Promise<void> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.site_release
       (release_ref,site_ref,state,web_artifact_digest,release_manifest_digest,
        certification_digest,launch_profile_ref,site_config_revision_ref,legal_revision_ref,
        feature_policy_revision,model_option_catalog_ref,agent_catalog_ref,identity_issuer_label,
        identity_auth_strength_policy_revision,enabled_surface_ids,locale_policy)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb)`,
      [release.releaseRef, release.siteRef, release.state, release.webArtifactDigest,
        release.releaseManifestDigest, release.certificationDigest, release.launchProfileRef,
        release.siteConfigRevisionRef, release.legalRevisionRef, release.featurePolicyRevision,
        release.modelOptionCatalogRef, release.agentCatalogRef, release.identityIssuerLabel,
        release.identityAuthStrengthPolicyRevision, JSON.stringify(release.enabledSurfaceIds),
        JSON.stringify(release.localePolicy)],
    );
    if (changed !== 1) throw new Error("SITE_RELEASE_INSERT_FAILED");
  }

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
              site_project_binding_ref AS "siteProjectBindingRef",
              site_project_binding_epoch AS "siteProjectBindingEpoch",
              environment,region,audience,session_contract_revision AS "sessionContractRevision",
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
        site_project_binding_ref,site_project_binding_epoch,environment,region,audience,
        session_contract_revision,state,requested_at,provider_operation_key,deployment_ref,observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::timestamptz,$16,$17,$18::timestamptz)`,
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
         AND candidate_certification_digest=$10 AND site_project_binding_ref=$11
         AND site_project_binding_epoch=$12 AND environment=$13 AND region=$14
         AND audience=$15 AND session_contract_revision=$16`,
      [value.attemptRef, value.state, value.providerOperationKey, value.deploymentRef, value.observedAt,
        value.siteRef, value.candidateReleaseRef, value.candidateWebArtifactDigest,
        value.candidateManifestDigest, value.candidateCertificationDigest, value.siteProjectBindingRef,
        value.siteProjectBindingEpoch, value.environment, value.region, value.audience,
        value.sessionContractRevision],
    );
    if (changed !== 1) throw new Error("SITE_ACTIVATION_UPDATE_CONFLICT");
  }

  async recordObservationAndCandidateDeployment(
    transaction: PlatformTransaction,
    observation: SiteDeploymentObservation,
    deployment: SiteDeploymentBinding,
  ): Promise<void> {
    const sql = resolvePlatformTransaction(transaction);
    const observationInserted = await sql.execute(
      `INSERT INTO platform.site_deployment_observation
       (observation_ref,attempt_ref,provider_operation_key,deployment_ref,release_ref,
        web_artifact_digest,healthy,traffic_ready,observed_at,payload_digest)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10)`,
      [observation.observationRef, observation.attemptRef, observation.providerOperationKey,
        observation.deploymentRef, observation.releaseRef, observation.webArtifactDigest,
        observation.healthy, observation.trafficReady, observation.observedAt,
        observation.payloadDigest],
    );
    if (observationInserted !== 1) throw new Error("SITE_DEPLOYMENT_OBSERVATION_INSERT_FAILED");

    const deploymentInserted = await sql.execute(
      `INSERT INTO platform.site_deployment_binding
       (deployment_ref,binding_ref,site_ref,release_ref,environment,region,audience,
        session_contract_revision,web_artifact_digest,binding_epoch,state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'candidate')
       ON CONFLICT (deployment_ref) DO NOTHING`,
      [deployment.deploymentRef, deployment.bindingRef, deployment.siteRef, deployment.releaseRef,
        deployment.environment, deployment.region, deployment.audience,
        deployment.sessionContractRevision, deployment.webArtifactDigest, deployment.bindingEpoch],
    );
    if (deploymentInserted === 1) return;
    const existing = await sql.query<Record<string, unknown>>(
      `SELECT 1 FROM platform.site_deployment_binding
       WHERE deployment_ref=$1 AND binding_ref=$2 AND site_ref=$3 AND release_ref=$4
         AND environment=$5 AND region=$6 AND audience=$7 AND session_contract_revision=$8
         AND web_artifact_digest=$9 AND binding_epoch=$10 AND state='candidate' FOR UPDATE`,
      [deployment.deploymentRef, deployment.bindingRef, deployment.siteRef, deployment.releaseRef,
        deployment.environment, deployment.region, deployment.audience,
        deployment.sessionContractRevision, deployment.webArtifactDigest, deployment.bindingEpoch],
    );
    if (existing.length !== 1) throw new Error("SITE_DEPLOYMENT_BINDING_CONFLICT");
  }

  async loadDrainingDeploymentForUpdate(
    transaction: PlatformTransaction,
    siteRef: string,
    environment: "development" | "preview" | "production",
    releaseRef: string,
  ): Promise<Readonly<{ deploymentRef: string; webArtifactDigest: string }> | null> {
    const rows = await resolvePlatformTransaction(transaction).query<{
      deploymentRef: string; webArtifactDigest: string;
    }>(
      `SELECT deployment_ref AS "deploymentRef", web_artifact_digest AS "webArtifactDigest"
       FROM platform.site_deployment_binding
       WHERE site_ref=$1 AND environment=$2 AND release_ref=$3 AND state='draining' FOR UPDATE`,
      [siteRef, environment, releaseRef],
    );
    if (rows.length > 1) throw new Error("SITE_DRAINING_DEPLOYMENT_CONFLICT");
    return rows[0] === undefined ? null : Object.freeze({ ...rows[0] });
  }

  async recordDrainObservationAndComplete(
    transaction: PlatformTransaction,
    observation: SiteDeploymentObservation,
    attempt: ActivationAttempt,
  ): Promise<void> {
    const value = verifyActivationAttempt(attempt);
    if (value.state !== "succeeded" || value.expectedActiveReleaseRef !== observation.releaseRef) {
      throw new Error("SITE_DRAIN_COMPLETION_INVALID");
    }
    const sql = resolvePlatformTransaction(transaction);
    const observationInserted = await sql.execute(
      `INSERT INTO platform.site_deployment_observation
       (observation_ref,attempt_ref,provider_operation_key,deployment_ref,release_ref,
        web_artifact_digest,healthy,traffic_ready,observed_at,payload_digest)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,false,false,$7::timestamptz,$8)`,
      [observation.observationRef, observation.attemptRef, observation.providerOperationKey,
        observation.deploymentRef, observation.releaseRef, observation.webArtifactDigest,
        observation.observedAt, observation.payloadDigest],
    );
    if (observationInserted !== 1) throw new Error("SITE_DRAIN_OBSERVATION_INSERT_FAILED");
    const deploymentRevoked = await sql.execute(
      `UPDATE platform.site_deployment_binding SET state='revoked',updated_at=now()
       WHERE deployment_ref=$1 AND site_ref=$2 AND release_ref=$3 AND environment=$4
         AND web_artifact_digest=$5 AND state='draining'`,
      [observation.deploymentRef, value.siteRef, observation.releaseRef, value.environment,
        observation.webArtifactDigest],
    );
    if (deploymentRevoked !== 1) throw new Error("SITE_DRAIN_DEPLOYMENT_CONFLICT");
    const releaseRetired = await sql.execute(
      `UPDATE platform.site_release SET state='retired',updated_at=now()
       WHERE release_ref=$1 AND site_ref=$2 AND state='draining'`,
      [observation.releaseRef, value.siteRef],
    );
    if (releaseRetired !== 1) throw new Error("SITE_DRAIN_RELEASE_CONFLICT");
    const activationCompleted = await sql.execute(
      `UPDATE platform.site_activation_attempt SET state='succeeded',updated_at=now()
       WHERE attempt_ref=$1 AND site_ref=$2 AND state='draining'
         AND expected_active_release_ref=$3`,
      [value.attemptRef, value.siteRef, observation.releaseRef],
    );
    if (activationCompleted !== 1) throw new Error("SITE_DRAIN_ACTIVATION_CONFLICT");
  }

  async commitActivation(
    transaction: PlatformTransaction,
    input: Parameters<SiteAuthorityRepository["commitActivation"]>[1],
  ): Promise<void> {
    const site = verifySiteAggregate(input.site);
    const candidate = verifySiteRelease(input.candidate);
    const attempt = verifyActivationAttempt(input.attempt);
    const sql = resolvePlatformTransaction(transaction);
    if (attempt.deploymentRef === null) throw new Error("SITE_DEPLOYMENT_BINDING_REQUIRED");
    if (input.expectedActiveReleaseRef !== null) {
      const drainingDeployment = await sql.execute(
        `UPDATE platform.site_deployment_binding SET state='draining',updated_at=now()
         WHERE site_ref=$1 AND environment=$2 AND release_ref=$3 AND state='active'`,
        [site.siteRef, attempt.environment, input.expectedActiveReleaseRef],
      );
      if (drainingDeployment !== 1) throw new Error("SITE_ACTIVE_DEPLOYMENT_CONFLICT");
    }
    const activeDeployment = await sql.execute(
      `UPDATE platform.site_deployment_binding SET state='active',updated_at=now()
       WHERE deployment_ref=$1 AND binding_ref=$2 AND site_ref=$3 AND release_ref=$4
         AND environment=$5 AND region=$6 AND audience=$7 AND session_contract_revision=$8
         AND web_artifact_digest=$9 AND binding_epoch=$10 AND state='candidate'`,
      [attempt.deploymentRef, attempt.siteProjectBindingRef, attempt.siteRef,
        attempt.candidateReleaseRef, attempt.environment, attempt.region, attempt.audience,
        attempt.sessionContractRevision, attempt.candidateWebArtifactDigest,
        attempt.siteProjectBindingEpoch],
    );
    if (activeDeployment !== 1) throw new Error("SITE_CANDIDATE_DEPLOYMENT_CONFLICT");
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
  siteProjectBindingRef: string; siteProjectBindingEpoch: bigint;
  environment: "development" | "preview" | "production"; region: string; audience: string;
  sessionContractRevision: string;
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
    value.candidateCertificationDigest, value.siteProjectBindingRef, value.siteProjectBindingEpoch,
    value.environment, value.region, value.audience, value.sessionContractRevision,
    value.state, value.requestedAt, value.providerOperationKey, value.deploymentRef, value.observedAt];
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
