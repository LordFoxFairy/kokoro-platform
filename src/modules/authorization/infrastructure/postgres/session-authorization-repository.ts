import { authorizationDigest } from "../../application/contracts/authorization-digest.js";
import type { SessionAuthorizationRepository } from "../../application/contracts/session-authorization-ports.js";
import {
  SESSION_ACCESS_AUDIENCES,
  SessionAuthorizationError,
  type PersonalContextSnapshot,
  type ProductContextSnapshot,
  type SessionAccessGrantClaims,
  type SurfaceModelOptionCatalog,
} from "../../domain/session-access-grant.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";

type ProductAuthorityRow = Record<string, unknown> & {
  readonly bindingRef: string;
  readonly workloadIdentityId: string;
  readonly deploymentRef: string;
  readonly siteRef: string;
  readonly siteReleaseRef: string;
  readonly environment: string;
  readonly region: string;
  readonly audience: string;
  readonly sessionContractRevision: string;
  readonly bindingEpoch: bigint;
  readonly bindingState: string;
  readonly siteState: string;
  readonly siteSecurityEpoch: bigint;
  readonly policyEpoch: bigint;
  readonly revocationEpoch: bigint;
  readonly releaseState: string;
  readonly webArtifactDigest: string;
  readonly enabledSurfaceIds: unknown;
  readonly featurePolicyRevision: string;
  readonly modelOptionCatalogRef: string;
  readonly agentCatalogRef: string;
  readonly localePolicy: unknown;
};

type GrantAuthorityRow = ProductAuthorityRow & {
  readonly productContextRef: string;
  readonly contextExpiresAt: Date;
  readonly contextSnapshotDigest: string;
  readonly contextPolicyEpoch: bigint;
  readonly contextRevocationEpoch: bigint;
  readonly subjectRef: string;
  readonly subjectState: string;
  readonly subjectGeneration: bigint;
  readonly restrictionEpoch: bigint;
  readonly identitySessionRef: string;
  readonly sessionState: string;
  readonly identitySessionEpoch: bigint;
  readonly credentialEpoch: bigint;
  readonly sessionExpiresAt: Date;
  readonly projectRef: string;
  readonly projectState: string;
  readonly membershipState: string;
  readonly membershipEpoch: bigint;
  readonly authorizationEpoch: bigint;
};

type PersonalRow = Record<string, unknown> & {
  readonly subjectRef: string;
  readonly subjectGeneration: bigint;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly projectRef: string;
  readonly workspaceRef: string;
  readonly executionSpaceRef: string;
  readonly projectDisplayName: string;
  readonly membershipEpoch: bigint;
  readonly authorizationEpoch: bigint;
  readonly isDefault: boolean;
  readonly productContextRef: string;
};

export class PostgresSessionAuthorizationRepository implements SessionAuthorizationRepository {
  async resolveProductContext(transaction: Parameters<SessionAuthorizationRepository["resolveProductContext"]>[0], input: Parameters<SessionAuthorizationRepository["resolveProductContext"]>[1]): Promise<ProductContextSnapshot> {
    validateCatalogs(input.modelOptionCatalogs, input.modelOptionCatalogRef);
    const sql = resolvePlatformTransaction(transaction);
    const rows = await sql.query<ProductAuthorityRow>(PRODUCT_AUTHORITY_SQL, [
      input.workload.siteProjectBindingRef,
      input.workload.workloadIdentityId,
    ]);
    const row = rows[0];
    if (row === undefined || !productAuthorityMatches(row, input.workload)) {
      throw new SessionAuthorizationError("WORKLOAD_NOT_AUTHORIZED");
    }
    if (
      row.bindingState !== "active" ||
      row.siteState !== "active" ||
      row.releaseState !== "active" ||
      row.modelOptionCatalogRef !== input.modelOptionCatalogRef
    ) throw new SessionAuthorizationError("PRODUCT_CONTEXT_STALE");
    const enabledSurfaceIds = stringArray(row.enabledSurfaceIds, "PRODUCT_CONTEXT_STALE");
    const modelSurfaces = input.modelOptionCatalogs.map((catalog) => catalog.surfaceId);
    if (modelSurfaces.some((surface) => !enabledSurfaceIds.includes(surface))) {
      throw new SessionAuthorizationError("PRODUCT_CONTEXT_STALE");
    }
    const authority = {
      siteProjectBindingRef: row.bindingRef,
      deploymentRef: row.deploymentRef,
      siteRef: row.siteRef,
      siteReleaseRef: row.siteReleaseRef,
      webArtifactDigest: row.webArtifactDigest,
      runtimeEnvironment: input.workload.environment,
      region: row.region,
      audience: row.audience,
      sessionContractRevision: row.sessionContractRevision,
      policyEpoch: positive(row.policyEpoch),
      revocationEpoch: positive(row.revocationEpoch),
      enabledSurfaceIds,
      featurePolicyRevision: row.featurePolicyRevision,
      modelOptionCatalogRef: row.modelOptionCatalogRef,
      modelOptionCatalogs: input.modelOptionCatalogs,
      agentCatalogRef: row.agentCatalogRef,
      localePolicy: localePolicy(row.localePolicy),
    } as const;
    const snapshotDigest = authorizationDigest(authority);
    const productContextRef = `pc_${snapshotDigest.slice(0, 48)}`;
    const context: ProductContextSnapshot = Object.freeze({
      productContextRef,
      ...authority,
      cacheMaxAgeSeconds: input.cacheMaxAgeSeconds,
      issuedAt: input.now,
      expiresAt: input.expiresAt,
      snapshotDigest,
    });
    const changed = await sql.query<{ snapshotDigest: string }>(
      `INSERT INTO platform.authorization_product_context
       (product_context_ref, binding_ref, site_ref, release_ref, snapshot_digest,
        policy_epoch, revocation_epoch, issued_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz)
       ON CONFLICT (product_context_ref) DO UPDATE
         SET issued_at=EXCLUDED.issued_at, expires_at=EXCLUDED.expires_at
       WHERE authorization_product_context.snapshot_digest=EXCLUDED.snapshot_digest
       RETURNING snapshot_digest AS "snapshotDigest"`,
      [productContextRef, row.bindingRef, row.siteRef, row.siteReleaseRef, snapshotDigest,
        row.policyEpoch, row.revocationEpoch, input.now, input.expiresAt],
    );
    if (changed[0]?.snapshotDigest !== snapshotDigest) {
      throw new SessionAuthorizationError("PRODUCT_CONTEXT_STALE");
    }
    return context;
  }

  async loadPersonalContext(transaction: Parameters<SessionAuthorizationRepository["loadPersonalContext"]>[0], input: Parameters<SessionAuthorizationRepository["loadPersonalContext"]>[1]): Promise<PersonalContextSnapshot> {
    const sql = resolvePlatformTransaction(transaction);
    const rows = await sql.query<PersonalRow>(
      `SELECT subject.subject_ref AS "subjectRef", subject.subject_generation AS "subjectGeneration",
              subject.display_name AS "displayName", subject.avatar_url AS "avatarUrl",
              project.project_ref AS "projectRef", project.workspace_ref AS "workspaceRef",
              project.execution_space_ref AS "executionSpaceRef", project.display_name AS "projectDisplayName",
              membership.membership_epoch AS "membershipEpoch",
              membership.authorization_epoch AS "authorizationEpoch", membership.is_default AS "isDefault",
              context.product_context_ref AS "productContextRef"
       FROM platform.authorization_identity_session identity_session
       JOIN platform.authorization_subject subject ON subject.subject_ref=identity_session.subject_ref
       JOIN platform.authorization_project_membership membership ON membership.subject_ref=subject.subject_ref
       JOIN platform.authorization_project project ON project.project_ref=membership.project_ref
       JOIN LATERAL (
         SELECT product_context_ref FROM platform.authorization_product_context
         WHERE binding_ref=$1 AND site_ref=$2 AND expires_at>$5::timestamptz
         ORDER BY expires_at DESC LIMIT 1
       ) context ON TRUE
       WHERE identity_session.session_ref=$3 AND identity_session.site_ref=$2
         AND identity_session.state='active' AND identity_session.expires_at>$5::timestamptz
         AND identity_session.session_epoch=$4 AND subject.state='active'
         AND subject.subject_generation=$6 AND subject.restriction_epoch=$7
         AND membership.state='active' AND project.state='active'
       ORDER BY membership.is_default DESC, project.project_ref
       FOR SHARE OF identity_session,subject,membership,project`,
      [input.workload.siteProjectBindingRef, input.workload.siteRef, input.session.identitySessionRef,
        BigInt(input.session.identitySessionEpoch), input.now, BigInt(input.session.subjectGeneration),
        BigInt(input.session.restrictionEpoch)],
    );
    if (rows.length === 0) throw new SessionAuthorizationError("PROJECT_NOT_AUTHORIZED");
    const first = rows[0]!;
    if (first.subjectRef !== input.session.subjectRef) {
      throw new SessionAuthorizationError("AUTHORIZATION_STALE");
    }
    const projects = rows.map((row) => Object.freeze({
      projectRef: row.projectRef,
      workspaceRef: row.workspaceRef,
      executionSpaceRef: row.executionSpaceRef,
      displayName: row.projectDisplayName,
      membershipRevision: `${positive(row.membershipEpoch)}.${positive(row.authorizationEpoch)}`,
    }));
    const contextRevision = authorizationDigest({
      subjectRef: first.subjectRef,
      subjectGeneration: positive(first.subjectGeneration),
      projects,
    });
    return Object.freeze({
      personalContextRef: `personal_${contextRevision.slice(0, 48)}`,
      productContextRef: first.productContextRef,
      contextRevision,
      actor: Object.freeze({
        subjectRef: first.subjectRef,
        subjectGeneration: positive(first.subjectGeneration),
        displayName: first.displayName,
        avatarUrl: first.avatarUrl,
        state: "active" as const,
      }),
      defaultProjectRef: (rows.find((row) => row.isDefault) ?? first).projectRef,
      projects: Object.freeze(projects),
      issuedAt: input.now,
      expiresAt: input.expiresAt,
    });
  }

  async prepareSessionAccessGrant(transaction: Parameters<SessionAuthorizationRepository["prepareSessionAccessGrant"]>[0], input: Parameters<SessionAuthorizationRepository["prepareSessionAccessGrant"]>[1]): Promise<Readonly<{ claims: SessionAccessGrantClaims; claimsDigest: string }>> {
    const sql = resolvePlatformTransaction(transaction);
    const rows = await sql.query<GrantAuthorityRow>(GRANT_AUTHORITY_SQL, [
      input.workload.siteProjectBindingRef,
      input.workload.workloadIdentityId,
      input.productContextRef,
      input.session.identitySessionRef,
      input.projectRef,
      input.issuedAt,
    ]);
    const row = rows[0];
    if (row === undefined || !productAuthorityMatches(row, input.workload)) {
      throw new SessionAuthorizationError("PROJECT_NOT_AUTHORIZED");
    }
    if (
      row.bindingState !== "active" || row.siteState !== "active" || row.releaseState !== "active" ||
      row.subjectState !== "active" || row.sessionState !== "active" || row.projectState !== "active" ||
      row.membershipState !== "active" || row.contextExpiresAt.getTime() <= Date.parse(input.issuedAt) ||
      row.sessionExpiresAt.getTime() <= Date.parse(input.issuedAt) ||
      row.contextPolicyEpoch !== row.policyEpoch || row.contextRevocationEpoch !== row.revocationEpoch
    ) throw new SessionAuthorizationError("AUTHORIZATION_STALE");
    if (
      row.subjectRef !== input.session.subjectRef ||
      positive(row.subjectGeneration) !== input.session.subjectGeneration ||
      positive(row.identitySessionEpoch) !== input.session.identitySessionEpoch ||
      positive(row.restrictionEpoch) !== input.session.restrictionEpoch ||
      positive(row.credentialEpoch) !== input.session.credentialEpoch
    ) throw new SessionAuthorizationError("AUTHORIZATION_STALE");
    const claims: SessionAccessGrantClaims = Object.freeze({
      grantRef: input.grantRef,
      binding: Object.freeze({
        productContextRef: row.productContextRef,
        siteProjectBindingRef: row.bindingRef,
        deploymentRef: row.deploymentRef,
        siteRef: row.siteRef,
        siteReleaseRef: row.siteReleaseRef,
        webArtifactDigest: row.webArtifactDigest,
        runtimeEnvironment: input.workload.environment,
        region: row.region,
        sessionContractRevision: row.sessionContractRevision,
        projectRef: row.projectRef,
        subjectRef: row.subjectRef,
        subjectGeneration: positive(row.subjectGeneration),
        identitySessionRef: row.identitySessionRef,
        issuer: input.issuer,
        keyRevision: input.keyRevision,
        notBefore: input.notBefore,
        siteSecurityEpoch: positive(row.siteSecurityEpoch),
        identitySessionEpoch: positive(row.identitySessionEpoch),
        membershipEpoch: positive(row.membershipEpoch),
        authorizationEpoch: positive(row.authorizationEpoch),
        restrictionEpoch: positive(row.restrictionEpoch),
        credentialEpoch: positive(row.credentialEpoch),
        policyEpoch: positive(row.policyEpoch),
        revocationEpoch: positive(row.revocationEpoch),
        resource: input.resource,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
      }),
      authorization: Object.freeze({
        purpose: input.purpose,
        audience: SESSION_ACCESS_AUDIENCES[input.purpose],
      }),
    });
    const claimsDigest = authorizationDigest(claims);
    await sql.execute(
      `INSERT INTO platform.authorization_session_access_grant
       (grant_ref, binding_ref, site_ref, subject_ref, identity_session_ref, project_ref,
        purpose, audience, resource, claims_digest, key_revision, policy_epoch, revocation_epoch,
        site_security_epoch,subject_generation,identity_session_epoch,membership_epoch,
        authorization_epoch,restriction_epoch,credential_epoch,
        delivery_state, issued_at, not_before, expires_at)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,
               $14,$15,$16,$17,$18,$19,$20,'pending',$21::timestamptz,$22::timestamptz,$23::timestamptz)`,
      [claims.grantRef, row.bindingRef, row.siteRef, row.subjectRef, row.identitySessionRef,
        row.projectRef, input.purpose, claims.authorization.audience, JSON.stringify(input.resource),
        claimsDigest, input.keyRevision, row.policyEpoch, row.revocationEpoch,
        row.siteSecurityEpoch,row.subjectGeneration,row.identitySessionEpoch,row.membershipEpoch,
        row.authorizationEpoch,row.restrictionEpoch,row.credentialEpoch,
        input.issuedAt,input.notBefore,input.expiresAt],
    );
    return Object.freeze({ claims, claimsDigest });
  }

  async markGrantDelivered(transaction: Parameters<SessionAuthorizationRepository["markGrantDelivered"]>[0], input: Parameters<SessionAuthorizationRepository["markGrantDelivered"]>[1]): Promise<void> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.authorization_session_access_grant
       SET delivery_state='delivered', credential_digest=$3, delivered_at=now()
       WHERE grant_ref=$1::uuid AND claims_digest=$2 AND delivery_state='pending'`,
      [input.grantRef, input.claimsDigest, input.credentialDigest],
    );
    if (changed !== 1) throw new SessionAuthorizationError("AUTHORIZATION_DELIVERY_FAILED");
  }

  async markGrantDeliveryFailed(transaction: Parameters<SessionAuthorizationRepository["markGrantDeliveryFailed"]>[0], input: Parameters<SessionAuthorizationRepository["markGrantDeliveryFailed"]>[1]): Promise<void> {
    await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.authorization_session_access_grant
       SET delivery_state='failed', delivery_error_code=$3, failed_at=now()
       WHERE grant_ref=$1::uuid AND claims_digest=$2 AND delivery_state='pending'`,
      [input.grantRef, input.claimsDigest, input.errorCode],
    );
  }

}

const PRODUCT_AUTHORITY_SQL = `
  SELECT binding.binding_ref AS "bindingRef", binding.workload_identity_id AS "workloadIdentityId",
         binding.deployment_ref AS "deploymentRef", binding.site_ref AS "siteRef",
         binding.release_ref AS "siteReleaseRef", binding.environment, binding.region, binding.audience,
         binding.session_contract_revision AS "sessionContractRevision",
         binding.binding_epoch AS "bindingEpoch", binding.state AS "bindingState",
         site.state AS "siteState", site.security_epoch AS "siteSecurityEpoch",
         site.policy_epoch AS "policyEpoch", site.revocation_epoch AS "revocationEpoch",
         release.state AS "releaseState", release.web_artifact_digest AS "webArtifactDigest",
         release.enabled_surface_ids AS "enabledSurfaceIds",
         release.feature_policy_revision AS "featurePolicyRevision",
         release.model_option_catalog_ref AS "modelOptionCatalogRef",
         release.agent_catalog_ref AS "agentCatalogRef", release.locale_policy AS "localePolicy"
  FROM platform.authorization_product_binding binding
  JOIN platform.authorization_site site ON site.site_ref=binding.site_ref
  JOIN platform.authorization_site_release release
    ON release.release_ref=binding.release_ref AND release.site_ref=binding.site_ref
  WHERE binding.binding_ref=$1 AND binding.workload_identity_id=$2
  FOR UPDATE OF binding,site,release`;

const GRANT_AUTHORITY_SQL = `
  SELECT binding.binding_ref AS "bindingRef", binding.workload_identity_id AS "workloadIdentityId",
         binding.deployment_ref AS "deploymentRef", binding.site_ref AS "siteRef",
         binding.release_ref AS "siteReleaseRef", binding.environment, binding.region, binding.audience,
         binding.session_contract_revision AS "sessionContractRevision",
         binding.binding_epoch AS "bindingEpoch", binding.state AS "bindingState",
         site.state AS "siteState", site.security_epoch AS "siteSecurityEpoch",
         site.policy_epoch AS "policyEpoch", site.revocation_epoch AS "revocationEpoch",
         release.state AS "releaseState", release.web_artifact_digest AS "webArtifactDigest",
         release.enabled_surface_ids AS "enabledSurfaceIds",
         release.feature_policy_revision AS "featurePolicyRevision",
         release.model_option_catalog_ref AS "modelOptionCatalogRef",
         release.agent_catalog_ref AS "agentCatalogRef", release.locale_policy AS "localePolicy",
         context.product_context_ref AS "productContextRef",
         context.expires_at AS "contextExpiresAt", context.snapshot_digest AS "contextSnapshotDigest",
         context.policy_epoch AS "contextPolicyEpoch", context.revocation_epoch AS "contextRevocationEpoch",
         subject.subject_ref AS "subjectRef", subject.state AS "subjectState",
         subject.subject_generation AS "subjectGeneration", subject.restriction_epoch AS "restrictionEpoch",
         identity_session.session_ref AS "identitySessionRef", identity_session.state AS "sessionState",
         identity_session.session_epoch AS "identitySessionEpoch",
         identity_session.credential_epoch AS "credentialEpoch",
         identity_session.expires_at AS "sessionExpiresAt",
         project.project_ref AS "projectRef", project.state AS "projectState",
         membership.state AS "membershipState", membership.membership_epoch AS "membershipEpoch",
         membership.authorization_epoch AS "authorizationEpoch"
  FROM platform.authorization_product_binding binding
  JOIN platform.authorization_site site ON site.site_ref=binding.site_ref
  JOIN platform.authorization_site_release release
    ON release.release_ref=binding.release_ref AND release.site_ref=binding.site_ref
  JOIN platform.authorization_product_context context
    ON context.product_context_ref=$3 AND context.binding_ref=binding.binding_ref
  JOIN platform.authorization_identity_session identity_session
    ON identity_session.session_ref=$4 AND identity_session.site_ref=binding.site_ref
  JOIN platform.authorization_subject subject
    ON subject.subject_ref=identity_session.subject_ref AND subject.site_ref=binding.site_ref
  JOIN platform.authorization_project project
    ON project.project_ref=$5 AND project.site_ref=binding.site_ref
  JOIN platform.authorization_project_membership membership
    ON membership.project_ref=project.project_ref AND membership.subject_ref=subject.subject_ref
  WHERE binding.binding_ref=$1 AND binding.workload_identity_id=$2
    AND context.expires_at>$6::timestamptz
  FOR UPDATE OF binding,site,release,context,identity_session,subject,project,membership`;

function productAuthorityMatches(row: ProductAuthorityRow, workload: Parameters<SessionAuthorizationRepository["resolveProductContext"]>[1]["workload"]): boolean {
  return row.bindingRef === workload.siteProjectBindingRef &&
    row.workloadIdentityId === workload.workloadIdentityId &&
    row.deploymentRef === workload.deploymentRef &&
    row.siteRef === workload.siteRef &&
    row.siteReleaseRef === workload.siteReleaseRef &&
    row.webArtifactDigest === workload.webArtifactDigest &&
    row.sessionContractRevision === workload.sessionContractRevision &&
    row.environment === workload.environment && row.region === workload.region &&
    row.audience === workload.audience && positive(row.bindingEpoch) === workload.bindingEpoch &&
    positive(row.policyEpoch) === workload.policyEpoch;
}

function positive(value: bigint): string {
  if (value <= 0n) throw new SessionAuthorizationError("AUTHORIZATION_STALE");
  return value.toString();
}

function stringArray(value: unknown, code: "PRODUCT_CONTEXT_STALE"): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new SessionAuthorizationError(code);
  }
  const values = value as string[];
  if (new Set(values).size !== values.length) throw new SessionAuthorizationError(code);
  return Object.freeze([...values]);
}

function localePolicy(value: unknown): ProductContextSnapshot["localePolicy"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionAuthorizationError("PRODUCT_CONTEXT_STALE");
  }
  const policy = value as Record<string, unknown>;
  if (
    typeof policy.defaultLocale !== "string" || !Array.isArray(policy.allowedLocales) ||
    policy.allowedLocales.some((item) => typeof item !== "string")
  ) throw new SessionAuthorizationError("PRODUCT_CONTEXT_STALE");
  return Object.freeze({
    defaultLocale: policy.defaultLocale,
    allowedLocales: Object.freeze([...(policy.allowedLocales as string[])]),
  });
}

function validateCatalogs(catalogs: readonly SurfaceModelOptionCatalog[], aggregateRef: string): void {
  if (aggregateRef.length < 1 || aggregateRef.length > 256 || catalogs.length < 1 || catalogs.length > 64) {
    throw new SessionAuthorizationError("PRODUCT_CONTEXT_STALE");
  }
  const surfaces = new Set<string>();
  for (const catalog of catalogs) {
    if (surfaces.has(catalog.surfaceId) || catalog.options.length < 1) {
      throw new SessionAuthorizationError("PRODUCT_CONTEXT_STALE");
    }
    surfaces.add(catalog.surfaceId);
    if (!catalog.options.some((option) => option.modelOptionRevisionRef === catalog.defaultModelOptionRevisionRef)) {
      throw new SessionAuthorizationError("PRODUCT_CONTEXT_STALE");
    }
  }
}
