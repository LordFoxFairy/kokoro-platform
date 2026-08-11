import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import { capabilitySnapshotDigest, capabilitySignaturePayloadDigest } from
  "../../../src/modules/admission/infrastructure/crypto/capability-publication-verifier.js";
import { PostgresCapabilityCatalogProjectionRepository } from
  "../../../src/modules/admission/infrastructure/postgres/capability-catalog-projection-repository.js";
import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
  type PlatformTransactionalDatabaseClient,
} from "../../../src/infrastructure/postgres/client.js";
import { runPlatformMigrations } from "../../../src/infrastructure/postgres/migrator.js";
import { canonicalizeModelInventory } from
  "../../../src/modules/model-control/domain/model-catalog.js";
import { materializeModelOptionDraftSet } from
  "../../../src/modules/model-control/domain/model-option-materialization.js";
import { createSiteReleaseModelCatalogRevision } from
  "../../../src/modules/model-control/domain/product-model-option.js";
import {
  canonicalCertificationPayload,
  Ed25519SiteReleaseCertificationAuthority,
} from
  "../../../src/modules/site/infrastructure/crypto/site-release-certification-authority.js";
import {
  CORE_SINGLE_SITE_BOOTSTRAP_CHECKER_OPERATIONS,
  CORE_SINGLE_SITE_BOOTSTRAP_MAKER_OPERATIONS,
  createCoreSingleSiteBootstrapProductionOwners,
  createCoreSingleSiteBootstrapRecipe,
  prepareCoreSingleSiteBootstrapExecution,
  type CoreSingleSiteBootstrapExecution,
  type CoreSingleSiteBootstrapOwners,
  type CoreSingleSiteBootstrapProductionDatabases,
} from "../../../src/process/core-single-site-bootstrap-composition.js";
import { coreBootstrapAdminAttestationPayload, type CoreBootstrapAdminAttestationBundle } from
  "../../../src/process/core-single-site-bootstrap-attestation.js";
import {
  coreBootstrapIdempotencyKey,
  coreBootstrapUuid,
  loadCoreSingleSiteBootstrapDocument,
  loadCoreSingleSiteBootstrapSecretMaterial,
  type CoreSingleSiteBootstrapDocument,
} from "../../../src/process/core-single-site-bootstrap-document.js";
import type { RequestSecurityContext } from
  "../../../src/shared/security-context/request-security-context.js";
import { createPlatformFixtureAuthorizationEventAuthority } from
  "../../fixtures/web-chat-credit-runtime.js";

const ADMIN_AUDIENCE = "platform-admin";
const ENVIRONMENT = "production" as const;
const REGION = "us-east-1";
const EMPTY_CAPABILITY_SNAPSHOT = Object.freeze({
  schemaVersion: 1 as const,
  agentOptions: Object.freeze([]),
  tools: Object.freeze([]),
  skillOptions: Object.freeze([]),
  mcpOptions: Object.freeze([]),
  subagents: Object.freeze([]),
});
const EMPTY_CAPABILITY_DIGEST = capabilitySnapshotDigest(EMPTY_CAPABILITY_SNAPSHOT);
const EMPTY_AGENT_CATALOG_REF = `agent-catalog:sha256:${EMPTY_CAPABILITY_DIGEST}`;

export interface CoreSingleSiteBootstrapPostgresFixture {
  readonly document: CoreSingleSiteBootstrapDocument;
  readonly execution: CoreSingleSiteBootstrapExecution;
  readonly owners: CoreSingleSiteBootstrapOwners;
  readonly databases: CoreSingleSiteBootstrapProductionDatabases;
  readonly bootstrap: Client;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly initialCodeKeyRevision: string;
  readonly paths: Readonly<{
    document: string;
    result: string;
    redemptionCode: string;
    commerceKeyRing: string;
  }>;
  lazyReplayEnvironment(): Readonly<Record<string, string | undefined>>;
  mainArguments(documentPath?: string): readonly string[];
  rotateCommerceCodeKey(): Promise<void>;
  writeDocument(
    document: CoreSingleSiteBootstrapDocument,
    name: string,
  ): Promise<string>;
  close(): Promise<void>;
}

export async function createCoreSingleSiteBootstrapPostgresFixture():
Promise<CoreSingleSiteBootstrapPostgresFixture> {
  const lease = databaseLeaseEnvironment(process.env);
  const databaseName = `kokoro_test_core_bootstrap_${randomUUID()
    .replaceAll("-", "").slice(0, 16)}`;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "kokoro-core-bootstrap-component-"));
  const metadataServer = createMetadataServer();
  let bootstrap: Client | undefined;
  let admission: PlatformTransactionalDatabaseClient | undefined;
  let databases: CoreSingleSiteBootstrapProductionDatabases | undefined;
  let databaseCreated = false;
  let closed = false;
  try {
    await createIsolatedDatabase(lease, databaseName);
    databaseCreated = true;
    const urls = isolatedDatabaseUrls(lease, databaseName);
    const migrationEnvironment = Object.freeze({
      ...process.env,
      ...lease.roles,
      DATABASE_URL_PLATFORM: urls.migrator,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "migrator",
      PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
    });
    await runPlatformMigrations({ environment: migrationEnvironment });

    await listen(metadataServer.server);
    const metadataPort = (metadataServer.server.address() as AddressInfo).port;
    const metadataEndpoint = `http://core-bootstrap-provider.internal:${metadataPort}/metadata`;
    const loopbackMetadataEndpoint = `http://127.0.0.1:${metadataPort}/metadata`;
    const fixtureFiles = await createFixtureFiles(temporaryDirectory, metadataEndpoint);
    metadataServer.setMetadata({
      schemaVersion: 1,
      siteId: fixtureFiles.rawDocument.site.siteId,
      siteReleaseRef: fixtureFiles.rawDocument.site.siteReleaseRef,
      webArtifactDigest: fixtureFiles.rawDocument.site.webArtifactDigest,
      deploymentRef: fixtureFiles.deploymentRef,
      readiness: "ready",
      observedAt: fixtureFiles.now,
    });
    const environment = Object.freeze({
      ...migrationEnvironment,
      KOKORO_ENVIRONMENT: ENVIRONMENT,
      DATABASE_URL_PLATFORM_ADMIN: urls.admin,
      DATABASE_URL_PLATFORM_API: urls.api,
      DATABASE_URL_PLATFORM_ADMISSION: urls.admission,
      DATABASE_URL_PLATFORM_SITE_WORKER: urls.siteWorker,
      DATABASE_URL_PLATFORM_IDENTITY_WORKER: urls.identityWorker,
      PLATFORM_MODEL_GATEWAY_DIRECT_ENDPOINT: fixtureFiles.rawDocument.model.endpoint,
      PLATFORM_API_FILE_TRUST_ROOT: temporaryDirectory,
      PLATFORM_AUTHORIZATION_EVENT_KEY_RING_FILE: fixtureFiles.authorizationEventKeyRing,
      PLATFORM_IDENTITY_PASSWORD_PEPPER_RING_FILE: fixtureFiles.identityPepperRing,
      PLATFORM_IDENTITY_AUDIT_DIGEST_KEY_FILE: fixtureFiles.identityAuditKey,
      PLATFORM_COMMERCE_REDEMPTION_KEY_RING_FILE: fixtureFiles.commerceKeyRing.path,
      PLATFORM_SITE_PROVIDER_REGISTRY_FILE: fixtureFiles.siteProviderRegistry,
      PLATFORM_SITE_RELEASE_CERTIFICATION_KEYS_FILE: fixtureFiles.certificationKeys,
      PLATFORM_CORE_BOOTSTRAP_HUB_TLS_TRUST_ROOT: temporaryDirectory,
      PLATFORM_CORE_BOOTSTRAP_HUB_TLS_KEY_FILE: fixtureFiles.hubTlsKey,
      PLATFORM_CORE_BOOTSTRAP_HUB_TLS_CERT_FILE: fixtureFiles.hubTlsCertificate,
      PLATFORM_CORE_BOOTSTRAP_HUB_TLS_CA_FILE: fixtureFiles.hubTlsCa,
      PLATFORM_CORE_BOOTSTRAP_HUB_BASE_URL: "https://127.0.0.1:1",
      PLATFORM_CORE_BOOTSTRAP_HUB_SERVER_NAME: "localhost",
    });
    const document = await loadCoreSingleSiteBootstrapDocument(
      fixtureFiles.document,
      environment,
    );
    const material = await loadCoreSingleSiteBootstrapSecretMaterial(document);
    const execution = await prepareCoreSingleSiteBootstrapExecution({
      document,
      secretDigests: material.secretDigests,
      makerAttestations: fixtureFiles.maker.bundle,
      makerPublicKey: fixtureFiles.maker.publicKey,
      checkerAttestations: fixtureFiles.checker.bundle,
      checkerPublicKey: fixtureFiles.checker.publicKey,
      certificationAuthority: fixtureFiles.certification.authority,
      now: fixtureFiles.now,
      environment,
    });

    bootstrap = new Client({ connectionString: urls.bootstrap });
    databases = Object.freeze({
      admin: platformClient("admin", urls.admin, environment),
      api: platformClient("api", urls.api, environment),
      siteWorker: platformClient("site-worker", urls.siteWorker, environment),
      identityWorker: platformClient("identity-worker", urls.identityWorker, environment),
    });
    admission = platformClient("admission", urls.admission, environment);
    await bootstrap.connect();
    await Promise.all([
      databases.admin.connect(),
      databases.api.connect(),
      databases.siteWorker.connect(),
      databases.identityWorker.connect(),
      admission.connect(),
    ]);

    const productionOwners = await captureFixedProviderOwners({
      databases,
      document,
      authority: fixtureFiles.certification.authority,
      password: material.password,
      entropy: material.redemptionEntropySecret,
      environment,
      now: fixtureFiles.now,
      metadataEndpoint,
      loopbackMetadataEndpoint,
    });
    const owners = Object.freeze({
      ...productionOwners,
      capability: capabilityProjectionPort(admission, fixtureFiles.now),
    });
    const paths = Object.freeze({
      document: fixtureFiles.document,
      result: join(temporaryDirectory, "bootstrap-result.json"),
      redemptionCode: join(temporaryDirectory, "bootstrap-code.txt"),
      commerceKeyRing: fixtureFiles.commerceKeyRing.path,
    });
    const deadEffectEnvironment = Object.freeze({
      ...environment,
      DATABASE_URL_PLATFORM_API: deadDatabaseUrl(urls.api, 1),
      DATABASE_URL_PLATFORM_SITE_WORKER: deadDatabaseUrl(urls.siteWorker, 2),
      DATABASE_URL_PLATFORM_IDENTITY_WORKER: deadDatabaseUrl(urls.identityWorker, 3),
    });
    const mainArguments = (documentPath = paths.document) => Object.freeze([
      "--file", documentPath,
      "--result", paths.result,
      "--redemption-code", paths.redemptionCode,
      "--maker-attestation", join(temporaryDirectory, "missing-maker-attestation.json"),
      "--maker-public-key", join(temporaryDirectory, "missing-maker-public.pem"),
      "--checker-attestation", join(temporaryDirectory, "missing-checker-attestation.json"),
      "--checker-public-key", join(temporaryDirectory, "missing-checker-public.pem"),
    ]);
    const writeDocument = async (
      value: CoreSingleSiteBootstrapDocument,
      name: string,
    ): Promise<string> => {
      if (!/^[a-z][a-z0-9-]{2,63}\.json$/u.test(name)) {
        throw new Error("CORE_BOOTSTRAP_COMPONENT_DOCUMENT_NAME_INVALID");
      }
      const path = join(temporaryDirectory, name);
      await writePrivate(path, JSON.stringify(value));
      return path;
    };
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      const failures: unknown[] = [];
      const disconnected = await Promise.allSettled([
        databases!.admin.disconnect(),
        databases!.api.disconnect(),
        databases!.siteWorker.disconnect(),
        databases!.identityWorker.disconnect(),
        admission!.disconnect(),
        bootstrap!.end(),
      ]);
      failures.push(...disconnected.filter((item): item is PromiseRejectedResult =>
        item.status === "rejected").map((item) => item.reason));
      await closeServer(metadataServer.server).catch((error) => failures.push(error));
      await dropIsolatedDatabase(lease, databaseName).catch((error) => failures.push(error));
      await rm(temporaryDirectory, { recursive: true, force: true })
        .catch((error) => failures.push(error));
      if (failures.length > 0) {
        throw new AggregateError(failures, "CORE_BOOTSTRAP_COMPONENT_CLEANUP_FAILED");
      }
    };
    return Object.freeze({
      document,
      execution,
      owners,
      databases,
      bootstrap,
      environment,
      initialCodeKeyRevision: fixtureFiles.commerceKeyRing.initialCodeKeyRevision,
      paths,
      lazyReplayEnvironment: () => deadEffectEnvironment,
      mainArguments,
      rotateCommerceCodeKey: fixtureFiles.commerceKeyRing.rotate,
      writeDocument,
      close,
    });
  } catch (error) {
    await Promise.allSettled([
      databases?.admin.disconnect(),
      databases?.api.disconnect(),
      databases?.siteWorker.disconnect(),
      databases?.identityWorker.disconnect(),
      admission?.disconnect(),
      bootstrap?.end(),
    ]);
    await closeServer(metadataServer.server).catch(() => undefined);
    if (databaseCreated) await dropIsolatedDatabase(lease, databaseName).catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function createFixtureFiles(directory: string, metadataEndpoint: string) {
  const suffix = randomUUID().replaceAll("-", "");
  const nowDate = new Date(Math.floor(Date.now() / 1_000) * 1_000);
  const now = nowDate.toISOString();
  const issuedAt = new Date(nowDate.getTime() - 60_000).toISOString();
  const expiresAt = new Date(nowDate.getTime() + 30 * 60_000).toISOString();
  const passwordPath = join(directory, "owner-password.txt");
  const entropyPath = join(directory, "redemption-entropy.txt");
  await Promise.all([
    writePrivate(passwordPath, `component-password-${suffix}`),
    writePrivate(entropyPath, randomBytes(48).toString("base64url")),
  ]);

  const makerKeys = generateKeyPairSync("ed25519");
  const checkerKeys = generateKeyPairSync("ed25519");
  const certificationKeys = generateKeyPairSync("ed25519");
  const rawDocument = baseDocument({
    suffix,
    now,
    issuedAt,
    expiresAt,
    metadataEndpoint,
    passwordPath,
    entropyPath,
  });
  const model = fixtureModel(rawDocument, issuedAt);
  rawDocument.model.optionRevisionRef = model.optionRevisionRef;
  rawDocument.model.catalogRef = model.catalogRef;
  const initialRecipe = createCoreSingleSiteBootstrapRecipe(
    rawDocument as CoreSingleSiteBootstrapDocument,
  );
  const proof = rawDocument.site.releaseCertification;
  const certificationPayload = canonicalCertificationPayload({
    ...initialRecipe.siteRelease,
    proof: {
      signingKeyRef: proof.signingKeyRef,
      issuedAt: proof.issuedAt,
      expiresAt: proof.expiresAt,
    },
  });
  rawDocument.site.certificationDigest = createHash("sha256")
    .update(certificationPayload).digest("hex");
  rawDocument.site.releaseCertification.signature = sign(
    null,
    Buffer.concat([
      Buffer.from("kokoro.site-release-certification.v1\0", "utf8"),
      Buffer.from(certificationPayload, "utf8"),
    ]),
    certificationKeys.privateKey,
  ).toString("base64url");
  const provisionalDocument = rawDocument as CoreSingleSiteBootstrapDocument;
  const maker = Object.freeze({
    ...makerKeys,
    bundle: signedBundle(
      CORE_SINGLE_SITE_BOOTSTRAP_MAKER_OPERATIONS,
      provisionalDocument.makerSubjectRef,
      provisionalDocument,
      makerKeys.privateKey,
      "maker",
      issuedAt,
      expiresAt,
    ),
  });
  const checker = Object.freeze({
    ...checkerKeys,
    bundle: signedBundle(
      CORE_SINGLE_SITE_BOOTSTRAP_CHECKER_OPERATIONS,
      provisionalDocument.checkerSubjectRef,
      provisionalDocument,
      checkerKeys.privateKey,
      "checker",
      issuedAt,
      expiresAt,
    ),
  });
  const certification = Object.freeze({
    ...certificationKeys,
    authority: new Ed25519SiteReleaseCertificationAuthority([{
      signingKeyRef: proof.signingKeyRef,
      publicKey: certificationKeys.publicKey,
    }]),
  });
  const authorizationEventAuthority = await createPlatformFixtureAuthorizationEventAuthority();
  const document = join(directory, "bootstrap-document.json");
  const authorizationEventKeyRing = join(directory, "authorization-event-key-ring.json");
  const identityPepperRing = join(directory, "identity-pepper-ring.json");
  const identityAuditKey = join(directory, "identity-audit-key.txt");
  const siteProviderRegistry = join(directory, "site-provider-registry.json");
  const certificationKeyFile = join(directory, "site-certification-keys.json");
  const hubTlsKey = join(directory, "hub-client-key.pem");
  const hubTlsCertificate = join(directory, "hub-client-certificate.pem");
  const hubTlsCa = join(directory, "hub-ca.pem");
  const commerceKeyRing = await createCommerceKeyRing(directory);
  await Promise.all([
    writePrivate(document, JSON.stringify(rawDocument)),
    writePrivate(authorizationEventKeyRing, JSON.stringify(authorizationEventAuthority.keyRing)),
    writePrivate(identityPepperRing, JSON.stringify({
      version: 1,
      currentPepperVersion: 1,
      peppers: [{ version: 1, secretBase64url: randomBytes(32).toString("base64url") }],
      memoryCostKiB: 19_456,
      timeCost: 2,
      parallelism: 1,
    })),
    writePrivate(identityAuditKey, randomBytes(32).toString("base64url")),
    writePrivate(siteProviderRegistry, JSON.stringify({
      version: 1,
      providers: [{
        kind: "fixed_http",
        namespace: rawDocument.site.providerNamespace,
        metadataEndpoint,
        timeoutMs: 5_000,
      }],
    })),
    writePrivate(certificationKeyFile, JSON.stringify({
      version: 1,
      keys: [{
        signingKeyRef: proof.signingKeyRef,
        algorithm: "Ed25519",
        publicKeyPem: certificationKeys.publicKey
          .export({ type: "spki", format: "pem" }).toString(),
      }],
    })),
    writePrivate(hubTlsKey,
      "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n"),
    writePrivate(hubTlsCertificate,
      "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n"),
    writePrivate(hubTlsCa,
      "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n"),
  ]);
  return Object.freeze({
    rawDocument,
    now,
    deploymentRef: `deployment:core:${suffix}`,
    document,
    maker,
    checker,
    certification,
    authorizationEventKeyRing,
    identityPepperRing,
    identityAuditKey,
    siteProviderRegistry,
    certificationKeys: certificationKeyFile,
    hubTlsKey,
    hubTlsCertificate,
    hubTlsCa,
    commerceKeyRing,
  });
}

function baseDocument(input: Readonly<{
  suffix: string;
  now: string;
  issuedAt: string;
  expiresAt: string;
  metadataEndpoint: string;
  passwordPath: string;
  entropyPath: string;
}>) {
  const short = input.suffix.slice(0, 24);
  return {
    version: 1 as const,
    bootstrapId: randomUUID(),
    environment: ENVIRONMENT,
    region: REGION,
    makerSubjectRef: `operator:core-maker:${short}`,
    checkerSubjectRef: `operator:core-checker:${short}`,
    site: {
      siteId: `site:core:${short}`,
      siteKey: `core-${short}`,
      siteReleaseRef: `site-release:core:${short}`,
      siteProjectBindingRef: `site-binding:core:${short}`,
      workloadIdentityId: `spiffe://kokoro.test/site/core-${short}`,
      workloadBindingEpoch: "1" as const,
      providerNamespace: "core.fixed",
      providerProjectRef: `provider-project:core:${short}`,
      metadataEndpoint: input.metadataEndpoint,
      webArtifactDigest: digest(`web:${input.suffix}`),
      releaseManifestDigest: digest(`manifest:${input.suffix}`),
      certificationDigest: digest(`certification:${input.suffix}`),
      releaseCertification: {
        signingKeyRef: `site-release-key:${short}`,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        signature: "A".repeat(86),
      },
      audience: "site-product",
      sessionContractRevision: "session-browser-v3",
    },
    model: {
      provider: "direct" as const,
      providerKey: "direct" as const,
      modelKey: `chat-primary-${short}`,
      modelOptionKey: `chat.standard.${short}`,
      endpoint: "https://direct-model.internal/v1",
      inventoryRef: `model-inventory:core:${short}`,
      optionRevisionRef: "model-option:placeholder",
      catalogRef: "model-catalog:placeholder",
    },
    rating: {
      policyRevisionRef: `rating-policy:core:${short}`,
      unit: "credit",
      inputTokenAmount: "1",
      outputTokenAmount: "1",
    },
    redemption: {
      creditProgramRevisionRef: `credit-program:core:${short}`,
      productVersionRef: `product:core-credit:${short}`,
      fulfillmentProgramRevisionRef: `fulfillment:core-credit:${short}`,
      programRevisionRef: `redemption-program:core:${short}`,
      batchRef: randomUUID(),
      amount: "250000",
      liabilityMerchantAccountRef: `merchant:core:${short}`,
      entropyKeyFile: input.entropyPath,
    },
    identity: {
      email: `owner-${short}@example.test`,
      passwordFile: input.passwordPath,
      accountRef: randomUUID(),
      subjectRef: `subject:core-owner:${short}`,
      workspaceRef: `workspace:core-owner:${short}`,
      projectRef: `project:core-owner:${short}`,
      billingAccountRef: `billing:core-owner:${short}`,
      executionSpaceRef: `execution-space:core-owner:${short}`,
      executionNamespace: `namespace_core_owner_${input.suffix}`,
    },
    externalEmptyAgentCatalogRef: EMPTY_AGENT_CATALOG_REF,
  };
}

function fixtureModel(
  document: ReturnType<typeof baseDocument>,
  publishedAt: string,
) {
  const inventory = canonicalizeModelInventory({
    schemaVersion: 1,
    source: { kind: "platform-native", reference: document.model.inventoryRef },
    providers: [{
      key: "direct",
      provider: "openai-compatible",
      accountKey: "primary",
      secretRef: "secret://platform/model-gateway/direct",
      adapterKind: "direct",
      priority: 0,
    }],
    models: [{
      key: document.model.modelKey,
      displayName: "Chat",
      inputModalities: ["text"],
      outputModalities: ["text"],
      capabilities: ["chat"],
      contextWindow: null,
      enabled: true,
    }],
    bindings: [{
      key: `binding:${document.model.modelKey}`,
      modelKey: document.model.modelKey,
      providerKey: "direct",
      upstreamModel: document.model.modelKey,
      gatewayModelName: document.model.modelKey,
      priority: 0,
      enabled: true,
    }],
    productRoutes: [{
      product: "chat",
      role: "main",
      modelKey: document.model.modelKey,
      position: 0,
      requiredCapabilities: ["chat"],
    }],
  });
  const selection = Object.freeze({
    primaryModelKey: document.model.modelKey,
    fallbackModelKeys: Object.freeze([]),
  });
  const materialized = materializeModelOptionDraftSet({
    inventory,
    draftSet: {
      schemaVersion: 1,
      inventoryDigest: inventory.digest,
      options: [{
        schemaVersion: 1,
        optionKey: document.model.modelOptionKey,
        surface: "chat",
        label: "Chat",
        description: null,
        tier: null,
        lifecycle: "active",
        composition: { orchestration: selection, generation: selection },
      }],
    },
  });
  const optionRevisionRef = materialized.optionRevisions[0]!.modelOptionRevisionRef;
  const catalog = createSiteReleaseModelCatalogRevision({
    siteId: document.site.siteId,
    siteReleaseRef: document.site.siteReleaseRef,
    inventoryDigest: inventory.digest,
    publishedAt,
    surfaces: [{
      surfaceId: "chat",
      allowedModelOptionRevisionRefs: [optionRevisionRef],
      defaultModelOptionRevisionRef: optionRevisionRef,
    }],
    optionRevisions: materialized.optionRevisions,
  });
  return Object.freeze({ optionRevisionRef, catalogRef: catalog.modelOptionCatalogRef });
}

function signedBundle(
  operations: readonly string[],
  operatorRef: string,
  document: CoreSingleSiteBootstrapDocument,
  privateKey: KeyObject,
  nonce: string,
  issuedAt: string,
  expiresAt: string,
): CoreBootstrapAdminAttestationBundle {
  return Object.freeze({
    version: 1 as const,
    attestations: Object.freeze(operations.map((operation, index) => {
      const context = adminContext({
        operation,
        operatorRef,
        document,
        nonce: `${nonce}-${index}`,
        issuedAt,
        expiresAt,
      });
      return Object.freeze({
        operation,
        envelope: Object.freeze({
          context,
          signature: sign(
            null,
            coreBootstrapAdminAttestationPayload(context),
            privateKey,
          ).toString("base64"),
          keyVersion: "component-bootstrap-1",
        }),
      });
    })),
  });
}

function adminContext(input: Readonly<{
  operation: string;
  operatorRef: string;
  document: CoreSingleSiteBootstrapDocument;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}>): RequestSecurityContext {
  const globalModel = [
    "model.inventory.import",
    "model.inventory.activate",
    "model.option.materialize",
  ].includes(input.operation);
  const siteCatalog = input.operation === "model.site-release-catalog.publish";
  const activationChecker = input.operation === "site.activation.begin";
  return {
    requestId: `request:${input.nonce}:${input.operation}`,
    correlationId: `correlation:${input.nonce}:${input.operation}`,
    trustedCaller: {
      workloadIdentityId: `spiffe://kokoro.test/admin/${input.operatorRef.replaceAll(":", "-")}`,
      kind: "admin_workload",
      audience: ADMIN_AUDIENCE,
      environment: input.document.environment,
      region: input.document.region,
      allowedOperations: activationChecker
        ? ["site.approval.approve", "site.activation.begin"]
        : [input.operation],
      bindingEpoch: "1",
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    },
    actor: { kind: "operator", subjectId: input.operatorRef, subjectGeneration: "1" },
    delegatedGrant: null,
    target: {
      siteId: globalModel ? null : input.document.site.siteId,
      workspaceId: null,
      projectId: null,
      purpose: globalModel
        ? "model_control_administration"
        : siteCatalog ? "site_release" : input.operation,
      scopes: siteCatalog ? ["model:site-release:publish"] : [input.operation],
    },
    audience: ADMIN_AUDIENCE,
    environment: input.document.environment,
    region: input.document.region,
    evidence: [{
      kind: "signature",
      evidenceId: `evidence:${input.nonce}:${input.operation}`,
      issuer: "core-bootstrap-component",
    }],
    policyEpoch: "1",
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  };
}

async function createCommerceKeyRing(directory: string) {
  const path = join(directory, "commerce-redemption-key-ring.json");
  const initialCodeKeyRevision = "component-code-v1";
  const initialCodeKey = randomBytes(32).toString("base64url");
  const previewKey = randomBytes(32).toString("base64url");
  const requestAuditKey = randomBytes(32).toString("base64url");
  const write = async (current: string, codeLookupKeys: readonly Readonly<{
    keyRevision: string;
    keyBase64url: string;
  }>[]) => writeFile(path, JSON.stringify({
    version: 1,
    currentCodeLookupKeyRevision: current,
    codeLookupKeys,
    currentPreviewCredentialKeyRevision: "component-preview-v1",
    previewCredentialKeys: [{
      keyRevision: "component-preview-v1",
      keyBase64url: previewKey,
    }],
    requestAuditKeyBase64url: requestAuditKey,
  }), { encoding: "utf8", mode: 0o600 });
  await write(initialCodeKeyRevision, [{
    keyRevision: initialCodeKeyRevision,
    keyBase64url: initialCodeKey,
  }]);
  return Object.freeze({
    path,
    initialCodeKeyRevision,
    rotate: async () => write("component-code-v2", [{
      keyRevision: initialCodeKeyRevision,
      keyBase64url: initialCodeKey,
    }, {
      keyRevision: "component-code-v2",
      keyBase64url: randomBytes(32).toString("base64url"),
    }]),
  });
}

async function captureFixedProviderOwners(input: Readonly<{
  databases: CoreSingleSiteBootstrapProductionDatabases;
  document: CoreSingleSiteBootstrapDocument;
  authority: Ed25519SiteReleaseCertificationAuthority;
  password: string;
  entropy: Uint8Array;
  environment: Readonly<Record<string, string | undefined>>;
  now: string;
  metadataEndpoint: string;
  loopbackMetadataEndpoint: string;
}>): Promise<CoreSingleSiteBootstrapOwners> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((resource: string | URL | Request, init?: RequestInit) => {
    const url = typeof resource === "string"
      ? resource
      : resource instanceof URL ? resource.href : resource.url;
    return originalFetch(
      url === input.metadataEndpoint ? input.loopbackMetadataEndpoint : resource,
      init,
    );
  }) as typeof globalThis.fetch;
  try {
    return await createCoreSingleSiteBootstrapProductionOwners({
      databases: input.databases,
      document: input.document,
      certificationAuthority: input.authority,
      password: input.password,
      redemptionEntropySecret: input.entropy,
      environment: input.environment,
      clock: () => input.now,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function capabilityProjectionPort(
  database: PlatformTransactionalDatabaseClient,
  now: string,
): CoreSingleSiteBootstrapOwners["capability"] {
  const repository = new PostgresCapabilityCatalogProjectionRepository(database, {
    now: () => new Date(now),
  });
  const signingKey = generateKeyPairSync("ed25519").privateKey;
  return Object.freeze({
    async ensureEmpty(execution) {
      const signingKeyRef = "component-hub-signing-v1";
      const publicationBinding = Object.freeze({
        siteId: execution.document.site.siteId,
        siteReleaseRef: execution.document.site.siteReleaseRef,
        agentCatalogRef: execution.document.externalEmptyAgentCatalogRef,
        snapshotDigest: EMPTY_CAPABILITY_DIGEST,
        signingKeyRef,
      });
      const signaturePayloadDigest = capabilitySignaturePayloadDigest(publicationBinding);
      const commandId = coreBootstrapUuid(
        execution.document.bootstrapId,
        "capability.catalog.project",
      );
      await repository.project({
        callerIdentity: "spiffe://kokoro.test/hub/component",
        commandId,
        idempotencyKey: coreBootstrapIdempotencyKey(
          execution.document.bootstrapId,
          "capability.catalog.project",
        ),
        requestDigest: digest(`${commandId}:${signaturePayloadDigest}`),
        publication: Object.freeze({
          ...publicationBinding,
          snapshot: EMPTY_CAPABILITY_SNAPSHOT,
          frozenAt: now,
          signatureAlgorithm: "ed25519-sha256-v1",
          signaturePayloadDigest,
          signature: sign(
            null,
            Buffer.from(signaturePayloadDigest, "hex"),
            signingKey,
          ),
        }),
      });
      return execution.document.externalEmptyAgentCatalogRef;
    },
  });
}

function createMetadataServer() {
  let metadata: Readonly<Record<string, unknown>> | undefined;
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/metadata" || metadata === undefined) {
      response.statusCode = 404;
      response.end();
      return;
    }
    const body = JSON.stringify(metadata);
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.setHeader("content-length", Buffer.byteLength(body));
    response.end(body);
  });
  return Object.freeze({
    server,
    setMetadata(value: Readonly<Record<string, unknown>>) {
      metadata = value;
    },
  });
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

function platformClient(
  role: "admin" | "api" | "site-worker" | "identity-worker" | "admission",
  url: string,
  environment: Readonly<Record<string, string | undefined>>,
): PlatformTransactionalDatabaseClient {
  return createPlatformDatabaseClient(loadPlatformDatabaseConfig(role, {
    ...environment,
    DATABASE_URL_PLATFORM: url,
    PLATFORM_DATABASE_CREDENTIAL_CLASS: role,
  }));
}

type DatabaseLease = ReturnType<typeof databaseLeaseEnvironment>;

function databaseLeaseEnvironment(environment: NodeJS.ProcessEnv) {
  const urls = Object.freeze({
    bootstrap: leased(environment.DATABASE_URL_PLATFORM_BOOTSTRAP_TEST),
    migrator: leased(environment.DATABASE_URL_PLATFORM_MIGRATOR_TEST),
    admin: leased(environment.DATABASE_URL_PLATFORM_ADMIN_TEST),
    api: leased(environment.DATABASE_URL_PLATFORM_API_TEST),
    admission: leased(environment.DATABASE_URL_PLATFORM_ADMISSION_TEST),
    siteWorker: leased(environment.DATABASE_URL_PLATFORM_SITE_WORKER_TEST),
    identityWorker: leased(environment.DATABASE_URL_PLATFORM_IDENTITY_WORKER_TEST),
  });
  const roles = Object.freeze({
    PLATFORM_DATABASE_MIGRATOR_ROLE: role(environment.PLATFORM_DATABASE_MIGRATOR_ROLE),
    PLATFORM_DATABASE_API_ROLE: role(environment.PLATFORM_DATABASE_API_ROLE),
    PLATFORM_DATABASE_ADMISSION_ROLE: role(environment.PLATFORM_DATABASE_ADMISSION_ROLE),
    PLATFORM_DATABASE_AUTHORIZATION_ROLE: role(environment.PLATFORM_DATABASE_AUTHORIZATION_ROLE),
    PLATFORM_DATABASE_ASSET_DATA_PLANE_ROLE:
      role(environment.PLATFORM_DATABASE_ASSET_DATA_PLANE_ROLE),
    PLATFORM_DATABASE_ARTIFACT_DATA_PLANE_ROLE:
      role(environment.PLATFORM_DATABASE_ARTIFACT_DATA_PLANE_ROLE),
    PLATFORM_DATABASE_COMMERCE_WORKER_ROLE:
      role(environment.PLATFORM_DATABASE_COMMERCE_WORKER_ROLE),
    PLATFORM_DATABASE_SITE_WORKER_ROLE: role(environment.PLATFORM_DATABASE_SITE_WORKER_ROLE),
    PLATFORM_DATABASE_ASSET_WORKER_ROLE: role(environment.PLATFORM_DATABASE_ASSET_WORKER_ROLE),
    PLATFORM_DATABASE_ADMIN_WORKER_ROLE: role(environment.PLATFORM_DATABASE_ADMIN_WORKER_ROLE),
    PLATFORM_DATABASE_IDENTITY_WORKER_ROLE:
      role(environment.PLATFORM_DATABASE_IDENTITY_WORKER_ROLE),
    PLATFORM_DATABASE_AUTHORIZATION_MAINTENANCE_ROLE:
      role(environment.PLATFORM_DATABASE_AUTHORIZATION_MAINTENANCE_ROLE),
    PLATFORM_DATABASE_ADMIN_ROLE: role(environment.PLATFORM_DATABASE_ADMIN_ROLE),
    PLATFORM_DATABASE_MODEL_GATEWAY_ROLE: role(environment.PLATFORM_DATABASE_MODEL_GATEWAY_ROLE),
    PLATFORM_DATABASE_MEMORY_PUBLIC_ROLE: role(environment.PLATFORM_DATABASE_MEMORY_PUBLIC_ROLE),
    PLATFORM_DATABASE_MEMORY_RUNTIME_ROLE: role(environment.PLATFORM_DATABASE_MEMORY_RUNTIME_ROLE),
    PLATFORM_DATABASE_MEMORY_WORKER_ROLE: role(environment.PLATFORM_DATABASE_MEMORY_WORKER_ROLE),
  });
  return Object.freeze({ urls, roles });
}

function isolatedDatabaseUrls(lease: DatabaseLease, databaseName: string) {
  return Object.freeze(Object.fromEntries(
    Object.entries(lease.urls).map(([name, value]) => [name, databaseUrl(value, databaseName)]),
  )) as Readonly<Record<keyof DatabaseLease["urls"], string>>;
}

async function createIsolatedDatabase(lease: DatabaseLease, databaseName: string): Promise<void> {
  const maintenance = new Client({ connectionString: lease.urls.bootstrap });
  await maintenance.connect();
  try {
    await maintenance.query(
      `CREATE DATABASE ${quoteIdentifier(databaseName)} ` +
        `OWNER ${quoteIdentifier(lease.roles.PLATFORM_DATABASE_MIGRATOR_ROLE)}`,
    );
    await maintenance.query(
      `REVOKE ALL ON DATABASE ${quoteIdentifier(databaseName)} FROM PUBLIC`,
    );
    const connectRoles = new Set([
      ...Object.values(lease.roles),
      "platform_model_image_worker",
      "platform_media_public",
      "platform_media_runtime",
      "platform_media_worker",
    ]);
    await maintenance.query(
      `GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ` +
        [...connectRoles].map(quoteIdentifier).join(","),
    );
  } finally {
    await maintenance.end();
  }
}

async function dropIsolatedDatabase(lease: DatabaseLease, databaseName: string): Promise<void> {
  const maintenance = new Client({ connectionString: lease.urls.bootstrap });
  await maintenance.connect();
  try {
    await maintenance.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`,
    );
  } finally {
    await maintenance.end();
  }
}

function leased(value: string | undefined): string {
  if (value === undefined) throw new Error("DATABASE_URL_PLATFORM_TEST_REQUIRED");
  const url = new URL(value);
  if (!url.pathname.slice(1).startsWith("kokoro_test_") || url.username.length < 1) {
    throw new Error("DATABASE_URL_PLATFORM_TEST_MUST_BE_LEASED");
  }
  return value;
}

function role(value: string | undefined): string {
  if (value === undefined || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(value)) {
    throw new Error("PLATFORM_DATABASE_TEST_ROLE_REQUIRED");
  }
  return value;
}

function databaseUrl(value: string, databaseName: string): string {
  const url = new URL(value);
  url.pathname = `/${databaseName}`;
  return url.href;
}

function deadDatabaseUrl(value: string, port: number): string {
  const url = new URL(value);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return url.href;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function writePrivate(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
}
