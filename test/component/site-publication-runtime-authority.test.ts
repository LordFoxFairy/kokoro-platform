import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
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
  ReleaseEvidenceProducerRole,
  WorkloadAuthorizationState,
} from "../../src/generated/proto/kokoro/platform/site/v1/site_publication_pb.js";
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
    await Promise.all([bootstrap.connect(), rawAdmin.connect(), admin.connect()]);
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
    } finally {
      await Promise.allSettled([admin.disconnect(), rawAdmin.end()]);
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
      offerPriceRevisions: Object.freeze([revision("offer-price")]),
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
      [`binding.${fixture.suffix}`, fixture.siteRef, `repository.${fixture.suffix}`,
        `component.${fixture.suffix.slice(0, 20)}`, `project.${fixture.suffix}`,
        `workload.${fixture.suffix}`],
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
    await client.query("DELETE FROM platform.launch_product_profile_revision WHERE profile_revision_ref=$1",
      [fixture.profile.ref]);
    await client.query("DELETE FROM platform.product_surface_catalog_revision WHERE catalog_revision_ref=$1",
      [fixture.catalog.ref]);
    await client.query("DELETE FROM platform.command_receipt WHERE idempotency_key LIKE $1 OR command_id=ANY($2)",
      [`%${fixture.suffix}`, [...fixture.productCommandIds]]);
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
      offerPriceRevisions: snapshot.commerceClosure.offerPriceRevisions.map(wire),
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
