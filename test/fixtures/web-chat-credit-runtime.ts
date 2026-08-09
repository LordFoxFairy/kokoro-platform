import { spawn } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
  type PlatformProcessRole,
  type PlatformTransactionalDatabaseClient,
} from "../../src/infrastructure/postgres/client.js";
import { runPlatformMigrations, type MigrationCommandExecutor } from
  "../../src/infrastructure/postgres/migrator.js";
import type { AuthenticatedUserSession, ProductWorkloadIdentity } from
  "../../src/modules/authorization/domain/session-access-grant.js";
import { ExchangeProductContextService } from
  "../../src/modules/authorization/application/services/exchange-product-context.js";
import { IssueSessionAccessGrantService } from
  "../../src/modules/authorization/application/services/issue-session-access-grant.js";
import { createSessionAccessGrantSigner } from
  "../../src/modules/authorization/infrastructure/jose/session-access-grant-signer.js";
import { createSessionAuthorizationEventSigner } from
  "../../src/modules/authorization/infrastructure/jose/session-authorization-event-signer.js";
import type { SessionAccessGrantSigner, SessionAuthorizationEventSigner } from
  "../../src/modules/authorization/application/contracts/session-authorization-ports.js";
import { PostgresSessionAuthorizationRepository } from
  "../../src/modules/authorization/infrastructure/postgres/session-authorization-repository.js";
import { IdentitySessionAuthorizationMutation } from
  "../../src/modules/identity/application/services/identity-session-authorization-mutation.js";
import { PersonalBootstrapAuthorizationMutation } from
  "../../src/modules/identity/application/services/personal-bootstrap-authorization-mutation.js";
import { IdentityApplicationService } from
  "../../src/modules/identity/application/services/identity-application-service.js";
import { createIdentityAuditDigester } from
  "../../src/modules/identity/infrastructure/crypto/identity-audit-digester.js";
import { createIdentityPasswordHasher } from
  "../../src/modules/identity/infrastructure/crypto/identity-password-hasher.js";
import { createIdentityTotpSecretProtector } from
  "../../src/modules/identity/infrastructure/crypto/identity-totp-secret-protector.js";
import { createIdentityTotpVerifier } from
  "../../src/modules/identity/infrastructure/crypto/identity-totp-verifier.js";
import { createVerificationEnvelopeSealer } from
  "../../src/modules/identity/infrastructure/crypto/verification-envelope-sealer.js";
import { createOpaqueCredentialCodec } from
  "../../src/modules/identity/infrastructure/crypto/opaque-credential.js";
import { PostgresIdentityRepository } from
  "../../src/modules/identity/infrastructure/postgres/identity-repository.js";
import { IdentityOutboxConsumer } from
  "../../src/modules/identity/application/services/identity-outbox-consumer.js";
import { createPostgresIdentityEffectEventQueue } from
  "../../src/modules/identity/infrastructure/postgres/identity-outbox-consumer.js";
import { SignedScopedSessionAuthorizationPublisher } from
  "../../src/modules/authorization/infrastructure/postgres/signed-scoped-session-authorization-publisher.js";
import { PostgresScopedAuthorizationFeedRepository } from
  "../../src/modules/authorization/infrastructure/postgres/scoped-authorization-feed-repository.js";
import { PostgresCreditGrantIssuer } from
  "../../src/modules/credit/infrastructure/postgres/credit-grant-issuer.js";
import { PostgresCreditGrantProgram } from
  "../../src/modules/commerce/infrastructure/postgres/credit-program-repository.js";
import { RatingPolicyPublicationService } from
  "../../src/modules/credit/application/rating-policy-publication-service.js";
import { PostgresRatingPolicyPublicationRepository } from
  "../../src/modules/credit/infrastructure/postgres/rating-policy-publication-repository.js";
import { SitePublicationService } from
  "../../src/modules/site/application/services/site-publication-service.js";
import { SiteLifecycleService } from
  "../../src/modules/site/application/services/site-lifecycle-service.js";
import { SiteRuntimeDispatcher } from
  "../../src/modules/site/application/services/site-runtime-dispatcher.js";
import {
  SiteDeploymentProviderRegistry,
  sitePromotionCommandDigest,
} from "../../src/modules/site/application/contracts/site-deployment-provider.js";
import { PostgresSiteAuthorityJournal } from
  "../../src/modules/site/infrastructure/postgres/site-authority-journal.js";
import { PostgresSiteAuthorityRepository } from
  "../../src/modules/site/infrastructure/postgres/site-authority-repository.js";
import { PostgresSiteWorkerProjectBindingLock } from
  "../../src/modules/site/infrastructure/postgres/site-worker-project-binding-lock.js";
import {
  createPostgresSiteRuntimeTransactionRunner,
  PostgresSiteRuntimeStateStore,
} from "../../src/modules/site/infrastructure/postgres/site-runtime-state-store.js";
import { PostgresSiteCurrentAuthorizationReader } from
  "../../src/modules/site/infrastructure/postgres/site-current-authorization-reader.js";
import { SiteCurrentAuthorizationMutation } from
  "../../src/modules/site/application/services/site-current-authorization-mutation.js";
import { OutboxRepository } from "../../src/shared/outbox-inbox/outbox.js";
import { CommandReceiptRepository } from "../../src/shared/outbox-inbox/receipt.js";
import { verifyRequestSecurityContext, type WorkloadKind } from
  "../../src/shared/security-context/request-security-context.js";
import { PlatformUnitOfWork } from "../../src/shared/unit-of-work/index.js";
import { canonicalizeModelInventory } from
  "../../src/modules/model-control/domain/model-catalog.js";
import {
  DIRECT_MODEL_PROVIDER_IDENTITY,
  DIRECT_MODEL_PROVIDER_SECRET_REF,
} from "../../src/modules/model-control/domain/direct-model-provider-identity.js";
import { materializeModelOptionDraftSet } from
  "../../src/modules/model-control/domain/model-option-materialization.js";
import { createSiteReleaseModelCatalogRevision } from
  "../../src/modules/model-control/domain/product-model-option.js";
import { PostgresProductModelOptionCatalogReader } from
  "../../src/modules/model-control/infrastructure/postgres/product-model-option-repository.js";
import { createProductModelOptionAdministrationComposition } from
  "../../src/process/model-option-admin-composition.js";
import { AdmissionLaunchProfilePublicationService } from
  "../../src/modules/admission/application/admission-launch-profile-publication-service.js";
import { defineAdmissionLaunchProfilePublication } from
  "../../src/modules/admission/domain/admission-launch-profile-publication.js";
import { PostgresAdmissionLaunchProfilePublicationRepository } from
  "../../src/modules/admission/infrastructure/postgres/admission-launch-profile-publication-repository.js";
import {
  capabilitySnapshotDigest,
} from "../../src/modules/admission/infrastructure/crypto/capability-publication-verifier.js";
import { PLATFORM_API_RUNTIME_CONTRACT } from
  "../../src/process/platform-api-runtime-contract.js";
import { createCommerceAdministrationComposition } from
  "../../src/process/commerce-admin-composition.js";
import {
  fulfillmentOutputDigest,
  fulfillmentOutputSetDigest,
} from "../../src/modules/commerce/domain/canonical-fulfillment.js";

export type PlatformFixtureCommand = "prepare" | "finalize" | "observe";

export type PlatformFixturePreparedResult = Readonly<{
  schemaVersion: 1;
  kind: "platform-web-chat-credit-runtime-prepared";
  siteId: string;
  siteReleaseRef: string;
  siteProjectBindingRef: string;
  workloadIdentityId: string;
  deploymentRef: string;
  webArtifactDigest: string;
  modelOptionRevisionRef: string;
  agentCatalogRef: string;
}>;

export type PlatformFixtureSetupResult = Readonly<{
  schemaVersion: 1;
  kind: "platform-web-chat-credit-runtime-setup";
  siteId: string;
  siteReleaseRef: string;
  siteProjectBindingRef: string;
  workloadIdentityId: string;
  deploymentRef: string;
  webArtifactDigest: string;
  subjectRef: string;
  subjectGeneration: "1";
  projectRef: string;
  billingAccountRef: string;
  ratingPolicyRevisionRef: string;
  sessionCredentialFile: string;
  sessionAccessGrantFile: string;
  platformApiTrustRoot: string;
  platformPublicTlsCertificateAuthorityFile: string;
  browserAuthFile: string;
  redemptionCodeFile: string;
  siteBffClientCertificateFile: string;
  siteBffWorkloadCredentialFile: string;
  productWorkloadRegistryFile: string;
  authorizationEventKeyRingFile: string;
  authorizationEventVerificationKeySetFile: string;
  sessionAccessKeyRingFile: string;
  sessionAccessVerificationKeySetFile: string;
  platformPublicTlsKeyFile: string;
  platformPublicTlsCertificateFile: string;
  platformPublicTlsClientCaFile: string;
  commerceRedemptionKeyRingFile: string;
  assetUploadPolicyRegistryFile: string;
  assetUploadCapabilityKeyRingFile: string;
  artifactDeliveryCapabilityKeyFile: string;
  artifactOwnerCursorKeyFile: string;
  identityPasswordPepperRingFile: string;
  identityVerificationDigestKeyFile: string;
  identitySessionDigestKeyFile: string;
  identityRefreshDigestKeyFile: string;
  identityReauthenticationDigestKeyFile: string;
  identityAuditDigestKeyFile: string;
  identityDeliveryKeyFile: string;
  identityTotpKeyRingFile: string;
  modelOptionRevisionRef: string;
  agentCatalogRef: string;
}>;

export type PlatformFixtureObservation = Readonly<{
  schemaVersion: 1;
  kind: "platform-web-chat-credit-runtime-observation";
  providerInvocationCount: number;
  providerAttemptCount: number;
  finalizedEvidenceCount: number;
  segmentSettlementCount: number;
  captureJournalCount: number;
  claimedRedemptionCodeCount: number;
  redemptionCount: number;
  redemptionFulfillmentCount: number;
  redemptionGrantCount: number;
  providerEffectOnce: boolean;
  evidenceChainFinalized: boolean;
  creditSettledOnce: boolean;
  replayStable: boolean;
  availableConsumedDeltaEqual: boolean;
  redemptionFulfilledOnce: boolean;
  redemptionReplayStable: boolean;
  redemptionProductSourceVerified: boolean;
  redemptionGrantSourceVerified: boolean;
}>;

type SetupFields = Omit<PlatformFixtureSetupResult, "schemaVersion" | "kind">;
type PreparedFields = Omit<PlatformFixturePreparedResult, "schemaVersion" | "kind">;
type ObservationFields = Omit<PlatformFixtureObservation, "schemaVersion" | "kind">;

export const PLATFORM_FIXTURE_API_RUNTIME_FILE_FIELDS = Object.freeze([
  "productWorkloadRegistryFile",
  "sessionAccessKeyRingFile",
  "authorizationEventKeyRingFile",
  "platformPublicTlsKeyFile",
  "platformPublicTlsCertificateFile",
  "platformPublicTlsClientCaFile",
  "commerceRedemptionKeyRingFile",
  "assetUploadPolicyRegistryFile",
  "assetUploadCapabilityKeyRingFile",
  "artifactDeliveryCapabilityKeyFile",
  "artifactOwnerCursorKeyFile",
  "identityPasswordPepperRingFile",
  "identityVerificationDigestKeyFile",
  "identitySessionDigestKeyFile",
  "identityRefreshDigestKeyFile",
  "identityReauthenticationDigestKeyFile",
  "identityAuditDigestKeyFile",
  "identityDeliveryKeyFile",
  "identityTotpKeyRingFile",
] as const);
type PlatformFixtureApiRuntimeFileField = typeof PLATFORM_FIXTURE_API_RUNTIME_FILE_FIELDS[number];
type PlatformFixtureApiRuntimeFiles = Readonly<Record<PlatformFixtureApiRuntimeFileField, string>>;

const PLATFORM_FIXTURE_SETUP_PATH_FIELDS = Object.freeze([
  "sessionCredentialFile",
  "sessionAccessGrantFile",
  "platformApiTrustRoot",
  "platformPublicTlsCertificateAuthorityFile",
  "browserAuthFile",
  "redemptionCodeFile",
  "siteBffClientCertificateFile",
  "siteBffWorkloadCredentialFile",
  ...PLATFORM_FIXTURE_API_RUNTIME_FILE_FIELDS,
  "authorizationEventVerificationKeySetFile",
  "sessionAccessVerificationKeySetFile",
] as const satisfies readonly (keyof SetupFields)[]);

const OBSERVER_RELATIONS = Object.freeze([
  "model_gateway_invocation",
  "model_gateway_attempt_usage_fact",
  "credit_usage_attempt_intent",
  "credit_attempt_usage_evidence",
  "credit_usage_settlement",
  "credit_journal_transaction",
  "credit_journal_entry",
  "credit_grant",
  "commerce_redeem_code",
  "commerce_redemption",
  "commerce_fulfillment_transaction",
  "commerce_fulfillment_actual_output",
] as const);
const UNIT = "credit_micros";
const LIABILITY_MERCHANT = "merchant:platform-runtime";
const ENVIRONMENT = "production";
const REGION = "us-east-1";
type FixtureRuntimeRole = Extract<PlatformProcessRole,
  "admin" | "api" | "site-worker" | "identity-worker">;
const FIXTURE_RUNTIME_ROLE_ENVIRONMENT = Object.freeze({
  admin: "PLATFORM_DATABASE_ADMIN_ROLE",
  api: "PLATFORM_DATABASE_API_ROLE",
  "site-worker": "PLATFORM_DATABASE_SITE_WORKER_ROLE",
  "identity-worker": "PLATFORM_DATABASE_IDENTITY_WORKER_ROLE",
} as const satisfies Record<FixtureRuntimeRole, string>);

export function parsePlatformFixtureCommand(args: readonly string[]): PlatformFixtureCommand {
  const command = args[0];
  if (args.length !== 1 ||
      (command !== "prepare" && command !== "finalize" && command !== "observe")) {
    throw new Error("PLATFORM_FIXTURE_COMMAND_INVALID");
  }
  return command;
}

export function createPlatformFixturePreparedResult(
  input: PreparedFields,
): PlatformFixturePreparedResult {
  for (const value of [input.siteId, input.siteReleaseRef, input.siteProjectBindingRef,
    input.workloadIdentityId, input.deploymentRef, input.modelOptionRevisionRef]) {
    bounded(value, 256, "PLATFORM_FIXTURE_PREPARED_RESULT_INVALID");
  }
  if (!/^[0-9a-f]{64}$/u.test(input.webArtifactDigest) ||
      !/^agent-catalog:sha256:[0-9a-f]{64}$/u.test(input.agentCatalogRef)) {
    throw new Error("PLATFORM_FIXTURE_PREPARED_RESULT_INVALID");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "platform-web-chat-credit-runtime-prepared",
    ...input,
  });
}

export function createPlatformFixtureSetupResult(input: SetupFields): PlatformFixtureSetupResult {
  for (const value of [input.siteId, input.siteReleaseRef, input.siteProjectBindingRef,
    input.workloadIdentityId, input.deploymentRef, input.subjectRef, input.projectRef,
    input.billingAccountRef,
    input.ratingPolicyRevisionRef, input.modelOptionRevisionRef]) {
    bounded(value, 256, "PLATFORM_FIXTURE_SETUP_RESULT_INVALID");
  }
  if (input.subjectGeneration !== "1" ||
      !/^[0-9a-f]{64}$/u.test(input.webArtifactDigest) ||
      !/^agent-catalog:sha256:[0-9a-f]{64}$/u.test(input.agentCatalogRef) ||
      PLATFORM_FIXTURE_SETUP_PATH_FIELDS.map((field) => input[field])
        .some((path) => !isAbsolute(path) || path.length > 4_096 || control(path))) {
    throw new Error("PLATFORM_FIXTURE_SETUP_RESULT_INVALID");
  }
  return Object.freeze({ schemaVersion: 1, kind: "platform-web-chat-credit-runtime-setup", ...input });
}

export function createPlatformFixtureObservation(input: ObservationFields): PlatformFixtureObservation {
  const counts = [input.providerInvocationCount, input.providerAttemptCount,
    input.finalizedEvidenceCount, input.segmentSettlementCount, input.captureJournalCount,
    input.claimedRedemptionCodeCount, input.redemptionCount,
    input.redemptionFulfillmentCount, input.redemptionGrantCount];
  const flags = [input.providerEffectOnce, input.evidenceChainFinalized, input.creditSettledOnce,
    input.replayStable, input.availableConsumedDeltaEqual, input.redemptionFulfilledOnce,
    input.redemptionReplayStable, input.redemptionProductSourceVerified,
    input.redemptionGrantSourceVerified];
  if (counts.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) ||
      flags.some((value) => typeof value !== "boolean")) {
    throw new Error("PLATFORM_FIXTURE_OBSERVATION_INVALID");
  }
  return Object.freeze({ schemaVersion: 1, kind: "platform-web-chat-credit-runtime-observation", ...input });
}

const REDEMPTION_LINEAGE_FIELDS = Object.freeze([
  "redemptionId", "codeRef", "redemptionState", "redemptionProductVersionRef",
  "redemptionFulfillmentRef", "redemptionBillingAccountRef", "fulfillmentId",
  "fulfillmentState", "fulfillmentSourceType", "fulfillmentSourceRef",
  "fulfillmentProductVersionRef", "fulfillmentOutputSetDigest",
  "fulfillmentBillingAccountRef", "fulfillmentIdempotencyKey", "outputKind",
  "outputLineId", "outputOrdinal", "occurrence", "outputRef", "templateRevisionRef",
  "outputVersion", "outputDigest", "grantId", "grantBillingAccountRef",
  "grantSourceType", "grantSourceRef", "grantCreditProgramRevisionRef",
] as const);

export function verifyPlatformFixtureRedemptionLineage(value: unknown) {
  const failed = Object.freeze({
    redemptionProductSourceVerified: false,
    redemptionGrantSourceVerified: false,
  });
  if (!Array.isArray(value) || value.length !== 1 || !objectRecord(value[0]) ||
      Object.keys(value[0]).length !== REDEMPTION_LINEAGE_FIELDS.length ||
      REDEMPTION_LINEAGE_FIELDS.some((field) => !Object.hasOwn(value[0]!, field))) {
    return failed;
  }
  const row = value[0];
  try {
    const field = (name: typeof REDEMPTION_LINEAGE_FIELDS[number]) => lineageText(row, name);
    const outputOrdinal = lineageInteger(row.outputOrdinal);
    const occurrence = lineageInteger(row.occurrence);
    const outputVersion = lineageInteger(row.outputVersion);
    if (outputVersion !== 1) return failed;
    const output = Object.freeze({
      kind: field("outputKind") as "credit_grant",
      outputLineId: field("outputLineId"),
      outputOrdinal,
      occurrence,
      outputRef: field("outputRef"),
      templateRevisionRef: field("templateRevisionRef"),
      outputVersion: 1 as const,
    });
    if (output.kind !== "credit_grant") return failed;
    const storedOutputDigest = field("outputDigest");
    const productVerified =
      field("redemptionState") === "fulfilled" && field("fulfillmentState") === "committed" &&
      field("fulfillmentSourceType") === "redemption" &&
      field("redemptionFulfillmentRef") === field("fulfillmentId") &&
      field("fulfillmentSourceRef") === field("codeRef") &&
      field("fulfillmentProductVersionRef") === field("redemptionProductVersionRef") &&
      field("redemptionBillingAccountRef") === field("fulfillmentBillingAccountRef") &&
      /^[0-9a-f]{64}$/u.test(storedOutputDigest) &&
      storedOutputDigest === fulfillmentOutputDigest(output) &&
      field("fulfillmentOutputSetDigest") === fulfillmentOutputSetDigest([{
        ...output,
        outputDigest: storedOutputDigest,
      }]);
    const idempotencyKey = field("fulfillmentIdempotencyKey");
    const grantVerified = productVerified && /^[0-9a-f]{64}$/u.test(idempotencyKey) &&
      field("grantId") === output.outputRef &&
      field("grantBillingAccountRef") === field("fulfillmentBillingAccountRef") &&
      field("grantSourceType") === "redemption" &&
      field("grantSourceRef") === `${idempotencyKey}:${output.outputLineId}:${output.occurrence}` &&
      field("grantCreditProgramRevisionRef") === output.templateRevisionRef;
    return Object.freeze({
      redemptionProductSourceVerified: productVerified,
      redemptionGrantSourceVerified: grantVerified,
    });
  } catch {
    return failed;
  }
}

function lineageText(
  row: Record<string, unknown>,
  name: typeof REDEMPTION_LINEAGE_FIELDS[number],
): string {
  const value = row[name];
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || control(value)) {
    throw new Error("PLATFORM_FIXTURE_REDEMPTION_LINEAGE_INVALID");
  }
  return value;
}

function lineageInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 32) {
    throw new Error("PLATFORM_FIXTURE_REDEMPTION_LINEAGE_INVALID");
  }
  return value as number;
}

export async function createPlatformFixtureAuthorizationEventAuthority() {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2_048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const now = new Date(Math.floor(Date.now() / 1_000) * 1_000);
  const verificationKey = Object.freeze({
    keyRevision: "fixture-authorization-event-v1",
    publicKeyPem: keys.publicKey,
    current: true,
    notBefore: new Date(now.getTime() - 60_000).toISOString(),
    notAfter: new Date(now.getTime() + 60 * 60_000).toISOString(),
  });
  const signingKey = Object.freeze({
    ...verificationKey,
    privateKeyPem: keys.privateKey,
  });
  const keyRing = Object.freeze({ version: 1 as const, keys: Object.freeze([signingKey]) });
  const signer = await createSessionAuthorizationEventSigner(keyRing);
  return Object.freeze({ signer, verificationKey, keyRing });
}

export async function createPlatformFixtureSessionAccessAuthority() {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2_048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const signerNow = new Date(Math.floor(Date.now() / 1_000) * 1_000);
  const verificationKey = Object.freeze({
    keyRevision: "fixture-session-access-v1",
    publicKeyPem: keys.publicKey,
    current: true,
    notBefore: new Date(signerNow.getTime() - 60_000).toISOString(),
    notAfter: new Date(signerNow.getTime() + 60 * 60_000).toISOString(),
  });
  const keyRing = Object.freeze({
    version: 2 as const,
    issuer: "https://fixture.kokoro.test/",
    maximumTtlSeconds: 300,
    keys: Object.freeze([Object.freeze({ ...verificationKey, privateKeyPem: keys.privateKey })]),
  });
  const signer = await createSessionAccessGrantSigner(keyRing);
  return Object.freeze({ signer, verificationKey, keyRing });
}

type AuthorizationEventAuthority = Awaited<ReturnType<
  typeof createPlatformFixtureAuthorizationEventAuthority
>>;
type SessionAccessAuthority = Awaited<ReturnType<typeof createPlatformFixtureSessionAccessAuthority>>;

export async function createPlatformFixtureApiRuntimeAuthority(input: Readonly<{
  privateDirectory: string;
  site: Readonly<{
    siteRef: string;
    siteReleaseRef: string;
    siteProjectBindingRef: string;
    workloadIdentityId: string;
    deploymentRef: string;
    webArtifactDigest: string;
  }>;
  siteBffClientCertificateFile: string;
  siteBffWorkloadCredentialFile: string;
  siteBffCertificateAuthorityFile: string;
  authorizationEventAuthority: AuthorizationEventAuthority;
  sessionAccessAuthority: SessionAccessAuthority;
  environment?: Readonly<Record<string, string | undefined>>;
}>) {
  const platformPrivateRoot = resolve(
    input.privateDirectory,
    `platform-runtime-${randomUUID()}`,
  );
  const platformApiTrustRoot = resolve(platformPrivateRoot, "api");
  await mkdir(platformApiTrustRoot, { recursive: true, mode: 0o700 });
  const runtimeFiles = platformFixtureApiRuntimeFiles(platformApiTrustRoot);
  const [clientCertificatePem, clientCertificateAuthorityPem, workloadCredentialRaw] =
    await Promise.all([
      readBoundedFixtureFile(input.siteBffClientCertificateFile, 256 * 1024),
      readBoundedFixtureFile(input.siteBffCertificateAuthorityFile, 256 * 1024),
      readBoundedFixtureFile(input.siteBffWorkloadCredentialFile, 512),
    ]);
  const clientCertificate = verifiedSiteBffCertificate(
    clientCertificatePem,
    clientCertificateAuthorityPem,
    input.site.workloadIdentityId,
  );
  const workloadCredential = canonicalSecret(workloadCredentialRaw.toString("ascii"));
  const identity = createPlatformFixtureIdentityAuthority();
  const platformPublicTlsCertificateAuthorityFile = await generatePlatformPublicTls({
    runtimeFiles,
    platformPrivateRoot,
    environment: input.environment ?? process.env,
  });
  const siteBffClientCertificateFile = resolve(platformPrivateRoot, "site-bff-client.crt");
  const siteBffWorkloadCredentialFile = resolve(platformPrivateRoot, "site-bff.credential");
  await Promise.all([
    writePrivateFile(runtimeFiles.platformPublicTlsClientCaFile, clientCertificateAuthorityPem),
    writePrivateFile(siteBffClientCertificateFile, clientCertificatePem),
    writePrivateFile(siteBffWorkloadCredentialFile, workloadCredential),
  ]);
  const authorizationFiles = await writePlatformFixtureAuthorizationKeyFiles(
    platformApiTrustRoot,
    runtimeFiles,
    input.authorizationEventAuthority,
    input.sessionAccessAuthority,
  );
  const workload: ProductWorkloadIdentity = Object.freeze({
    certificateSha256: createHash("sha256").update(clientCertificate.raw).digest("hex"),
    workloadIdentityId: input.site.workloadIdentityId,
    siteProjectBindingRef: input.site.siteProjectBindingRef,
    deploymentRef: input.site.deploymentRef,
    siteRef: input.site.siteRef,
    siteReleaseRef: input.site.siteReleaseRef,
    webArtifactDigest: input.site.webArtifactDigest,
    sessionContractRevision: "session-browser-v3",
    environment: ENVIRONMENT,
    region: REGION,
    audience: "site-product",
    allowedOperations: Object.freeze([
      "createIdentitySession",
      "exchangeProductContext",
      "previewRedemption",
      "confirmRedemption",
      "recoverRedemptionCommand",
      "listIdentitySessions",
      "listAccountProducts",
      "getCreditSummary",
      "getPersonalContext",
      "issueSessionAccessGrant",
    ]),
    bindingEpoch: "2",
    siteSecurityEpoch: "1",
    policyEpoch: "2",
    csrfSha256: digest(workloadCredential),
  });
  await Promise.all([
    writePrivateJson(runtimeFiles.productWorkloadRegistryFile, {
      version: 1,
      registryRevision: `fixture-${digest(input.site.siteRef).slice(0, 24)}`,
      registrations: [workload],
    }),
    writePrivateJson(runtimeFiles.commerceRedemptionKeyRingFile, {
      version: 1,
      currentCodeLookupKeyRevision: "fixture-code-lookup-v1",
      codeLookupKeys: [{ keyRevision: "fixture-code-lookup-v1", keyBase64url: secret() }],
      currentPreviewCredentialKeyRevision: "fixture-preview-credential-v1",
      previewCredentialKeys: [{
        keyRevision: "fixture-preview-credential-v1",
        keyBase64url: secret(),
      }],
      requestAuditKeyBase64url: secret(),
    }),
    writePrivateJson(runtimeFiles.assetUploadPolicyRegistryFile, {
      version: 1,
      profiles: [{
        siteRef: input.site.siteRef,
        siteReleaseRef: input.site.siteReleaseRef,
        bindingEpoch: "2",
        purpose: "chat-attachment",
        policyRevisionRef: `${input.site.siteRef}:asset-policy:1`,
        quotaRevisionRef: `${input.site.siteRef}:asset-quota:1`,
        storageTenantRef: `${input.site.siteRef}:asset-storage`,
        storageRegion: REGION,
        uploadAudience: "platform-asset-data-plane",
        uploadEndpoint: "https://127.0.0.1:4246/v1/uploads",
        allowedOrigins: ["https://127.0.0.1:3900"],
        allowedClientMediaTypes: ["image/png", "image/jpeg"],
        maximumFileBytes: "1048576",
        maximumInflightBytes: "10485760",
        maximumReadyBytes: "10485760",
        minimumPartBytes: "262144",
        maximumPartBytes: "1048576",
        capabilityLifetimeSeconds: 300,
        sessionLifetimeSeconds: 3600,
      }],
    }),
    writePrivateJson(runtimeFiles.assetUploadCapabilityKeyRingFile, {
      version: 1,
      currentKeyRevision: "fixture-asset-upload-v1",
      keys: [{ keyRevision: "fixture-asset-upload-v1", keyBase64url: secret() }],
    }),
    writePrivateJson(runtimeFiles.artifactDeliveryCapabilityKeyFile, {
      version: 1,
      revision: "artifact-delivery-capability-hmac-sha256-v1",
      keyBase64Url: secret(),
    }),
    writePrivateJson(runtimeFiles.artifactOwnerCursorKeyFile, {
      version: 1,
      revision: "artifact-owner-cursor-hmac-sha256-v1",
      keyBase64Url: secret(),
    }),
    writePrivateJson(runtimeFiles.identityPasswordPepperRingFile, identity.documents.passwordPepper),
    writePrivateFile(runtimeFiles.identityVerificationDigestKeyFile,
      identity.documents.verificationDigestKey),
    writePrivateFile(runtimeFiles.identitySessionDigestKeyFile, identity.documents.sessionDigestKey),
    writePrivateFile(runtimeFiles.identityRefreshDigestKeyFile, identity.documents.refreshDigestKey),
    writePrivateFile(runtimeFiles.identityReauthenticationDigestKeyFile,
      identity.documents.reauthenticationDigestKey),
    writePrivateFile(runtimeFiles.identityAuditDigestKeyFile, identity.documents.auditDigestKey),
    writePrivateJson(runtimeFiles.identityDeliveryKeyFile, identity.documents.deliveryKey),
    writePrivateJson(runtimeFiles.identityTotpKeyRingFile, identity.documents.totpKeyRing),
  ]);
  return Object.freeze({
    platformPrivateRoot,
    platformApiTrustRoot,
    platformPublicTlsCertificateAuthorityFile,
    siteBffClientCertificateFile,
    siteBffWorkloadCredentialFile,
    runtimeFiles,
    ...authorizationFiles,
    identity,
    workload,
  });
}

function platformFixtureApiRuntimeFiles(trustRoot: string): PlatformFixtureApiRuntimeFiles {
  if (PLATFORM_API_RUNTIME_CONTRACT.files.length !== PLATFORM_FIXTURE_API_RUNTIME_FILE_FIELDS.length) {
    throw new Error("PLATFORM_FIXTURE_API_RUNTIME_CONTRACT_INVALID");
  }
  return Object.freeze(Object.fromEntries(PLATFORM_FIXTURE_API_RUNTIME_FILE_FIELDS.map(
    (field, index) => [field, resolve(trustRoot, PLATFORM_API_RUNTIME_CONTRACT.files[index]!.filename)],
  ))) as PlatformFixtureApiRuntimeFiles;
}

function createPlatformFixtureIdentityAuthority() {
  const keys = Array.from({ length: 8 }, () => randomBytes(32));
  const passwordPepper = Object.freeze({
    version: 1,
    currentPepperVersion: 1,
    peppers: Object.freeze([{ version: 1, secretBase64url: keys[0]!.toString("base64url") }]),
    memoryCostKiB: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
  const totpKeyRing = Object.freeze({
    version: 1,
    currentKeyRevision: "fixture-identity-totp-v1",
    keys: Object.freeze([{
      keyRevision: "fixture-identity-totp-v1",
      keyBase64url: keys[5]!.toString("base64url"),
    }]),
  });
  const deliveryKey = Object.freeze({
    version: 1,
    keyRevision: "fixture-identity-delivery-v1",
    keyBase64url: keys[7]!.toString("base64url"),
  });
  return Object.freeze({
    passwordHasher: createIdentityPasswordHasher({
      currentPepperVersion: 1,
      peppers: [{ version: 1, secret: keys[0]! }],
      memoryCostKiB: passwordPepper.memoryCostKiB,
      timeCost: passwordPepper.timeCost,
      parallelism: passwordPepper.parallelism,
    }),
    verificationCredentials: createOpaqueCredentialCodec(keys[1]!),
    sessionCredentials: createOpaqueCredentialCodec(keys[2]!),
    refreshCredentials: createOpaqueCredentialCodec(keys[3]!),
    auditDigest: createIdentityAuditDigester(keys[4]!),
    totpSecretProtector: createIdentityTotpSecretProtector({
      currentKeyRevision: totpKeyRing.currentKeyRevision,
      keys: [{ keyRevision: totpKeyRing.keys[0]!.keyRevision, key: keys[5]! }],
    }),
    reauthenticationCredentials: createOpaqueCredentialCodec(keys[6]!),
    deliverySealer: createVerificationEnvelopeSealer({
      keyRevision: deliveryKey.keyRevision,
      key: keys[7]!,
    }),
    documents: Object.freeze({
      passwordPepper,
      verificationDigestKey: keys[1]!.toString("base64url"),
      sessionDigestKey: keys[2]!.toString("base64url"),
      refreshDigestKey: keys[3]!.toString("base64url"),
      auditDigestKey: keys[4]!.toString("base64url"),
      totpKeyRing,
      reauthenticationDigestKey: keys[6]!.toString("base64url"),
      deliveryKey,
    }),
  });
}

async function readBoundedFixtureFile(path: string, maximumBytes: number): Promise<Buffer> {
  if (!isAbsolute(path) || path.length > 4_096 || control(path)) {
    throw new Error("PLATFORM_FIXTURE_SITE_BFF_TRUST_INVALID");
  }
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink() ||
      metadata.size < 1 || metadata.size > maximumBytes) {
    throw new Error("PLATFORM_FIXTURE_SITE_BFF_TRUST_INVALID");
  }
  return readFile(path);
}

function verifiedSiteBffCertificate(
  certificatePem: Buffer,
  authorityPem: Buffer,
  workloadIdentityId: string,
): X509Certificate {
  let certificate: X509Certificate;
  let authority: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
    authority = new X509Certificate(authorityPem);
  } catch {
    throw new Error("PLATFORM_FIXTURE_SITE_BFF_TRUST_INVALID");
  }
  const now = Date.now();
  if (!authority.ca || !certificate.checkIssued(authority) || !certificate.verify(authority.publicKey) ||
      certificate.subjectAltName !== `URI:${workloadIdentityId}` ||
      Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) {
    throw new Error("PLATFORM_FIXTURE_SITE_BFF_TRUST_INVALID");
  }
  return certificate;
}

function canonicalSecret(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error("PLATFORM_FIXTURE_SITE_BFF_CREDENTIAL_INVALID");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== 32 || bytes.toString("base64url") !== value) {
    throw new Error("PLATFORM_FIXTURE_SITE_BFF_CREDENTIAL_INVALID");
  }
  return value;
}

function secret(): string {
  return randomBytes(32).toString("base64url");
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writePrivateFile(path, `${JSON.stringify(value)}\n`);
}

async function writePrivateFile(path: string, value: string | Buffer): Promise<void> {
  await writeFile(path, value, { mode: 0o600, flag: "wx" });
}

async function generatePlatformPublicTls(input: Readonly<{
  runtimeFiles: PlatformFixtureApiRuntimeFiles;
  platformPrivateRoot: string;
  environment: Readonly<Record<string, string | undefined>>;
}>): Promise<string> {
  const authorityCertificate = resolve(input.platformPrivateRoot, "platform-public-ca.crt");
  const authorityKey = resolve(input.platformPrivateRoot, "platform-public-ca.key");
  const request = resolve(input.platformPrivateRoot, "platform-public.csr");
  const extensions = resolve(input.platformPrivateRoot, "platform-public-extensions.cnf");
  await runQuietFixtureCommand("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", authorityKey,
    "-out", authorityCertificate,
    "-days", "1",
    "-sha256",
    "-subj", "/CN=Kokoro Platform fixture CA",
    "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    "-addext", "subjectKeyIdentifier=hash",
    "-addext", "authorityKeyIdentifier=keyid:always",
  ], input.environment, "PLATFORM_FIXTURE_PUBLIC_TLS_GENERATION_FAILED");
  await writePrivateFile(extensions, [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    "subjectAltName=DNS:platform-api.fixture.local,IP:127.0.0.1",
    "subjectKeyIdentifier=hash",
    "authorityKeyIdentifier=keyid:always",
    "",
  ].join("\n"));
  await runQuietFixtureCommand("openssl", [
    "req", "-new", "-newkey", "rsa:2048", "-nodes",
    "-keyout", input.runtimeFiles.platformPublicTlsKeyFile,
    "-out", request,
    "-subj", "/CN=platform-api.fixture.local",
    "-addext", "subjectAltName=DNS:platform-api.fixture.local,IP:127.0.0.1",
  ], input.environment, "PLATFORM_FIXTURE_PUBLIC_TLS_GENERATION_FAILED");
  await runQuietFixtureCommand("openssl", [
    "x509", "-req",
    "-in", request,
    "-CA", authorityCertificate,
    "-CAkey", authorityKey,
    "-CAcreateserial",
    "-out", input.runtimeFiles.platformPublicTlsCertificateFile,
    "-days", "1",
    "-sha256",
    "-extfile", extensions,
  ], input.environment, "PLATFORM_FIXTURE_PUBLIC_TLS_GENERATION_FAILED");
  await Promise.all([
    authorityCertificate,
    authorityKey,
    request,
    input.runtimeFiles.platformPublicTlsKeyFile,
    input.runtimeFiles.platformPublicTlsCertificateFile,
  ].map((path) => chmod(path, 0o600)));
  return authorityCertificate;
}

export async function preparePlatformFixture(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<PlatformFixturePreparedResult> {
  const configuration = fixtureConfiguration(environment);
  await mkdir(configuration.privateDirectory, { recursive: true, mode: 0o700 });
  await runPlatformMigrations({ environment, execute: silentMigrationCommand });
  await configureObserver(configuration.migratorDatabaseUrl, configuration.observerRole);

  const admin = runtimeDatabase("admin", configuration.adminDatabaseUrl, environment);
  await admin.connect();
  try {
    const model = createPlatformFixtureModel(configuration.siteId, environment);
    const launch = launchProfileFixture(configuration.siteId, model.siteReleaseRef);
    const site = await prepareSite(admin, configuration.siteId, {
      ...model,
      launch,
      agentCatalogRef: emptyAgentCatalogRef(),
    });
    const prepared = createPlatformFixturePreparedResult({
      siteId: configuration.siteId,
      siteReleaseRef: site.siteReleaseRef,
      siteProjectBindingRef: site.siteProjectBindingRef,
      workloadIdentityId: site.workloadIdentityId,
      deploymentRef: site.deploymentRef,
      webArtifactDigest: site.webArtifactDigest,
      modelOptionRevisionRef: model.modelOptionRevisionRef,
      agentCatalogRef: site.agentCatalogRef,
    });
    await writeFile(preparedStateFile(configuration.privateDirectory), `${JSON.stringify(prepared)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" });
    return prepared;
  } finally {
    await admin.disconnect();
  }
}

export async function finalizePlatformFixture(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<PlatformFixtureSetupResult> {
  const configuration = fixtureConfiguration(environment);
  const prepared = await loadPreparedState(configuration.privateDirectory, configuration.siteId);
  const [authorizationEventAuthority, sessionAccessAuthority] = await Promise.all([
    createPlatformFixtureAuthorizationEventAuthority(),
    createPlatformFixtureSessionAccessAuthority(),
  ]);
  const siteBffTrust = fixtureSiteBffTrust(environment);
  const admin = runtimeDatabase("admin", configuration.adminDatabaseUrl, environment);
  const api = runtimeDatabase("api", configuration.apiDatabaseUrl, environment);
  const siteWorker = runtimeDatabase("site-worker", configuration.siteWorkerDatabaseUrl, environment);
  const identityWorker = runtimeDatabase("identity-worker",
    configuration.identityWorkerDatabaseUrl, environment);
  await Promise.all([admin.connect(), api.connect(), siteWorker.connect(), identityWorker.connect()]);
  try {
    const model = createPlatformFixtureModel(configuration.siteId, environment);
    const launch = launchProfileFixture(configuration.siteId, model.siteReleaseRef);
    if (prepared.siteReleaseRef !== model.siteReleaseRef ||
        prepared.modelOptionRevisionRef !== model.modelOptionRevisionRef ||
        prepared.agentCatalogRef !== emptyAgentCatalogRef()) {
      throw new Error("PLATFORM_FIXTURE_PREPARED_STATE_CONFLICT");
    }
    const site = await finalizeSite(admin, siteWorker, configuration.siteId, {
      ...model,
      launch,
      agentCatalogRef: prepared.agentCatalogRef,
    }, prepared, authorizationEventAuthority.signer);
    const runtimeAuthority = await createPlatformFixtureApiRuntimeAuthority({
      privateDirectory: configuration.privateDirectory,
      site: { siteRef: configuration.siteId, ...site },
      ...siteBffTrust,
      authorizationEventAuthority,
      sessionAccessAuthority,
      environment,
    });
    const identity = await setupIdentity(api, identityWorker, runtimeAuthority.platformPrivateRoot,
      configuration.siteId, site, authorizationEventAuthority.signer, runtimeAuthority.identity,
      runtimeAuthority.workload);
    const ratingPolicyRevisionRef = `${configuration.siteId}:rating-policy:chat-v1`;
    await setupCredit(api, admin, {
      siteId: configuration.siteId,
      billingAccountRef: identity.billingAccountRef,
      ratingPolicyRevisionRef,
    });
    const redemptionCodeFile = await setupRedemptionCommerce(admin, {
      siteId: configuration.siteId,
      privateDirectory: configuration.privateDirectory,
      keyRingFile: runtimeAuthority.runtimeFiles.commerceRedemptionKeyRingFile,
    });
    const access = await setupSessionAccessGrant(api, configuration.privateDirectory, site, identity,
      sessionAccessAuthority.signer, authorizationEventAuthority.signer);
    return createPlatformFixtureSetupResult({
      siteId: configuration.siteId,
      siteReleaseRef: site.siteReleaseRef,
      siteProjectBindingRef: site.siteProjectBindingRef,
      workloadIdentityId: site.workloadIdentityId,
      deploymentRef: site.deploymentRef,
      webArtifactDigest: site.webArtifactDigest,
      subjectRef: identity.subjectRef,
      subjectGeneration: "1",
      projectRef: identity.projectRef,
      billingAccountRef: identity.billingAccountRef,
      ratingPolicyRevisionRef,
      sessionCredentialFile: identity.sessionCredentialFile,
      sessionAccessGrantFile: access.sessionAccessGrantFile,
      platformApiTrustRoot: runtimeAuthority.platformApiTrustRoot,
      platformPublicTlsCertificateAuthorityFile:
        runtimeAuthority.platformPublicTlsCertificateAuthorityFile,
      browserAuthFile: identity.browserAuthFile,
      redemptionCodeFile,
      siteBffClientCertificateFile: runtimeAuthority.siteBffClientCertificateFile,
      siteBffWorkloadCredentialFile: runtimeAuthority.siteBffWorkloadCredentialFile,
      ...runtimeAuthority.runtimeFiles,
      authorizationEventVerificationKeySetFile:
        runtimeAuthority.authorizationEventVerificationKeySetFile,
      sessionAccessVerificationKeySetFile: runtimeAuthority.sessionAccessVerificationKeySetFile,
      modelOptionRevisionRef: model.modelOptionRevisionRef,
      agentCatalogRef: prepared.agentCatalogRef,
    });
  } finally {
    await Promise.allSettled([
      admin.disconnect(), api.disconnect(), siteWorker.disconnect(), identityWorker.disconnect(),
    ]);
  }
}

export async function observePlatformFixture(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<PlatformFixtureObservation> {
  const configuration = fixtureConfiguration(environment);
  const client = new Client({ connectionString: configuration.observerDatabaseUrl,
    application_name: "kokoro-platform-web-chat-credit-observer",
    connectionTimeoutMillis: 5_000, statement_timeout: 10_000, lock_timeout: 3_000 });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query(
      `SELECT set_config('app.site_id',$1,true),set_config('app.operation',$2,true),
              set_config('app.workload_kind','platform_model_gateway',true)`,
      [configuration.siteId, "fixture.web-chat-credit.observe"],
    );
    const result = await client.query<ObservationRow>(OBSERVATION_SQL, [configuration.siteId]);
    await client.query("COMMIT");
    const row = result.rows[0];
    if (row === undefined) throw new Error("PLATFORM_FIXTURE_OBSERVATION_INVALID");
    const counts = {
      providerInvocationCount: integer(row.providerInvocationCount),
      providerAttemptCount: integer(row.providerAttemptCount),
      finalizedEvidenceCount: integer(row.finalizedEvidenceCount),
      segmentSettlementCount: integer(row.segmentSettlementCount),
      captureJournalCount: integer(row.captureJournalCount),
      claimedRedemptionCodeCount: integer(row.claimedRedemptionCodeCount),
      redemptionCount: integer(row.redemptionCount),
      redemptionFulfillmentCount: integer(row.redemptionFulfillmentCount),
      redemptionGrantCount: integer(row.redemptionGrantCount),
    };
    const redemptionCounts = [counts.claimedRedemptionCodeCount, counts.redemptionCount,
      counts.redemptionFulfillmentCount, counts.redemptionGrantCount];
    const redemptionLineage = verifyPlatformFixtureRedemptionLineage(row.redemptionLineage);
    return createPlatformFixtureObservation({ ...counts,
      providerEffectOnce: counts.providerInvocationCount === 1,
      evidenceChainFinalized: counts.providerAttemptCount === 1 && counts.finalizedEvidenceCount === 1,
      creditSettledOnce: counts.segmentSettlementCount === 1 && counts.captureJournalCount === 1,
      replayStable: [counts.providerInvocationCount, counts.providerAttemptCount,
        counts.finalizedEvidenceCount, counts.segmentSettlementCount,
        counts.captureJournalCount].every((value) => value <= 1),
      availableConsumedDeltaEqual: row.availableConsumedDeltaEqual === true,
      redemptionFulfilledOnce: redemptionCounts.every((value) => value === 1),
      redemptionReplayStable: redemptionCounts.every((value) => value <= 1),
      ...redemptionLineage,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export function createPlatformFixtureModel(
  siteId: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const adapterKind = platformFixtureModelProvider(environment);
  const siteReleaseRef = `${siteId}:release:1`;
  const inventory = canonicalizeModelInventory({
    schemaVersion: 1,
    source: { kind: "platform-native", reference: "fixture:web-chat-credit-runtime" },
    providers: adapterKind === "direct" ? [{
      key: DIRECT_MODEL_PROVIDER_IDENTITY.providerKey, provider: "openai-compatible",
      accountKey: DIRECT_MODEL_PROVIDER_IDENTITY.accountKey,
      secretRef: DIRECT_MODEL_PROVIDER_SECRET_REF, adapterKind: "direct", priority: 0,
    }] : [{
      key: DIRECT_MODEL_PROVIDER_IDENTITY.providerKey, provider: "openai-compatible",
      accountKey: DIRECT_MODEL_PROVIDER_IDENTITY.accountKey,
      secretRef: DIRECT_MODEL_PROVIDER_SECRET_REF, adapterKind: "direct", priority: 1,
    }, {
      key: "fixture-provider", provider: "openai-compatible", accountKey: "litellm",
      secretRef: "secret://fixture-provider", adapterKind: "litellm", priority: 0,
    }],
    models: [{ key: "chat-primary", displayName: "Chat", inputModalities: ["text"],
      outputModalities: ["text"], capabilities: ["chat"], contextWindow: null, enabled: true }],
    bindings: [{ key: "binding:chat-primary", modelKey: "chat-primary",
      providerKey: adapterKind === "direct" ? DIRECT_MODEL_PROVIDER_IDENTITY.providerKey :
        "fixture-provider", upstreamModel: "fixture-chat",
      gatewayModelName: "chat-primary", priority: 0, enabled: true }],
    productRoutes: [{ product: "chat", role: "main", modelKey: "chat-primary", position: 0,
      requiredCapabilities: ["chat"] }],
  });
  const selection = Object.freeze({ primaryModelKey: "chat-primary",
    fallbackModelKeys: Object.freeze([] as string[]) });
  const modelOptionDraft = Object.freeze({ schemaVersion: 1 as const, optionKey: "chat.standard",
    surface: "chat" as const, label: "Standard", description: null, tier: "standard",
    lifecycle: "active" as const, composition: Object.freeze({ orchestration: selection,
      generation: selection }) });
  const materialized = materializeModelOptionDraftSet({ inventory, draftSet: {
    schemaVersion: 1, inventoryDigest: inventory.digest, options: [modelOptionDraft],
  } });
  const modelOptionRevisionRef = materialized.optionRevisions[0]?.modelOptionRevisionRef;
  if (modelOptionRevisionRef === undefined) throw new Error("PLATFORM_FIXTURE_MODEL_OPTION_MISSING");
  const modelCatalog = createSiteReleaseModelCatalogRevision({ siteId, siteReleaseRef,
    inventoryDigest: inventory.digest, publishedAt: new Date().toISOString(), surfaces: [{
      surfaceId: "chat", allowedModelOptionRevisionRefs: [modelOptionRevisionRef],
      defaultModelOptionRevisionRef: modelOptionRevisionRef,
    }], optionRevisions: materialized.optionRevisions });
  return Object.freeze({ siteReleaseRef, inventory, modelOptionDraft,
    modelOptionRevisionRef, modelCatalog });
}

function platformFixtureModelProvider(
  environment: Readonly<Record<string, string | undefined>>,
): "direct" | "litellm" {
  const provider = environment.PLATFORM_FIXTURE_MODEL_PROVIDER ?? "direct";
  if (provider !== "direct" && provider !== "litellm") {
    throw new Error("PLATFORM_FIXTURE_MODEL_PROVIDER_INVALID");
  }
  return provider;
}

function launchProfileFixture(siteId: string, siteReleaseRef: string) {
  const snapshot = Object.freeze({ schemaVersion: 1 as const, siteId, siteReleaseRef,
    backend: "state" as const, permissions: Object.freeze({
      approval_tools: [] as string[], review_tools: [] as string[],
      subagent_create: "deny" as const, filesystem: "read_only" as const,
    }), billing: Object.freeze({ unit: UNIT, liabilityMerchantAccountRef: LIABILITY_MERCHANT,
      ratingPolicyRevisionRef: `${siteId}:rating-policy:chat-v1`, rootCeiling: "1000",
      segmentMaximum: "500", surfaceRef: "chat", capabilityKey: "model.chat",
    }) });
  const publication = defineAdmissionLaunchProfilePublication({ siteId, siteReleaseRef,
    snapshot, publishedAt: new Date().toISOString() });
  return Object.freeze({ snapshot, publication });
}

function emptyAgentCatalogRef(): string {
  const snapshot = Object.freeze({ schemaVersion: 1 as const,
    agentOptions: Object.freeze([]), tools: Object.freeze([]), skillOptions: Object.freeze([]),
    mcpOptions: Object.freeze([]), subagents: Object.freeze([]) });
  const snapshotDigest = capabilitySnapshotDigest(snapshot);
  return `agent-catalog:sha256:${snapshotDigest}`;
}

async function prepareSite(
  admin: PlatformTransactionalDatabaseClient,
  siteId: string,
  fixture: ReturnType<typeof createPlatformFixtureModel> & Readonly<{
    launch: ReturnType<typeof launchProfileFixture>;
    agentCatalogRef: string;
  }>,
): Promise<Readonly<{ siteReleaseRef: string; siteProjectBindingRef: string;
  workloadIdentityId: string; webArtifactDigest: string; deploymentRef: string;
  modelOptionCatalogRef: string; agentCatalogRef: string }>> {
  const now = new Date();
  const clock = () => now.toISOString();
  const siteProjectBindingRef = `${siteId}:binding:1`;
  const siteReleaseRef = fixture.siteReleaseRef;
  const workloadIdentityId = `spiffe://kokoro.test/site/${digest(siteId).slice(0, 24)}`;
  const webArtifactDigest = digest(`${siteId}:web-artifact`);
  const releaseManifestDigest = digest(`${siteId}:release-manifest`);
  const certificationDigest = digest(`${siteId}:release-certification`);
  const repository = new PostgresSiteAuthorityRepository();
  const journal = new PostgresSiteAuthorityJournal();
  const modelControl = createProductModelOptionAdministrationComposition(admin, { now: clock });
  await modelControl.importInventory.import({ importId: randomUUID(),
    requestDigest: digest(`${siteId}:model-inventory:import`), inventory: fixture.inventory.document,
    providerAvailability: fixture.inventory.document.providers.some(
      (provider) => provider.adapterKind === "litellm",
    ) ? fixture.inventory.document.providers.map((provider) => ({
        providerKey: provider.key, status: "active" as const, health: "healthy" as const,
        epoch: "1", observationRef: `${siteId}:provider-health:${provider.key}:1`, observedAt: clock(),
      })) : [],
  }, await adminContext("model.inventory.import", null,
    "model_control_administration", ["model.inventory.import"]));
  await modelControl.activateInventory.activate({ activationId: randomUUID(),
    requestDigest: digest(`${siteId}:model-inventory:activate`), targetDigest: fixture.inventory.digest,
    expectedPointerRevision: "0",
  }, await adminContext("model.inventory.activate", null,
    "model_control_administration", ["model.inventory.activate"]));
  const materialized = await modelControl.materialize.materialize({ materializationId: randomUUID(),
    requestDigest: digest(`${siteId}:model-options:materialize`), inventoryDigest: fixture.inventory.digest,
    options: [fixture.modelOptionDraft],
  }, await adminContext("model.option.materialize", null,
    "model_control_administration", ["model.option.materialize"]));
  if (materialized.optionRevisionRefs.length !== 1 ||
      materialized.optionRevisionRefs[0] !== fixture.modelOptionRevisionRef) {
    throw new Error("PLATFORM_FIXTURE_MODEL_OPTION_MATERIALIZATION_INVALID");
  }
  const publication = new SitePublicationService(new PlatformUnitOfWork(admin), repository, journal, {
    verify: async () => Object.freeze({ status: "passed" as const,
      expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString() }),
  }, { now: clock });
  await publication.registerSite({ commandId: randomUUID(), idempotencyKey: `${siteId}:register`,
    siteRef: siteId, siteKey: `web-chat-${digest(siteId).slice(0, 12)}`,
    bindingRef: siteProjectBindingRef, repositoryRef: "fixture://generated-site",
    providerNamespace: "fixture.local", providerProjectRef: `generated-${digest(siteId).slice(0, 12)}`,
    environment: ENVIRONMENT, workloadIdentityId,
  }, await securityContext("admin_workload", "operator", "site.register", siteId));
  await publication.publishRelease({ commandId: randomUUID(), idempotencyKey: `${siteId}:release`,
    releaseRef: siteReleaseRef, siteRef: siteId, webArtifactDigest, releaseManifestDigest,
    certificationDigest, launchProfileRef: fixture.launch.publication.launchProfileRef,
    siteConfigRevisionRef: "site-config:web-chat-credit-v1", legalRevisionRef: "legal:web-chat-credit-v1",
    featurePolicyRevision: "feature-policy:web-chat-credit-v1",
    modelOptionCatalogRef: fixture.modelCatalog.modelOptionCatalogRef,
    agentCatalogRef: fixture.agentCatalogRef, identityIssuerLabel: "Kokoro",
    identityAuthStrengthPolicyRevision: "identity-policy-web-chat-credit-v1",
    enabledSurfaceIds: ["account", "chat", "redemption"],
    localePolicy: { defaultLocale: "en-US", allowedLocales: ["en-US"] },
    certificationProof: { signingKeyRef: "fixture-signing-key", issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(), signature: new Uint8Array(64) },
  }, await securityContext("admin_workload", "operator", "site.release.publish", siteId));

  await new AdmissionLaunchProfilePublicationService({ unitOfWork: new PlatformUnitOfWork(admin),
    repository: new PostgresAdmissionLaunchProfilePublicationRepository(), clock })
    .publish({ siteId, siteReleaseRef, snapshot: fixture.launch.snapshot },
      await securityContext("admin_workload", "operator",
        "admission.launch-profile.publish", siteId));

  return Object.freeze({ siteReleaseRef, siteProjectBindingRef, workloadIdentityId,
    webArtifactDigest, deploymentRef: `${siteId}:deployment:1`,
    modelOptionCatalogRef: fixture.modelCatalog.modelOptionCatalogRef,
    agentCatalogRef: fixture.agentCatalogRef });
}

async function finalizeSite(
  admin: PlatformTransactionalDatabaseClient,
  siteWorker: PlatformTransactionalDatabaseClient,
  siteId: string,
  fixture: ReturnType<typeof createPlatformFixtureModel> & Readonly<{
    launch: ReturnType<typeof launchProfileFixture>;
    agentCatalogRef: string;
  }>,
  prepared: PlatformFixturePreparedResult,
  authorizationEventSigner: SessionAuthorizationEventSigner,
): Promise<Readonly<{ siteReleaseRef: string; siteProjectBindingRef: string;
  workloadIdentityId: string; webArtifactDigest: string; deploymentRef: string;
  modelOptionCatalogRef: string }>> {
  const now = new Date();
  const clock = () => now.toISOString();
  const siteReleaseRef = prepared.siteReleaseRef;
  const repository = new PostgresSiteAuthorityRepository();
  const journal = new PostgresSiteAuthorityJournal();
  const modelControl = createProductModelOptionAdministrationComposition(admin, { now: clock });

  const approvalAuthority = { consume: async () => undefined };
  const preconditions = new PostgresSiteAuthorityRepository();
  const adminLifecycle = new SiteLifecycleService(new PlatformUnitOfWork(admin), repository, journal,
    { now: clock, approvalAuthority, preconditions });
  const attemptRef = `${siteId}:activation:1`;
  const deploymentRef = prepared.deploymentRef;
  await adminLifecycle.beginActivation({ commandId: randomUUID(), idempotencyKey: `${siteId}:activate`,
    attemptRef, approvalRef: randomUUID(), siteRef: siteId,
    candidateReleaseRef: siteReleaseRef, expectedActiveReleaseRef: null,
    activationFactsDigest: `sha256:${"f".repeat(64)}`,
    audience: "site-product", sessionContractRevision: "session-browser-v3",
    reason: "local runtime closure fixture",
  }, await securityContext("admin_workload", "operator", "site.activation.begin", siteId));
  const publisher = new SignedScopedSessionAuthorizationPublisher(
    new PostgresScopedAuthorizationFeedRepository(),
    authorizationEventSigner,
  );
  const state = new PostgresSiteRuntimeStateStore(
    createPostgresSiteRuntimeTransactionRunner(siteWorker),
    new PostgresSiteAuthorityRepository(new PostgresSiteWorkerProjectBindingLock()),
    new SiteCurrentAuthorizationMutation(publisher, new PostgresSiteCurrentAuthorizationReader()),
    clock,
  );
  const providers = new SiteDeploymentProviderRegistry([{
    namespace: "fixture.local",
    async promote(command) {
      return Object.freeze({ ...command, status: "ready" as const, deploymentRef,
        observedAt: now.toISOString(), commandDigest: sitePromotionCommandDigest(command),
        payloadDigest: digest(`${siteId}:provider-observation`) });
    },
    async observePromotion(command) {
      return Object.freeze({ ...command, status: "ready" as const, deploymentRef,
        observedAt: now.toISOString(), commandDigest: sitePromotionCommandDigest(command),
        payloadDigest: digest(`${siteId}:provider-observation`) });
    },
    async stopTraffic() { throw new Error("PLATFORM_FIXTURE_UNEXPECTED_TRAFFIC_STOP"); },
    async observeTrafficStop() { throw new Error("PLATFORM_FIXTURE_UNEXPECTED_TRAFFIC_STOP"); },
  }]);
  await new SiteRuntimeDispatcher(state, providers).runActivation(
    attemptRef,
    new AbortController().signal,
  );
  const modelCatalog = await modelControl.publishSiteRelease.publish({ publicationId: randomUUID(),
    requestDigest: digest(`${siteId}:model-catalog:publish`), siteId, siteReleaseRef,
    inventoryDigest: fixture.inventory.digest, surfaces: [{ surfaceId: "chat",
      allowedModelOptionRevisionRefs: [fixture.modelOptionRevisionRef],
      defaultModelOptionRevisionRef: fixture.modelOptionRevisionRef }],
  }, await adminContext("model.site-release-catalog.publish", siteId,
    "site_release", ["model:site-release:publish"]));
  if (modelCatalog.modelOptionCatalogRef !== fixture.modelCatalog.modelOptionCatalogRef) {
    throw new Error("PLATFORM_FIXTURE_MODEL_CATALOG_PUBLICATION_INVALID");
  }
  return Object.freeze({ siteReleaseRef, siteProjectBindingRef: prepared.siteProjectBindingRef,
    workloadIdentityId: prepared.workloadIdentityId, webArtifactDigest: prepared.webArtifactDigest,
    deploymentRef, modelOptionCatalogRef: fixture.modelCatalog.modelOptionCatalogRef });
}

async function setupIdentity(
  api: PlatformTransactionalDatabaseClient,
  identityWorker: PlatformTransactionalDatabaseClient,
  privateDirectory: string,
  siteId: string,
  site: Readonly<{ siteReleaseRef: string; siteProjectBindingRef: string;
    workloadIdentityId: string; webArtifactDigest: string; deploymentRef: string;
    modelOptionCatalogRef: string }>,
  authorizationEventSigner: SessionAuthorizationEventSigner,
  authority: ReturnType<typeof createPlatformFixtureIdentityAuthority>,
  workload: ProductWorkloadIdentity,
): Promise<Readonly<{ subjectRef: string; projectRef: string; billingAccountRef: string;
  sessionCredentialFile: string; browserAuthFile: string; workload: ProductWorkloadIdentity;
  session: AuthenticatedUserSession }>> {
  const now = new Date();
  const { passwordHasher, verificationCredentials, sessionCredentials, refreshCredentials,
    auditDigest, totpSecretProtector, deliverySealer } = authority;
  const references = identityReferences();
  const referenceQueue = [...references.queue];
  let verificationSecret: string | null = null;
  const publisher = new SignedScopedSessionAuthorizationPublisher(
    new PostgresScopedAuthorizationFeedRepository(),
    authorizationEventSigner,
  );
  const dummyPasswordHash = await passwordHasher.hash(`fixture-dummy-password-${randomUUID()}`);
  const service = new IdentityApplicationService({ unitOfWork: new PlatformUnitOfWork(api),
    repository: new PostgresIdentityRepository(), receipts: new CommandReceiptRepository(),
    outbox: new OutboxRepository(), passwordHasher, dummyPasswordHash,
    verificationCredentials, sessionCredentials, refreshCredentials,
    totpSecretProtector,
    totpVerifier: createIdentityTotpVerifier(), dummyTotpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    auditDigest,
    deliverySealer: { seal(content) { verificationSecret = content.verificationSecret;
      return deliverySealer.seal(content); } },
    personalBootstrapAuthorization: new PersonalBootstrapAuthorizationMutation(publisher),
    sessionAuthorization: new IdentitySessionAuthorizationMutation(publisher),
    clock: () => now, reference: () => {
      const value = referenceQueue.shift();
      if (value === undefined) throw new Error("PLATFORM_FIXTURE_IDENTITY_REFERENCE_EXHAUSTED");
      return value;
    } });
  const password = `fixture-password-${randomUUID()}`;
  const email = `fixture-${digest(siteId).slice(0, 12)}@example.com`;
  const registration = await service.beginRegistration({ workload,
    context: await securityContext("site_product", "anonymous", "beginRegistration", siteId, site),
    commandId: randomUUID(), idempotencyKey: `${siteId}:identity:register`,
    email, password,
    legalAcceptanceRefs: ["legal:web-chat-credit-v1"] });
  if (verificationSecret === null) throw new Error("PLATFORM_FIXTURE_VERIFICATION_SECRET_MISSING");
  await service.completeEmailVerification({ workload,
    context: await securityContext("site_product", "anonymous", "completeEmailVerification", siteId, site),
    commandId: randomUUID(), idempotencyKey: `${siteId}:identity:verify`,
    transactionRef: registration.transaction.transactionRef, transactionSecret: verificationSecret,
    receiptRecoveryCapability: randomBytes(32).toString("base64url") });
  const identityConsumer = new IdentityOutboxConsumer(
    createPostgresIdentityEffectEventQueue(identityWorker, {
      workerId: `fixture-identity-worker:${digest(siteId).slice(0, 24)}`,
    }),
    { publish: async (effect) => Object.freeze({ deliveryId: effect.eventId,
      acknowledgedAt: new Date().toISOString() }) },
    { auditDigest, baseRetryMs: 100, maxRetryMs: 100, leaseHeartbeatMs: 100 },
  );
  await identityConsumer.runOneCycle({ signal: AbortSignal.timeout(10_000) });
  const session = await service.createIdentitySession({ workload,
    context: await securityContext("site_product", "anonymous", "createIdentitySession", siteId, site),
    commandId: randomUUID(), idempotencyKey: `${siteId}:identity:session`,
    receiptRecoveryCapability: randomBytes(32).toString("base64url"),
    email, password });
  if (!("credentials" in session)) throw new Error("PLATFORM_FIXTURE_SESSION_CREDENTIAL_MISSING");
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  const sessionCredentialFile = resolve(privateDirectory, `platform-session-${randomUUID()}.credential`);
  const browserAuthFile = resolve(privateDirectory, "browser-auth.json");
  await Promise.all([
    writePrivateFile(sessionCredentialFile, session.credentials.sessionCredential),
    writePrivateJson(browserAuthFile, { schemaVersion: 1, email, password }),
  ]);
  const authenticated = await api.authenticateUserSession({
    credentialDigest: sessionCredentials.digest(session.credentials.sessionCredential),
    siteRef: siteId,
    now: new Date().toISOString(),
  });
  if (authenticated === null || authenticated.subjectRef !== references.subjectRef) {
    throw new Error("PLATFORM_FIXTURE_AUTHENTICATED_SESSION_MISSING");
  }
  return Object.freeze({ subjectRef: references.subjectRef, projectRef: references.projectRef,
    billingAccountRef: references.billingAccountRef, sessionCredentialFile, browserAuthFile,
    workload, session: authenticated });
}

async function setupCredit(
  api: PlatformTransactionalDatabaseClient,
  admin: PlatformTransactionalDatabaseClient,
  input: Readonly<{ siteId: string; billingAccountRef: string; ratingPolicyRevisionRef: string }>,
): Promise<void> {
  const now = new Date().toISOString();
  const scopePolicy = Object.freeze({ version: 1 as const, surfaceRefs: Object.freeze(["chat"]),
    capabilityKeys: Object.freeze(["model.chat"]), agentRefs: Object.freeze([] as string[]),
    allowUnattributedAgent: true });
  const creditProgramRevisionRef = `${input.siteId}:credit-program:1`;
  const creditProgramRevisionDigest = digest(`${input.siteId}:credit-program:1`);
  const creditProgramUnitOfWork = new PlatformUnitOfWork(admin);
  const creditProgramContext = await securityContext(
    "admin_workload", "operator", "fixture.credit-program.publish", input.siteId,
  );
  await creditProgramUnitOfWork.execute({ context: creditProgramContext,
    operation: "fixture.credit-program.publish" }, async (transaction) => {
    await new PostgresCreditGrantProgram().publishRevision(transaction, {
      revisionRef: creditProgramRevisionRef, siteId: input.siteId,
      programRef: `${input.siteId}:starter`, revision: 1n, bucketClass: "permanent",
      unit: UNIT, amount: "1000000", burnPriority: 100, scopePolicy,
      liabilityMerchantAccountId: LIABILITY_MERCHANT, windowKind: "none", rolloverPolicy: "none",
      calendarZone: null, windowAnchor: null, expiresAfterSeconds: null,
      revisionDigest: creditProgramRevisionDigest, catalogEpoch: 1n, publishedAt: now,
    });
  });
  const grantUnitOfWork = new PlatformUnitOfWork(api);
  const issuer = new PostgresCreditGrantIssuer();
  const grantContext = await securityContext("site_product", "user", "fixture.credit.setup", input.siteId);
  await grantUnitOfWork.execute({ context: grantContext,
    operation: "fixture.credit.setup" }, async (transaction) => {
    const prepared = await issuer.prepareIssuance(transaction, { commandId: null, grants: [{
      account: { siteId: input.siteId, billingAccountId: input.billingAccountRef,
        unit: UNIT, liabilityMerchantAccountId: LIABILITY_MERCHANT },
      outputLineId: "fixture-initial-credit", outputOrdinal: 1, occurrence: 1,
      creditProgramRevisionRef, creditProgramRevision: 1n,
      creditProgramRevisionDigest, sourceType: "admin_grant", sourceRef: `${input.siteId}:initial-credit`,
      sourceWindowKey: "", businessOperationKey: `${input.siteId}:initial-credit`,
      bucketClass: "permanent", amount: "1000000", burnPriority: 100,
      scopePolicy, acquiredAt: now, effectiveAt: now, expiresAt: null,
    }] });
    if (prepared.kind !== "ready") throw new Error("PLATFORM_FIXTURE_CREDIT_UNAVAILABLE");
    await issuer.issuePrepared(transaction, { preparation: prepared.preparation });
  });
  const rating = new RatingPolicyPublicationService({ unitOfWork: new PlatformUnitOfWork(admin),
    repository: new PostgresRatingPolicyPublicationRepository(), clock: () => now });
  await rating.publish({ siteId: input.siteId, policy: {
    ratingPolicyRevisionRef: input.ratingPolicyRevisionRef, customerUnit: UNIT,
    chargeableAttemptOutcomes: ["succeeded", "failed_after_effect"], minimumAmount: 0n,
    rules: [
      { dimensionKey: "input_tokens", sourceUnit: "token", quantum: 1n,
        amountPerQuantum: 1n, required: true },
      { dimensionKey: "output_tokens", sourceUnit: "token", quantum: 1n,
        amountPerQuantum: 1n, required: true },
    ],
  } }, await securityContext("admin_workload", "operator",
    "credit.rating-policy.publish", input.siteId));
}

type FixtureCommerceAdminOperation =
  | "commerce.credit-program.publish"
  | "commerce.offer.publish"
  | "commerce.redemption-program.publish"
  | "commerce.code-batch.issue"
  | "commerce.code-batch.approve"
  | "commerce.code-batch.activate";

async function setupRedemptionCommerce(
  admin: PlatformTransactionalDatabaseClient,
  input: Readonly<{ siteId: string; privateDirectory: string; keyRingFile: string }>,
): Promise<string> {
  const production = await createCommerceAdministrationComposition({
    database: admin,
    environment: { PLATFORM_COMMERCE_REDEMPTION_KEY_RING_FILE: input.keyRingFile },
  });
  const maker = "operator:fixture:commerce-maker";
  const checker = "operator:fixture:commerce-checker";
  const command = async (actorRef: string, subjectGeneration: string,
    operation: FixtureCommerceAdminOperation) => {
    const commandId = randomUUID();
    return Object.freeze({
      context: await adminCommerceContext(operation, input.siteId, actorRef, subjectGeneration),
      siteId: input.siteId,
      commandId,
      idempotencyKey: `web-chat-credit-commerce:${commandId}`,
    });
  };
  const creditProgramRevisionRef = `${input.siteId}:redemption-credit-program:1`;
  const productVersionRef = `${input.siteId}:redemption-credit-pack:1`;
  const fulfillmentProgramRevisionRef = `${input.siteId}:redemption-fulfillment:1`;
  const redemptionProgramRevisionRef = `${input.siteId}:redemption-program:1`;
  const batchRef = randomUUID();

  await production.commerce.publishCreditProgramRevision({
    ...await command(maker, "11", "commerce.credit-program.publish"),
    creditProgramRevisionRef,
    programRef: `${input.siteId}:redemption-credit-program`,
    revision: "1",
    uxBucketClass: "permanent",
    unit: UNIT,
    amount: "250000",
    burnPriority: 90,
    scopePolicy: { surfaceRefs: ["chat"], capabilityKeys: ["model.chat"],
      agentRefs: [], allowUnattributedAgent: true },
    liabilityMerchantAccountRef: LIABILITY_MERCHANT,
    rolloverPolicy: "none",
    calendarZone: null,
    windowAnchor: null,
    expiresAfterSeconds: null,
  });
  await production.commerce.publishOffer({
    ...await command(maker, "11", "commerce.offer.publish"),
    productRef: `${input.siteId}:redemption-credit-pack`,
    productKind: "credit_pack",
    productVersionRef,
    productRevision: "1",
    safeLabel: "Runtime redemption credits",
    planVersion: null,
    fulfillmentProgramRevisionRef,
    fulfillmentProgramRef: `${input.siteId}:redemption-fulfillment`,
    fulfillmentProgramRevision: "1",
    outputs: [{ outputLineId: "credits", ordinal: 1, cardinality: 1,
      outputKind: "credit_grant", targetRevisionRef: creditProgramRevisionRef }],
    legalTermRefs: [],
  });
  await production.commerce.publishProgram({
    ...await command(maker, "11", "commerce.redemption-program.publish"),
    redemptionProgramRevisionRef,
    programRef: `${input.siteId}:redemption-program`,
    revision: "1",
    productVersionRef,
    fulfillmentProgramRevisionRef,
    maxRedemptionsPerAccount: 1,
  });
  const delivery = await production.commerce.issueBatch({
    ...await command(maker, "11", "commerce.code-batch.issue"),
    batchRef,
    redemptionProgramRevisionRef,
    count: 1,
    startsAt: null,
    endsAt: null,
  });
  if (delivery.kind !== "secret_export" || delivery.codes.length !== 1) {
    throw new Error("PLATFORM_FIXTURE_REDEMPTION_CODE_EXPORT_INVALID");
  }
  await production.commerce.approveBatch({
    ...await command(checker, "7", "commerce.code-batch.approve"),
    batchRef,
  });
  await production.commerce.activateBatch({
    ...await command(checker, "7", "commerce.code-batch.activate"),
    batchRef,
  });
  const redemptionCodeFile = resolve(input.privateDirectory, "redemption-code");
  await writePrivateFile(redemptionCodeFile, delivery.codes[0]!);
  return redemptionCodeFile;
}

async function setupSessionAccessGrant(
  api: PlatformTransactionalDatabaseClient,
  privateDirectory: string,
  site: Readonly<{ siteReleaseRef: string; siteProjectBindingRef: string;
    workloadIdentityId: string; webArtifactDigest: string; deploymentRef: string }>,
  identity: Readonly<{ projectRef: string; workload: ProductWorkloadIdentity;
    session: AuthenticatedUserSession }>,
  signer: SessionAccessGrantSigner,
  authorizationEventSigner: SessionAuthorizationEventSigner,
) {
  const repository = new PostgresSessionAuthorizationRepository();
  const unitOfWork = new PlatformUnitOfWork(api);
  const productContext = await new ExchangeProductContextService(unitOfWork, repository,
    new PostgresProductModelOptionCatalogReader()).execute({ workload: identity.workload,
    context: await securityContext("site_product", "user", "exchangeProductContext",
      identity.workload.siteRef, site),
    commandId: randomUUID(), commandRef: `${identity.workload.siteRef}:product-context:1`,
    idempotencyKey: `${identity.workload.siteRef}:product-context:exchange:1` });
  const publisher = new SignedScopedSessionAuthorizationPublisher(
    new PostgresScopedAuthorizationFeedRepository(),
    authorizationEventSigner,
  );
  const grant = await new IssueSessionAccessGrantService(unitOfWork, repository, signer, publisher)
    .execute({ workload: identity.workload, session: identity.session,
      context: await securityContext("site_product", "user", "issueSessionAccessGrant",
        identity.workload.siteRef, site),
      productContextRef: productContext.context.productContextRef, projectRef: identity.projectRef,
      purpose: "write", resource: { kind: "project" } });
  const sessionAccessGrantFile = resolve(privateDirectory,
    `platform-session-access-${randomUUID()}.credential`);
  await writeFile(sessionAccessGrantFile, grant.credential,
    { encoding: "utf8", mode: 0o600, flag: "wx" });
  return Object.freeze({ credential: grant.credential, sessionAccessGrantFile });
}

async function writePlatformFixtureAuthorizationKeyFiles(
  platformApiTrustRoot: string,
  runtimeFiles: PlatformFixtureApiRuntimeFiles,
  eventAuthority: AuthorizationEventAuthority,
  sessionAccessAuthority: SessionAccessAuthority,
) {
  const authorizationEventVerificationKeySetFile = resolve(
    platformApiTrustRoot,
    "authorization-event-verification-keys.json",
  );
  const sessionAccessVerificationKeySetFile = resolve(
    platformApiTrustRoot,
    "session-access-verification-keys.json",
  );
  await Promise.all([
    writePrivateJson(runtimeFiles.authorizationEventKeyRingFile, eventAuthority.keyRing),
    writePrivateJson(authorizationEventVerificationKeySetFile, {
      version: 1, purpose: "event_signing", keys: [eventAuthority.verificationKey],
    }),
    writePrivateJson(runtimeFiles.sessionAccessKeyRingFile, sessionAccessAuthority.keyRing),
    writePrivateJson(sessionAccessVerificationKeySetFile, {
      version: 1, purpose: "session_access_grant", keys: [sessionAccessAuthority.verificationKey],
    }),
  ]);
  return Object.freeze({
    authorizationEventVerificationKeySetFile,
    sessionAccessVerificationKeySetFile,
  });
}

function identityReferences() {
  const accountRef = randomUUID();
  const subjectRef = randomUUID();
  const transactionRef = randomUUID();
  const deliveryRef = randomUUID();
  const verificationEventRef = randomUUID();
  const workspaceRef = randomUUID();
  const billingAccountRef = randomUUID();
  const projectRef = randomUUID();
  const executionSpaceRef = randomUUID();
  const executionNamespace = randomUUID();
  const namespaceIntentRef = randomUUID();
  const namespaceEventRef = randomUUID();
  const authenticationRef = randomUUID();
  const sessionRef = randomUUID();
  const familyRef = randomUUID();
  return Object.freeze({ subjectRef, projectRef, billingAccountRef,
    queue: Object.freeze([accountRef, subjectRef, transactionRef, deliveryRef, verificationEventRef,
      workspaceRef, billingAccountRef, projectRef, executionSpaceRef, executionNamespace,
      namespaceIntentRef, namespaceEventRef, authenticationRef, sessionRef, familyRef]) });
}

async function securityContext(
  kind: WorkloadKind,
  actorKind: "anonymous" | "user" | "operator" | "workload",
  operation: string,
  siteId: string | null,
  site?: Readonly<{ siteReleaseRef: string; workloadIdentityId: string }>,
  targetOverride?: Readonly<{ purpose: string; scopes: readonly string[] }>,
  actorOverride?: Readonly<{ subjectId: string; subjectGeneration: string }>,
) {
  if (kind === "site_product" && siteId === null) {
    throw new Error("PLATFORM_FIXTURE_SITE_CONTEXT_REQUIRED");
  }
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 20 * 60_000).toISOString();
  const issuer = "spiffe://kokoro.test/fixture-authority";
  const audience = kind === "admin_workload" ? "platform-admin" :
    kind === "platform_worker" ? "platform-worker" : "site-product";
  const workloadIdentityId = site?.workloadIdentityId ??
    (kind === "admin_workload" ? "spiffe://kokoro.test/admin/fixture" : "spiffe://kokoro.test/worker/fixture");
  const siteCaller = kind === "site_product" ? {
    siteId, siteReleaseRef: site?.siteReleaseRef ?? `${siteId}:release:1`, siteSecurityEpoch: "1",
  } : {};
  const input = { requestId: randomUUID(), correlationId: randomUUID(),
    trustedCaller: { kind, workloadIdentityId, environment: ENVIRONMENT, region: REGION, audience,
      allowedOperations: [operation], bindingEpoch: kind === "site_product" ? "2" : "1",
      issuedAt, expiresAt, ...siteCaller },
    actor: { kind: actorKind, subjectId: actorOverride?.subjectId ?? `${actorKind}:fixture`,
      subjectGeneration: actorOverride?.subjectGeneration ?? "1" },
    delegatedGrant: null,
    target: { siteId, workspaceId: null, projectId: null,
      purpose: targetOverride?.purpose ?? operation,
      scopes: targetOverride?.scopes ?? [operation] },
    audience, environment: ENVIRONMENT, region: REGION,
    evidence: [{ kind: "workload_attestation", evidenceId: randomUUID(), issuer }],
    policyEpoch: "1", issuedAt, expiresAt } as const;
  return verifyRequestSecurityContext(input, { now: new Date().toISOString(), operation,
    expectedAudience: audience, expectedEnvironment: ENVIRONMENT, expectedRegion: REGION,
    callerVerifier: { verify: async () => ({ workloadIdentityId, kind, audience,
      environment: ENVIRONMENT, region: REGION, allowedOperations: [operation],
      siteId: kind === "site_product" ? siteId : null,
      ...(kind === "site_product" ? { siteReleaseRef: siteCaller.siteReleaseRef,
        siteSecurityEpoch: "1" } : {}),
      bindingEpoch: kind === "site_product" ? "2" : "1", issuedAt, expiresAt,
      issuer, keyVersion: "fixture-v1" }) } });
}

function adminContext(
  operation: string,
  siteId: string | null,
  purpose: string,
  scopes: readonly string[],
) {
  return securityContext("admin_workload", "operator", operation, siteId, undefined,
    { purpose, scopes });
}

function adminCommerceContext(
  operation: FixtureCommerceAdminOperation,
  siteId: string,
  subjectId: string,
  subjectGeneration: string,
) {
  return securityContext("admin_workload", "operator", operation, siteId, undefined,
    { purpose: operation, scopes: ["admin:site", operation] },
    { subjectId, subjectGeneration });
}

function runtimeDatabase(
  role: FixtureRuntimeRole,
  databaseUrl: string,
  environment: Readonly<Record<string, string | undefined>>,
): PlatformTransactionalDatabaseClient {
  const user = decodeURIComponent(new URL(databaseUrl).username);
  const database = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  const roleEnvironment = FIXTURE_RUNTIME_ROLE_ENVIRONMENT[role];
  return createPlatformDatabaseClient(loadPlatformDatabaseConfig(role, {
    DATABASE_URL_PLATFORM: databaseUrl,
    PLATFORM_DATABASE_CREDENTIAL_CLASS: role,
    PLATFORM_DATABASE_MIGRATOR_ROLE: required(environment.PLATFORM_DATABASE_MIGRATOR_ROLE,
      "PLATFORM_DATABASE_MIGRATOR_ROLE"),
    PLATFORM_DATABASE_EXPECTED_DATABASE: database,
    [roleEnvironment]: user,
  }));
}

function fixtureConfiguration(environment: Readonly<Record<string, string | undefined>>) {
  const migratorDatabaseUrl = leasedDatabaseUrl(environment.DATABASE_URL_PLATFORM);
  const siteId = required(environment.PLATFORM_FIXTURE_SITE_ID, "PLATFORM_FIXTURE_SITE_ID");
  bounded(siteId, 96, "PLATFORM_FIXTURE_SITE_ID_INVALID");
  const privateDirectory = required(environment.PLATFORM_FIXTURE_PRIVATE_DIR,
    "PLATFORM_FIXTURE_PRIVATE_DIR");
  if (!isAbsolute(privateDirectory) || privateDirectory.length > 4_096 || control(privateDirectory)) {
    throw new Error("PLATFORM_FIXTURE_PRIVATE_DIR_INVALID");
  }
  return Object.freeze({ migratorDatabaseUrl, siteId, privateDirectory,
    apiDatabaseUrl: leasedDatabaseUrl(environment.DATABASE_URL_PLATFORM_API_FIXTURE),
    adminDatabaseUrl: leasedDatabaseUrl(environment.DATABASE_URL_PLATFORM_ADMIN_FIXTURE),
    siteWorkerDatabaseUrl: leasedDatabaseUrl(environment.DATABASE_URL_PLATFORM_SITE_WORKER_FIXTURE),
    identityWorkerDatabaseUrl: leasedDatabaseUrl(
      environment.DATABASE_URL_PLATFORM_IDENTITY_WORKER_FIXTURE,
    ),
    observerDatabaseUrl: leasedDatabaseUrl(environment.DATABASE_URL_PLATFORM_OBSERVER_FIXTURE),
    observerRole: databaseUser(environment.DATABASE_URL_PLATFORM_OBSERVER_FIXTURE),
  });
}

function fixtureSiteBffTrust(environment: Readonly<Record<string, string | undefined>>) {
  return Object.freeze({
    siteBffClientCertificateFile: required(
      environment.PLATFORM_FIXTURE_SITE_BFF_CLIENT_CERTIFICATE_FILE,
      "PLATFORM_FIXTURE_SITE_BFF_CLIENT_CERTIFICATE_FILE",
    ),
    siteBffWorkloadCredentialFile: required(
      environment.PLATFORM_FIXTURE_SITE_BFF_WORKLOAD_CREDENTIAL_FILE,
      "PLATFORM_FIXTURE_SITE_BFF_WORKLOAD_CREDENTIAL_FILE",
    ),
    siteBffCertificateAuthorityFile: required(
      environment.PLATFORM_FIXTURE_SITE_BFF_CERTIFICATE_AUTHORITY_FILE,
      "PLATFORM_FIXTURE_SITE_BFF_CERTIFICATE_AUTHORITY_FILE",
    ),
  });
}

function preparedStateFile(privateDirectory: string): string {
  return resolve(privateDirectory, "platform-prepared-state.json");
}

async function loadPreparedState(
  privateDirectory: string,
  expectedSiteId: string,
): Promise<PlatformFixturePreparedResult> {
  let candidate: unknown;
  try {
    candidate = JSON.parse(await readFile(preparedStateFile(privateDirectory), "utf8"));
  } catch {
    throw new Error("PLATFORM_FIXTURE_PREPARED_STATE_INVALID");
  }
  if (!objectRecord(candidate) || candidate.schemaVersion !== 1 ||
      candidate.kind !== "platform-web-chat-credit-runtime-prepared" ||
      candidate.siteId !== expectedSiteId) {
    throw new Error("PLATFORM_FIXTURE_PREPARED_STATE_INVALID");
  }
  const names = ["siteId", "siteReleaseRef", "siteProjectBindingRef", "workloadIdentityId",
    "deploymentRef", "webArtifactDigest", "modelOptionRevisionRef", "agentCatalogRef"] as const;
  if (Object.keys(candidate).length !== names.length + 2 ||
      names.some((name) => typeof candidate[name] !== "string")) {
    throw new Error("PLATFORM_FIXTURE_PREPARED_STATE_INVALID");
  }
  return createPlatformFixturePreparedResult({
    siteId: preparedString(candidate, "siteId"),
    siteReleaseRef: preparedString(candidate, "siteReleaseRef"),
    siteProjectBindingRef: preparedString(candidate, "siteProjectBindingRef"),
    workloadIdentityId: preparedString(candidate, "workloadIdentityId"),
    deploymentRef: preparedString(candidate, "deploymentRef"),
    webArtifactDigest: preparedString(candidate, "webArtifactDigest"),
    modelOptionRevisionRef: preparedString(candidate, "modelOptionRevisionRef"),
    agentCatalogRef: preparedString(candidate, "agentCatalogRef"),
  });
}

function preparedString(value: Record<string, unknown>, name: string): string {
  const candidate = value[name];
  if (typeof candidate !== "string") throw new Error("PLATFORM_FIXTURE_PREPARED_STATE_INVALID");
  return candidate;
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function configureObserver(databaseUrl: string, observerRole: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl,
    application_name: "kokoro-platform-web-chat-credit-observer-authority",
    connectionTimeoutMillis: 5_000, statement_timeout: 10_000, lock_timeout: 3_000 });
  await client.connect();
  try {
    const role = quoteIdentifier(observerRole);
    await client.query(`GRANT USAGE ON SCHEMA platform TO ${role}`);
    await client.query(`GRANT SELECT ON TABLE ${OBSERVER_RELATIONS
      .map((relation) => `platform.${quoteIdentifier(relation)}`).join(",")} TO ${role}`);
  } finally { await client.end(); }
}

const silentMigrationCommand: MigrationCommandExecutor = (command, args, environment) =>
  new Promise((resolveExit, reject) => {
    const child = spawn(command, [...args], { cwd: process.cwd(), env: environment,
      stdio: ["ignore", "ignore", "ignore"] });
    child.once("error", reject);
    child.once("exit", (code, signal) => signal === null ? resolveExit(code ?? 1) :
      reject(new Error("PLATFORM_FIXTURE_MIGRATION_TERMINATED")));
  });

async function runQuietFixtureCommand(
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  code: string,
): Promise<void> {
  const exitCode = await silentMigrationCommand(command, args, { ...environment });
  if (exitCode !== 0) throw new Error(code);
}

interface ObservationRow extends Record<string, unknown> {
  providerInvocationCount: number;
  providerAttemptCount: number;
  finalizedEvidenceCount: number;
  segmentSettlementCount: number;
  captureJournalCount: number;
  claimedRedemptionCodeCount: number;
  redemptionCount: number;
  redemptionFulfillmentCount: number;
  redemptionGrantCount: number;
  availableConsumedDeltaEqual: boolean;
  redemptionLineage: unknown;
}

const OBSERVATION_SQL = `WITH ledger AS (
  SELECT COALESCE(sum(CASE WHEN entry.account_type='customer_available'
    THEN CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END ELSE 0 END),0) AS available,
    COALESCE(sum(CASE WHEN entry.account_type='customer_consumed'
    THEN CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END ELSE 0 END),0) AS consumed
  FROM platform.credit_journal_entry entry WHERE entry.site_ref=$1
), issued AS (
  SELECT COALESCE(sum(original_amount),0) AS total FROM platform.credit_grant WHERE site_ref=$1
)
SELECT
  (SELECT count(*)::int FROM platform.model_gateway_invocation WHERE site_ref=$1) AS "providerInvocationCount",
  (SELECT count(*)::int FROM platform.model_gateway_attempt_usage_fact WHERE site_ref=$1) AS "providerAttemptCount",
  (SELECT count(*)::int FROM platform.credit_attempt_usage_evidence WHERE site_ref=$1) AS "finalizedEvidenceCount",
  (SELECT count(*)::int FROM platform.credit_usage_settlement WHERE site_ref=$1) AS "segmentSettlementCount",
  (SELECT count(*)::int FROM platform.credit_journal_transaction
    WHERE site_ref=$1 AND operation_kind='hold_capture') AS "captureJournalCount",
  (SELECT count(*)::int FROM platform.commerce_redeem_code
    WHERE site_ref=$1 AND state='claimed') AS "claimedRedemptionCodeCount",
  (SELECT count(*)::int FROM platform.commerce_redemption
    WHERE site_ref=$1 AND state='fulfilled') AS "redemptionCount",
  (SELECT count(*)::int FROM platform.commerce_fulfillment_transaction
    WHERE site_ref=$1 AND source_type='redemption' AND state='committed')
    AS "redemptionFulfillmentCount",
  (SELECT count(*)::int FROM platform.credit_grant
    WHERE site_ref=$1 AND source_type='redemption') AS "redemptionGrantCount",
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'redemptionId',redemption.redemption_id::text,
      'codeRef',redemption.code_ref::text,
      'redemptionState',redemption.state,
      'redemptionProductVersionRef',redemption.product_version_ref,
      'redemptionFulfillmentRef',redemption.fulfillment_ref::text,
      'redemptionBillingAccountRef',redemption.billing_account_ref,
      'fulfillmentId',fulfillment.fulfillment_id::text,
      'fulfillmentState',fulfillment.state,
      'fulfillmentSourceType',fulfillment.source_type,
      'fulfillmentSourceRef',fulfillment.source_id,
      'fulfillmentProductVersionRef',fulfillment.product_version_ref,
      'fulfillmentOutputSetDigest',fulfillment.output_set_digest,
      'fulfillmentBillingAccountRef',fulfillment.billing_account_ref,
      'fulfillmentIdempotencyKey',fulfillment.idempotency_key,
      'outputKind',actual.output_kind,
      'outputLineId',actual.output_line_id,
      'outputOrdinal',actual.output_ordinal,
      'occurrence',actual.occurrence,
      'outputRef',actual.output_ref,
      'templateRevisionRef',actual.template_revision,
      'outputVersion',actual.output_version,
      'outputDigest',actual.output_digest,
      'grantId',grant_fact.credit_grant_id::text,
      'grantBillingAccountRef',grant_fact.billing_account_ref,
      'grantSourceType',grant_fact.source_type,
      'grantSourceRef',grant_fact.source_ref,
      'grantCreditProgramRevisionRef',grant_fact.credit_program_revision_ref
    ) ORDER BY actual.output_ordinal,actual.occurrence)
    FROM platform.commerce_redemption redemption
    JOIN platform.commerce_fulfillment_transaction fulfillment
      ON fulfillment.fulfillment_id=redemption.fulfillment_ref
     AND fulfillment.site_ref=redemption.site_ref
     AND fulfillment.state='committed'
     AND fulfillment.source_type='redemption'
     AND fulfillment.source_id=redemption.code_ref::text
     AND fulfillment.product_version_ref=redemption.product_version_ref
    JOIN platform.commerce_fulfillment_actual_output actual
      ON actual.fulfillment_id=fulfillment.fulfillment_id
     AND actual.output_kind='credit_grant'
    JOIN platform.credit_grant grant_fact
      ON grant_fact.credit_grant_id::text=actual.output_ref
     AND grant_fact.site_ref=fulfillment.site_ref
     AND grant_fact.billing_account_ref=fulfillment.billing_account_ref
     AND grant_fact.source_type='redemption'
     AND grant_fact.source_ref=fulfillment.idempotency_key || ':' ||
       actual.output_line_id || ':' || actual.occurrence::text
     AND grant_fact.credit_program_revision_ref=actual.template_revision
    WHERE redemption.site_ref=$1 AND redemption.state='fulfilled'),
    '[]'::jsonb) AS "redemptionLineage",
  (SELECT issued.total-ledger.available=ledger.consumed FROM issued CROSS JOIN ledger)
    AS "availableConsumedDeltaEqual"`;

function leasedDatabaseUrl(value: string | undefined): string {
  const result = required(value, "PLATFORM_FIXTURE_DATABASE_URL_REQUIRED");
  const url = new URL(result);
  if (!url.pathname.slice(1).startsWith("kokoro_test_") || url.username.length < 1) {
    throw new Error("PLATFORM_FIXTURE_DATABASE_URL_INVALID");
  }
  return result;
}

function databaseUser(value: string | undefined): string {
  const user = decodeURIComponent(new URL(leasedDatabaseUrl(value)).username);
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(user)) throw new Error("PLATFORM_FIXTURE_DATABASE_ROLE_INVALID");
  return user;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) throw new Error("PLATFORM_FIXTURE_IDENTIFIER_INVALID");
  return `"${value}"`;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("PLATFORM_FIXTURE_OBSERVATION_INVALID");
  }
  return value as number;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function bounded(value: string, maximum: number, code: string): void {
  if (value.length < 1 || value.length > maximum || control(value)) throw new Error(code);
}

function control(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  });
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length < 1) throw new Error(`${name}_REQUIRED`);
  return value;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  const command = parsePlatformFixtureCommand(process.argv.slice(2));
  const action = command === "prepare"
    ? preparePlatformFixture()
    : command === "finalize"
      ? finalizePlatformFixture()
      : observePlatformFixture();
  action.then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(() => {
    process.stderr.write("PLATFORM_FIXTURE_FAILED\n");
    process.exitCode = 1;
  });
}
