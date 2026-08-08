import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { HandlerContext } from "@connectrpc/connect";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
  CommandDigestAlgorithmV2,
  CommandIdentityV2Schema,
} from "../../src/generated/proto/kokoro/common/v2/command_envelope_pb.js";
import { ImmutableContractRevisionBindingSchema } from
  "../../src/generated/proto/kokoro/platform/publication/v1/publication_common_pb.js";
import {
  AttestedReleaseEvidenceContextSchema,
  DetachedReleaseEvidenceAttestationSchema,
  DetachedReleaseEvidenceDecisionAttestationSchema,
  ReleaseEvidenceCheckerRole,
  ReleaseEvidenceDecisionMaterialSchema,
  ReleaseEvidenceDecisionState,
  ReleaseEvidenceKind,
  ReleaseEvidenceProducerRole,
  ReleaseEvidenceSignatureAlgorithm,
  SignedReleaseEvidenceDecisionSchema,
  WorkloadAuthorizationState,
} from "../../src/generated/proto/kokoro/platform/site/v1/site_publication_pb.js";
import {
  releaseEvidenceDecisionCanonicalPayload,
  releaseEvidenceDecisionPayloadDigest,
  releaseEvidenceDecisionSignaturePreimage,
} from "../../src/generated/contracts/platform-site-evidence-admission@v1/digest.js";
import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
} from "../../src/infrastructure/postgres/client.js";
import { runPlatformMigrations } from "../../src/infrastructure/postgres/migrator.js";
import {
  SITE_PUBLICATION_ADMIN_INSERT_RELATIONS,
  SITE_PUBLICATION_ADMIN_SELECT_RELATIONS,
  SITE_PUBLICATION_ADMIN_UPDATE_RELATIONS,
  SITE_PUBLICATION_ADMISSION_INSERT_RELATIONS,
  SITE_PUBLICATION_ADMISSION_SELECT_RELATIONS,
  SITE_PUBLICATION_ADMISSION_UPDATE_RELATIONS,
} from "../../src/infrastructure/postgres/runtime-relation-authority.js";
import { canonicalDigest, canonicalJson, type ResolvedCanonicalDocument } from
  "../../src/modules/product-catalog/domain/canonical-product-document.js";
import type { SiteEffectiveAccessSnapshot } from
  "../../src/modules/site/application/contracts/site-effective-access-snapshot.js";
import type {
  SitePublicationDocumentResolver,
  SiteReleaseAssemblyPort,
  SiteReleaseCertificationAdmissionPort,
} from "../../src/modules/site/application/contracts/site-publication-authority-ports.js";
import { SitePublicationAuthorityService } from
  "../../src/modules/site/application/services/site-publication-authority-service.js";
import { SiteWebBuildIntentIssuer } from
  "../../src/modules/site/application/services/site-web-build-intent-issuer.js";
import type { CandidateAuthorityBinding, ImmutableRevisionBinding } from
  "../../src/modules/site/domain/site-publication-authority.js";
import { Ed25519SiteWebBuildIntentSigner } from
  "../../src/modules/site/infrastructure/crypto/ed25519-site-web-build-intent-signer.js";
import { PostgresSiteAuthorityJournal } from
  "../../src/modules/site/infrastructure/postgres/site-authority-journal.js";
import { PostgresSiteEffectiveAccessSnapshotAuthority } from
  "../../src/modules/site/infrastructure/postgres/site-effective-access-snapshot-authority.js";
import { PostgresSitePublicationAuthorityRepository } from
  "../../src/modules/site/infrastructure/postgres/site-publication-authority-repository.js";
import { PostgresSiteReleaseCandidateAssembler } from
  "../../src/modules/site/infrastructure/postgres/site-release-candidate-assembler.js";
import { PostgresSiteReleaseEvidenceTrustAuthority } from
  "../../src/modules/site/infrastructure/postgres/site-release-evidence-trust-authority.js";
import { PostgresSiteReleaseEvidenceRecordRepository } from
  "../../src/modules/site/infrastructure/postgres/site-release-evidence-record-repository.js";
import {
  PostgresSiteEvidenceWorkloadAuthorizationResolver,
  siteEvidenceWorkloadAuthorizationLiveRead,
} from "../../src/modules/site/infrastructure/postgres/site-evidence-workload-authorization-resolver.js";
import { PostgresSiteWebBuildIntentIssuerAuthority } from
  "../../src/modules/site/infrastructure/postgres/site-web-build-intent-issuer-authority.js";
import {
  SITE_EVIDENCE_ADMISSION_AUDIENCE,
  SITE_EVIDENCE_ADMISSION_RPC_OPERATION,
  type VerifiedSiteEvidencePeer,
} from "../../src/modules/site/infrastructure/security/site-evidence-peer-registry.js";
import { verifyRequestSecurityContext } from
  "../../src/shared/security-context/request-security-context.js";
import { PlatformUnitOfWork } from "../../src/shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import { createSiteReleaseEvidenceAuthorityProductionComposition } from
  "../../src/process/site-publication-authority-composition.js";

const migratorUrl = leased(process.env.DATABASE_URL_PLATFORM_MIGRATOR_TEST);
const bootstrapUrl = leased(process.env.DATABASE_URL_PLATFORM_BOOTSTRAP_TEST);
const adminUrl = leased(process.env.DATABASE_URL_PLATFORM_ADMIN_TEST);
const admissionUrl = leased(process.env.DATABASE_URL_PLATFORM_ADMISSION_TEST);
const apiRole = role(process.env.PLATFORM_DATABASE_API_ROLE);
const adminRole = role(process.env.PLATFORM_DATABASE_ADMIN_ROLE);
const admissionRole = role(process.env.PLATFORM_DATABASE_ADMISSION_ROLE);
const migratorRole = role(process.env.PLATFORM_DATABASE_MIGRATOR_ROLE);
const databaseName = new URL(migratorUrl).pathname.slice(1);
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;

describe("Site publication PostgreSQL runtime authority", () => {
  it("applies the schema and enforces exact Admin authority at startup", async () => {
    await runPlatformMigrations({
      environment: {
        ...process.env,
        DATABASE_URL_PLATFORM: migratorUrl,
        PLATFORM_DATABASE_CREDENTIAL_CLASS: "migrator",
      },
    });
    const bootstrap = new Client({ connectionString: bootstrapUrl });
    const admin = createPlatformDatabaseClient(loadPlatformDatabaseConfig("admin", {
      DATABASE_URL_PLATFORM: adminUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "admin",
      PLATFORM_DATABASE_ADMIN_ROLE: adminRole,
      PLATFORM_DATABASE_MIGRATOR_ROLE: migratorRole,
      PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
    }));
    const admission = createPlatformDatabaseClient(loadPlatformDatabaseConfig("admission", {
      DATABASE_URL_PLATFORM: admissionUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "admission",
      PLATFORM_DATABASE_ADMISSION_ROLE: admissionRole,
      PLATFORM_DATABASE_MIGRATOR_ROLE: migratorRole,
      PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
    }));
    await bootstrap.connect();
    try {
      await expect(Promise.all([admin.connect(), admission.connect()])).resolves.toHaveLength(2);
      const authority = await bootstrap.query<{
        relation_name: string;
        admin_select: boolean;
        admin_insert: boolean;
        admin_update: boolean;
        admin_delete: boolean;
        api_select: boolean;
      }>(
        `SELECT relation_name,
                has_table_privilege($1,format('platform.%I',relation_name),'SELECT') AS admin_select,
                has_table_privilege($1,format('platform.%I',relation_name),'INSERT') AS admin_insert,
                has_any_column_privilege($1,format('platform.%I',relation_name),'UPDATE') AS admin_update,
                has_table_privilege($1,format('platform.%I',relation_name),'DELETE') AS admin_delete,
                has_table_privilege($2,format('platform.%I',relation_name),'SELECT') AS api_select
         FROM unnest($3::text[]) relation_name ORDER BY relation_name`,
        [adminRole, apiRole, SITE_PUBLICATION_ADMIN_SELECT_RELATIONS],
      );
      expect(authority.rows).toHaveLength(SITE_PUBLICATION_ADMIN_SELECT_RELATIONS.length);
      for (const row of authority.rows) {
        expect(row).toEqual({
          relation_name: row.relation_name,
          admin_select: true,
          admin_insert: SITE_PUBLICATION_ADMIN_INSERT_RELATIONS.includes(
            row.relation_name as never,
          ),
          admin_update: SITE_PUBLICATION_ADMIN_UPDATE_RELATIONS.includes(
            row.relation_name as never,
          ),
          admin_delete: false,
          api_select: false,
        });
      }
      const rls = await bootstrap.query<{ relation_name: string; enabled: boolean; forced: boolean }>(
        `SELECT relation.relname AS relation_name,relation.relrowsecurity AS enabled,
                relation.relforcerowsecurity AS forced
         FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
         WHERE namespace.nspname='platform' AND relation.relname=ANY($1::text[])
         ORDER BY relation.relname`,
        [SITE_PUBLICATION_ADMIN_SELECT_RELATIONS],
      );
      expect(rls.rows).toHaveLength(SITE_PUBLICATION_ADMIN_SELECT_RELATIONS.length);
      expect(rls.rows.every((row) => row.enabled && row.forced)).toBe(true);

      const admissionAuthority = await bootstrap.query<{
        relation_name: string;
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
      }>(
        `SELECT relation_name,
                has_table_privilege($1,format('platform.%I',relation_name),'SELECT') AS can_select,
                has_table_privilege($1,format('platform.%I',relation_name),'INSERT') AS can_insert,
                has_any_column_privilege($1,format('platform.%I',relation_name),'UPDATE') AS can_update,
                has_table_privilege($1,format('platform.%I',relation_name),'DELETE') AS can_delete
         FROM unnest($2::text[]) relation_name ORDER BY relation_name`,
        [admissionRole, SITE_PUBLICATION_ADMISSION_SELECT_RELATIONS],
      );
      expect(admissionAuthority.rows).toHaveLength(SITE_PUBLICATION_ADMISSION_SELECT_RELATIONS.length);
      for (const row of admissionAuthority.rows) {
        expect(row).toEqual({
          relation_name: row.relation_name,
          can_select: true,
          can_insert: SITE_PUBLICATION_ADMISSION_INSERT_RELATIONS.includes(row.relation_name as never),
          can_update: SITE_PUBLICATION_ADMISSION_UPDATE_RELATIONS.includes(row.relation_name as never),
          can_delete: false,
        });
      }
      const receiptUpdate = await bootstrap.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='platform' AND table_name='command_receipt'
           AND has_column_privilege($1,'platform.command_receipt',column_name,'UPDATE')
         ORDER BY ordinal_position`,
        [admissionRole],
      );
      expect(receiptUpdate.rows.map((row) => row.column_name)).toEqual([
        "state", "result", "result_digest", "updated_at",
      ]);

      await expect(bootstrap.query(
        `SELECT platform.bootstrap_site_publication_authorities(
           '{"version":1,"effectiveAccess":[{}],"intentIssuers":[{}],"producerTrust":[{},{}]}'::jsonb,
           repeat('a',64)::char(64)
         )`,
      )).rejects.toMatchObject({ message: expect.stringContaining(
        "SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_INVALID",
      ) });
      await expect(bootstrap.query(
        "DELETE FROM platform.site_publication_authority_bootstrap WHERE singleton IS TRUE",
      )).rejects.toMatchObject({ message: expect.stringContaining(
        "SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_TRANSITION_INVALID",
      ) });
    } finally {
      await Promise.allSettled([admin.disconnect(), admission.disconnect()]);
      await bootstrap.end();
    }
  }, 60_000);

  it("executes the operator publication chain and denies every mismatched RLS axis", async () => {
    await runPlatformMigrations({
      environment: {
        ...process.env,
        DATABASE_URL_PLATFORM: migratorUrl,
        PLATFORM_DATABASE_CREDENTIAL_CLASS: "migrator",
      },
    });
    const fixture = createFixture();
    const bootstrap = new Client({ connectionString: bootstrapUrl });
    const rawAdmin = new Client({ connectionString: adminUrl });
    const admin = createPlatformDatabaseClient(loadPlatformDatabaseConfig("admin", {
      DATABASE_URL_PLATFORM: adminUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "admin",
      PLATFORM_DATABASE_ADMIN_ROLE: adminRole,
      PLATFORM_DATABASE_MIGRATOR_ROLE: migratorRole,
      PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
    }));
    const admission = createPlatformDatabaseClient(loadPlatformDatabaseConfig("admission", {
      DATABASE_URL_PLATFORM: admissionUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "admission",
      PLATFORM_DATABASE_ADMISSION_ROLE: admissionRole,
      PLATFORM_DATABASE_MIGRATOR_ROLE: migratorRole,
      PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
    }));
    await Promise.all([bootstrap.connect(), rawAdmin.connect(), admin.connect(), admission.connect()]);
    try {
      await seedPublicationAuthority(bootstrap, fixture);
      const documents = publicationDocuments();
      const service = publicationService(admin, fixture, documents.resolver);
      const candidateCommandId = randomUUID();
      const candidateResult = await service.authorizeCandidate({
        commandId: candidateCommandId,
        idempotencyKey: `candidate-${fixture.suffix}`,
        siteRef: fixture.siteRef,
        candidateRef: fixture.candidateRef,
        expectedCandidateVersion: 1n,
        candidateAuthorizationEpoch: 1n,
        launchProductProfile: fixture.profile,
        productSurfaceCatalog: fixture.catalog,
        businessBindingsDigest: canonicalDigest(businessBindings(fixture.snapshot)),
        reason: "component publication authority",
      }, await operatorContext("site.release-candidate.authorize", fixture.siteRef));

      const surface = surfaceDocument(fixture, candidateResult.candidate);
      const surfaceSource = source(surface);
      const surfaceBinding = binding(fixture.inventoryRef, surfaceSource);
      documents.add("surface-inventory", surfaceBinding, surfaceSource);
      await expect(service.publishNode({
        commandId: randomUUID(), idempotencyKey: `inventory-${fixture.suffix}`,
        siteRef: fixture.siteRef, kind: "surface-inventory", candidate: candidateResult.candidate,
        binding: surfaceBinding, reason: "approve surface inventory", producerKind: "operator-approved",
      }, await operatorContext("site.surface-inventory.publish", fixture.siteRef)))
        .resolves.toMatchObject({ state: "published", replayed: false });

      documents.add("web-build-material-bundle", fixture.material, fixture.materialSource);
      await expect(service.publishNode({
        commandId: randomUUID(), idempotencyKey: `material-${fixture.suffix}`,
        siteRef: fixture.siteRef, kind: "web-build-material-bundle",
        candidate: candidateResult.candidate, binding: fixture.material,
        reason: "approve web build material", producerKind: "operator-approved",
      }, await operatorContext("site.web-build-material-bundle.publish", fixture.siteRef)))
        .resolves.toMatchObject({ state: "published", replayed: false });

      const intentCommand = {
        commandId: randomUUID(), idempotencyKey: `intent-${fixture.suffix}`,
        siteRef: fixture.siteRef, candidate: candidateResult.candidate,
        expectedSurfaceInventory: surfaceBinding,
        expectedWebBuildMaterialBundle: fixture.material,
        reason: "issue signed web build intent",
      } as const;
      const intentContext = await operatorContext("site.web-build-intent.publish", fixture.siteRef);
      const intent = await service.issueWebBuildIntent(intentCommand, intentContext);
      const replay = await service.issueWebBuildIntent(intentCommand, intentContext);
      expect(intent).toMatchObject({ state: "published", replayed: false });
      expect(replay).toEqual({ ...intent, replayed: true });

      const persisted = await bootstrap.query<{ nodes: string; envelopes: string }>(
        `SELECT
           (SELECT count(*)::text FROM platform.site_publication_revision
             WHERE candidate_ref=$1) AS nodes,
           (SELECT count(*)::text FROM platform.site_web_build_intent_envelope
             WHERE intent_ref=$2) AS envelopes`,
        [fixture.candidateRef, intent.binding.ref],
      );
      expect(persisted.rows[0]).toEqual({ nodes: "3", envelopes: "1" });

      const evidence = createSignedEvidenceFixture(
        fixture, candidateResult.candidate, surfaceBinding, intent.binding,
      );
      await seedEvidenceTrust(bootstrap, evidence);
      documents.add("compiled-web-manifest", evidence.compiledWebManifest,
        evidence.compiledWebManifestSource);
      documents.add("web-artifact-provenance", evidence.webArtifactProvenance,
        evidence.webArtifactProvenanceSource);
      const peer = evidenceProductionPeer(fixture, evidence);
      const authorizationObservedAt = new Date(Date.now() - 1_000);
      const authorizationValidUntil = new Date(Date.now() + 20_000);
      const claimed = evidenceContext(peer, 1n, authorizationObservedAt, authorizationValidUntil);
      const workloadResolver = new PostgresSiteEvidenceWorkloadAuthorizationResolver({
        database: admission,
        peer: () => peer,
      });
      const resolved = await workloadResolver.resolve(claimed, {} as HandlerContext, {
        siteRef: fixture.siteRef,
        resourceRefs: [candidateResult.candidate.ref, evidence.compiledWebManifest.ref,
          evidence.webArtifactProvenance.ref],
      });
      expect(await evidenceCandidateCount(admission, fixture, "site.evidence.record", false,
        fixture.workloadIdentityRef)).toBe(0);
      expect(await evidenceCandidateCount(admission, fixture, "site.evidence.record", true,
        `${fixture.workloadIdentityRef}.wrong`)).toBe(0);
      expect(await evidenceCandidateCount(admission, fixture, "site.evidence.authorize", true,
        fixture.workloadIdentityRef)).toBe(0);
      await expectExpiredEvidenceWorkload(admission, fixture, resolved.workload);

      const verifiedAt = new Date(Date.now() + 1_000).toISOString();
      const production = createSiteReleaseEvidenceAuthorityProductionComposition(admission, {
        evidenceTrustAuthority: new PostgresSiteReleaseEvidenceTrustAuthority(),
        documents: documents.resolver,
        now: () => verifiedAt,
      });
      const command = claimed.command;
      if (command === undefined) throw new Error("SITE_EVIDENCE_COMPONENT_COMMAND_REQUIRED");
      const input = {
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        requestDigest: command.requestDigest,
        siteRef: fixture.siteRef,
        candidate: candidateResult.candidate,
        compiledWebManifest: evidence.compiledWebManifest,
        webArtifactProvenance: evidence.webArtifactProvenance,
        webArtifactDigest: evidence.webArtifactDigest,
        artifactInspectionEvidence: evidence.artifactInspectionEvidence,
        journeyEvidence: evidence.journeyEvidence,
        securityEvidence: evidence.securityEvidence,
        producerIdentityRef: evidence.producerIdentityRef,
        producerRegistration: evidence.producerRegistration,
        provenanceAttestation: evidence.provenanceAttestation,
        evidenceDecisions: evidence.evidenceDecisions,
        workload: resolved.workload,
        reason: "record four verified site release signatures",
      } as const;
      const recorded = await production.authority.recordEvidence(input, resolved.context);
      const receiptAt = await production.receipts.read(resolved.context, {
        commandId: command.commandId,
        operation: "site.release-evidence.publish",
      });
      const evidenceReplay = await production.authority.recordEvidence(input, resolved.context);
      expect(recorded).toMatchObject({ replayed: false });
      expect(recorded).not.toHaveProperty("recordedAt");
      expect(evidenceReplay).toEqual({ ...recorded, replayed: true });
      const evidenceRows = await bootstrap.query<{
        nodes: string; provenance: string; decisions: string; receipts: string;
        admittedAt: string; receiptAt: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM platform.site_publication_revision
             WHERE candidate_ref=$1 AND publication_kind='release-evidence') AS nodes,
           (SELECT count(*)::text FROM platform.site_release_provenance_attestation
             WHERE candidate_ref=$1) AS provenance,
           (SELECT count(*)::text FROM platform.site_release_evidence_checker_decision
             WHERE candidate_ref=$1) AS decisions,
           (SELECT count(*)::text FROM platform.command_receipt
             WHERE command_id=$2 AND state='succeeded') AS receipts,
           (SELECT to_char(admitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             FROM platform.site_release_provenance_attestation
             WHERE candidate_ref=$1) AS "admittedAt",
           (SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             FROM platform.command_receipt WHERE command_id=$2) AS "receiptAt"`,
        [fixture.candidateRef, command.commandId],
      );
      const persistedEvidence = evidenceRows.rows[0]!;
      expect(persistedEvidence).toMatchObject({
        nodes: "1", provenance: "1", decisions: "3", receipts: "1", admittedAt: verifiedAt,
      });
      expect(persistedEvidence.receiptAt).not.toBe(verifiedAt);
      expect(receiptAt).toBe(persistedEvidence.receiptAt);
      await expect(rawAdmin.query(
        "SELECT count(*) FROM platform.site_release_evidence_checker_decision",
      )).rejects.toMatchObject({ message: expect.stringContaining("permission denied") });

      for (const denied of [
        { operation: "site.register", siteRef: fixture.siteRef, workload: "admin_workload" },
        { operation: "site.web-build-intent.publish", siteRef: `site.foreign.${fixture.suffix}`,
          workload: "admin_workload" },
        { operation: "site.web-build-intent.publish", siteRef: fixture.siteRef,
          workload: "platform_admin" },
      ]) {
        await expect(visibleCandidateCount(rawAdmin, fixture.candidateRef, denied))
          .resolves.toBe(0);
      }
      await expect(visibleEnvelopeCount(rawAdmin, intent.binding.ref, {
        operation: "site.release.publish", siteRef: fixture.siteRef, workload: "admin_workload",
      })).resolves.toBe(0);
      await expectRawEvidenceMutationsDenied(admission, bootstrap, fixture);
    } finally {
      await Promise.allSettled([admin.disconnect(), admission.disconnect(), rawAdmin.end()]);
      await cleanupPublicationAuthority(bootstrap, fixture);
      await bootstrap.end();
    }
  }, 60_000);

  it("resolves only the exact active workload binding through Admission RLS", async () => {
    await runPlatformMigrations({
      environment: {
        ...process.env,
        DATABASE_URL_PLATFORM: migratorUrl,
        PLATFORM_DATABASE_CREDENTIAL_CLASS: "migrator",
      },
    });
    const suffix = randomUUID().replaceAll("-", "");
    const peer = evidencePeer(suffix);
    const bootstrap = new Client({ connectionString: bootstrapUrl });
    const admission = createPlatformDatabaseClient(loadPlatformDatabaseConfig("admission", {
      DATABASE_URL_PLATFORM: admissionUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "admission",
      PLATFORM_DATABASE_ADMISSION_ROLE: admissionRole,
      PLATFORM_DATABASE_MIGRATOR_ROLE: migratorRole,
      PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
    }));
    await Promise.all([bootstrap.connect(), admission.connect()]);
    try {
      await bootstrap.query(
        "INSERT INTO platform.site(site_ref,site_key,state) VALUES ($1,$2,'preview_ready')",
        [peer.siteRef, `evidence-${suffix.slice(0, 24)}`],
      );
      await bootstrap.query(
        `INSERT INTO platform.site_project_binding
         (binding_ref,site_ref,repository_ref,provider_namespace,provider_project_ref,
          environment,region,workload_identity_id,binding_epoch,state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'active')`,
        [peer.siteProjectBindingRef, peer.siteRef, `repository.${suffix}`, "fixture-provider",
          `project.${suffix}`, peer.environment, peer.region, peer.workloadIdentityRef],
      );
      const resolver = new PostgresSiteEvidenceWorkloadAuthorizationResolver({
        database: admission,
        peer: () => peer,
      });
      const observedAt = new Date(Date.now() - 1_000);
      const validUntil = new Date(Date.now() + 20_000);
      const request = { siteRef: peer.siteRef, resourceRefs: ["candidate.alpha"] } as const;

      await expect(resolver.resolve(
        evidenceContext(peer, 1n, observedAt, validUntil),
        {} as HandlerContext,
        request,
      )).resolves.toMatchObject({
        context: { trustedCaller: { workloadIdentityId: peer.workloadIdentityRef, bindingEpoch: "1" } },
        axes: { siteId: peer.siteRef, workloadAuthorizationEpoch: 1n },
      });
      await expect(resolver.resolve(
        evidenceContext(peer, 2n, observedAt, validUntil),
        {} as HandlerContext,
        request,
      )).rejects.toThrow("SITE_EVIDENCE_WORKLOAD_AUTHORIZATION_NOT_FOUND");

      await bootstrap.query(
        "UPDATE platform.site_project_binding SET state='revoked' WHERE binding_ref=$1",
        [peer.siteProjectBindingRef],
      );
      await expect(resolver.resolve(
        evidenceContext(peer, 1n, observedAt, validUntil),
        {} as HandlerContext,
        request,
      )).rejects.toThrow("SITE_EVIDENCE_WORKLOAD_AUTHORIZATION_NOT_FOUND");
    } finally {
      await Promise.allSettled([admission.disconnect()]);
      await bootstrap.query("DELETE FROM platform.site_project_binding WHERE binding_ref=$1",
        [peer.siteProjectBindingRef]);
      await bootstrap.query("DELETE FROM platform.site WHERE site_ref=$1", [peer.siteRef]);
      await bootstrap.end();
    }
  }, 60_000);
});

function evidencePeer(suffix: string): VerifiedSiteEvidencePeer {
  return Object.freeze({
    workloadIdentityRef: `spiffe://kokoro/site-evidence-attestor/${suffix}`,
    siteProjectBindingRef: `site-project-binding.${suffix}`,
    siteRef: `site.evidence.${suffix}`,
    environment: "production",
    region: "us-east-1",
    audience: SITE_EVIDENCE_ADMISSION_AUDIENCE,
    operation: SITE_EVIDENCE_ADMISSION_RPC_OPERATION,
    producerIdentityRef: `producer.web-attestor.${suffix}`,
    producerRegistration: Object.freeze({ ref: `producer-registration.${suffix}`,
      revision: 1n, digest: digestA }),
    producerRole: "web-artifact-provenance-attestor",
    workloadAttestation: Object.freeze({ ref: `workload-attestation.${suffix}`,
      revision: 1n, digest: digestA }),
  });
}

function evidenceContext(
  peer: VerifiedSiteEvidencePeer,
  bindingEpoch: bigint,
  observedAt: Date,
  validUntil: Date,
) {
  const liveRead = siteEvidenceWorkloadAuthorizationLiveRead({
    bindingRef: peer.siteProjectBindingRef,
    bindingEpoch,
    workloadIdentityRef: peer.workloadIdentityRef,
    siteRef: peer.siteRef,
    environment: peer.environment,
    region: peer.region,
    state: "active",
  });
  return create(AttestedReleaseEvidenceContextSchema, {
    command: create(CommandIdentityV2Schema, {
      commandId: randomUUID(),
      idempotencyKey: `evidence-${randomUUID()}`,
      digestAlgorithm: CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE,
      requestDigest: "b".repeat(64),
    }),
    workloadIdentityRef: peer.workloadIdentityRef,
    audience: peer.audience,
    environment: peer.environment,
    region: peer.region,
    producerIdentityRef: peer.producerIdentityRef,
    producerRegistration: create(ImmutableContractRevisionBindingSchema, peer.producerRegistration),
    producerRole: ReleaseEvidenceProducerRole.WEB_ARTIFACT_PROVENANCE_ATTESTOR,
    workloadAttestation: create(ImmutableContractRevisionBindingSchema, peer.workloadAttestation),
    workloadAuthorizationEpoch: bindingEpoch,
    workloadRevocationEpoch: 0n,
    workloadAuthorizationState: WorkloadAuthorizationState.ACTIVE,
    workloadAuthorizationLiveRead: create(ImmutableContractRevisionBindingSchema, liveRead),
    workloadAuthorizationObservedAt: timestampFromDate(observedAt),
    workloadAuthorizationValidUntil: timestampFromDate(validUntil),
  });
}

interface PublicationFixture {
  readonly suffix: string;
  readonly siteRef: string;
  readonly candidateRef: string;
  readonly inventoryRef: string;
  readonly siteProjectBindingRef: string;
  readonly workloadIdentityRef: string;
  readonly profile: ImmutableRevisionBinding;
  readonly catalog: ImmutableRevisionBinding;
  readonly material: ImmutableRevisionBinding;
  readonly materialSource: ResolvedCanonicalDocument;
  readonly snapshot: SiteEffectiveAccessSnapshot;
  readonly productCommandIds: readonly [string, string];
  readonly intentAuthority: Readonly<{
    authorityRef: string;
    keyId: string;
    publicKeyPem: string;
    privateKeyPem: string;
    publicKeyFingerprint: string;
  }>;
}

function createFixture(): PublicationFixture {
  const suffix = randomUUID().replaceAll("-", "");
  const siteRef = `site.component.${suffix}`;
  const materialDocument = webBuildMaterialDocument(siteRef, `material.${suffix}`);
  const materialSource = source(materialDocument);
  const material = binding(`material.${suffix}`, materialSource);
  const revision = (name: string): ImmutableRevisionBinding =>
    Object.freeze({ ref: `${name}.${suffix}`, revision: 1n, digest: digestA });
  const snapshot: SiteEffectiveAccessSnapshot = Object.freeze({
    webBuildMaterialBundle: material,
    siteConfig: revision("site-config"), legalPolicy: revision("legal-policy"),
    salesPolicy: revision("sales-policy"), assortmentPolicy: revision("assortment-policy"),
    memoryPolicy: revision("memory-policy"),
    authIdentityClosure: Object.freeze({
      identityIssuer: revision("identity-issuer"),
      authenticationPolicy: revision("authentication-policy"),
      authorizationPolicy: revision("authorization-policy"), closureDigest: digestA,
    }),
    commerceClosure: Object.freeze({
      offerRevisions: Object.freeze([revision("offer")]),
      entitlementTemplateRevisions: Object.freeze([revision("entitlement")]),
      creditProgramRevisions: Object.freeze([revision("credit-program")]), closureDigest: digestA,
    }),
    hubClosure: Object.freeze({
      capabilityAssignment: revision("capability-assignment"),
      capabilityCatalog: revision("capability-catalog"),
      agentCatalog: revision("agent-catalog"), closureDigest: digestA,
    }),
    modelRequirements: Object.freeze([]),
  });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicKeyFingerprint = `sha256:${createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" })).digest("hex")}`;
  return Object.freeze({
    suffix, siteRef, candidateRef: `candidate.${suffix}`, inventoryRef: `inventory.${suffix}`,
    siteProjectBindingRef: `binding.${suffix}`,
    workloadIdentityRef: `spiffe://kokoro/site-evidence-attestor/${suffix}`,
    profile: revision("profile"), catalog: revision("catalog"), material, materialSource, snapshot,
    productCommandIds: Object.freeze([randomUUID(), randomUUID()] as const),
    intentAuthority: Object.freeze({ authorityRef: `intent-authority.${suffix}`,
      keyId: `key.intent.${suffix}`, publicKeyPem, privateKeyPem, publicKeyFingerprint }),
  });
}

function publicationService(
  admin: ReturnType<typeof createPlatformDatabaseClient>,
  fixture: PublicationFixture,
  documents: SitePublicationDocumentResolver,
): SitePublicationAuthorityService {
  const unexpected = async (): Promise<never> => {
    throw new Error("UNEXPECTED_SITE_PUBLICATION_COMPONENT_PATH");
  };
  const certification: SiteReleaseCertificationAdmissionPort = { verify: unexpected };
  const releases: SiteReleaseAssemblyPort = { assemble: unexpected };
  const signer = new Ed25519SiteWebBuildIntentSigner([{
    keyId: fixture.intentAuthority.keyId,
    keyVersion: 1n,
    publicKeyPem: fixture.intentAuthority.publicKeyPem,
    privateKeyPem: fixture.intentAuthority.privateKeyPem,
    publicKeyFingerprint: fixture.intentAuthority.publicKeyFingerprint,
  }]);
  return new SitePublicationAuthorityService(
    new PlatformUnitOfWork(admin),
    new PostgresSitePublicationAuthorityRepository(),
    new PostgresSiteAuthorityJournal(),
    new PostgresSiteReleaseCandidateAssembler(
      new PostgresSiteEffectiveAccessSnapshotAuthority(),
      { now: () => "2026-08-08T00:00:00.000Z" },
    ),
    documents,
    new SiteWebBuildIntentIssuer(
      new PostgresSiteWebBuildIntentIssuerAuthority(), signer,
      () => "2026-08-08T00:00:00.000Z",
    ),
    certification,
    releases,
  );
}

function publicationDocuments(): Readonly<{
  resolver: SitePublicationDocumentResolver;
  add(kind: string, binding: ImmutableRevisionBinding, source: ResolvedCanonicalDocument): void;
}> {
  const values = new Map<string, ResolvedCanonicalDocument>();
  const key = (kind: string, value: ImmutableRevisionBinding) =>
    `${kind}\0${value.ref}\0${value.revision.toString()}\0${value.digest}`;
  const resolver: SitePublicationDocumentResolver = Object.freeze({
    async resolve(input: Parameters<SitePublicationDocumentResolver["resolve"]>[0]) {
      const value = values.get(key(input.kind, input.binding));
      if (value === undefined) throw new Error("SITE_PUBLICATION_COMPONENT_DOCUMENT_NOT_FOUND");
      return value;
    },
  });
  return Object.freeze({
    resolver,
    add(kind, binding, value) { values.set(key(kind, binding), value); },
  });
}

async function seedPublicationAuthority(client: Client, fixture: PublicationFixture): Promise<void> {
  const catalogDocument = source({ contract: "kokoro.component-catalog.v1" });
  const profileDocument = source({ contract: "kokoro.component-profile.v1" });
  await client.query("BEGIN");
  try {
    await client.query(
      "INSERT INTO platform.site(site_ref,site_key,state) VALUES ($1,$2,'preview_ready')",
      [fixture.siteRef, `component-${fixture.suffix.slice(0, 24)}`],
    );
    await client.query(
      `INSERT INTO platform.site_project_binding
       (binding_ref,site_ref,repository_ref,provider_namespace,provider_project_ref,
        environment,region,workload_identity_id,binding_epoch,state)
       VALUES ($1,$2,$3,$4,$5,'production','us-east-1',$6,1,'active')`,
      [fixture.siteProjectBindingRef, fixture.siteRef, `repository.${fixture.suffix}`,
        `component.${fixture.suffix.slice(0, 20)}`, `project.${fixture.suffix}`,
        fixture.workloadIdentityRef],
    );
    for (const [index, commandId] of fixture.productCommandIds.entries()) {
      await client.query(
        `INSERT INTO platform.command_receipt
         (command_id,environment,region,caller_identity,operation,idempotency_key,request_digest,state)
         VALUES ($1,'production','us-east-1','component-bootstrap',$2,$3,$4,'succeeded')`,
        [commandId, index === 0 ? "product.catalog.publish" : "product.launch-profile.publish",
          `product-${index}-${fixture.suffix}`, index === 0 ? "a".repeat(64) : "b".repeat(64)],
      );
    }
    await client.query(
      `INSERT INTO platform.product_surface_catalog_revision
       (catalog_revision_ref,revision,digest,canonical_payload,canonical_bytes,published_at,
        published_by,command_id)
       VALUES ($1,1,$2,$3::jsonb,$4,'2026-08-08T00:00:00.000Z','component-bootstrap',$5)`,
      [fixture.catalog.ref, fixture.catalog.digest, JSON.stringify(catalogDocument.parsedDocument),
        catalogDocument.canonicalBytes, fixture.productCommandIds[0]],
    );
    await client.query(
      `INSERT INTO platform.launch_product_profile_revision
       (profile_revision_ref,revision,digest,canonical_payload,canonical_bytes,catalog_revision_ref,
        catalog_revision,catalog_digest,target_site_kind_ref,published_at,published_by,command_id)
       VALUES ($1,1,$2,$3::jsonb,$4,$5,1,$6,'site-kind.component',
               '2026-08-08T00:00:00.000Z','component-bootstrap',$7)`,
      [fixture.profile.ref, fixture.profile.digest, JSON.stringify(profileDocument.parsedDocument),
        profileDocument.canonicalBytes, fixture.catalog.ref, fixture.catalog.digest,
        fixture.productCommandIds[1]],
    );
    await client.query("SELECT set_config('app.site_publication_authority_bootstrap','true',true)");
    await client.query(
      `INSERT INTO platform.site_effective_access_authority_revision
       (site_ref,environment,profile_ref,profile_revision,profile_digest,catalog_ref,
        catalog_revision,catalog_digest,snapshot_digest,snapshot,configuration_digest)
       VALUES ($1,'production',$2,1,$3,$4,1,$5,$6,$7::jsonb,$8)`,
      [fixture.siteRef, fixture.profile.ref, fixture.profile.digest, fixture.catalog.ref,
        fixture.catalog.digest, canonicalDigest(wireSnapshot(fixture.snapshot)),
        JSON.stringify(wireSnapshot(fixture.snapshot)), "c".repeat(64)],
    );
    await client.query(
      `INSERT INTO platform.site_web_build_intent_issuer_revision
       (authority_ref,authority_revision,authority_digest,site_ref,environment,
        web_composition_registry_ref,web_composition_registry_revision,
        web_composition_registry_digest,web_build_toolchain_ref,web_build_toolchain_revision,
        web_build_toolchain_digest,contract_floor,issuer_ref,producer_registry_ref,
        producer_registry_digest,producer_registry_epoch,trust_policy_ref,trust_policy_digest,
        trust_policy_epoch,signing_key_id,key_version,public_key_fingerprint,key_valid_from,
        key_valid_until,configuration_digest)
       VALUES ($1,1,$2,$3,'production','web-registry.component',1,$4,'web-toolchain.component',1,$5,
               '[{"contractRef":"platform-public.v1","minimumMajor":"1"}]'::jsonb,
               'platform.site-intent-issuer','producer-registry.component',$4,1,
               'trust-policy.intent',$5,1,$6,1,$7,'2026-01-01T00:00:00.000Z',
               '2027-01-01T00:00:00.000Z',$8)`,
      [fixture.intentAuthority.authorityRef, digestA, fixture.siteRef, digestA, digestB,
        fixture.intentAuthority.keyId, fixture.intentAuthority.publicKeyFingerprint, "c".repeat(64)],
    );
    await client.query(
      `INSERT INTO platform.site_web_build_intent_issuer_head
       (site_ref,environment,authority_ref,authority_revision,authority_digest,configuration_digest)
       VALUES ($1,'production',$2,1,$3,$4)`,
      [fixture.siteRef, fixture.intentAuthority.authorityRef, digestA, "c".repeat(64)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function cleanupPublicationAuthority(client: Client, fixture: PublicationFixture): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL session_replication_role='replica'");
    await client.query(
      "DELETE FROM platform.site_release_evidence_checker_decision WHERE candidate_ref=$1",
      [fixture.candidateRef],
    );
    await client.query(
      "DELETE FROM platform.site_release_provenance_attestation WHERE candidate_ref=$1",
      [fixture.candidateRef],
    );
    await client.query(
      "DELETE FROM platform.site_web_build_intent_envelope WHERE intent_ref LIKE $1",
      [`web-build-intent.%`],
    );
    await client.query("DELETE FROM platform.site_publication_revision WHERE candidate_ref=$1",
      [fixture.candidateRef]);
    await client.query("DELETE FROM platform.site_release_candidate_authorization WHERE candidate_ref=$1",
      [fixture.candidateRef]);
    await client.query("DELETE FROM platform.site_release_candidate_authority WHERE candidate_ref=$1",
      [fixture.candidateRef]);
    await client.query("DELETE FROM platform.site_web_build_intent_issuer_head WHERE site_ref=$1",
      [fixture.siteRef]);
    await client.query("DELETE FROM platform.site_web_build_intent_issuer_revision WHERE site_ref=$1",
      [fixture.siteRef]);
    await client.query("DELETE FROM platform.site_effective_access_authority_revision WHERE site_ref=$1",
      [fixture.siteRef]);
    await client.query(
      "DELETE FROM platform.site_release_checker_trust_revision WHERE checker_identity_ref LIKE $1",
      [`%${fixture.suffix}`],
    );
    await client.query(
      "DELETE FROM platform.site_release_producer_trust_revision WHERE producer_identity_ref LIKE $1",
      [`%${fixture.suffix}`],
    );
    await client.query("DELETE FROM platform.launch_product_profile_revision WHERE profile_revision_ref=$1",
      [fixture.profile.ref]);
    await client.query("DELETE FROM platform.product_surface_catalog_revision WHERE catalog_revision_ref=$1",
      [fixture.catalog.ref]);
    await client.query("DELETE FROM platform.command_receipt WHERE idempotency_key LIKE $1 OR command_id=ANY($2)",
      [`%${fixture.suffix}`, [...fixture.productCommandIds]]);
    await client.query("DELETE FROM platform.command_receipt WHERE caller_identity=$1",
      [fixture.workloadIdentityRef]);
    await client.query("DELETE FROM platform.site_project_binding WHERE site_ref=$1", [fixture.siteRef]);
    await client.query("DELETE FROM platform.site WHERE site_ref=$1", [fixture.siteRef]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function visibleCandidateCount(
  client: Client,
  candidateRef: string,
  axes: Readonly<{ operation: string; siteRef: string; workload: string }>,
): Promise<number> {
  return scopedCount(client, axes,
    "SELECT count(*)::int AS count FROM platform.site_release_candidate_authority WHERE candidate_ref=$1",
    candidateRef);
}

async function visibleEnvelopeCount(
  client: Client,
  intentRef: string,
  axes: Readonly<{ operation: string; siteRef: string; workload: string }>,
): Promise<number> {
  return scopedCount(client, axes,
    "SELECT count(*)::int AS count FROM platform.site_web_build_intent_envelope WHERE intent_ref=$1",
    intentRef);
}

async function scopedCount(
  client: Client,
  axes: Readonly<{ operation: string; siteRef: string; workload: string }>,
  statement: string,
  ref: string,
): Promise<number> {
  await client.query("BEGIN TRANSACTION READ ONLY");
  try {
    await client.query(
      `SELECT set_config('app.operation',$1,true),set_config('app.site_id',$2,true),
              set_config('app.environment','production',true),
              set_config('app.workload_kind',$3,true),set_config('app.actor_kind','operator',true)`,
      [axes.operation, axes.siteRef, axes.workload],
    );
    const result = await client.query<{ count: number }>(statement, [ref]);
    await client.query("COMMIT");
    return result.rows[0]?.count ?? -1;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function operatorContext(operation: string, siteRef: string) {
  const now = new Date();
  const issuedAt = new Date(now.getTime() - 60_000).toISOString();
  const expiresAt = new Date(now.getTime() + 600_000).toISOString();
  const issuer = "spiffe://kokoro.test/admin";
  const input = {
    requestId: randomUUID(), correlationId: randomUUID(),
    trustedCaller: { kind: "admin_workload", workloadIdentityId: "admin-component",
      environment: "production", region: "us-east-1", audience: "platform-admin",
      allowedOperations: [operation], bindingEpoch: "1", issuedAt, expiresAt },
    actor: { kind: "operator", subjectId: "operator-component", subjectGeneration: "1" },
    delegatedGrant: null,
    target: { siteId: siteRef, workspaceId: null, projectId: null, purpose: operation,
      scopes: [operation] },
    audience: "platform-admin", environment: "production", region: "us-east-1",
    evidence: [{ kind: "workload_attestation", evidenceId: "component-attestation", issuer }],
    policyEpoch: "1", issuedAt, expiresAt,
  } as const;
  return verifyRequestSecurityContext(input, {
    now: now.toISOString(), operation, expectedAudience: "platform-admin",
    expectedEnvironment: "production", expectedRegion: "us-east-1",
    callerVerifier: { verify: async () => ({ workloadIdentityId: "admin-component",
      kind: "admin_workload" as const, audience: "platform-admin", environment: "production",
      region: "us-east-1", allowedOperations: [operation], siteId: null, bindingEpoch: "1",
      issuedAt, expiresAt, issuer, keyVersion: "component-1" }) },
  });
}

function surfaceDocument(fixture: PublicationFixture, candidate: CandidateAuthorityBinding) {
  return {
    contract: "kokoro.surface-inventory.v1", schemaRevision: "1",
    inventoryRevisionRef: fixture.inventoryRef, revision: "1", siteRef: fixture.siteRef,
    siteReleaseCandidate: wireCandidate(candidate), launchProductProfile: wire(fixture.profile),
    productSurfaceCatalog: wire(fixture.catalog), compilerRevisionRef: "compiler.component-v1",
    enabledSurfaceRefs: ["surface.chat"], disabledSurfaceRefs: [],
    shellRequirementRefs: ["shell.main"], generatedAt: "2026-08-08T00:00:00.000Z",
  };
}

function webBuildMaterialDocument(siteRef: string, ref: string) {
  const material = (name: string) => ({
    materialRef: `material.${name}`, mediaType: "application/json", sizeBytes: "2",
    digest: digestA, scanEvidenceRef: `scan.${name}`,
  });
  return {
    contract: "kokoro.web-build-material-bundle.v1", schemaRevision: "1",
    bundleRef: ref, revision: "1", siteRef,
    brand: { displayName: "Component Site", tokens: [], logos: [], icons: [], publicFonts: [] },
    domainPolicy: { canonicalHost: "component.example.com",
      canonicalHttpsOrigin: "https://component.example.com", wwwPolicy: "absent" },
    localePolicy: { defaultLocale: "en", translations: [{ locale: "en", catalog: material("locale") }] },
    legal: { documents: [{ documentRef: "legal.terms", kind: "terms", revision: "1",
      content: material("terms") }], consentPresentationRef: "consent.main",
      cookiePresentationRef: "cookie.main" },
    seo: { title: "Component Site", description: "Component publication authority",
      robotsPolicy: "noindex-nofollow", sitemapPolicy: "disabled", socialCards: [] },
    publicRuntimeConfig: [],
  };
}

function createSignedEvidenceFixture(
  fixture: PublicationFixture,
  candidate: CandidateAuthorityBinding,
  surfaceInventory: ImmutableRevisionBinding,
  webBuildIntent: ImmutableRevisionBinding,
) {
  const producerKey = componentEvidenceKey();
  const producerRegistration = componentBinding(`producer-registration.${fixture.suffix}`, digestA);
  const producerTrustPolicy = componentBinding(`trust-policy.producer.${fixture.suffix}`, digestB);
  const producerIdentityRef = `producer.web-attestor.${fixture.suffix}`;
  const producer = Object.freeze({
    producerIdentityRef,
    producerRegistration,
    producerRegistryEpoch: 1n,
    trustPolicy: producerTrustPolicy,
    trustPolicyEpoch: 1n,
    signingKeyId: `key.producer.${fixture.suffix}`,
    signingKeyVersion: 1n,
    signingKeyFingerprint: producerKey.fingerprint,
    publicKeySpkiPem: producerKey.publicKeyPem,
    configurationDigest: "d".repeat(64),
  });
  const checkers = Object.freeze([
    componentChecker(fixture, "artifact-inspection", ReleaseEvidenceCheckerRole.ARTIFACT_INSPECTION,
      componentEvidenceKey(), "1"),
    componentChecker(fixture, "journey", ReleaseEvidenceCheckerRole.JOURNEY,
      componentEvidenceKey(), "2"),
    componentChecker(fixture, "security", ReleaseEvidenceCheckerRole.SECURITY,
      componentEvidenceKey(), "3"),
  ] as const);
  const webArtifactDigest = `sha256:${"9".repeat(64)}`;
  const artifactInspectionEvidence = componentBinding(
    `evidence.artifact-inspection.${fixture.suffix}`, `sha256:${"4".repeat(64)}`,
  );
  const journeyEvidence = componentBinding(
    `evidence.journey.${fixture.suffix}`, `sha256:${"5".repeat(64)}`,
  );
  const securityEvidence = componentBinding(
    `evidence.security.${fixture.suffix}`, `sha256:${"6".repeat(64)}`,
  );

  const manifest = contractVectorDocument("manifest-chat-only");
  manifest.manifestRef = `compiled-web-manifest.${fixture.suffix}`;
  manifest.siteReleaseCandidate = wireCandidate(candidate);
  manifest.registry = wire(componentBinding("web-registry.component", digestA));
  manifest.catalog = wire(fixture.catalog);
  manifest.surfaceInventory = wire(surfaceInventory);
  manifest.toolchain = wire(componentBinding("web-toolchain.component", digestB));
  manifest.webBuildIntent = wire(webBuildIntent);
  const compiledWebManifestSource = source(manifest);
  const compiledWebManifest = binding(String(manifest.manifestRef), compiledWebManifestSource);

  const provenance = contractVectorDocument("provenance-site-alpha");
  provenance.provenanceRef = `web-artifact-provenance.${fixture.suffix}`;
  const subject = provenance.subject as Array<Record<string, unknown>>;
  (subject[0]!.digest as Record<string, unknown>).sha256 = webArtifactDigest.slice(7);
  const predicate = provenance.predicate as Record<string, unknown>;
  const buildDefinition = predicate.buildDefinition as Record<string, unknown>;
  const external = buildDefinition.externalParameters as Record<string, unknown>;
  external.siteRef = fixture.siteRef;
  external.toolchain = wire(componentBinding("web-toolchain.component", digestB));
  external.webBuildIntent = wire(webBuildIntent);
  external.compiledWebManifest = wire(compiledWebManifest);
  external.siteReleaseCandidate = wireCandidate(candidate);
  const runDetails = predicate.runDetails as Record<string, unknown>;
  runDetails.webArtifactDigest = webArtifactDigest;
  const builder = runDetails.builder as Record<string, unknown>;
  builder.producerRegistryEpoch = producer.producerRegistryEpoch.toString();
  builder.trustPolicyEpoch = producer.trustPolicyEpoch.toString();
  builder.kokoro_signingKeyId = producer.signingKeyId;
  builder.keyVersion = producer.signingKeyVersion.toString();
  builder.publicKeyFingerprint = producer.signingKeyFingerprint;
  builder.keyValidFrom = "2026-01-01T00:00:00.000Z";
  builder.keyValidUntil = "2027-01-01T00:00:00.000Z";
  const webArtifactProvenanceSource = source(provenance);
  const webArtifactProvenance = binding(String(provenance.provenanceRef),
    webArtifactProvenanceSource);
  const provenanceAttestation = create(DetachedReleaseEvidenceAttestationSchema, {
    payloadType: "application/vnd.in-toto+json",
    keyId: producer.signingKeyId,
    keyVersion: producer.signingKeyVersion,
    signatureAlgorithm: ReleaseEvidenceSignatureAlgorithm.ED25519,
    signature: new Uint8Array(sign(null, componentPae(
      "application/vnd.in-toto+json", webArtifactProvenanceSource.canonicalBytes,
    ), producerKey.privateKey)),
  });
  const evidenceDecisions = Object.freeze([
    componentEvidenceDecision(ReleaseEvidenceKind.ARTIFACT_INSPECTION, candidate,
      fixture.siteRef, webArtifactDigest, artifactInspectionEvidence, checkers[0]),
    componentEvidenceDecision(ReleaseEvidenceKind.JOURNEY, candidate,
      fixture.siteRef, webArtifactDigest, journeyEvidence, checkers[1]),
    componentEvidenceDecision(ReleaseEvidenceKind.SECURITY, candidate,
      fixture.siteRef, webArtifactDigest, securityEvidence, checkers[2]),
  ] as const);
  return Object.freeze({
    producerKey, producer, producerIdentityRef, producerRegistration, checkers,
    workloadAttestation: componentBinding(`workload-attestation.${fixture.suffix}`, digestA),
    compiledWebManifest, compiledWebManifestSource,
    webArtifactProvenance, webArtifactProvenanceSource, provenanceAttestation,
    webArtifactDigest, artifactInspectionEvidence, journeyEvidence, securityEvidence,
    evidenceDecisions,
  });
}

function componentChecker(
  fixture: PublicationFixture,
  role: "artifact-inspection" | "journey" | "security",
  protoRole: ReleaseEvidenceCheckerRole,
  key: ReturnType<typeof componentEvidenceKey>,
  character: string,
) {
  return Object.freeze({
    role, protoRole, key,
    checkerIdentityRef: `checker.${role}.${fixture.suffix}`,
    checkerRegistration: componentBinding(`checker-registration.${role}.${fixture.suffix}`,
      `sha256:${character.repeat(64)}`),
    trustPolicy: componentBinding(`trust-policy.${role}.${fixture.suffix}`,
      `sha256:${character.repeat(64)}`),
    trustPolicyEpoch: 1n,
    signingKeyId: `key.checker.${role}.${fixture.suffix}`,
    signingKeyVersion: 1n,
    signingKeyFingerprint: key.fingerprint,
    configurationDigest: `${Number(character) + 6}`.repeat(64),
  });
}

function componentEvidenceDecision(
  kind: ReleaseEvidenceKind,
  candidate: CandidateAuthorityBinding,
  siteRef: string,
  webArtifactDigest: string,
  evidence: ImmutableRevisionBinding,
  checker: ReturnType<typeof componentChecker>,
) {
  const material = create(ReleaseEvidenceDecisionMaterialSchema, {
    kind,
    state: ReleaseEvidenceDecisionState.PASSED,
    candidate: {
      candidateRef: candidate.ref,
      candidateVersion: candidate.version,
      candidateAuthorizationEpoch: candidate.authorizationEpoch,
      candidateDigest: candidate.digest,
    },
    siteId: siteRef,
    environment: "production",
    webArtifactDigest,
    evidence: create(ImmutableContractRevisionBindingSchema, evidence),
    checkerTrust: {
      checkerIdentityRef: checker.checkerIdentityRef,
      checkerRegistration: create(ImmutableContractRevisionBindingSchema,
        checker.checkerRegistration),
      role: checker.protoRole,
      signingKeyId: checker.signingKeyId,
      signingKeyVersion: checker.signingKeyVersion,
      signingKeyFingerprint: checker.signingKeyFingerprint,
      trustPolicyEpoch: checker.trustPolicyEpoch,
    },
  });
  const decision = create(SignedReleaseEvidenceDecisionSchema, {
    material,
    attestation: create(DetachedReleaseEvidenceDecisionAttestationSchema, {
      payloadType: "application/vnd.kokoro.release-evidence-decision.v1+json",
      canonicalPayload: releaseEvidenceDecisionCanonicalPayload(material),
      payloadDigest: releaseEvidenceDecisionPayloadDigest(material),
      keyId: checker.signingKeyId,
      keyVersion: checker.signingKeyVersion,
      signatureAlgorithm: ReleaseEvidenceSignatureAlgorithm.ED25519,
      signature: new Uint8Array(64),
    }),
  });
  decision.attestation!.signature = new Uint8Array(sign(null,
    releaseEvidenceDecisionSignaturePreimage(decision), checker.key.privateKey));
  return decision;
}

function componentEvidenceKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return Object.freeze({
    privateKey,
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    fingerprint: `sha256:${createHash("sha256").update(publicKey.export({
      format: "der", type: "spki",
    })).digest("hex")}`,
  });
}

function componentPae(type: string, payload: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "utf8");
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${typeBytes.byteLength} `, "ascii"), typeBytes,
    Buffer.from(` ${payload.byteLength} `, "ascii"), Buffer.from(payload),
  ]);
}

function contractVectorDocument(id: string): Record<string, unknown> {
  const vectors = JSON.parse(readFileSync(new URL(
    "../../src/generated/contracts/web/release-composition-v1.json", import.meta.url,
  ), "utf8")) as Readonly<{
    positiveCases: readonly Readonly<{ id: string; document: Record<string, unknown> }>[];
  }>;
  const document = vectors.positiveCases.find((value) => value.id === id)?.document;
  if (document === undefined) throw new Error(`SITE_EVIDENCE_COMPONENT_VECTOR_MISSING:${id}`);
  return structuredClone(document);
}

function componentBinding(ref: string, digest: string): ImmutableRevisionBinding {
  return Object.freeze({ ref, revision: 1n, digest });
}

async function seedEvidenceTrust(
  client: Client,
  evidence: ReturnType<typeof createSignedEvidenceFixture>,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.site_release_producer_trust_revision(
       producer_identity_ref,producer_role,environment,producer_registration_ref,
       producer_registration_revision,producer_registration_digest,producer_registry_epoch,
       trust_policy_ref,trust_policy_revision,trust_policy_digest,trust_policy_epoch,
       signing_key_id,signing_key_version,signing_key_fingerprint,signature_domain,key_status,
       key_valid_from,key_valid_until,public_key_spki_pem,configuration_digest)
     VALUES ($1,'web-artifact-provenance-attestor','production',$2,1,$3,1,
       $4,1,$5,1,$6,1,$7,'application/vnd.in-toto+json','active',
       '2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z',$8,$9)`,
    [evidence.producer.producerIdentityRef, evidence.producerRegistration.ref,
      evidence.producerRegistration.digest, evidence.producer.trustPolicy.ref,
      evidence.producer.trustPolicy.digest, evidence.producer.signingKeyId,
      evidence.producer.signingKeyFingerprint, evidence.producer.publicKeySpkiPem,
      evidence.producer.configurationDigest],
  );
  for (const checker of evidence.checkers) {
    await client.query(
      `INSERT INTO platform.site_release_checker_trust_revision(
         environment,checker_role,checker_identity_ref,checker_registration_ref,
         checker_registration_revision,checker_registration_digest,trust_policy_ref,
         trust_policy_revision,trust_policy_digest,trust_policy_epoch,signing_key_id,
         signing_key_version,signing_key_fingerprint,signature_domain,key_status,key_valid_from,
         key_valid_until,public_key_spki_pem,configuration_digest)
       VALUES ('production',$1,$2,$3,1,$4,$5,1,$6,1,$7,1,$8,
         'application/vnd.kokoro.release-evidence-decision.v1+json','active',
         '2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z',$9,$10)`,
      [checker.role, checker.checkerIdentityRef, checker.checkerRegistration.ref,
        checker.checkerRegistration.digest, checker.trustPolicy.ref, checker.trustPolicy.digest,
        checker.signingKeyId, checker.signingKeyFingerprint, checker.key.publicKeyPem,
        checker.configurationDigest],
    );
  }
}

function evidenceProductionPeer(
  fixture: PublicationFixture,
  evidence: ReturnType<typeof createSignedEvidenceFixture>,
): VerifiedSiteEvidencePeer {
  return Object.freeze({
    workloadIdentityRef: fixture.workloadIdentityRef,
    siteProjectBindingRef: fixture.siteProjectBindingRef,
    siteRef: fixture.siteRef,
    environment: "production",
    region: "us-east-1",
    audience: SITE_EVIDENCE_ADMISSION_AUDIENCE,
    operation: SITE_EVIDENCE_ADMISSION_RPC_OPERATION,
    producerIdentityRef: evidence.producerIdentityRef,
    producerRegistration: evidence.producerRegistration,
    producerRole: "web-artifact-provenance-attestor",
    workloadAttestation: evidence.workloadAttestation,
  });
}

async function evidenceCandidateCount(
  database: ReturnType<typeof createPlatformDatabaseClient>,
  fixture: PublicationFixture,
  operation: "site.evidence.authorize" | "site.evidence.record",
  ownerAxis: boolean,
  workloadIdentityRef: string,
): Promise<number> {
  return database.internalTransaction(operation, async (transaction) => {
    const sql = resolvePlatformTransaction(transaction);
    await sql.query(
      `SELECT set_config('app.site_id',$1,true),set_config('app.environment','production',true),
              set_config('app.region','us-east-1',true),
              set_config('app.workload_identity_ref',$2,true),
              set_config('app.workload_binding_epoch','1',true),
              set_config('app.actor_kind','workload',true),
              CASE WHEN $3::boolean THEN set_config('app.workload_kind','platform_worker',true)
                   ELSE current_setting('app.workload_kind',true) END`,
      [fixture.siteRef, workloadIdentityRef, ownerAxis],
    );
    const rows = await sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.site_release_candidate_authority
       WHERE candidate_ref=$1`,
      [fixture.candidateRef],
    );
    return Number(rows[0]?.count ?? "-1");
  });
}

async function expectExpiredEvidenceWorkload(
  database: ReturnType<typeof createPlatformDatabaseClient>,
  fixture: PublicationFixture,
  workload: Parameters<PostgresSiteReleaseEvidenceRecordRepository["assertLiveWorkload"]>[1],
): Promise<void> {
  await database.internalTransaction("site.evidence.record", async (transaction) => {
    const sql = resolvePlatformTransaction(transaction);
    await sql.query(
      `SELECT set_config('app.site_id',$1,true),set_config('app.environment','production',true),
              set_config('app.region','us-east-1',true),
              set_config('app.workload_identity_ref',$2,true),
              set_config('app.workload_binding_epoch','1',true),
              set_config('app.workload_kind','platform_worker',true),
              set_config('app.actor_kind','workload',true)`,
      [fixture.siteRef, fixture.workloadIdentityRef],
    );
    const now = await sql.query<{ authoritativeNow: Date | string }>(
      `SELECT clock_timestamp() AS "authoritativeNow"`,
    );
    const validUntil = new Date(now[0]!.authoritativeNow).toISOString();
    await expect(new PostgresSiteReleaseEvidenceRecordRepository().assertLiveWorkload(
      transaction, { ...workload, validUntil },
    )).rejects.toThrow("SITE_EVIDENCE_WORKLOAD_AUTHORIZATION_REVOKED");
  });
}

async function expectRawEvidenceMutationsDenied(
  database: ReturnType<typeof createPlatformDatabaseClient>,
  bootstrap: Client,
  fixture: PublicationFixture,
): Promise<void> {
  const provenance = await bootstrap.query<{ record: Record<string, unknown> }>(
    `SELECT to_jsonb(provenance) AS record
     FROM platform.site_release_provenance_attestation provenance
     WHERE candidate_ref=$1`,
    [fixture.candidateRef],
  );
  const decisions = await bootstrap.query<{ record: Record<string, unknown> }>(
    `SELECT to_jsonb(decision) AS record
     FROM platform.site_release_evidence_checker_decision decision
     WHERE candidate_ref=$1 ORDER BY evidence_kind`,
    [fixture.candidateRef],
  );
  expect(provenance.rows).toHaveLength(1);
  expect(decisions.rows).toHaveLength(3);
  const provenanceRecord = provenance.rows[0]!.record;
  const decisionRecords = decisions.rows.map((row) => row.record);

  await deleteImmutableEvidenceRows(bootstrap,
    "DELETE FROM platform.site_release_evidence_checker_decision WHERE candidate_ref=$1",
    [fixture.candidateRef]);
  await withEvidenceOwnerTransaction(database, fixture, async (sql) => {
    const base = decisionRecords[0]!;
    for (const [column, value] of [
      ["candidate_ref", `${fixture.candidateRef}.mutated`],
      ["candidate_version", "2"],
      ["candidate_authorization_epoch", "2"],
      ["candidate_digest", changedDigest(base.candidate_digest)],
      ["site_ref", `${fixture.siteRef}.mutated`],
      ["environment", "staging"],
      ["web_artifact_digest", changedDigest(base.web_artifact_digest)],
    ] as const) {
      await expectRlsRejected(sql, decisionInsertSql(), { ...base, [column]: value });
    }
    for (const decision of decisionRecords) {
      for (const [column, value] of [
        ["evidence_ref", `${String(decision.evidence_ref)}.mutated`],
        ["evidence_revision", "2"],
        ["evidence_digest", changedDigest(decision.evidence_digest)],
      ] as const) {
        await expectRlsRejected(sql, decisionInsertSql(), { ...decision, [column]: value });
      }
    }
    for (const decision of decisionRecords) {
      await sql.execute(decisionInsertSql(), [JSON.stringify(decision)]);
    }
  });

  await deleteImmutableEvidenceRows(bootstrap,
    "DELETE FROM platform.site_release_evidence_checker_decision WHERE candidate_ref=$1",
    [fixture.candidateRef]);
  await deleteImmutableEvidenceRows(bootstrap,
    "DELETE FROM platform.site_release_provenance_attestation WHERE candidate_ref=$1",
    [fixture.candidateRef]);
  await withEvidenceOwnerTransaction(database, fixture, async (sql) => {
    const record = JSON.stringify(provenanceRecord);
    for (const statement of [
      provenanceInsertSql(
        "statement_timestamp()-INTERVAL '31 seconds'",
        "statement_timestamp()+INTERVAL '1 second'",
      ),
      provenanceInsertSql(
        "statement_timestamp()+INTERVAL '1 second'",
        "statement_timestamp()+INTERVAL '10 seconds'",
      ),
      provenanceInsertSql("statement_timestamp()", "statement_timestamp()"),
    ]) {
      await expectRlsRejected(sql, statement, record);
    }
  });
}

async function withEvidenceOwnerTransaction(
  database: ReturnType<typeof createPlatformDatabaseClient>,
  fixture: PublicationFixture,
  work: (sql: ReturnType<typeof resolvePlatformTransaction>) => Promise<void>,
): Promise<void> {
  await database.internalTransaction("site.evidence.record", async (transaction) => {
    const sql = resolvePlatformTransaction(transaction);
    await sql.query(
      `SELECT set_config('app.site_id',$1,true),set_config('app.environment','production',true),
              set_config('app.region','us-east-1',true),
              set_config('app.workload_identity_ref',$2,true),
              set_config('app.workload_binding_epoch','1',true),
              set_config('app.workload_kind','platform_worker',true),
              set_config('app.actor_kind','workload',true)`,
      [fixture.siteRef, fixture.workloadIdentityRef],
    );
    await work(sql);
  });
}

async function expectRlsRejected(
  sql: ReturnType<typeof resolvePlatformTransaction>,
  statement: string,
  value: Record<string, unknown> | string,
): Promise<void> {
  await sql.query("SAVEPOINT site_evidence_mutation");
  let failure: unknown;
  try {
    await sql.execute(statement, [typeof value === "string" ? value : JSON.stringify(value)]);
  } catch (error) {
    failure = error;
  }
  await sql.query("ROLLBACK TO SAVEPOINT site_evidence_mutation");
  await sql.query("RELEASE SAVEPOINT site_evidence_mutation");
  expect(failure).toMatchObject({ message: expect.stringContaining("row-level security") });
}

function decisionInsertSql(): string {
  return `INSERT INTO platform.site_release_evidence_checker_decision
          SELECT (jsonb_populate_record(
            NULL::platform.site_release_evidence_checker_decision,$1::jsonb)).*`;
}

function provenanceInsertSql(observedAt: string, validUntil: string): string {
  return `INSERT INTO platform.site_release_provenance_attestation
          SELECT (jsonb_populate_record(NULL::platform.site_release_provenance_attestation,
            jsonb_set(jsonb_set($1::jsonb,'{workload_authorization_observed_at}',
              to_jsonb(${observedAt})),'{workload_authorization_valid_until}',
              to_jsonb(${validUntil})))).*`;
}

async function deleteImmutableEvidenceRows(
  client: Client,
  statement: string,
  values: unknown[],
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL session_replication_role='replica'");
    await client.query(statement, values);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function changedDigest(value: unknown): string {
  return value === digestA ? digestB : digestA;
}

function businessBindings(snapshot: SiteEffectiveAccessSnapshot) {
  const value = wireSnapshot(snapshot);
  const { modelRequirements: _modelRequirements, ...bindings } = value;
  return bindings;
}

function wireSnapshot(snapshot: SiteEffectiveAccessSnapshot) {
  return {
    webBuildMaterialBundle: wire(snapshot.webBuildMaterialBundle), siteConfig: wire(snapshot.siteConfig),
    legalPolicy: wire(snapshot.legalPolicy), salesPolicy: wire(snapshot.salesPolicy),
    assortmentPolicy: wire(snapshot.assortmentPolicy), memoryPolicy: wire(snapshot.memoryPolicy),
    authIdentityClosure: { identityIssuer: wire(snapshot.authIdentityClosure.identityIssuer),
      authenticationPolicy: wire(snapshot.authIdentityClosure.authenticationPolicy),
      authorizationPolicy: wire(snapshot.authIdentityClosure.authorizationPolicy),
      closureDigest: snapshot.authIdentityClosure.closureDigest },
    commerceClosure: { offerRevisions: snapshot.commerceClosure.offerRevisions.map(wire),
      entitlementTemplateRevisions: snapshot.commerceClosure.entitlementTemplateRevisions.map(wire),
      creditProgramRevisions: snapshot.commerceClosure.creditProgramRevisions.map(wire),
      closureDigest: snapshot.commerceClosure.closureDigest },
    hubClosure: { capabilityAssignment: wire(snapshot.hubClosure.capabilityAssignment),
      capabilityCatalog: wire(snapshot.hubClosure.capabilityCatalog),
      agentCatalog: wire(snapshot.hubClosure.agentCatalog), closureDigest: snapshot.hubClosure.closureDigest },
    modelRequirements: snapshot.modelRequirements,
  };
}

function source(document: unknown): ResolvedCanonicalDocument {
  const canonicalBytes = Buffer.from(canonicalJson(document), "utf8");
  return Object.freeze({ canonicalBytes, parsedDocument: document, digest: canonicalDigest(document) });
}

function binding(ref: string, document: ResolvedCanonicalDocument): ImmutableRevisionBinding {
  return Object.freeze({ ref, revision: 1n, digest: document.digest });
}

function wire(value: ImmutableRevisionBinding) {
  return { ref: value.ref, revision: value.revision.toString(), digest: value.digest };
}

function wireCandidate(value: CandidateAuthorityBinding) {
  return { ref: value.ref, version: value.version.toString(),
    authorizationEpoch: value.authorizationEpoch.toString(), digest: value.digest };
}

function leased(value: string | undefined): string {
  if (value === undefined || !new URL(value).pathname.slice(1).startsWith("kokoro_test_")) {
    throw new Error("DATABASE_URL_PLATFORM_TEST_MUST_BE_LEASED");
  }
  return value;
}

function role(value: string | undefined): string {
  if (value === undefined || !/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error("PLATFORM_DATABASE_RUNTIME_ROLE_REQUIRED");
  }
  return value;
}
