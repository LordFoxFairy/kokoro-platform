import type { SiteAuthorityRepository } from "../../application/contracts/site-authority-ports.js";
import type { SitePublicationRepository } from "../../application/contracts/site-publication-ports.js";
import type {
  ProviderBoundDeployment,
  SiteTrafficStopRepository,
} from "../../application/contracts/site-traffic-stop-ports.js";
import type { SiteRuntimeRepository } from "../../application/contracts/site-runtime-state.js";
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
import {
  verifySiteTrafficStopAttempt,
  type SiteTrafficStopAttempt,
  type SiteTrafficStopObservation,
} from "../../domain/site-traffic-stop.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";

export class PostgresSiteAuthorityRepository implements
  SiteAuthorityRepository, SitePublicationRepository, SiteTrafficStopRepository,
  SiteRuntimeRepository {
  async assertCapabilityCatalogSnapshot(
    transaction: PlatformTransaction,
    input: Readonly<{ siteRef: string; releaseRef: string }>,
  ): Promise<void> {
    const rows = await resolvePlatformTransaction(transaction).query<{ snapshotDigest: unknown }>(
      `SELECT catalog.snapshot_digest AS "snapshotDigest"
       FROM platform.site_release AS release
       JOIN platform.admission_capability_catalog_snapshot AS catalog
         ON catalog.site_ref=release.site_ref
        AND catalog.site_release_ref=release.release_ref
        AND catalog.agent_catalog_ref=release.agent_catalog_ref
       WHERE release.site_ref=$1 AND release.release_ref=$2 AND release.state='ready'
       FOR SHARE OF catalog`,
      [input.siteRef, input.releaseRef],
    );
    if (rows.length !== 1 || typeof rows[0]?.snapshotDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(rows[0].snapshotDigest)) {
      throw new Error("SITE_ACTIVATION_CAPABILITY_SNAPSHOT_REQUIRED");
    }
  }

  async loadActiveProjectBindingForUpdate(
    transaction: PlatformTransaction,
    siteRef: string,
    environment: "development" | "preview" | "production",
    region: string,
  ): Promise<Readonly<{ bindingRef: string; bindingEpoch: bigint }> | null> {
    const rows = await resolvePlatformTransaction(transaction).query<{
      bindingRef: string; bindingEpoch: bigint;
    }>(
      `SELECT binding_ref AS "bindingRef", binding_epoch AS "bindingEpoch"
       FROM platform.site_project_binding
       WHERE site_ref=$1 AND environment=$2 AND region=$3 AND state='active' FOR UPDATE`,
      [siteRef, environment, region],
    );
    return rows[0] === undefined ? null : Object.freeze({ ...rows[0] });
  }

  async loadRuntimeProjectBindingForUpdate(
    transaction: PlatformTransaction,
    input: Parameters<SiteRuntimeRepository["loadRuntimeProjectBindingForUpdate"]>[1],
  ): Promise<Readonly<{ providerNamespace: string; providerProjectRef: string }> | null> {
    const rows = await resolvePlatformTransaction(transaction).query<{
      providerNamespace: string; providerProjectRef: string;
    }>(
      `SELECT provider_namespace AS "providerNamespace",provider_project_ref AS "providerProjectRef"
       FROM platform.site_project_binding
       WHERE binding_ref=$1 AND site_ref=$2 AND ($3::bigint IS NULL OR binding_epoch=$3)
         AND environment=$4 AND region=$5 AND state='active' FOR UPDATE`,
      [input.bindingRef, input.siteRef, input.bindingEpoch ?? null, input.environment, input.region],
    );
    if (rows.length > 1) throw new Error("SITE_RUNTIME_PROJECT_BINDING_CONFLICT");
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
       (site_ref,site_key,state,active_release_ref,security_epoch,policy_epoch,revocation_epoch,
        runtime_binding_epoch)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [site.siteRef, site.siteKey, site.state, site.activeReleaseRef, site.securityEpoch,
        site.policyEpoch, site.revocationEpoch, site.runtimeBindingEpoch],
    );
    if (insertedSite !== 1) throw new Error("SITE_INSERT_FAILED");
    const insertedBinding = await sql.execute(
      `INSERT INTO platform.site_project_binding
       (binding_ref,site_ref,repository_ref,provider_namespace,provider_project_ref,environment,region,
        workload_identity_id,binding_epoch,state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [binding.bindingRef, binding.siteRef, binding.repositoryRef, binding.providerNamespace,
        binding.providerProjectRef, binding.environment, binding.region, binding.workloadIdentityId,
        binding.bindingEpoch, binding.state],
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
              revocation_epoch AS "revocationEpoch",
              runtime_binding_epoch AS "runtimeBindingEpoch"
       FROM platform.site WHERE site_ref=$1 FOR UPDATE`,
      [siteRef],
    );
    const row = rows[0];
    return row === undefined ? null : verifySiteAggregate(siteRow(row));
  }

  async reserveRuntimeBindingEpoch(
    transaction: PlatformTransaction,
    siteRef: string,
    expectedEpoch: bigint,
  ): Promise<bigint> {
    const rows = await resolvePlatformTransaction(transaction).query<{ runtimeBindingEpoch: bigint }>(
      `UPDATE platform.site
       SET runtime_binding_epoch=runtime_binding_epoch+1,updated_at=now()
       WHERE site_ref=$1 AND runtime_binding_epoch=$2
         AND state IN ('preview_ready','active')
       RETURNING runtime_binding_epoch AS "runtimeBindingEpoch"`,
      [siteRef, expectedEpoch],
    );
    const reserved = rows[0]?.runtimeBindingEpoch;
    if (reserved === undefined || reserved !== expectedEpoch + 1n) {
      throw new Error("SITE_RUNTIME_BINDING_EPOCH_CONFLICT");
    }
    return reserved;
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
              runtime_binding_epoch AS "runtimeBindingEpoch",
              environment,region,audience,session_contract_revision AS "sessionContractRevision",
              state, requested_at AS "requestedAt", provider_operation_key AS "providerOperationKey",
              deployment_ref AS "deploymentRef", observed_at AS "observedAt",failure_code AS "failureCode"
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
        site_project_binding_ref,site_project_binding_epoch,runtime_binding_epoch,environment,region,audience,
        session_contract_revision,state,requested_at,provider_operation_key,deployment_ref,observed_at,failure_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::timestamptz,$17,$18,$19::timestamptz,$20)`,
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
       SET state=$2,provider_operation_key=$3,deployment_ref=$4,observed_at=$5::timestamptz,
           failure_code=$6,updated_at=now()
       WHERE attempt_ref=$1 AND site_ref=$7 AND candidate_release_ref=$8
         AND candidate_web_artifact_digest=$9 AND candidate_manifest_digest=$10
         AND candidate_certification_digest=$11 AND site_project_binding_ref=$12
         AND site_project_binding_epoch=$13 AND runtime_binding_epoch=$14
         AND environment=$15 AND region=$16
         AND audience=$17 AND session_contract_revision=$18`,
      [value.attemptRef, value.state, value.providerOperationKey, value.deploymentRef, value.observedAt,
        value.failureCode, value.siteRef, value.candidateReleaseRef, value.candidateWebArtifactDigest,
        value.candidateManifestDigest, value.candidateCertificationDigest, value.siteProjectBindingRef,
        value.siteProjectBindingEpoch, value.runtimeBindingEpoch, value.environment, value.region, value.audience,
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

  async loadDrainingRuntimeDeploymentForUpdate(
    transaction: PlatformTransaction,
    siteRef: string,
    environment: "development" | "preview" | "production",
    region: string,
    releaseRef: string,
  ): Promise<Readonly<{ deploymentRef: string; webArtifactDigest: string;
    providerNamespace: string; providerProjectRef: string;
    environment: "development" | "preview" | "production"; region: string }> | null> {
    const rows = await resolvePlatformTransaction(transaction).query<{
      deploymentRef: string; webArtifactDigest: string; providerNamespace: string;
      providerProjectRef: string; environment: "development" | "preview" | "production";
      region: string;
    }>(
      `SELECT deployment.deployment_ref AS "deploymentRef",
              deployment.web_artifact_digest AS "webArtifactDigest",
              deployment.environment,deployment.region,
              project.provider_namespace AS "providerNamespace",
              project.provider_project_ref AS "providerProjectRef"
       FROM platform.site_deployment_binding deployment
       JOIN platform.site_project_binding project
         ON project.binding_ref=deployment.binding_ref AND project.site_ref=deployment.site_ref
       WHERE deployment.site_ref=$1 AND deployment.environment=$2 AND deployment.region=$3
         AND deployment.release_ref=$4 AND deployment.state='draining' AND project.state='active'
       FOR UPDATE OF deployment,project`,
      [siteRef, environment, region, releaseRef],
    );
    if (rows.length > 1) throw new Error("SITE_DRAINING_DEPLOYMENT_CONFLICT");
    return rows[0] === undefined ? null : Object.freeze({ ...rows[0] });
  }

  async loadActiveDeploymentForUpdate(
    transaction: PlatformTransaction,
    siteRef: string,
    environment: "development" | "preview" | "production",
    region: string,
  ): Promise<ProviderBoundDeployment | null> {
    const rows = await resolvePlatformTransaction(transaction).query<ProviderBoundDeployment & Record<string, unknown>>(
      `SELECT deployment.deployment_ref AS "deploymentRef",deployment.binding_ref AS "bindingRef",
              deployment.site_ref AS "siteRef",deployment.release_ref AS "releaseRef",
              deployment.environment,deployment.region,deployment.audience,
              deployment.session_contract_revision AS "sessionContractRevision",
              deployment.web_artifact_digest AS "webArtifactDigest",
              deployment.binding_epoch AS "bindingEpoch",deployment.state,
              project.provider_namespace AS "providerNamespace"
       FROM platform.site_deployment_binding deployment
       JOIN platform.site_project_binding project
         ON project.binding_ref=deployment.binding_ref AND project.site_ref=deployment.site_ref
       WHERE deployment.site_ref=$1 AND deployment.environment=$2 AND deployment.region=$3
         AND deployment.state='active' AND project.state='active' FOR UPDATE OF deployment,project`,
      [siteRef, environment, region],
    );
    if (rows.length > 1) throw new Error("SITE_ACTIVE_DEPLOYMENT_CONFLICT");
    return rows[0] === undefined ? null : Object.freeze({ ...rows[0] });
  }

  async loadTrafficStopForUpdate(
    transaction: PlatformTransaction,
    attemptRef: string,
  ): Promise<SiteTrafficStopAttempt | null> {
    const rows = await resolvePlatformTransaction(transaction).query<TrafficStopRow>(
      `SELECT attempt_ref AS "attemptRef",site_ref AS "siteRef",action,
              release_ref AS "releaseRef",deployment_ref AS "deploymentRef",binding_ref AS "bindingRef",
              runtime_binding_epoch AS "runtimeBindingEpoch",provider_namespace AS "providerNamespace",
              environment,region,state,requested_at AS "requestedAt",
              provider_operation_key AS "providerOperationKey",observed_at AS "observedAt",
              failure_code AS "failureCode"
       FROM platform.site_traffic_stop_attempt WHERE attempt_ref=$1 FOR UPDATE`,
      [attemptRef],
    );
    const row = rows[0];
    return row === undefined ? null : verifySiteTrafficStopAttempt(trafficStopRow(row));
  }

  async beginTrafficStop(
    transaction: PlatformTransaction,
    site: SiteAggregate,
    attempt: SiteTrafficStopAttempt,
  ): Promise<void> {
    const owner = verifySiteAggregate(site);
    const value = verifySiteTrafficStopAttempt(attempt);
    const sql = resolvePlatformTransaction(transaction);
    const inserted = await sql.execute(
      `INSERT INTO platform.site_traffic_stop_attempt
       (attempt_ref,site_ref,action,release_ref,deployment_ref,binding_ref,runtime_binding_epoch,
        provider_namespace,environment,region,state,requested_at,provider_operation_key,observed_at,failure_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13,$14::timestamptz,$15)`,
      trafficStopValues(value),
    );
    if (inserted !== 1) throw new Error("SITE_TRAFFIC_STOP_INSERT_FAILED");
    const draining = await sql.execute(
      `UPDATE platform.site_deployment_binding SET state='draining',updated_at=now()
       WHERE deployment_ref=$1 AND site_ref=$2 AND release_ref=$3
         AND binding_epoch=$4 AND state='active'`,
      [value.deploymentRef, value.siteRef, value.releaseRef, value.runtimeBindingEpoch],
    );
    if (draining !== 1) throw new Error("SITE_TRAFFIC_STOP_DEPLOYMENT_CONFLICT");
    const fenced = await sql.execute(
      `UPDATE platform.site SET state=$2,security_epoch=$3,revocation_epoch=$4,updated_at=now()
       WHERE site_ref=$1 AND state='active' AND active_release_ref=$5
         AND runtime_binding_epoch=$6`,
      [owner.siteRef, owner.state, owner.securityEpoch, owner.revocationEpoch,
        value.releaseRef, value.runtimeBindingEpoch],
    );
    if (fenced !== 1) throw new Error("SITE_TRAFFIC_STOP_SITE_CONFLICT");
    const authorizationSite = await sql.execute(
      `UPDATE platform.authorization_site
       SET state=$2,security_epoch=$3,revocation_epoch=$4,updated_at=now()
       WHERE site_ref=$1 AND state='active'
         AND security_epoch<$3 AND revocation_epoch<$4`,
      [owner.siteRef, value.action === "suspend" ? "suspended" : "decommissioning",
        owner.securityEpoch, owner.revocationEpoch],
    );
    if (authorizationSite !== 1) throw new Error("SITE_TRAFFIC_STOP_AUTHORIZATION_CONFLICT");
    const authorizationBinding = await sql.execute(
      `UPDATE platform.authorization_product_binding SET state='revoked',updated_at=now()
       WHERE binding_ref=$1 AND site_ref=$2 AND deployment_ref=$3
         AND binding_epoch=$4 AND state='active'`,
      [value.bindingRef, value.siteRef, value.deploymentRef, value.runtimeBindingEpoch],
    );
    if (authorizationBinding !== 1) throw new Error("SITE_TRAFFIC_STOP_BINDING_CONFLICT");
  }

  async updateTrafficStop(
    transaction: PlatformTransaction,
    attempt: SiteTrafficStopAttempt,
  ): Promise<void> {
    const value = verifySiteTrafficStopAttempt(attempt);
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.site_traffic_stop_attempt
       SET state=$2,provider_operation_key=$3,observed_at=$4::timestamptz,
           failure_code=$5,updated_at=now()
       WHERE attempt_ref=$1 AND site_ref=$6 AND deployment_ref=$7 AND runtime_binding_epoch=$8`,
      [value.attemptRef, value.state, value.providerOperationKey, value.observedAt,
        value.failureCode, value.siteRef, value.deploymentRef, value.runtimeBindingEpoch],
    );
    if (changed !== 1) throw new Error("SITE_TRAFFIC_STOP_UPDATE_CONFLICT");
  }

  async recordTrafficStopObservation(
    transaction: PlatformTransaction,
    observation: SiteTrafficStopObservation,
    attempt: SiteTrafficStopAttempt,
    site: Pick<SiteAggregate, "state" | "activeReleaseRef">,
  ): Promise<void> {
    const value = verifySiteTrafficStopAttempt(attempt);
    const sql = resolvePlatformTransaction(transaction);
    const inserted = await sql.execute(
      `INSERT INTO platform.site_traffic_stop_observation
       (observation_ref,attempt_ref,provider_operation_key,deployment_ref,status,observed_at,payload_digest)
       VALUES ($1::uuid,$2,$3,$4,$5,$6::timestamptz,$7)`,
      [observation.observationRef, observation.attemptRef, observation.providerOperationKey,
        observation.deploymentRef, observation.status, observation.observedAt, observation.payloadDigest],
    );
    if (inserted !== 1) throw new Error("SITE_TRAFFIC_STOP_OBSERVATION_INSERT_FAILED");
    await this.updateTrafficStop(transaction, value);
    if (value.state !== "succeeded") return;
    const revoked = await sql.execute(
      `UPDATE platform.site_deployment_binding SET state='revoked',updated_at=now()
       WHERE deployment_ref=$1 AND site_ref=$2 AND state='draining'`,
      [value.deploymentRef, value.siteRef],
    );
    if (revoked !== 1) throw new Error("SITE_TRAFFIC_STOP_DEPLOYMENT_CONFLICT");
    if (value.action === "decommission") {
      const release = await sql.execute(
        `UPDATE platform.site_release SET state='retired',updated_at=now()
         WHERE release_ref=$1 AND site_ref=$2 AND state='active'`,
        [value.releaseRef, value.siteRef],
      );
      if (release !== 1) throw new Error("SITE_TRAFFIC_STOP_RELEASE_CONFLICT");
      const authorizationRelease = await sql.execute(
        `UPDATE platform.authorization_site_release SET state='revoked',updated_at=now()
         WHERE release_ref=$1 AND site_ref=$2 AND state='active'`,
        [value.releaseRef, value.siteRef],
      );
      if (authorizationRelease !== 1) throw new Error("SITE_TRAFFIC_STOP_AUTHORIZATION_RELEASE_CONFLICT");
    }
    const completed = await sql.execute(
      `UPDATE platform.site SET state=$2,active_release_ref=$3,
         revocation_epoch=revocation_epoch+CASE WHEN $2='decommissioned' THEN 1 ELSE 0 END,
         tombstoned_at=CASE WHEN $2='decommissioned' THEN $4::timestamptz ELSE NULL END,updated_at=now()
       WHERE site_ref=$1 AND state=$5 AND runtime_binding_epoch=$6`,
      [value.siteRef, site.state, site.activeReleaseRef, observation.observedAt,
        value.action === "suspend" ? "suspending" : "decommissioning", value.runtimeBindingEpoch],
    );
    if (completed !== 1) throw new Error("SITE_TRAFFIC_STOP_COMPLETION_CONFLICT");
    const authorizationCompleted = await sql.execute(
      `UPDATE platform.authorization_site SET state=$2,
         revocation_epoch=revocation_epoch+CASE WHEN $2='decommissioned' THEN 1 ELSE 0 END,
         updated_at=now()
       WHERE site_ref=$1 AND state=$3`,
      [value.siteRef, value.action === "suspend" ? "suspended" : "decommissioned",
        value.action === "suspend" ? "suspended" : "decommissioning"],
    );
    if (authorizationCompleted !== 1) throw new Error("SITE_TRAFFIC_STOP_AUTHORIZATION_COMPLETION_CONFLICT");
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
        attempt.runtimeBindingEpoch],
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

    const authorizationSite = await sql.execute(
      `INSERT INTO platform.authorization_site
       (site_ref,state,security_epoch,policy_epoch,revocation_epoch)
       VALUES ($1,'active',$2,$3,$4)
       ON CONFLICT (site_ref) DO UPDATE
       SET state='active',security_epoch=EXCLUDED.security_epoch,
           policy_epoch=EXCLUDED.policy_epoch,revocation_epoch=EXCLUDED.revocation_epoch,
           updated_at=now()
       WHERE platform.authorization_site.security_epoch<=EXCLUDED.security_epoch
         AND platform.authorization_site.policy_epoch<=EXCLUDED.policy_epoch
         AND platform.authorization_site.revocation_epoch<=EXCLUDED.revocation_epoch`,
      [site.siteRef, site.securityEpoch, site.policyEpoch, site.revocationEpoch],
    );
    if (authorizationSite !== 1) throw new Error("SITE_AUTHORIZATION_SITE_CONFLICT");

    if (input.expectedActiveReleaseRef !== null) {
      const retiredAuthorizationRelease = await sql.execute(
        `UPDATE platform.authorization_site_release SET state='retired',updated_at=now()
         WHERE release_ref=$1 AND site_ref=$2 AND state='active'`,
        [input.expectedActiveReleaseRef, site.siteRef],
      );
      if (retiredAuthorizationRelease !== 1) {
        throw new Error("SITE_AUTHORIZATION_RELEASE_RETIRE_CONFLICT");
      }
    }

    const authorizationRelease = await sql.execute(
      `INSERT INTO platform.authorization_site_release
       (release_ref,site_ref,state,web_artifact_digest,enabled_surface_ids,
        feature_policy_revision,model_option_catalog_ref,agent_catalog_ref,
        identity_issuer_label,identity_auth_strength_policy_revision,locale_policy)
       SELECT release_ref,site_ref,'active',web_artifact_digest,enabled_surface_ids,
              feature_policy_revision,model_option_catalog_ref,agent_catalog_ref,
              identity_issuer_label,identity_auth_strength_policy_revision,locale_policy
       FROM platform.site_release WHERE release_ref=$1 AND site_ref=$2
       ON CONFLICT (release_ref) DO UPDATE SET state='active',updated_at=now()
       WHERE platform.authorization_site_release.site_ref=EXCLUDED.site_ref
         AND platform.authorization_site_release.web_artifact_digest=EXCLUDED.web_artifact_digest
         AND platform.authorization_site_release.enabled_surface_ids=EXCLUDED.enabled_surface_ids
         AND platform.authorization_site_release.feature_policy_revision=EXCLUDED.feature_policy_revision
         AND platform.authorization_site_release.model_option_catalog_ref=EXCLUDED.model_option_catalog_ref
         AND platform.authorization_site_release.agent_catalog_ref=EXCLUDED.agent_catalog_ref
         AND platform.authorization_site_release.identity_issuer_label=EXCLUDED.identity_issuer_label
         AND platform.authorization_site_release.identity_auth_strength_policy_revision=
             EXCLUDED.identity_auth_strength_policy_revision
         AND platform.authorization_site_release.locale_policy=EXCLUDED.locale_policy`,
      [candidate.releaseRef, site.siteRef],
    );
    if (authorizationRelease !== 1) throw new Error("SITE_AUTHORIZATION_RELEASE_CONFLICT");

    const authorizationBinding = await sql.execute(
      `INSERT INTO platform.authorization_product_binding
       (binding_ref,workload_identity_id,deployment_ref,site_ref,release_ref,environment,
        region,audience,session_contract_revision,binding_epoch,state)
       SELECT deployment.binding_ref,project.workload_identity_id,deployment.deployment_ref,
              deployment.site_ref,deployment.release_ref,deployment.environment,deployment.region,
              deployment.audience,deployment.session_contract_revision,deployment.binding_epoch,'active'
       FROM platform.site_deployment_binding deployment
       JOIN platform.site_project_binding project
         ON project.binding_ref=deployment.binding_ref AND project.site_ref=deployment.site_ref
       WHERE deployment.deployment_ref=$1 AND deployment.site_ref=$2
         AND deployment.state='active' AND project.state='active'
       ON CONFLICT (binding_ref) DO UPDATE
       SET workload_identity_id=EXCLUDED.workload_identity_id,
           deployment_ref=EXCLUDED.deployment_ref,release_ref=EXCLUDED.release_ref,
           environment=EXCLUDED.environment,region=EXCLUDED.region,audience=EXCLUDED.audience,
           session_contract_revision=EXCLUDED.session_contract_revision,
           binding_epoch=EXCLUDED.binding_epoch,state='active',updated_at=now()
       WHERE platform.authorization_product_binding.site_ref=EXCLUDED.site_ref
         AND platform.authorization_product_binding.binding_epoch < EXCLUDED.binding_epoch`,
      [attempt.deploymentRef, site.siteRef],
    );
    if (authorizationBinding !== 1) throw new Error("SITE_AUTHORIZATION_BINDING_CONFLICT");
  }

  async updateSite(transaction: PlatformTransaction, site: SiteAggregate): Promise<void> {
    const value = verifySiteAggregate(site);
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.site SET state=$2,active_release_ref=$3,security_epoch=$4,
         policy_epoch=$5,revocation_epoch=$6,runtime_binding_epoch=$7,updated_at=now()
       WHERE site_ref=$1`,
      [value.siteRef, value.state, value.activeReleaseRef, value.securityEpoch,
        value.policyEpoch, value.revocationEpoch, value.runtimeBindingEpoch],
    );
    if (changed !== 1) throw new Error("SITE_UPDATE_CONFLICT");
  }
}

type SiteRow = Record<string, unknown> & {
  siteRef: string; state: string; activeReleaseRef: string | null;
  securityEpoch: bigint; policyEpoch: bigint; revocationEpoch: bigint;
  runtimeBindingEpoch: bigint;
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
  runtimeBindingEpoch: bigint;
  environment: "development" | "preview" | "production"; region: string; audience: string;
  sessionContractRevision: string;
  requestedAt: Date | string; providerOperationKey: string | null; deploymentRef: string | null;
  observedAt: Date | string | null;
  failureCode: string | null;
};
type TrafficStopRow = Record<string, unknown> & {
  attemptRef: string; siteRef: string; action: string; releaseRef: string; deploymentRef: string;
  bindingRef: string; runtimeBindingEpoch: bigint; providerNamespace: string;
  environment: "development" | "preview" | "production"; region: string; state: string;
  requestedAt: Date | string; providerOperationKey: string | null; observedAt: Date | string | null;
  failureCode: string | null;
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

function trafficStopRow(row: TrafficStopRow): SiteTrafficStopAttempt {
  if (!(["suspend", "decommission"] as const).includes(row.action as "suspend" | "decommission") ||
      !["requested", "stop_requested", "observing", "succeeded", "failed", "unknown"].includes(row.state)) {
    throw new Error("SITE_TRAFFIC_STOP_PERSISTED_STATE_INVALID");
  }
  return {
    ...row,
    action: row.action as SiteTrafficStopAttempt["action"],
    state: row.state as SiteTrafficStopAttempt["state"],
    requestedAt: instant(row.requestedAt),
    observedAt: row.observedAt === null ? null : instant(row.observedAt),
  };
}

function activationValues(value: ActivationAttempt): readonly unknown[] {
  return [value.attemptRef, value.siteRef, value.candidateReleaseRef,
    value.expectedActiveReleaseRef, value.candidateWebArtifactDigest, value.candidateManifestDigest,
    value.candidateCertificationDigest, value.siteProjectBindingRef, value.siteProjectBindingEpoch,
    value.runtimeBindingEpoch, value.environment, value.region, value.audience, value.sessionContractRevision,
    value.state, value.requestedAt, value.providerOperationKey, value.deploymentRef, value.observedAt,
    value.failureCode];
}

function trafficStopValues(value: SiteTrafficStopAttempt): readonly unknown[] {
  return [value.attemptRef, value.siteRef, value.action, value.releaseRef, value.deploymentRef,
    value.bindingRef, value.runtimeBindingEpoch, value.providerNamespace, value.environment,
    value.region, value.state, value.requestedAt, value.providerOperationKey, value.observedAt,
    value.failureCode];
}

function siteState(value: string): value is SiteAggregate["state"] {
  return ["preview_ready", "active", "suspending", "suspended", "decommissioning", "decommissioned"].includes(value);
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
