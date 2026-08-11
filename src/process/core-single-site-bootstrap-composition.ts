import { createHash, createHmac } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { capabilityCatalogSnapshotDigest, readBoundedHubConnectFile } from "@kokoro/hub";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  CapabilityCatalogSnapshotSchema,
  CatalogProjectionState,
  FreezeCatalogEffectSchema,
  HubCatalogService,
  type FreezeCatalogEffect,
} from "../generated/proto/kokoro/platform/capability/v1/capability_catalog_pb.js";
import { CommandDigestAlgorithm, CommandReceiptState } from
  "../generated/proto/kokoro/common/v1/receipt_pb.js";
import { freezeCatalogRequestDigest } from
  "../modules/hub/interfaces/connect/capability-catalog-services.js";
import { buildProjectionTransportOptions } from
  "../modules/hub/infrastructure/connect/platform-capability-projection-client.js";
import { canonicalizeModelInventory, type CanonicalizedModelInventory } from
  "../modules/model-control/domain/model-catalog.js";
import {
  DIRECT_MODEL_PROVIDER_IDENTITY,
  DIRECT_MODEL_PROVIDER_SECRET_REF,
} from "../modules/model-control/domain/direct-model-provider-identity.js";
import { materializeModelOptionDraftSet } from
  "../modules/model-control/domain/model-option-materialization.js";
import {
  createSiteReleaseModelCatalogRevision,
  type ModelOptionDraft,
} from "../modules/model-control/domain/product-model-option.js";
import {
  defineAdmissionLaunchProfilePublication,
  type AdmissionLaunchProfileSnapshot,
} from "../modules/admission/domain/admission-launch-profile-publication.js";
import type { RatingPolicyRevision } from "../modules/credit/domain/usage-rating.js";
import type { SiteReleaseCertificationAuthority } from
  "../modules/site/application/contracts/site-publication-ports.js";
import type { PublishedSiteRelease } from "../modules/site/domain/site-publication.js";
import type { VerifiedRequestSecurityContext } from
  "../shared/security-context/request-security-context.js";
import type { PlatformTransactionalDatabaseClient } from
  "../infrastructure/postgres/client.js";
import { PlatformUnitOfWork } from "../shared/unit-of-work/unit-of-work.js";
import { resolvePlatformTransaction, type PlatformTransaction } from
  "../shared/unit-of-work/platform-transaction.js";
import {
  CommandReceiptRepository,
  type CommandIdentity,
  type CommandReceipt,
  type JsonValue,
} from
  "../shared/outbox-inbox/receipt.js";
import { OutboxRepository } from "../shared/outbox-inbox/outbox.js";
import { createProductModelOptionAdministrationComposition } from
  "./model-option-admin-composition.js";
import { createPlatformSiteProvisioningComposition } from
  "./site-provisioning-admin-composition.js";
import { createPlatformSiteAdminComposition } from "./site-admin-composition.js";
import { createSiteRuntimeWorkerProductionComposition } from
  "./site-runtime-worker-composition.js";
import { assertFixedSiteProviderBinding } from
  "../modules/site/infrastructure/rpc/site-provider-registry-config.js";
import {
  IdentityOutboxConsumer,
  type IdentityEffect,
  type IdentityEffectEventQueue,
  type IdentityEffectFailure,
  type IdentityVerificationDeliveryPort,
} from "../modules/identity/application/services/identity-outbox-consumer.js";
import type { IdentityAuditDigesterPort } from
  "../modules/identity/application/contracts/identity-security-ports.js";
import type { ClaimedOutboxEvent } from "../shared/outbox-inbox/outbox.js";
import { createPostgresIdentityEffectEventQueue } from
  "../modules/identity/infrastructure/postgres/identity-outbox-consumer.js";
import { createCommerceAdministrationComposition } from
  "./commerce-admin-composition.js";
import {
  canonicalCommerceCreditProgramPayload,
  canonicalCommerceOfferPayload,
  canonicalCommerceRedemptionProgramPayload,
  commerceAdministrationDigest,
} from "../modules/commerce/application/services/commerce-administration.js";
import { canonicalFulfillmentProgramDigest } from
  "../modules/commerce/domain/fulfillment-program.js";
import {
  loadAuthorizationEventKeyRing,
  loadIdentityAuditDigester,
  loadIdentityPasswordHasher,
} from "./platform-public-composition.js";
import { createSessionAuthorizationEventSigner } from
  "../modules/authorization/infrastructure/jose/session-authorization-event-signer.js";
import { SignedScopedSessionAuthorizationPublisher } from
  "../modules/authorization/infrastructure/postgres/signed-scoped-session-authorization-publisher.js";
import { PostgresScopedAuthorizationFeedRepository } from
  "../modules/authorization/infrastructure/postgres/scoped-authorization-feed-repository.js";
import { BootstrapVerifiedPersonalAccountService } from
  "../modules/identity/application/services/bootstrap-verified-personal-account.js";
import { PersonalBootstrapAuthorizationMutation } from
  "../modules/identity/application/services/personal-bootstrap-authorization-mutation.js";
import { PostgresIdentityRepository } from
  "../modules/identity/infrastructure/postgres/identity-repository.js";
import { AdmissionLaunchProfilePublicationService } from
  "../modules/admission/application/admission-launch-profile-publication-service.js";
import { PostgresAdmissionLaunchProfilePublicationRepository } from
  "../modules/admission/infrastructure/postgres/admission-launch-profile-publication-repository.js";
import { RatingPolicyPublicationService } from
  "../modules/credit/application/rating-policy-publication-service.js";
import { PostgresRatingPolicyPublicationRepository } from
  "../modules/credit/infrastructure/postgres/rating-policy-publication-repository.js";
import { definePublishedRatingPolicyRevision } from
  "../modules/credit/domain/rating-policy-publication.js";
import { createPlatformApiRuntimeFileReader } from "./platform-api-runtime-contract.js";
import { createBoundedFileReaderWithinTrustRoot } from "./secret-files.js";
import {
  coreBootstrapConfigDigest,
  coreBootstrapIdempotencyKey,
  coreBootstrapUuid,
  CORE_SINGLE_SITE_SURFACES,
  type CoreBootstrapSecretDigests,
  type CoreSingleSiteBootstrapDocument,
} from "./core-single-site-bootstrap-document.js";
import {
  verifyCoreBootstrapAdminAttestation,
  type CoreBootstrapAdminAttestationBundle,
} from "./core-single-site-bootstrap-attestation.js";

const ADMIN_AUDIENCE = "platform-admin";
const EMPTY_CAPABILITY_SNAPSHOT = Object.freeze({
  schemaVersion: 1 as const,
  agentOptions: Object.freeze([]),
  tools: Object.freeze([]),
  skillOptions: Object.freeze([]),
  mcpOptions: Object.freeze([]),
  subagents: Object.freeze([]),
});
export const CORE_SINGLE_SITE_BOOTSTRAP_EMPTY_AGENT_CATALOG_REF =
  `agent-catalog:sha256:${capabilityCatalogSnapshotDigest(EMPTY_CAPABILITY_SNAPSHOT)}`;

export const CORE_SINGLE_SITE_BOOTSTRAP_IDENTITY_DELIVERY:
IdentityVerificationDeliveryPort = Object.freeze({
  async publish() {
    throw Object.assign(new Error("CORE_BOOTSTRAP_UNEXPECTED_VERIFICATION_DELIVERY"), {
      retryable: false,
    });
  },
});

export function createCoreSingleSiteBootstrapIdentityOutboxConsumer(
  queue: IdentityEffectEventQueue,
  auditDigest: IdentityAuditDigesterPort,
  now: () => string = () => new Date().toISOString(),
): IdentityOutboxConsumer {
  return new IdentityOutboxConsumer(Object.freeze({
    ...queue,
    async fail(
      event: ClaimedOutboxEvent | IdentityEffect,
      failure: IdentityEffectFailure,
    ) {
      if (failure.errorCode === "CORE_BOOTSTRAP_UNEXPECTED_VERIFICATION_DELIVERY") {
        throw new Error("CORE_BOOTSTRAP_UNEXPECTED_VERIFICATION_DELIVERY");
      }
      await queue.fail(event, failure);
    },
  }), CORE_SINGLE_SITE_BOOTSTRAP_IDENTITY_DELIVERY, { auditDigest, now });
}

export const CORE_SINGLE_SITE_BOOTSTRAP_MAKER_OPERATIONS = Object.freeze([
  "core.single-site.bootstrap",
  "site.register",
  "model.inventory.import",
  "model.inventory.activate",
  "model.option.materialize",
  "site.release.publish",
  "site.approval.request",
  "model.site-release-catalog.publish",
  "admission.launch-profile.publish",
  "identity.bootstrap-verified-personal-account",
  "credit.rating-policy.publish",
  "commerce.credit-program.publish",
  "commerce.offer.publish",
  "commerce.redemption-program.publish",
  "commerce.code-batch.issue",
] as const);

export const CORE_SINGLE_SITE_BOOTSTRAP_CHECKER_OPERATIONS = Object.freeze([
  "site.activation.begin",
  "commerce.code-batch.approve",
  "commerce.code-batch.activate",
] as const);

export const CORE_SINGLE_SITE_BOOTSTRAP_EFFECT_STEPS = Object.freeze([
  "configuration.claim",
  "site.register",
  "model.import-inventory",
  "model.activate-inventory",
  "model.materialize-option",
  "site.publish-release",
  "site.request-activation-approval",
  "capability.ensure-empty-catalog",
  "site.approve-and-activate",
  "site.run-outbox-cycle",
  "model.publish-site-catalog",
  "admission.publish-launch-profile",
  "identity.bootstrap-verified-personal",
  "identity.run-outbox-cycle",
  "rating.publish-policy",
  "commerce.publish-credit-program",
  "commerce.publish-offer",
  "commerce.publish-redemption-program",
  "commerce.issue-code-batch",
  "commerce.approve-code-batch",
  "commerce.activate-code-batch",
  "readback.assert-ready",
  "configuration.complete",
] as const);

export type CoreSingleSiteBootstrapEffectStep =
  typeof CORE_SINGLE_SITE_BOOTSTRAP_EFFECT_STEPS[number];
type MakerOperation = typeof CORE_SINGLE_SITE_BOOTSTRAP_MAKER_OPERATIONS[number];
type CheckerOperation = typeof CORE_SINGLE_SITE_BOOTSTRAP_CHECKER_OPERATIONS[number];

export type CoreSingleSiteBootstrapRecipe = Readonly<{
  inventory: CanonicalizedModelInventory;
  modelOption: ModelOptionDraft;
  modelOptionRevisionRef: string;
  modelOptionCatalogRef: string;
  launchProfile: AdmissionLaunchProfileSnapshot;
  launchProfileRef: string;
  siteRelease: Omit<PublishedSiteRelease, "state">;
  ratingPolicy: RatingPolicyRevision;
  activation: Readonly<{
    approvalRef: string;
    attemptRef: string;
    activationFactsDigest: string;
    reason: string;
  }>;
}>;

export type CoreSingleSiteBootstrapExecution = Readonly<{
  document: CoreSingleSiteBootstrapDocument;
  secretDigests: CoreBootstrapSecretDigests;
  configDigest: string;
  recipe: CoreSingleSiteBootstrapRecipe;
  authorization: Readonly<{
    maker: Readonly<Record<MakerOperation, VerifiedRequestSecurityContext>>;
    checker: Readonly<Record<CheckerOperation, VerifiedRequestSecurityContext>>;
  }>;
}>;

export type CoreSingleSiteBootstrapResult = Readonly<{
  schemaVersion: 1;
  kind: "kokoro-core-single-site-bootstrap-result";
  bootstrapId: string;
  configDigest: string;
  site: Readonly<{
    siteId: string;
    siteReleaseRef: string;
    webArtifactDigest: string;
    deploymentRef: string;
    state: "active";
  }>;
  model: Readonly<{
    inventoryDigest: string;
    modelOptionRevisionRef: string;
    modelOptionCatalogRef: string;
  }>;
  identity: Readonly<{
    accountRef: string;
    subjectRef: string;
    workspaceRef: string;
    projectRef: string;
    billingAccountRef: string;
    executionSpaceRef: string;
    executionNamespace: string;
  }>;
  ratingPolicyRevisionRef: string;
  agentCatalogRef: string;
  redemption: Readonly<{
    creditProgramRevisionRef: string;
    productVersionRef: string;
    fulfillmentProgramRevisionRef: string;
    programRevisionRef: string;
    batchRef: string;
    amount: string;
    unit: string;
    safeCodeFingerprint: string;
    state: "active";
  }>;
}>;

export type CoreSingleSiteBootstrapPersistedCodeIdentity = Readonly<{
  safeFingerprint: string;
  keyRevision: string;
  batchSelector: string;
  lookupDigest: string;
  state: "available" | "claimed" | "void";
}>;

type CoreSingleSiteBootstrapReadback = Readonly<{
  deploymentRef: string;
  code: CoreSingleSiteBootstrapPersistedCodeIdentity;
}>;

type CoreSingleSiteBootstrapReconstructedCode = Readonly<{
  code: string;
  safeFingerprint: string;
  keyRevision: string;
  batchSelector: string;
  lookupDigest: string;
}>;

type OwnerEffect = (execution: CoreSingleSiteBootstrapExecution) => Promise<void>;

export interface CoreSingleSiteBootstrapOwners {
  readonly configuration: Readonly<{
    claim: OwnerEffect;
    complete(
      execution: CoreSingleSiteBootstrapExecution,
      result: CoreSingleSiteBootstrapResult,
    ): Promise<void>;
  }>;
  readonly site: Readonly<{
    register: OwnerEffect;
    publishRelease: OwnerEffect;
    requestActivationApproval: OwnerEffect;
    approveAndActivate: OwnerEffect;
    runOutboxCycle: OwnerEffect;
  }>;
  readonly capability: Readonly<{
    ensureEmpty(execution: CoreSingleSiteBootstrapExecution): Promise<void | string>;
  }>;
  readonly model: Readonly<{
    importInventory: OwnerEffect;
    activateInventory: OwnerEffect;
    materializeOption(execution: CoreSingleSiteBootstrapExecution): Promise<string>;
    publishSiteCatalog(execution: CoreSingleSiteBootstrapExecution): Promise<string>;
  }>;
  readonly admission: Readonly<{ publishLaunchProfile: OwnerEffect }>;
  readonly identity: Readonly<{
    bootstrapVerifiedPersonal: OwnerEffect;
    runOutboxCycle: OwnerEffect;
  }>;
  readonly rating: Readonly<{ publishPolicy: OwnerEffect }>;
  readonly commerce: Readonly<{
    publishCreditProgram: OwnerEffect;
    publishOffer: OwnerEffect;
    publishRedemptionProgram: OwnerEffect;
    issueCodeBatch(execution: CoreSingleSiteBootstrapExecution): Promise<string | null>;
    approveCodeBatch: OwnerEffect;
    activateCodeBatch: OwnerEffect;
    reconstructCode(
      execution: CoreSingleSiteBootstrapExecution,
      persisted: CoreSingleSiteBootstrapPersistedCodeIdentity,
    ): Promise<CoreSingleSiteBootstrapReconstructedCode> |
      CoreSingleSiteBootstrapReconstructedCode;
  }>;
  readonly readback: Readonly<{
    assertReady(execution: CoreSingleSiteBootstrapExecution): Promise<CoreSingleSiteBootstrapReadback>;
  }>;
}

export function coreSingleSiteBootstrapDatabaseEnvironments(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<{
  admin: Readonly<Record<string, string | undefined>>;
  api: Readonly<Record<string, string | undefined>>;
  siteWorker: Readonly<Record<string, string | undefined>>;
  identityWorker: Readonly<Record<string, string | undefined>>;
}> {
  const bindings = [
    ["admin", "DATABASE_URL_PLATFORM_ADMIN", "admin"],
    ["api", "DATABASE_URL_PLATFORM_API", "api"],
    ["siteWorker", "DATABASE_URL_PLATFORM_SITE_WORKER", "site-worker"],
    ["identityWorker", "DATABASE_URL_PLATFORM_IDENTITY_WORKER", "identity-worker"],
  ] as const;
  const urls = bindings.map(([, name]) => requiredEnvironment(environment, name));
  if (new Set(urls).size !== urls.length) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_DATABASE_URLS_NOT_DISTINCT");
  }
  const roleEnvironment = (name: typeof bindings[number][1], credentialClass: string) =>
    Object.freeze({
      ...environment,
      DATABASE_URL_PLATFORM: requiredEnvironment(environment, name),
      PLATFORM_DATABASE_CREDENTIAL_CLASS: credentialClass,
    });
  return Object.freeze({
    admin: roleEnvironment("DATABASE_URL_PLATFORM_ADMIN", "admin"),
    api: roleEnvironment("DATABASE_URL_PLATFORM_API", "api"),
    siteWorker: roleEnvironment("DATABASE_URL_PLATFORM_SITE_WORKER", "site-worker"),
    identityWorker: roleEnvironment("DATABASE_URL_PLATFORM_IDENTITY_WORKER", "identity-worker"),
  });
}

export async function assertCoreSingleSiteBootstrapSiteProviderConfiguration(
  document: CoreSingleSiteBootstrapDocument,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  try {
    await assertFixedSiteProviderBinding(
      requiredEnvironment(environment, "PLATFORM_SITE_PROVIDER_REGISTRY_FILE"),
      {
        namespace: document.site.providerNamespace,
        metadataEndpoint: document.site.metadataEndpoint,
      },
    );
  } catch {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_SITE_PROVIDER_MISMATCH");
  }
}

interface HubCapabilityCatalogClient {
  freezeCatalog(input: Readonly<{
    command: Readonly<{ commandId: string; idempotencyKey: string;
      digestAlgorithm: CommandDigestAlgorithm; requestDigest: string }>;
    effect: FreezeCatalogEffect;
  }>): Promise<Readonly<{
    publication?: Readonly<{ agentCatalogRef: string; siteId: string; siteReleaseRef: string }>;
    projectionState: CatalogProjectionState;
    receipt?: HubCapabilityCatalogReceipt;
  }>>;
  getCatalogPublication(input: Readonly<{
    commandId: string;
    idempotencyKey: string;
    digestAlgorithm: CommandDigestAlgorithm;
    requestDigest: string;
    siteId: string;
    siteReleaseRef: string;
  }>): Promise<Readonly<{
    publication?: Readonly<{ agentCatalogRef: string; siteId: string; siteReleaseRef: string }>;
    projectionState: CatalogProjectionState;
    receipt?: HubCapabilityCatalogReceipt;
    lastProjectionErrorCode?: string;
  }>>;
}

type HubCapabilityCatalogReceipt = Readonly<{
  identity?: Readonly<{
    commandId: string;
    idempotencyKey: string;
    digestAlgorithm: CommandDigestAlgorithm;
    requestDigest: string;
  }> | undefined;
  operation: string;
  state: CommandReceiptState;
}>;

export function createHubCapabilityCatalogPublicationPort(input: Readonly<{
  client: HubCapabilityCatalogClient;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}>): CoreSingleSiteBootstrapOwners["capability"] {
  const sleep = input.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = input.now ?? Date.now;
  const timeoutMs = boundedInteger(input.timeoutMs ?? 20_000, 1, 300_000,
    "CORE_SINGLE_SITE_BOOTSTRAP_HUB_TIMEOUT_INVALID");
  const pollIntervalMs = boundedInteger(input.pollIntervalMs ?? 100, 1, 10_000,
    "CORE_SINGLE_SITE_BOOTSTRAP_HUB_POLL_INVALID");
  return Object.freeze({
    async ensureEmpty(execution) {
      const effect = create(FreezeCatalogEffectSchema, {
        siteId: execution.document.site.siteId,
        siteReleaseRef: execution.document.site.siteReleaseRef,
        snapshot: create(CapabilityCatalogSnapshotSchema, {
          schemaVersion: 1,
          agentOptions: [],
          tools: [],
          skillOptions: [],
          mcpOptions: [],
          subagents: [],
        }),
      });
      const command = Object.freeze({
        commandId: coreBootstrapUuid(execution.document.bootstrapId, "capability.catalog.freeze"),
        idempotencyKey: coreBootstrapIdempotencyKey(
          execution.document.bootstrapId,
          "capability.catalog.freeze",
        ),
        digestAlgorithm: CommandDigestAlgorithm.SHA256_PROTOBUF_V1,
        requestDigest: freezeCatalogRequestDigest(effect),
      });
      let response = await input.client.freezeCatalog({ command, effect });
      assertHubPublication(response, execution, command);
      const deadline = now() + timeoutMs;
      while (response.projectionState === CatalogProjectionState.PENDING && now() < deadline) {
        await sleep(pollIntervalMs);
        response = await input.client.getCatalogPublication({
          ...command,
          siteId: execution.document.site.siteId,
          siteReleaseRef: execution.document.site.siteReleaseRef,
        });
        assertHubPublication(response, execution, command);
      }
      if (response.projectionState !== CatalogProjectionState.COMMITTED ||
          response.receipt?.state !== CommandReceiptState.COMMITTED) {
        throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_CAPABILITY_PROJECTION_NOT_COMMITTED");
      }
      return execution.document.externalEmptyAgentCatalogRef;
    },
  });
}

export async function createProductionHubCapabilityCatalogPublicationPort(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<CoreSingleSiteBootstrapOwners["capability"]> {
  const trustRoot = requiredEnvironment(
    environment,
    "PLATFORM_CORE_BOOTSTRAP_HUB_TLS_TRUST_ROOT",
  );
  const [privateKeyPem, certificatePem, certificateAuthorityPem] = await Promise.all([
    readBoundedHubConnectFile(
      requiredEnvironment(environment, "PLATFORM_CORE_BOOTSTRAP_HUB_TLS_KEY_FILE"),
      trustRoot,
      64 * 1024,
      true,
    ),
    readBoundedHubConnectFile(
      requiredEnvironment(environment, "PLATFORM_CORE_BOOTSTRAP_HUB_TLS_CERT_FILE"),
      trustRoot,
      64 * 1024,
      false,
    ),
    readBoundedHubConnectFile(
      requiredEnvironment(environment, "PLATFORM_CORE_BOOTSTRAP_HUB_TLS_CA_FILE"),
      trustRoot,
      256 * 1024,
      false,
    ),
  ]);
  const timeoutMs = optionalEnvironmentInteger(
    environment,
    "PLATFORM_CORE_BOOTSTRAP_HUB_REQUEST_TIMEOUT_MS",
    1,
    5_000,
  ) ?? 5_000;
  const transport = createConnectTransport(buildProjectionTransportOptions({
    baseUrl: requiredEnvironment(environment, "PLATFORM_CORE_BOOTSTRAP_HUB_BASE_URL"),
    serverName: requiredEnvironment(environment, "PLATFORM_CORE_BOOTSTRAP_HUB_SERVER_NAME"),
    privateKeyPem,
    certificatePem,
    certificateAuthorityPem,
    timeoutMs,
  }));
  const client = createClient(HubCatalogService, transport);
  return createHubCapabilityCatalogPublicationPort({
    client: {
      async freezeCatalog(request) {
        const response = await client.freezeCatalog(request);
        return wireHubPublicationResponse(response);
      },
      async getCatalogPublication(request) {
        const response = await client.getCatalogPublication(request);
        return {
          ...wireHubPublicationResponse(response),
          ...(response.lastProjectionErrorCode === undefined
            ? {} : { lastProjectionErrorCode: response.lastProjectionErrorCode }),
        };
      },
    },
    timeoutMs: optionalEnvironmentInteger(
      environment,
      "PLATFORM_CORE_BOOTSTRAP_HUB_PROJECTION_TIMEOUT_MS",
      1,
      300_000,
    ) ?? 20_000,
    pollIntervalMs: optionalEnvironmentInteger(
      environment,
      "PLATFORM_CORE_BOOTSTRAP_HUB_PROJECTION_POLL_MS",
      1,
      10_000,
    ) ?? 100,
  });
}

export type CoreSingleSiteBootstrapProductionDatabases = Readonly<{
  admin: PlatformTransactionalDatabaseClient;
  api: PlatformTransactionalDatabaseClient;
  siteWorker: PlatformTransactionalDatabaseClient;
  identityWorker: PlatformTransactionalDatabaseClient;
}>;

export type CoreSingleSiteBootstrapCodeReconstructor = (input: Readonly<{
  document: CoreSingleSiteBootstrapDocument;
  recipe: CoreSingleSiteBootstrapRecipe;
  persisted: CoreSingleSiteBootstrapPersistedCodeIdentity;
}>) => Promise<CoreSingleSiteBootstrapReconstructedCode>;

export async function createCoreSingleSiteBootstrapProductionCodeRecovery(input: Readonly<{
  database: PlatformTransactionalDatabaseClient;
  document: CoreSingleSiteBootstrapDocument;
  redemptionEntropySecret: Uint8Array;
  environment: Readonly<Record<string, string | undefined>>;
}>): Promise<CoreSingleSiteBootstrapCodeReconstructor> {
  const commerce = await createCoreSingleSiteBootstrapCommerce(input);
  const expected = Object.freeze({
    bootstrapId: input.document.bootstrapId,
    siteId: input.document.site.siteId,
    batchRef: input.document.redemption.batchRef,
  });
  return async ({ document, persisted }) => {
    if (document.bootstrapId !== expected.bootstrapId ||
        document.site.siteId !== expected.siteId ||
        document.redemption.batchRef !== expected.batchRef) {
      throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_CODE_RECOVERY_TARGET_INVALID");
    }
    const recovered = commerce.codes.issueCode(
      document.site.siteId,
      document.redemption.batchRef,
      persisted.keyRevision,
    );
    return Object.freeze({
      code: recovered.code,
      safeFingerprint: recovered.safeFingerprint,
      keyRevision: recovered.keyRevision,
      batchSelector: recovered.batchSelector,
      lookupDigest: recovered.lookupDigest,
    });
  };
}

export async function createCoreSingleSiteBootstrapProductionOwners(input: Readonly<{
  databases: CoreSingleSiteBootstrapProductionDatabases;
  document: CoreSingleSiteBootstrapDocument;
  certificationAuthority: SiteReleaseCertificationAuthority;
  password: string;
  redemptionEntropySecret: Uint8Array;
  environment: Readonly<Record<string, string | undefined>>;
  clock?: () => string;
}>): Promise<CoreSingleSiteBootstrapOwners> {
  const clock = input.clock ?? (() => new Date().toISOString());
  if (input.password.length < 15 || input.password.length > 1024 ||
      [...input.password].some((character) => [0, 10, 13].includes(character.codePointAt(0) ?? 0)) ||
      input.redemptionEntropySecret.byteLength < 32 ||
      input.redemptionEntropySecret.byteLength > 4096) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_SECRET_MATERIAL_INVALID");
  }
  const adminUnitOfWork = new PlatformUnitOfWork(input.databases.admin, clock);
  const configuration = createConfigurationGuard(adminUnitOfWork);
  const model = createProductModelOptionAdministrationComposition(input.databases.admin, {
    now: clock,
  });
  const provisioning = createPlatformSiteProvisioningComposition(
    input.databases.admin,
    input.certificationAuthority,
    { now: clock },
  );
  const secretReader = await createBoundedFileReaderWithinTrustRoot(
    requiredEnvironment(input.environment, "PLATFORM_API_FILE_TRUST_ROOT"),
    "PLATFORM_API_FILE_TRUST_ROOT_INVALID",
  );
  const fileReader = createPlatformApiRuntimeFileReader(secretReader);
  const [eventKeyRing, passwordHasher, auditDigest, siteRuntime, capability] = await Promise.all([
    loadAuthorizationEventKeyRing(
      requiredEnvironment(input.environment, "PLATFORM_AUTHORIZATION_EVENT_KEY_RING_FILE"),
      fileReader,
    ),
    loadIdentityPasswordHasher(
      requiredEnvironment(input.environment, "PLATFORM_IDENTITY_PASSWORD_PEPPER_RING_FILE"),
      fileReader,
    ),
    loadIdentityAuditDigester(
      requiredEnvironment(input.environment, "PLATFORM_IDENTITY_AUDIT_DIGEST_KEY_FILE"),
      fileReader,
    ),
    createSiteRuntimeWorkerProductionComposition({
      database: input.databases.siteWorker,
      workerId: `core-bootstrap-site-${input.document.bootstrapId}`,
      environment: input.environment,
    }),
    createProductionHubCapabilityCatalogPublicationPort(input.environment),
  ]);
  const eventSigner = await createSessionAuthorizationEventSigner(eventKeyRing);
  const site = createPlatformSiteAdminComposition(input.databases.admin, eventSigner).site;
  const scopedPublisher = new SignedScopedSessionAuthorizationPublisher(
    new PostgresScopedAuthorizationFeedRepository(),
    eventSigner,
  );
  const identity = new BootstrapVerifiedPersonalAccountService({
    unitOfWork: new PlatformUnitOfWork(input.databases.api, clock),
    repository: new PostgresIdentityRepository(),
    receipts: new CommandReceiptRepository(),
    passwordHasher,
    authorizationMutation: new PersonalBootstrapAuthorizationMutation(scopedPublisher),
    outbox: new OutboxRepository(),
    auditDigest,
    clock: () => new Date(clock()),
  });
  const baseIdentityQueue = createPostgresIdentityEffectEventQueue(
    input.databases.identityWorker,
    { workerId: `core-bootstrap-identity-${input.document.bootstrapId}`, now: clock },
  );
  const identityRuntime = createCoreSingleSiteBootstrapIdentityOutboxConsumer(
    baseIdentityQueue,
    auditDigest,
    clock,
  );
  const admission = new AdmissionLaunchProfilePublicationService({
    unitOfWork: adminUnitOfWork,
    repository: new PostgresAdmissionLaunchProfilePublicationRepository(),
    clock,
  });
  const rating = new RatingPolicyPublicationService({
    unitOfWork: adminUnitOfWork,
    repository: new PostgresRatingPolicyPublicationRepository(),
    clock,
  });
  const commerce = await createCoreSingleSiteBootstrapCommerce({
    database: input.databases.admin,
    document: input.document,
    redemptionEntropySecret: input.redemptionEntropySecret,
    environment: input.environment,
  });

  return Object.freeze({
    configuration,
    site: Object.freeze({
      register: async (execution: CoreSingleSiteBootstrapExecution) => {
        await provisioning.publication.registerSite({
          commandId: commandUuid(execution, "site.register"),
          idempotencyKey: commandKey(execution, "site.register"),
          siteRef: execution.document.site.siteId,
          siteKey: execution.document.site.siteKey,
          bindingRef: execution.document.site.siteProjectBindingRef,
          repositoryRef: `site-repository:fixed:${execution.document.site.siteKey}`,
          providerNamespace: execution.document.site.providerNamespace,
          providerProjectRef: execution.document.site.providerProjectRef,
          environment: execution.document.environment,
          workloadIdentityId: execution.document.site.workloadIdentityId,
        }, maker(execution, "site.register"));
      },
      publishRelease: async (execution: CoreSingleSiteBootstrapExecution) => {
        const proof = execution.document.site.releaseCertification;
        await provisioning.publication.publishRelease({
          commandId: commandUuid(execution, "site.release.publish"),
          idempotencyKey: commandKey(execution, "site.release.publish"),
          ...execution.recipe.siteRelease,
          certificationProof: {
            signingKeyRef: proof.signingKeyRef,
            issuedAt: proof.issuedAt,
            expiresAt: proof.expiresAt,
            signature: Buffer.from(proof.signature, "base64url"),
          },
        }, maker(execution, "site.release.publish"));
      },
      requestActivationApproval: async (execution: CoreSingleSiteBootstrapExecution) => {
        await site.requestActivationApproval({
          ...activationInput(execution),
          commandId: commandUuid(execution, "site.approval.request"),
          idempotencyKey: commandKey(execution, "site.approval.request"),
          requestDigest: sha256(stableJson(activationInput(execution))),
        }, maker(execution, "site.approval.request"));
      },
      approveAndActivate: async (execution: CoreSingleSiteBootstrapExecution) => {
        await site.approveAndActivate({
          ...activationInput(execution),
          commandId: commandUuid(execution, "site.activation.begin"),
          idempotencyKey: commandKey(execution, "site.activation.begin"),
          attemptRef: execution.recipe.activation.attemptRef,
        }, checker(execution, "site.activation.begin"));
      },
      runOutboxCycle: async () => {
        await siteRuntime.runOneCycle({ signal: new AbortController().signal });
      },
    }),
    capability,
    model: Object.freeze({
      importInventory: async (execution: CoreSingleSiteBootstrapExecution) => {
        await model.importInventory.import({
          importId: commandUuid(execution, "model.inventory.import"),
          idempotencyKey: commandKey(execution, "model.inventory.import"),
          requestDigest: execution.configDigest,
          inventory: execution.recipe.inventory.document,
          providerAvailability: [],
        }, maker(execution, "model.inventory.import"));
      },
      activateInventory: async (execution: CoreSingleSiteBootstrapExecution) => {
        await model.activateInventory.activate({
          activationId: commandUuid(execution, "model.inventory.activate"),
          idempotencyKey: commandKey(execution, "model.inventory.activate"),
          requestDigest: execution.configDigest,
          targetDigest: execution.recipe.inventory.digest,
          expectedPointerRevision: "0",
        }, maker(execution, "model.inventory.activate"));
      },
      materializeOption: async (execution: CoreSingleSiteBootstrapExecution) => {
        const receipt = await model.materialize.materialize({
          materializationId: commandUuid(execution, "model.option.materialize"),
          idempotencyKey: commandKey(execution, "model.option.materialize"),
          requestDigest: execution.configDigest,
          inventoryDigest: execution.recipe.inventory.digest,
          options: [execution.recipe.modelOption],
        }, maker(execution, "model.option.materialize"));
        if (receipt.optionRevisionRefs.length !== 1 || receipt.optionRevisionRefs[0] === undefined) {
          throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_MODEL_OPTION_READBACK_INVALID");
        }
        return receipt.optionRevisionRefs[0];
      },
      publishSiteCatalog: async (execution: CoreSingleSiteBootstrapExecution) => {
        const receipt = await model.publishSiteRelease.publish({
          publicationId: commandUuid(execution, "model.site-release-catalog.publish"),
          idempotencyKey: commandKey(execution, "model.site-release-catalog.publish"),
          requestDigest: execution.configDigest,
          siteId: execution.document.site.siteId,
          siteReleaseRef: execution.document.site.siteReleaseRef,
          inventoryDigest: execution.recipe.inventory.digest,
          surfaces: [{
            surfaceId: "chat",
            allowedModelOptionRevisionRefs: [execution.recipe.modelOptionRevisionRef],
            defaultModelOptionRevisionRef: execution.recipe.modelOptionRevisionRef,
          }],
        }, maker(execution, "model.site-release-catalog.publish"));
        return receipt.modelOptionCatalogRef;
      },
    }),
    admission: Object.freeze({
      publishLaunchProfile: async (execution: CoreSingleSiteBootstrapExecution) => {
        await admission.publish({
          siteId: execution.document.site.siteId,
          siteReleaseRef: execution.document.site.siteReleaseRef,
          snapshot: execution.recipe.launchProfile,
        }, maker(execution, "admission.launch-profile.publish"));
      },
    }),
    identity: Object.freeze({
      bootstrapVerifiedPersonal: async (execution: CoreSingleSiteBootstrapExecution) => {
        const value = execution.document.identity;
        await identity.bootstrap({
          commandId: commandUuid(execution, "identity.bootstrap-verified-personal-account"),
          idempotencyKey: commandKey(execution, "identity.bootstrap-verified-personal-account"),
          requestDigest: execution.configDigest,
          siteRef: execution.document.site.siteId,
          email: value.email,
          password: input.password,
          displayName: "Core Owner",
          accountRef: value.accountRef,
          subjectRef: value.subjectRef,
          workspaceRef: value.workspaceRef,
          projectRef: value.projectRef,
          billingAccountRef: value.billingAccountRef,
          executionSpaceRef: value.executionSpaceRef,
          executionNamespace: value.executionNamespace,
          verificationTransactionRef: commandUuid(execution, "identity.verification"),
          namespaceIntentRef: commandUuid(execution, "identity.namespace-intent"),
          namespaceEventId: commandUuid(execution, "identity.namespace-event"),
        }, maker(execution, "identity.bootstrap-verified-personal-account"));
      },
      runOutboxCycle: async () => {
        await identityRuntime.runOneCycle({ signal: new AbortController().signal });
      },
    }),
    rating: Object.freeze({
      publishPolicy: async (execution: CoreSingleSiteBootstrapExecution) => {
        await rating.publish({
          siteId: execution.document.site.siteId,
          policy: execution.recipe.ratingPolicy,
        }, maker(execution, "credit.rating-policy.publish"));
      },
    }),
    commerce: Object.freeze({
      publishCreditProgram: async (execution: CoreSingleSiteBootstrapExecution) => {
        await commerce.commerce.publishCreditProgramRevision({
          context: maker(execution, "commerce.credit-program.publish"),
          commandId: commandUuid(execution, "commerce.credit-program.publish"),
          idempotencyKey: commandKey(execution, "commerce.credit-program.publish"),
          requestDigest: execution.configDigest,
          ...coreCreditProgramPublication(execution),
        });
      },
      publishOffer: async (execution: CoreSingleSiteBootstrapExecution) => {
        await commerce.commerce.publishOffer({
          context: maker(execution, "commerce.offer.publish"),
          commandId: commandUuid(execution, "commerce.offer.publish"),
          idempotencyKey: commandKey(execution, "commerce.offer.publish"),
          requestDigest: execution.configDigest,
          ...coreOfferPublication(execution),
        });
      },
      publishRedemptionProgram: async (execution: CoreSingleSiteBootstrapExecution) => {
        await commerce.commerce.publishProgram({
          context: maker(execution, "commerce.redemption-program.publish"),
          commandId: commandUuid(execution, "commerce.redemption-program.publish"),
          idempotencyKey: commandKey(execution, "commerce.redemption-program.publish"),
          requestDigest: execution.configDigest,
          ...coreRedemptionProgramPublication(execution),
        });
      },
      issueCodeBatch: async (execution: CoreSingleSiteBootstrapExecution) => {
        const result = await commerce.commerce.issueBatch({
          context: maker(execution, "commerce.code-batch.issue"),
          commandId: commandUuid(execution, "commerce.code-batch.issue"),
          idempotencyKey: commandKey(execution, "commerce.code-batch.issue"),
          requestDigest: execution.configDigest,
          siteId: execution.document.site.siteId,
          batchRef: execution.document.redemption.batchRef,
          redemptionProgramRevisionRef: execution.document.redemption.programRevisionRef,
          count: 1,
          startsAt: null,
          endsAt: null,
        });
        return result.kind === "secret_export" ? result.codes[0] ?? null : null;
      },
      approveCodeBatch: async (execution: CoreSingleSiteBootstrapExecution) => {
        await commerce.commerce.approveBatch({
          context: checker(execution, "commerce.code-batch.approve"),
          commandId: commandUuid(execution, "commerce.code-batch.approve"),
          idempotencyKey: commandKey(execution, "commerce.code-batch.approve"),
          requestDigest: execution.configDigest,
          siteId: execution.document.site.siteId,
          batchRef: execution.document.redemption.batchRef,
        });
      },
      activateCodeBatch: async (execution: CoreSingleSiteBootstrapExecution) => {
        await commerce.commerce.activateBatch({
          context: checker(execution, "commerce.code-batch.activate"),
          commandId: commandUuid(execution, "commerce.code-batch.activate"),
          idempotencyKey: commandKey(execution, "commerce.code-batch.activate"),
          requestDigest: execution.configDigest,
          siteId: execution.document.site.siteId,
          batchRef: execution.document.redemption.batchRef,
        });
      },
      reconstructCode: (
        execution: CoreSingleSiteBootstrapExecution,
        persisted: CoreSingleSiteBootstrapPersistedCodeIdentity,
      ) => {
        const recovered = commerce.codes.issueCode(
          execution.document.site.siteId,
          execution.document.redemption.batchRef,
          persisted.keyRevision,
        );
        return Object.freeze({
          code: recovered.code,
          safeFingerprint: recovered.safeFingerprint,
          keyRevision: recovered.keyRevision,
          batchSelector: recovered.batchSelector,
          lookupDigest: recovered.lookupDigest,
        });
      },
    }),
    readback: createProductionReadback(adminUnitOfWork),
  });
}

export function deriveCoreSingleSiteBootstrapModelArtifacts(input: Readonly<{
  siteId: string;
  siteReleaseRef: string;
  publishedAt: string;
  inventoryRef: string;
  modelKey: string;
  modelOptionKey: string;
}>) {
  const publishedAt = canonicalInstant(input.publishedAt);
  const inventory = canonicalizeModelInventory({
    schemaVersion: 1,
    source: { kind: "platform-native", reference: input.inventoryRef },
    providers: [{
      key: DIRECT_MODEL_PROVIDER_IDENTITY.providerKey,
      provider: DIRECT_MODEL_PROVIDER_IDENTITY.provider,
      accountKey: DIRECT_MODEL_PROVIDER_IDENTITY.accountKey,
      secretRef: DIRECT_MODEL_PROVIDER_SECRET_REF,
      adapterKind: "direct",
      priority: 0,
    }],
    models: [{
      key: input.modelKey,
      displayName: "Chat",
      inputModalities: ["text"],
      outputModalities: ["text"],
      capabilities: ["chat"],
      contextWindow: null,
      enabled: true,
    }],
    bindings: [{
      key: `binding:${input.modelKey}`,
      modelKey: input.modelKey,
      providerKey: DIRECT_MODEL_PROVIDER_IDENTITY.providerKey,
      upstreamModel: input.modelKey,
      gatewayModelName: input.modelKey,
      priority: 0,
      enabled: true,
    }],
    productRoutes: [{
      product: "chat",
      role: "main",
      modelKey: input.modelKey,
      position: 0,
      requiredCapabilities: ["chat"],
    }],
  });
  const selection = Object.freeze({
    primaryModelKey: input.modelKey,
    fallbackModelKeys: Object.freeze([] as string[]),
  });
  const modelOption = Object.freeze({
    schemaVersion: 1 as const,
    optionKey: input.modelOptionKey,
    surface: "chat" as const,
    label: "Chat",
    description: null,
    tier: null,
    lifecycle: "active" as const,
    composition: Object.freeze({ orchestration: selection, generation: selection }),
  });
  const materialized = materializeModelOptionDraftSet({
    inventory,
    draftSet: { schemaVersion: 1, inventoryDigest: inventory.digest, options: [modelOption] },
  });
  const modelOptionRevisionRef = materialized.optionRevisions[0]?.modelOptionRevisionRef;
  if (modelOptionRevisionRef === undefined) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_MODEL_OPTION_REF_INVALID");
  }
  const catalog = createSiteReleaseModelCatalogRevision({
    siteId: input.siteId,
    siteReleaseRef: input.siteReleaseRef,
    inventoryDigest: inventory.digest,
    publishedAt,
    surfaces: [{
      surfaceId: "chat",
      allowedModelOptionRevisionRefs: [modelOptionRevisionRef],
      defaultModelOptionRevisionRef: modelOptionRevisionRef,
    }],
    optionRevisions: materialized.optionRevisions,
  });
  return deepFreeze({
    inventory,
    modelOption,
    modelOptionRevisionRef,
    modelOptionCatalogRef: catalog.modelOptionCatalogRef,
  });
}

export function createCoreSingleSiteBootstrapRecipe(
  document: CoreSingleSiteBootstrapDocument,
): CoreSingleSiteBootstrapRecipe {
  const publishedAt = canonicalInstant(document.site.releaseCertification.issuedAt);
  if (document.model.provider !== "direct" || document.model.providerKey !== "direct") {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_DIRECT_PROVIDER_REQUIRED");
  }
  if (document.externalEmptyAgentCatalogRef !==
      CORE_SINGLE_SITE_BOOTSTRAP_EMPTY_AGENT_CATALOG_REF) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_EMPTY_AGENT_CATALOG_INVALID");
  }
  const model = deriveCoreSingleSiteBootstrapModelArtifacts({
    siteId: document.site.siteId,
    siteReleaseRef: document.site.siteReleaseRef,
    publishedAt,
    inventoryRef: document.model.inventoryRef,
    modelKey: document.model.modelKey,
    modelOptionKey: document.model.modelOptionKey,
  });
  if (model.modelOptionRevisionRef !== document.model.optionRevisionRef) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_MODEL_OPTION_REF_MISMATCH");
  }
  if (model.modelOptionCatalogRef !== document.model.catalogRef) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_MODEL_CATALOG_REF_MISMATCH");
  }
  const { inventory, modelOption, modelOptionRevisionRef, modelOptionCatalogRef } = model;
  const launchProfileInput: AdmissionLaunchProfileSnapshot = {
    schemaVersion: 1 as const,
    siteId: document.site.siteId,
    siteReleaseRef: document.site.siteReleaseRef,
    backend: "state" as const,
    permissions: {
      approval_tools: [],
      review_tools: [],
      subagent_create: "deny" as const,
      filesystem: "read_only" as const,
    },
    billing: {
      unit: document.rating.unit,
      liabilityMerchantAccountRef: document.redemption.liabilityMerchantAccountRef,
      ratingPolicyRevisionRef: document.rating.policyRevisionRef,
      rootCeiling: document.redemption.amount,
      segmentMaximum: document.redemption.amount,
      surfaceRef: "chat",
      capabilityKey: "model.chat",
    },
  };
  const launchPublication = defineAdmissionLaunchProfilePublication({
    siteId: document.site.siteId,
    siteReleaseRef: document.site.siteReleaseRef,
    snapshot: launchProfileInput,
    publishedAt,
  });
  const launchProfile = launchPublication.snapshot;
  const launchProfileRef = launchPublication.launchProfileRef;
  const siteRelease = Object.freeze({
    releaseRef: document.site.siteReleaseRef,
    siteRef: document.site.siteId,
    webArtifactDigest: document.site.webArtifactDigest,
    releaseManifestDigest: document.site.releaseManifestDigest,
    certificationDigest: document.site.certificationDigest,
    launchProfileRef,
    siteConfigRevisionRef: "site-config:core-single-site-v1",
    legalRevisionRef: "legal:core-single-site-v1",
    featurePolicyRevision: "feature-policy:core-single-site-v1",
    modelOptionCatalogRef,
    agentCatalogRef: document.externalEmptyAgentCatalogRef,
    identityIssuerLabel: "Kokoro",
    identityAuthStrengthPolicyRevision: "password-v1",
    enabledSurfaceIds: CORE_SINGLE_SITE_SURFACES,
    localePolicy: Object.freeze({
      defaultLocale: "en-US",
      allowedLocales: Object.freeze(["en-US"]),
    }),
  });
  const ratingPolicy = Object.freeze({
    ratingPolicyRevisionRef: document.rating.policyRevisionRef,
    customerUnit: document.rating.unit,
    chargeableAttemptOutcomes: Object.freeze(["succeeded", "failed_after_effect"] as const),
    minimumAmount: 0n,
    rules: Object.freeze([
      Object.freeze({ dimensionKey: "input_tokens", sourceUnit: "token", quantum: 1n,
        amountPerQuantum: BigInt(document.rating.inputTokenAmount), required: true }),
      Object.freeze({ dimensionKey: "output_tokens", sourceUnit: "token", quantum: 1n,
        amountPerQuantum: BigInt(document.rating.outputTokenAmount), required: true }),
    ]),
  });
  const activationFactsDigest = `sha256:${sha256(stableJson({
    siteId: document.site.siteId,
    siteReleaseRef: document.site.siteReleaseRef,
    siteProjectBindingRef: document.site.siteProjectBindingRef,
    workloadBindingEpoch: document.site.workloadBindingEpoch,
    webArtifactDigest: document.site.webArtifactDigest,
    releaseManifestDigest: document.site.releaseManifestDigest,
    certificationDigest: document.site.certificationDigest,
    modelOptionCatalogRef: document.model.catalogRef,
    agentCatalogRef: document.externalEmptyAgentCatalogRef,
  }))}`;
  return deepFreeze({
    inventory,
    modelOption,
    modelOptionRevisionRef,
    modelOptionCatalogRef,
    launchProfile,
    launchProfileRef,
    siteRelease,
    ratingPolicy,
    activation: {
      approvalRef: coreBootstrapUuid(document.bootstrapId, "site.activation.approval"),
      attemptRef: coreBootstrapUuid(document.bootstrapId, "site.activation.attempt"),
      activationFactsDigest,
      reason: "activate certified core Site release",
    },
  });
}

export async function prepareCoreSingleSiteBootstrapExecution(input: Readonly<{
  document: CoreSingleSiteBootstrapDocument;
  secretDigests: CoreBootstrapSecretDigests;
  makerAttestations: CoreBootstrapAdminAttestationBundle;
  makerPublicKey: Parameters<typeof verifyCoreBootstrapAdminAttestation>[0]["publicKey"];
  checkerAttestations: CoreBootstrapAdminAttestationBundle;
  checkerPublicKey: Parameters<typeof verifyCoreBootstrapAdminAttestation>[0]["publicKey"];
  certificationAuthority: SiteReleaseCertificationAuthority;
  now: string;
  environment: Readonly<Record<string, string | undefined>>;
}>): Promise<CoreSingleSiteBootstrapExecution> {
  const now = canonicalInstant(input.now);
  assertCoreSingleSiteBootstrapRuntimeConfiguration(input.document, input.environment);
  if (adminPublicKeyFingerprint(input.makerPublicKey) ===
      adminPublicKeyFingerprint(input.checkerPublicKey)) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_ATTESTATION_KEYS_NOT_DISTINCT");
  }
  const recipe = createCoreSingleSiteBootstrapRecipe(input.document);
  coreSingleSiteBootstrapExpectedOwnerFacts({ document: input.document, recipe });
  await verifyCertification(input.document, recipe, input.certificationAuthority, now);
  const [maker, checker] = await Promise.all([
    verifyBundle({
      bundle: input.makerAttestations,
      operations: CORE_SINGLE_SITE_BOOTSTRAP_MAKER_OPERATIONS,
      publicKey: input.makerPublicKey,
      operatorRef: input.document.makerSubjectRef,
      document: input.document,
      now,
    }),
    verifyBundle({
      bundle: input.checkerAttestations,
      operations: CORE_SINGLE_SITE_BOOTSTRAP_CHECKER_OPERATIONS,
      publicKey: input.checkerPublicKey,
      operatorRef: input.document.checkerSubjectRef,
      document: input.document,
      now,
    }),
  ]);
  return deepFreeze({
    document: input.document,
    secretDigests: input.secretDigests,
    configDigest: coreBootstrapConfigDigest(input.document, input.secretDigests),
    recipe,
    authorization: {
      maker: maker as Readonly<Record<MakerOperation, VerifiedRequestSecurityContext>>,
      checker: checker as Readonly<Record<CheckerOperation, VerifiedRequestSecurityContext>>,
    },
  });
}

export function assertCoreSingleSiteBootstrapRuntimeConfiguration(
  document: CoreSingleSiteBootstrapDocument,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const directEndpoint = environment.PLATFORM_MODEL_GATEWAY_DIRECT_ENDPOINT;
  if (directEndpoint === undefined ||
      canonicalUrl(directEndpoint) !== canonicalUrl(document.model.endpoint)) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_DIRECT_ENDPOINT_MISMATCH");
  }
}

export async function executeCoreSingleSiteBootstrap(
  execution: CoreSingleSiteBootstrapExecution,
  owners: CoreSingleSiteBootstrapOwners,
): Promise<Readonly<{
  result: CoreSingleSiteBootstrapResult;
  redemptionCode: string;
  persisted: CoreSingleSiteBootstrapPersistedCodeIdentity;
}>> {
  try {
    await owners.configuration.claim(execution);
  } catch (error) {
    if (error instanceof Error && ["COMMAND_DIGEST_CONFLICT", "COMMAND_IDENTITY_CONFLICT",
      "COMMAND_OUTCOME_CONFLICT"].includes(error.message)) {
      throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_CONFIGURATION_CONFLICT");
    }
    throw error;
  }
  await owners.site.register(execution);
  await owners.model.importInventory(execution);
  await owners.model.activateInventory(execution);
  const optionRef = await owners.model.materializeOption(execution);
  if (optionRef !== execution.recipe.modelOptionRevisionRef) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_MODEL_OPTION_READBACK_INVALID");
  }
  await owners.site.publishRelease(execution);
  await owners.site.requestActivationApproval(execution);
  const capabilityRef = await owners.capability.ensureEmpty(execution);
  if (capabilityRef !== undefined &&
      capabilityRef !== execution.document.externalEmptyAgentCatalogRef) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_CAPABILITY_CATALOG_MISMATCH");
  }
  await owners.site.approveAndActivate(execution);
  await owners.site.runOutboxCycle(execution);
  const catalogRef = await owners.model.publishSiteCatalog(execution);
  if (catalogRef !== execution.recipe.modelOptionCatalogRef) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_MODEL_CATALOG_READBACK_INVALID");
  }
  await owners.admission.publishLaunchProfile(execution);
  await owners.identity.bootstrapVerifiedPersonal(execution);
  await owners.identity.runOutboxCycle(execution);
  await owners.rating.publishPolicy(execution);
  await owners.commerce.publishCreditProgram(execution);
  await owners.commerce.publishOffer(execution);
  await owners.commerce.publishRedemptionProgram(execution);
  await owners.commerce.issueCodeBatch(execution);
  await owners.commerce.approveCodeBatch(execution);
  await owners.commerce.activateCodeBatch(execution);
  const observed = await owners.readback.assertReady(execution);
  if (observed.code.state !== "available") {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_READBACK_NOT_READY");
  }
  const recovered = await owners.commerce.reconstructCode(execution, observed.code);
  if (!sameCodeIdentity(recovered, observed.code)) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_REDEMPTION_READBACK_INVALID");
  }
  const result = resultFrom(execution, observed);
  await owners.configuration.complete(execution, result);
  return Object.freeze({ result, redemptionCode: recovered.code, persisted: observed.code });
}

export interface CoreSingleSiteBootstrapCompletedRecoveryPort {
  recover(input: Readonly<{
    document: CoreSingleSiteBootstrapDocument;
    recipe: CoreSingleSiteBootstrapRecipe;
    configDigest: string;
  }>): Promise<Readonly<{
    result: CoreSingleSiteBootstrapResult;
    persisted: CoreSingleSiteBootstrapPersistedCodeIdentity;
  }> | null>;
}

export async function recoverCompletedCoreSingleSiteBootstrap(input: Readonly<{
  document: CoreSingleSiteBootstrapDocument;
  secretDigests: CoreBootstrapSecretDigests;
  recovery: CoreSingleSiteBootstrapCompletedRecoveryPort;
  reconstructCode(input: Readonly<{
    document: CoreSingleSiteBootstrapDocument;
    recipe: CoreSingleSiteBootstrapRecipe;
    persisted: CoreSingleSiteBootstrapPersistedCodeIdentity;
  }>): Promise<CoreSingleSiteBootstrapReconstructedCode>;
}>): Promise<Readonly<{
  result: CoreSingleSiteBootstrapResult;
  redemptionCode: string;
  persisted: CoreSingleSiteBootstrapPersistedCodeIdentity;
}> | null> {
  const recipe = createCoreSingleSiteBootstrapRecipe(input.document);
  const configDigest = coreBootstrapConfigDigest(input.document, input.secretDigests);
  const recovered = await input.recovery.recover({ document: input.document, recipe, configDigest });
  if (recovered === null) return null;
  if (recovered.persisted.safeFingerprint !== recovered.result.redemption.safeCodeFingerprint) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_REDEMPTION_READBACK_INVALID");
  }
  const code = await input.reconstructCode({
    document: input.document,
    recipe,
    persisted: recovered.persisted,
  });
  if (!sameCodeIdentity(code, recovered.persisted)) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_REDEMPTION_READBACK_INVALID");
  }
  return Object.freeze({
    result: recovered.result,
    redemptionCode: code.code,
    persisted: recovered.persisted,
  });
}

export function createCoreSingleSiteBootstrapProductionRecovery(
  database: Pick<PlatformTransactionalDatabaseClient, "coreBootstrapRecoveryTransaction">,
): CoreSingleSiteBootstrapCompletedRecoveryPort {
  return Object.freeze({
    recover: (input: Parameters<CoreSingleSiteBootstrapCompletedRecoveryPort["recover"]>[0]) =>
      database.coreBootstrapRecoveryTransaction({
      bootstrapId: input.document.bootstrapId,
      siteRef: input.document.site.siteId,
      makerSubjectRef: input.document.makerSubjectRef,
      environment: input.document.environment,
      region: input.document.region,
    }, async (transaction) => {
      const identity = configurationIdentityFrom(input.document, input.configDigest);
      const receiptRows = await resolvePlatformTransaction(transaction).query<{
        commandId: unknown;
        environment: unknown;
        region: unknown;
        callerIdentity: unknown;
        operation: unknown;
        idempotencyKey: unknown;
        requestDigest: unknown;
        state: unknown;
        result: unknown;
        resultDigest: unknown;
      } & Record<string, unknown>>(
        `SELECT command_id AS "commandId",environment,region,
                caller_identity AS "callerIdentity",operation,
                idempotency_key AS "idempotencyKey",request_digest AS "requestDigest",
                state,result,result_digest AS "resultDigest"
         FROM platform.command_receipt
         WHERE command_id=$1
         LIMIT 2`,
        [identity.commandId],
      );
      const receipt = receiptRows[0];
      if (receipt === undefined) return null;
      if (receiptRows.length !== 1 || !sameConfigurationIdentity(
        receipt as unknown as Pick<CommandReceipt, keyof CommandIdentity>,
        identity,
      )) {
        throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_CONFIGURATION_CONFLICT");
      }
      if (receipt.state === "pending" || receipt.state === "outcome_unknown") return null;
      if (receipt.state !== "succeeded") {
        throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_CONFIGURATION_CONFLICT");
      }
      const observed = await queryProductionReadback(transaction, input);
      const expected = resultFromConfiguration(
        input.document,
        input.recipe,
        input.configDigest,
        observed,
      );
      if (stableJson(receipt.result) !== stableJson(expected) ||
          receipt.resultDigest !== coreSingleSiteBootstrapResultDigest(expected)) {
        throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_COMPLETION_RECEIPT_INVALID");
      }
      return Object.freeze({ result: expected, persisted: observed.code });
    }),
  });
}

function resultFrom(
  execution: CoreSingleSiteBootstrapExecution,
  observed: CoreSingleSiteBootstrapReadback,
): CoreSingleSiteBootstrapResult {
  return resultFromConfiguration(
    execution.document,
    execution.recipe,
    execution.configDigest,
    observed,
  );
}

function resultFromConfiguration(
  document: CoreSingleSiteBootstrapDocument,
  recipe: CoreSingleSiteBootstrapRecipe,
  configDigest: string,
  observed: CoreSingleSiteBootstrapReadback,
): CoreSingleSiteBootstrapResult {
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: "kokoro-core-single-site-bootstrap-result" as const,
    bootstrapId: document.bootstrapId,
    configDigest,
    site: {
      siteId: document.site.siteId,
      siteReleaseRef: document.site.siteReleaseRef,
      webArtifactDigest: document.site.webArtifactDigest,
      deploymentRef: observed.deploymentRef,
      state: "active" as const,
    },
    model: {
      inventoryDigest: recipe.inventory.digest,
      modelOptionRevisionRef: recipe.modelOptionRevisionRef,
      modelOptionCatalogRef: recipe.modelOptionCatalogRef,
    },
    identity: {
      accountRef: document.identity.accountRef,
      subjectRef: document.identity.subjectRef,
      workspaceRef: document.identity.workspaceRef,
      projectRef: document.identity.projectRef,
      billingAccountRef: document.identity.billingAccountRef,
      executionSpaceRef: document.identity.executionSpaceRef,
      executionNamespace: document.identity.executionNamespace,
    },
    ratingPolicyRevisionRef: document.rating.policyRevisionRef,
    agentCatalogRef: document.externalEmptyAgentCatalogRef,
    redemption: {
      creditProgramRevisionRef: document.redemption.creditProgramRevisionRef,
      productVersionRef: document.redemption.productVersionRef,
      fulfillmentProgramRevisionRef: document.redemption.fulfillmentProgramRevisionRef,
      programRevisionRef: document.redemption.programRevisionRef,
      batchRef: document.redemption.batchRef,
      amount: document.redemption.amount,
      unit: document.rating.unit,
      safeCodeFingerprint: observed.code.safeFingerprint,
      state: "active" as const,
    },
  });
}

function createConfigurationGuard(
  unitOfWork: PlatformUnitOfWork,
): CoreSingleSiteBootstrapOwners["configuration"] {
  const receipts = new CommandReceiptRepository();
  return Object.freeze({
    async claim(execution) {
      const context = maker(execution, "core.single-site.bootstrap");
      await unitOfWork.execute({ context, operation: "core.single-site.bootstrap" },
        async (transaction) => {
          const receipt = await beginConfigurationReceipt(
            transaction,
            configurationIdentity(execution),
          );
          if (receipt.state === "failed") {
            throw new Error("COMMAND_OUTCOME_CONFLICT");
          }
        });
    },
    async complete(execution, result) {
      const context = maker(execution, "core.single-site.bootstrap");
      const json = jsonValue(result);
      await unitOfWork.execute({ context, operation: "core.single-site.bootstrap" },
        async (transaction) => {
          await receipts.recordOutcome(transaction, configurationIdentity(execution), {
            state: "succeeded",
            result: json,
            resultDigest: coreSingleSiteBootstrapResultDigest(json),
          });
        });
    },
  });
}

async function beginConfigurationReceipt(
  transaction: PlatformTransaction,
  identity: CommandIdentity,
): Promise<CommandReceipt> {
  const sql = resolvePlatformTransaction(transaction);
  await sql.execute(
    `INSERT INTO platform.command_receipt
     (command_id,environment,region,caller_identity,operation,idempotency_key,request_digest)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING`,
    [identity.commandId, identity.environment, identity.region, identity.callerIdentity,
      identity.operation, identity.idempotencyKey, identity.requestDigest],
  );
  const rows = await sql.query<CommandReceipt & Record<string, unknown>>(
    `SELECT command_id AS "commandId",environment,region,
            caller_identity AS "callerIdentity",operation,
            idempotency_key AS "idempotencyKey",request_digest AS "requestDigest",
            state,result,result_digest AS "resultDigest"
     FROM platform.command_receipt
     WHERE command_id=$1
     LIMIT 2
     FOR UPDATE`,
    [identity.commandId],
  );
  const receipt = rows[0];
  if (rows.length !== 1 || receipt === undefined ||
      !sameConfigurationIdentity(receipt, identity)) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_CONFIGURATION_CONFLICT");
  }
  return receipt;
}

function sameConfigurationIdentity(
  receipt: Pick<CommandReceipt, keyof CommandIdentity>,
  identity: CommandIdentity,
): boolean {
  return receipt.commandId === identity.commandId &&
    receipt.environment === identity.environment &&
    receipt.region === identity.region &&
    receipt.callerIdentity === identity.callerIdentity &&
    receipt.operation === identity.operation &&
    receipt.idempotencyKey === identity.idempotencyKey &&
    receipt.requestDigest === identity.requestDigest;
}

export function coreSingleSiteBootstrapResultDigest(
  value: JsonValue | CoreSingleSiteBootstrapResult,
): string {
  return sha256(stableJson(jsonValue(value)));
}

function configurationIdentity(execution: CoreSingleSiteBootstrapExecution) {
  return configurationIdentityFrom(execution.document, execution.configDigest);
}

function configurationIdentityFrom(
  document: CoreSingleSiteBootstrapDocument,
  configDigest: string,
) {
  return Object.freeze({
    commandId: coreBootstrapUuid(document.bootstrapId, "configuration.guard"),
    environment: document.environment,
    region: document.region,
    callerIdentity: `core-single-site-bootstrap:${document.makerSubjectRef}`,
    operation: "core.single-site.bootstrap",
    idempotencyKey: coreBootstrapIdempotencyKey(document.bootstrapId, "configuration.guard"),
    requestDigest: configDigest,
  });
}

function coreCreditProgramPublication(
  execution: Pick<CoreSingleSiteBootstrapExecution, "document">,
) {
  const value = execution.document.redemption;
  return Object.freeze({
    siteId: execution.document.site.siteId,
    creditProgramRevisionRef: value.creditProgramRevisionRef,
    programRef: `${value.creditProgramRevisionRef}:program`,
    revision: "1",
    uxBucketClass: "permanent" as const,
    unit: execution.document.rating.unit,
    amount: value.amount,
    burnPriority: 100,
    scopePolicy: Object.freeze({
      surfaceRefs: Object.freeze(["chat"]),
      capabilityKeys: Object.freeze(["model.chat"]),
      agentRefs: Object.freeze([] as string[]),
      allowUnattributedAgent: true,
    }),
    liabilityMerchantAccountRef: value.liabilityMerchantAccountRef,
    rolloverPolicy: "none" as const,
    calendarZone: null,
    windowAnchor: null,
    expiresAfterSeconds: null,
  });
}

function coreOfferPublication(
  execution: Pick<CoreSingleSiteBootstrapExecution, "document">,
) {
  const value = execution.document.redemption;
  return Object.freeze({
    siteId: execution.document.site.siteId,
    productRef: `${value.productVersionRef}:product`,
    productKind: "credit_pack" as const,
    productVersionRef: value.productVersionRef,
    productRevision: "1",
    safeLabel: "Core credits",
    planVersion: null,
    fulfillmentProgramRevisionRef: value.fulfillmentProgramRevisionRef,
    fulfillmentProgramRef: `${value.fulfillmentProgramRevisionRef}:program`,
    fulfillmentProgramRevision: "1",
    outputs: Object.freeze([Object.freeze({
      outputLineId: "core-credit-grant",
      ordinal: 1,
      cardinality: 1,
      outputKind: "credit_grant" as const,
      targetRevisionRef: value.creditProgramRevisionRef,
    })]),
    legalTermRefs: Object.freeze([] as string[]),
  });
}

function coreRedemptionProgramPublication(
  execution: Pick<CoreSingleSiteBootstrapExecution, "document">,
) {
  const value = execution.document.redemption;
  return Object.freeze({
    siteId: execution.document.site.siteId,
    redemptionProgramRevisionRef: value.programRevisionRef,
    programRef: `${value.programRevisionRef}:program`,
    revision: "1",
    productVersionRef: value.productVersionRef,
    fulfillmentProgramRevisionRef: value.fulfillmentProgramRevisionRef,
    maxRedemptionsPerAccount: 1,
  });
}

export function coreSingleSiteBootstrapExpectedOwnerFacts(
  execution: Pick<CoreSingleSiteBootstrapExecution, "document" | "recipe">,
) {
  const credit = canonicalCommerceCreditProgramPayload(coreCreditProgramPublication(execution));
  const scopePolicy = credit.scopePolicy;
  const creditProgramRevisionDigest = commerceAdministrationDigest({
    version: 1,
    ...credit,
  });
  const offer = canonicalCommerceOfferPayload(coreOfferPublication(execution));
  const productRevisionDigest = commerceAdministrationDigest({ version: 1, ...offer });
  const fulfillmentOutputPlanDigest = canonicalFulfillmentProgramDigest({
    siteId: execution.document.site.siteId,
    fulfillmentProgramRevisionRef: offer.fulfillmentProgramRevisionRef,
    lines: [{
      outputLineId: "core-credit-grant",
      outputOrdinal: 1,
      occurrenceCount: 1,
      outputKind: "credit_grant",
      owner: {
        kind: "credit_program",
        revisionRef: credit.creditProgramRevisionRef,
        revision: 1n,
        revisionDigest: creditProgramRevisionDigest,
      },
    }],
  });
  const redemption = canonicalCommerceRedemptionProgramPayload(
    coreRedemptionProgramPublication(execution),
  );
  const redemptionProgramDigest = commerceAdministrationDigest({ version: 1, ...redemption });
  const rating = definePublishedRatingPolicyRevision({
    siteId: execution.document.site.siteId,
    policy: execution.recipe.ratingPolicy,
    publishedAt: execution.document.site.releaseCertification.issuedAt,
  });
  return deepFreeze({
    ratingPolicy: rating.policyDocument,
    ratingPolicyDigest: rating.policyDigest,
    creditAmount: credit.amount,
    creditLiabilityMerchantAccountRef: credit.liabilityMerchantAccountRef,
    creditScopePolicy: scopePolicy,
    creditProgramRevisionDigest,
    fulfillmentProgramRevisionRef: offer.fulfillmentProgramRevisionRef,
    fulfillmentOutputPlanDigest,
    productRevisionDigest,
    redemptionProgramDigest,
    siteKey: execution.document.site.siteKey,
    siteProjectBindingRef: execution.document.site.siteProjectBindingRef,
    siteRepositoryRef: `site-repository:fixed:${execution.document.site.siteKey}`,
    providerNamespace: execution.document.site.providerNamespace,
    providerProjectRef: execution.document.site.providerProjectRef,
    workloadIdentityId: execution.document.site.workloadIdentityId,
    releaseManifestDigest: execution.recipe.siteRelease.releaseManifestDigest,
    certificationDigest: execution.recipe.siteRelease.certificationDigest,
    siteConfigRevisionRef: execution.recipe.siteRelease.siteConfigRevisionRef,
    legalRevisionRef: execution.recipe.siteRelease.legalRevisionRef,
    featurePolicyRevision: execution.recipe.siteRelease.featurePolicyRevision,
    identityIssuerLabel: execution.recipe.siteRelease.identityIssuerLabel,
    identityAuthStrengthPolicyRevision:
      execution.recipe.siteRelease.identityAuthStrengthPolicyRevision,
    enabledSurfaceIds: execution.recipe.siteRelease.enabledSurfaceIds,
    localePolicy: execution.recipe.siteRelease.localePolicy,
    audience: execution.document.site.audience,
    sessionContractRevision: execution.document.site.sessionContractRevision,
  });
}

export const CORE_SINGLE_SITE_BOOTSTRAP_READBACK_SQL = `SELECT deployment.deployment_ref AS "deploymentRef",
                    (SELECT code.safe_fingerprint
                     FROM platform.commerce_redeem_code code
                     WHERE code.site_ref=site.site_ref AND code.batch_ref=$10::uuid
                     ORDER BY code.code_ref LIMIT 1) AS "safeCodeFingerprint",
                    (SELECT code.code_lookup_key_revision
                     FROM platform.commerce_redeem_code code
                     WHERE code.site_ref=site.site_ref AND code.batch_ref=$10::uuid
                     ORDER BY code.code_ref LIMIT 1) AS "codeKeyRevision",
                    (SELECT batch.batch_selector
                     FROM platform.commerce_code_batch batch
                     WHERE batch.site_ref=site.site_ref AND batch.batch_ref=$10::uuid
                     LIMIT 1) AS "codeBatchSelector",
                    (SELECT code.lookup_digest
                     FROM platform.commerce_redeem_code code
                     WHERE code.site_ref=site.site_ref AND code.batch_ref=$10::uuid
                     ORDER BY code.code_ref LIMIT 1) AS "codeLookupDigest",
                    (SELECT code.state
                     FROM platform.commerce_redeem_code code
                     WHERE code.site_ref=site.site_ref AND code.batch_ref=$10::uuid
                     ORDER BY code.code_ref LIMIT 1) AS "codeState",
                    (SELECT count(*)::integer FROM platform.commerce_redeem_code code
                     WHERE code.site_ref=site.site_ref AND code.batch_ref=$10::uuid) AS "codeCount",
                    (EXISTS (
                       SELECT 1 FROM platform.model_inventory_import inventory
                       WHERE inventory.source_digest=$4
                     ) AND EXISTS (
                       SELECT 1 FROM platform.model_option_revision option
                       WHERE option.revision_ref=$5 AND option.inventory_digest=$4
                     ) AND platform.core_single_site_bootstrap_model_catalog_ready(
                       site.site_ref,release.release_ref,$6
                     )) AS "modelReady",
                    EXISTS (
                      SELECT 1 FROM platform.admission_launch_profile_snapshot launch
                      WHERE launch.site_ref=site.site_ref AND launch.site_release_ref=release.release_ref
                        AND launch.launch_profile_ref=$7
                    ) AS "launchReady",
                    EXISTS (
                      SELECT 1 FROM platform.admission_capability_catalog_snapshot capability
                      WHERE capability.site_ref=site.site_ref
                        AND capability.site_release_ref=release.release_ref
                        AND capability.agent_catalog_ref=$8
                    ) AS "capabilityReady",
                    platform.core_single_site_bootstrap_identity_ready(
                      site.site_ref,$11::uuid,$12,$13,$14,$15,$16,$17
                    ) AS "identityReady",
                    EXISTS (
                      SELECT 1 FROM platform.credit_rating_policy_revision rating
                      WHERE rating.site_ref=site.site_ref AND rating.rating_policy_revision_ref=$9
                        AND rating.unit=$18 AND rating.state='published'
                        AND rating.policy_digest=($24::jsonb->>'ratingPolicyDigest')
                        AND rating.policy=($24::jsonb->'ratingPolicy')
                    ) AS "ratingReady",
                    EXISTS (
                      SELECT 1
                      FROM platform.commerce_credit_program_revision credit_program
                      JOIN platform.commerce_fulfillment_program_revision fulfillment
                        ON fulfillment.site_ref=credit_program.site_ref
                       AND fulfillment.fulfillment_program_revision_ref=
                           ($24::jsonb->>'fulfillmentProgramRevisionRef')
                      JOIN platform.commerce_fulfillment_program_output output
                        ON output.site_ref=fulfillment.site_ref
                       AND output.fulfillment_program_revision_ref=
                           fulfillment.fulfillment_program_revision_ref
                      JOIN platform.commerce_catalog_product_version product
                        ON product.site_ref=fulfillment.site_ref
                       AND product.product_version_ref=$20
                      JOIN platform.commerce_catalog_product product_owner
                        ON product_owner.site_ref=product.site_ref
                       AND product_owner.product_ref=product.product_ref
                      JOIN platform.commerce_redemption_program_revision program
                        ON program.site_ref=product.site_ref
                       AND program.redemption_program_revision_ref=$21
                      JOIN platform.commerce_redemption_program_availability availability
                        ON availability.site_ref=program.site_ref
                       AND availability.redemption_program_revision_ref=
                           program.redemption_program_revision_ref
                      JOIN platform.commerce_code_batch batch
                        ON batch.site_ref=program.site_ref AND batch.batch_ref=$10::uuid
                      WHERE credit_program.site_ref=site.site_ref
                        AND credit_program.credit_program_revision_ref=$19
                        AND credit_program.program_ref=$19||':program'
                        AND credit_program.revision=1
                        AND credit_program.ux_bucket_class='permanent'
                        AND credit_program.unit=$18
                        AND credit_program.amount=($24::jsonb->>'creditAmount')::numeric
                        AND credit_program.burn_priority=100
                        AND credit_program.scope_policy=($24::jsonb->'creditScopePolicy')
                        AND credit_program.liability_merchant_account_ref=($24::jsonb->>'creditLiabilityMerchantAccountRef')
                        AND credit_program.window_kind='none'
                        AND credit_program.rollover_policy='none'
                        AND credit_program.calendar_zone IS NULL
                        AND credit_program.window_anchor IS NULL
                        AND credit_program.expires_after_seconds IS NULL
                        AND credit_program.revision_digest=($24::jsonb->>'creditProgramRevisionDigest')
                        AND fulfillment.program_ref=
                            ($24::jsonb->>'fulfillmentProgramRevisionRef')||':program'
                        AND fulfillment.revision=1
                        AND fulfillment.output_plan_digest=($24::jsonb->>'fulfillmentOutputPlanDigest')
                        AND output.output_line_id='core-credit-grant'
                        AND output.ordinal=1 AND output.cardinality=1
                        AND output.output_kind='credit_grant'
                        AND output.plan_version_ref IS NULL
                        AND output.entitlement_template_revision_ref IS NULL
                        AND output.credit_program_revision_ref=$19
                        AND output.credit_program_revision_version=credit_program.revision
                        AND output.credit_program_revision_digest=credit_program.revision_digest
                        AND (SELECT count(*)
                             FROM platform.commerce_fulfillment_program_output sibling
                             WHERE sibling.fulfillment_program_revision_ref=
                                   fulfillment.fulfillment_program_revision_ref)=1
                        AND product.product_ref=$20||':product'
                        AND product.revision=1 AND product.safe_label='Core credits'
                        AND product.plan_version_ref IS NULL
                        AND product.fulfillment_program_revision_ref=($24::jsonb->>'fulfillmentProgramRevisionRef')
                        AND product.legal_term_refs=ARRAY[]::text[]
                        AND product.revision_digest=($24::jsonb->>'productRevisionDigest')
                        AND product_owner.kind='credit_pack' AND product_owner.state='active'
                        AND program.program_ref=$21||':program'
                        AND program.revision=1
                        AND program.product_version_ref=$20
                        AND program.fulfillment_program_revision_ref=($24::jsonb->>'fulfillmentProgramRevisionRef')
                        AND program.program_digest=($24::jsonb->>'redemptionProgramDigest')
                        AND program.max_redemptions_per_account=1
                        AND availability.state='active'
                        AND batch.redemption_program_revision_ref=$21
                        AND batch.state='active' AND batch.inventory_count=1
                        AND batch.starts_at IS NULL AND batch.ends_at IS NULL
                    ) AS "commerceReady"
             FROM platform.site site
             JOIN platform.site_release release
               ON release.site_ref=site.site_ref AND release.release_ref=site.active_release_ref
             JOIN platform.site_deployment_binding deployment
               ON deployment.site_ref=site.site_ref AND deployment.release_ref=release.release_ref
              AND deployment.binding_ref=($24::jsonb->>'siteProjectBindingRef')
              AND deployment.state='active' AND deployment.environment=$22 AND deployment.region=$23
              AND deployment.web_artifact_digest=$3
              AND deployment.audience=($24::jsonb->>'audience')
              AND deployment.session_contract_revision=($24::jsonb->>'sessionContractRevision')
              AND deployment.binding_epoch=site.runtime_binding_epoch
             JOIN platform.site_project_binding binding
               ON binding.binding_ref=($24::jsonb->>'siteProjectBindingRef')
              AND binding.binding_ref=deployment.binding_ref
              AND binding.site_ref=site.site_ref
              AND binding.repository_ref=($24::jsonb->>'siteRepositoryRef')
              AND binding.provider_namespace=($24::jsonb->>'providerNamespace')
              AND binding.provider_project_ref=($24::jsonb->>'providerProjectRef')
              AND binding.environment=$22 AND binding.region=$23
              AND binding.workload_identity_id=($24::jsonb->>'workloadIdentityId')
              AND binding.state='active'
             JOIN platform.authorization_site authorization_site
               ON authorization_site.site_ref=site.site_ref
              AND authorization_site.state='active'
              AND authorization_site.security_epoch=site.security_epoch
              AND authorization_site.policy_epoch=site.policy_epoch
              AND authorization_site.revocation_epoch=site.revocation_epoch
             JOIN platform.authorization_site_release authorization_release
               ON authorization_release.release_ref=release.release_ref
              AND authorization_release.site_ref=site.site_ref
              AND authorization_release.state='active'
              AND authorization_release.web_artifact_digest=release.web_artifact_digest
              AND authorization_release.enabled_surface_ids=release.enabled_surface_ids
              AND authorization_release.feature_policy_revision=release.feature_policy_revision
              AND authorization_release.model_option_catalog_ref=release.model_option_catalog_ref
              AND authorization_release.agent_catalog_ref=release.agent_catalog_ref
              AND authorization_release.identity_issuer_label=release.identity_issuer_label
              AND authorization_release.identity_auth_strength_policy_revision=release.identity_auth_strength_policy_revision
              AND authorization_release.locale_policy=release.locale_policy
             JOIN platform.authorization_product_binding authorization_binding
               ON authorization_binding.binding_ref=binding.binding_ref
              AND authorization_binding.workload_identity_id=binding.workload_identity_id
              AND authorization_binding.deployment_ref=deployment.deployment_ref
              AND authorization_binding.site_ref=site.site_ref
              AND authorization_binding.release_ref=release.release_ref
              AND authorization_binding.environment=deployment.environment
              AND authorization_binding.region=deployment.region
              AND authorization_binding.audience=deployment.audience
              AND authorization_binding.session_contract_revision=deployment.session_contract_revision
              AND authorization_binding.binding_epoch=deployment.binding_epoch
              AND authorization_binding.state='active'
             WHERE site.site_ref=$1 AND site.site_key=($24::jsonb->>'siteKey')
               AND site.state='active' AND site.active_release_ref=$2
               AND release.state='active' AND release.web_artifact_digest=$3
               AND release.release_manifest_digest=($24::jsonb->>'releaseManifestDigest')
               AND release.certification_digest=($24::jsonb->>'certificationDigest')
               AND release.launch_profile_ref=$7
               AND release.site_config_revision_ref=($24::jsonb->>'siteConfigRevisionRef')
               AND release.legal_revision_ref=($24::jsonb->>'legalRevisionRef')
               AND release.feature_policy_revision=($24::jsonb->>'featurePolicyRevision')
               AND release.model_option_catalog_ref=$6 AND release.agent_catalog_ref=$8
               AND release.identity_issuer_label=($24::jsonb->>'identityIssuerLabel')
               AND release.identity_auth_strength_policy_revision=($24::jsonb->>'identityAuthStrengthPolicyRevision')
               AND release.enabled_surface_ids=($24::jsonb->'enabledSurfaceIds')
               AND release.locale_policy=($24::jsonb->'localePolicy')
             LIMIT 1`;

export function coreSingleSiteBootstrapReadbackValues(
  execution: Pick<CoreSingleSiteBootstrapExecution, "document" | "recipe">,
): readonly unknown[] {
  const document = execution.document;
  return Object.freeze([
    document.site.siteId,
    document.site.siteReleaseRef,
    document.site.webArtifactDigest,
    execution.recipe.inventory.digest,
    execution.recipe.modelOptionRevisionRef,
    execution.recipe.modelOptionCatalogRef,
    execution.recipe.launchProfileRef,
    document.externalEmptyAgentCatalogRef,
    document.rating.policyRevisionRef,
    document.redemption.batchRef,
    document.identity.accountRef,
    document.identity.subjectRef,
    document.identity.workspaceRef,
    document.identity.projectRef,
    document.identity.billingAccountRef,
    document.identity.executionSpaceRef,
    document.identity.executionNamespace,
    document.rating.unit,
    document.redemption.creditProgramRevisionRef,
    document.redemption.productVersionRef,
    document.redemption.programRevisionRef,
    document.environment,
    document.region,
    JSON.stringify(coreSingleSiteBootstrapExpectedOwnerFacts(execution)),
  ]);
}

function createProductionReadback(
  unitOfWork: PlatformUnitOfWork,
): CoreSingleSiteBootstrapOwners["readback"] {
  return Object.freeze({
    async assertReady(execution) {
      const context = maker(execution, "core.single-site.bootstrap");
      return unitOfWork.execute({ context, operation: "core.single-site.bootstrap" },
        (transaction) => queryProductionReadback(transaction, execution));
    },
  });
}

async function queryProductionReadback(
  transaction: PlatformTransaction,
  execution: Pick<CoreSingleSiteBootstrapExecution, "document" | "recipe">,
): Promise<CoreSingleSiteBootstrapReadback> {
  const sql = resolvePlatformTransaction(transaction);
  const rows = await sql.query<{
    deploymentRef: unknown;
    safeCodeFingerprint: unknown;
    codeKeyRevision: unknown;
    codeBatchSelector: unknown;
    codeLookupDigest: unknown;
    codeState: unknown;
    codeCount: unknown;
    modelReady: unknown;
    launchReady: unknown;
    capabilityReady: unknown;
    identityReady: unknown;
    ratingReady: unknown;
    commerceReady: unknown;
  } & Record<string, unknown>>(
    CORE_SINGLE_SITE_BOOTSTRAP_READBACK_SQL,
    coreSingleSiteBootstrapReadbackValues(execution),
  );
  const row = rows[0];
  if (rows.length !== 1 || row === undefined ||
      typeof row.deploymentRef !== "string" || row.deploymentRef.length < 1 ||
      typeof row.safeCodeFingerprint !== "string" ||
      !/^CODE-[A-Z0-9]{16}$/u.test(row.safeCodeFingerprint) ||
      typeof row.codeKeyRevision !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(row.codeKeyRevision) ||
      typeof row.codeBatchSelector !== "string" ||
      !/^[0-9A-HJKMNP-TV-Z]{10}$/u.test(row.codeBatchSelector) ||
      typeof row.codeLookupDigest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(row.codeLookupDigest) ||
      !["available", "claimed", "void"].includes(String(row.codeState)) ||
      row.codeCount !== 1 || row.modelReady !== true || row.launchReady !== true ||
      row.capabilityReady !== true || row.identityReady !== true ||
      row.ratingReady !== true || row.commerceReady !== true) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_READBACK_NOT_READY");
  }
  return Object.freeze({
    deploymentRef: row.deploymentRef,
    code: Object.freeze({
      safeFingerprint: row.safeCodeFingerprint,
      keyRevision: row.codeKeyRevision,
      batchSelector: row.codeBatchSelector,
      lookupDigest: row.codeLookupDigest,
      state: row.codeState as "available" | "claimed" | "void",
    }),
  });
}

function activationInput(
  execution: Pick<CoreSingleSiteBootstrapExecution, "document" | "recipe">,
) {
  return Object.freeze({
    approvalRef: execution.recipe.activation.approvalRef,
    siteRef: execution.document.site.siteId,
    candidateReleaseRef: execution.document.site.siteReleaseRef,
    expectedActiveReleaseRef: null,
    activationFactsDigest: execution.recipe.activation.activationFactsDigest,
    audience: execution.document.site.audience,
    sessionContractRevision: execution.document.site.sessionContractRevision,
    reason: execution.recipe.activation.reason,
  });
}

function maker(
  execution: CoreSingleSiteBootstrapExecution,
  operation: MakerOperation,
): VerifiedRequestSecurityContext {
  return execution.authorization.maker[operation];
}

function checker(
  execution: CoreSingleSiteBootstrapExecution,
  operation: CheckerOperation,
): VerifiedRequestSecurityContext {
  return execution.authorization.checker[operation];
}

function commandUuid(execution: CoreSingleSiteBootstrapExecution, step: string): string {
  return coreBootstrapUuid(execution.document.bootstrapId, step);
}

function commandKey(execution: CoreSingleSiteBootstrapExecution, step: string): string {
  return coreBootstrapIdempotencyKey(execution.document.bootstrapId, step);
}

function deterministicRedemptionEntropy(
  secret: Uint8Array,
  bootstrapId: string,
  batchRef: string,
): Uint8Array {
  return new Uint8Array(createHmac("sha256", Uint8Array.from(secret))
    .update("kokoro.core-single-site-bootstrap.redemption-entropy.v1", "utf8")
    .update("\0", "utf8")
    .update(bootstrapId, "utf8")
    .update("\0", "utf8")
    .update(batchRef, "utf8")
    .digest().subarray(0, 20));
}

function sameCodeIdentity(
  reconstructed: CoreSingleSiteBootstrapReconstructedCode,
  persisted: CoreSingleSiteBootstrapPersistedCodeIdentity,
): boolean {
  return reconstructed.safeFingerprint === persisted.safeFingerprint &&
    reconstructed.keyRevision === persisted.keyRevision &&
    reconstructed.batchSelector === persisted.batchSelector &&
    reconstructed.lookupDigest === persisted.lookupDigest;
}

async function createCoreSingleSiteBootstrapCommerce(input: Readonly<{
  database: PlatformTransactionalDatabaseClient;
  document: CoreSingleSiteBootstrapDocument;
  redemptionEntropySecret: Uint8Array;
  environment: Readonly<Record<string, string | undefined>>;
}>) {
  const entropy = deterministicRedemptionEntropy(
    input.redemptionEntropySecret,
    input.document.bootstrapId,
    input.document.redemption.batchRef,
  );
  return createCommerceAdministrationComposition({
    database: input.database,
    environment: input.environment,
    entropySource: () => Uint8Array.from(entropy),
  });
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([key, child]) => [key, jsonValue(child)]));
  throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_RESULT_INVALID");
}

async function verifyCertification(
  document: CoreSingleSiteBootstrapDocument,
  recipe: CoreSingleSiteBootstrapRecipe,
  authority: SiteReleaseCertificationAuthority,
  now: string,
): Promise<void> {
  const proof = document.site.releaseCertification;
  if (Date.parse(proof.issuedAt) > Date.parse(now) || Date.parse(proof.expiresAt) <= Date.parse(now)) {
    throw new Error("SITE_RELEASE_CERTIFICATION_EXPIRED");
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(proof.signature, "base64url");
    if (signature.byteLength !== 64 || signature.toString("base64url") !== proof.signature) throw new Error();
  } catch {
    throw new Error("SITE_RELEASE_CERTIFICATION_SIGNATURE_INVALID");
  }
  await authority.verify({
    ...recipe.siteRelease,
    proof: {
      signingKeyRef: proof.signingKeyRef,
      issuedAt: proof.issuedAt,
      expiresAt: proof.expiresAt,
      signature,
    },
  });
}

async function verifyBundle<Operation extends string>(input: Readonly<{
  bundle: CoreBootstrapAdminAttestationBundle;
  operations: readonly Operation[];
  publicKey: Parameters<typeof verifyCoreBootstrapAdminAttestation>[0]["publicKey"];
  operatorRef: string;
  document: CoreSingleSiteBootstrapDocument;
  now: string;
}>): Promise<Readonly<Record<Operation, VerifiedRequestSecurityContext>>> {
  if (input.bundle.version !== 1 || input.bundle.attestations.length !== input.operations.length) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_ATTESTATION_SET_INVALID");
  }
  const byOperation = new Map(input.bundle.attestations.map((item) => [item.operation, item]));
  if (byOperation.size !== input.operations.length ||
      input.bundle.attestations.some(({ operation }) =>
        !(input.operations as readonly string[]).includes(operation))) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_ATTESTATION_SET_INVALID");
  }
  const entries = await Promise.all(input.operations.map(async (operation) => {
    const item = byOperation.get(operation);
    if (item === undefined) throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_ATTESTATION_SET_INVALID");
    const target = coreSingleSiteBootstrapAttestationTarget(operation, input.document);
    const allowedOperations = coreSingleSiteBootstrapAttestationAllowedOperations(operation);
    let verified: VerifiedRequestSecurityContext;
    try {
      verified = await verifyCoreBootstrapAdminAttestation({
        envelope: item.envelope,
        publicKey: input.publicKey,
        operation,
        operatorRef: input.operatorRef,
        now: input.now,
        audience: ADMIN_AUDIENCE,
        environment: input.document.environment,
        region: input.document.region,
        allowedOperations,
        target,
      });
    } catch {
      throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_ATTESTATION_INVALID");
    }
    return [operation, verified] as const;
  }));
  return Object.freeze(Object.fromEntries(entries)) as Readonly<
    Record<Operation, VerifiedRequestSecurityContext>
  >;
}

export function coreSingleSiteBootstrapAttestationAllowedOperations(
  operation: string,
): readonly string[] {
  return Object.freeze(operation === "site.activation.begin"
    ? ["site.approval.approve", "site.activation.begin"] : [operation]);
}

export function coreSingleSiteBootstrapAttestationTarget(
  operation: string,
  document: CoreSingleSiteBootstrapDocument,
): Readonly<{ siteId: string | null; purpose: string; scopes: readonly string[] }> {
  const global = ["model.inventory.import", "model.inventory.activate", "model.option.materialize"]
    .includes(operation);
  if (global) return Object.freeze({
    siteId: null,
    purpose: "model_control_administration",
    scopes: Object.freeze([operation]),
  });
  if (operation === "model.site-release-catalog.publish") return Object.freeze({
    siteId: document.site.siteId,
    purpose: "site_release",
    scopes: Object.freeze(["model:site-release:publish"]),
  });
  return Object.freeze({
    siteId: document.site.siteId,
    purpose: operation,
    scopes: Object.freeze([operation]),
  });
}

function canonicalInstant(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_TIME_INVALID");
  }
  return value;
}

function adminPublicKeyFingerprint(key: Parameters<
  typeof verifyCoreBootstrapAdminAttestation
>[0]["publicKey"]): string {
  try {
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error();
    return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
  } catch {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_ATTESTATION_KEY_INVALID");
  }
}

function assertHubPublication(
  response: Awaited<ReturnType<HubCapabilityCatalogClient["freezeCatalog"]>>,
  execution: CoreSingleSiteBootstrapExecution,
  command: Readonly<{
    commandId: string;
    idempotencyKey: string;
    digestAlgorithm: CommandDigestAlgorithm;
    requestDigest: string;
  }>,
): void {
  const publication = response.publication;
  const receipt = response.receipt;
  if (publication === undefined ||
      publication.siteId !== execution.document.site.siteId ||
      publication.siteReleaseRef !== execution.document.site.siteReleaseRef ||
      publication.agentCatalogRef !== execution.document.externalEmptyAgentCatalogRef ||
      receipt?.state !== CommandReceiptState.COMMITTED ||
      receipt.operation !== "capability_catalog.freeze" ||
      receipt.identity?.commandId !== command.commandId ||
      receipt.identity.idempotencyKey !== command.idempotencyKey ||
      receipt.identity.digestAlgorithm !== command.digestAlgorithm ||
      receipt.identity.requestDigest !== command.requestDigest ||
      response.projectionState === CatalogProjectionState.REJECTED ||
      response.projectionState === CatalogProjectionState.OUTCOME_UNKNOWN ||
      response.projectionState === CatalogProjectionState.UNSPECIFIED) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_CAPABILITY_PUBLICATION_INVALID");
  }
}

function requiredEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name}_REQUIRED`);
  }
  return value;
}

function optionalEnvironmentInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = environment[name];
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name}_INVALID`);
  return boundedInteger(Number(value), minimum, maximum, `${name}_INVALID`);
}

function wireHubPublicationResponse(response: Readonly<{
  publication?: Readonly<{ agentCatalogRef: string; siteId: string; siteReleaseRef: string }> | undefined;
  projectionState: CatalogProjectionState;
  receipt?: HubCapabilityCatalogReceipt | undefined;
}>): Readonly<{
  publication?: Readonly<{ agentCatalogRef: string; siteId: string; siteReleaseRef: string }>;
  projectionState: CatalogProjectionState;
  receipt?: HubCapabilityCatalogReceipt;
}> {
  return Object.freeze({
    ...(response.publication === undefined ? {} : {
      publication: Object.freeze({
        agentCatalogRef: response.publication.agentCatalogRef,
        siteId: response.publication.siteId,
        siteReleaseRef: response.publication.siteReleaseRef,
      }),
    }),
    projectionState: response.projectionState,
    ...(response.receipt === undefined ? {} : {
      receipt: Object.freeze({
        ...(response.receipt.identity === undefined ? {} : {
          identity: Object.freeze({
            commandId: response.receipt.identity.commandId,
            idempotencyKey: response.receipt.identity.idempotencyKey,
            digestAlgorithm: response.receipt.identity.digestAlgorithm,
            requestDigest: response.receipt.identity.requestDigest,
          }),
        }),
        operation: response.receipt.operation,
        state: response.receipt.state,
      }),
    }),
  });
}

function boundedInteger(value: number, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(code);
  return value;
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
        url.search !== "" || url.hash !== "") throw new Error();
    return url.href;
  } catch {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_DIRECT_ENDPOINT_MISMATCH");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
