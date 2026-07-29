import { open, readFile } from "node:fs/promises";
import { constants as fileSystemConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { generateSecret } from "otplib";
import { createServer as createHttpsServer, type ServerOptions } from "node:https";
import type { RequestListener, Server } from "node:http";
import type { PlatformTransactionalDatabaseClient } from "../infrastructure/postgres/client.js";
import type { ModelOptionCatalogReadPort } from "../modules/authorization/application/contracts/session-authorization-ports.js";
import { ExchangeProductContextService } from "../modules/authorization/application/services/exchange-product-context.js";
import { GetPersonalContextService } from "../modules/authorization/application/services/get-personal-context.js";
import { IssueSessionAccessGrantService } from "../modules/authorization/application/services/issue-session-access-grant.js";
import {
  createSessionAccessGrantSigner,
  type SessionAccessKeyRingConfig,
  type SessionAccessSigningKeyConfig,
} from "../modules/authorization/infrastructure/jose/session-access-grant-signer.js";
import { PostgresSessionAuthorizationRepository } from "../modules/authorization/infrastructure/postgres/session-authorization-repository.js";
import { PostgresAuthorizationFeedRepository } from "../modules/authorization/infrastructure/postgres/authorization-feed-repository.js";
import { SignedSessionAuthorizationPublisher } from "../modules/authorization/infrastructure/postgres/signed-session-authorization-publisher.js";
import { createSessionAuthorizationEventSigner } from "../modules/authorization/infrastructure/jose/session-authorization-event-signer.js";
import type {
  AuthorizationEventKeyRingConfig,
  AuthorizationEventSigningKeyConfig,
} from "../modules/authorization/infrastructure/jose/session-authorization-event-signer.js";
import { PostgresProductModelOptionCatalogReader } from "../modules/model-control/infrastructure/postgres/product-model-option-repository.js";
import { loadProductWorkloadRegistry } from "../modules/authorization/infrastructure/transport/product-workload-registry.js";
import { PlatformUnitOfWork } from "../shared/unit-of-work/unit-of-work.js";
import {
  createPlatformPublicHttpHandler,
  type PlatformPublicHttpHandler,
} from "../interfaces/http/platform-public.js";
import {
  createAuthorizationPublicOperations,
  AUTHORIZATION_PUBLIC_OPERATION_IDS,
} from "../modules/authorization/interfaces/http/authorization-public-operations.js";
import {
  createIdentityPublicOperations,
  IDENTITY_LAUNCH_OPERATION_IDS,
} from "../modules/identity/interfaces/http/identity-public-operations.js";
import { IdentityApplicationService } from "../modules/identity/application/services/identity-application-service.js";
import { IdentitySessionAuthorizationMutation } from "../modules/identity/application/services/identity-session-authorization-mutation.js";
import { SubjectAuthorizationMutation } from "../modules/identity/application/services/subject-authorization-mutation.js";
import { PostgresIdentityRepository } from "../modules/identity/infrastructure/postgres/identity-repository.js";
import { createIdentityPasswordHasher } from "../modules/identity/infrastructure/crypto/identity-password-hasher.js";
import { createOpaqueCredentialCodec } from "../modules/identity/infrastructure/crypto/opaque-credential.js";
import { createIdentityAuditDigester } from "../modules/identity/infrastructure/crypto/identity-audit-digester.js";
import { createVerificationEnvelopeSealer } from "../modules/identity/infrastructure/crypto/verification-envelope-sealer.js";
import { createIdentityTotpVerifier } from "../modules/identity/infrastructure/crypto/identity-totp-verifier.js";
import { createIdentityTotpSecretProtector } from "../modules/identity/infrastructure/crypto/identity-totp-secret-protector.js";
import { IdentitySecurityManagementService } from "../modules/identity/application/services/identity-security-management-service.js";
import { PostgresIdentitySecurityManagementRepository } from "../modules/identity/infrastructure/postgres/identity-security-management-repository.js";
import {
  createIdentityRecoveryCodeIssuer,
  createIdentityTotpEnrollmentIssuer,
} from "../modules/identity/infrastructure/crypto/identity-security-credential-issuer.js";
import { PostgresScopedAuthorizationFeedRepository } from "../modules/authorization/infrastructure/postgres/scoped-authorization-feed-repository.js";
import { SignedScopedSessionAuthorizationPublisher } from "../modules/authorization/infrastructure/postgres/signed-scoped-session-authorization-publisher.js";
import { CommandReceiptRepository } from "../shared/outbox-inbox/receipt.js";
import { OutboxRepository } from "../shared/outbox-inbox/outbox.js";
import { createRedemptionSecretCodec } from "../modules/commerce/infrastructure/crypto/redemption-secret-codec.js";
import { PostgresRedemptionRepository } from "../modules/commerce/infrastructure/postgres/redemption-repository.js";
import { PostgresCommerceRepository } from "../modules/commerce/infrastructure/postgres/repository.js";
import { CommerceCommandFence } from "../modules/commerce/application/command-fence.js";
import { PreviewRedemptionService } from "../modules/commerce/application/services/preview-redemption.js";
import { authorizeCommerceCommand } from "../workflows/commerce/authorize-command.js";
import { createCommercePublicOperations, COMMERCE_PUBLIC_OPERATION_IDS } from "../modules/commerce/interfaces/http/commerce-public-operations.js";
import { RedemptionQueryService } from "../modules/commerce/application/services/redemption-query.js";
import { ConfirmRedemptionService } from "../modules/commerce/application/services/confirm-redemption.js";
import { PostgresRedemptionConfirmationRepository } from "../modules/commerce/infrastructure/postgres/redemption-confirmation-repository.js";
import { AccountReadService } from "../modules/commerce/application/services/account-read.js";
import { PostgresAccountReadRepository } from "../modules/commerce/infrastructure/postgres/account-read-repository.js";

export interface PlatformPublicProductionComposition {
  readonly handler: PlatformPublicHttpHandler;
  readonly secure: true;
  createServer(listener: RequestListener): Server;
}

export async function createPlatformPublicProductionComposition(
  input: Readonly<{
    database: PlatformTransactionalDatabaseClient;
    modelOptions?: ModelOptionCatalogReadPort;
    environment?: Readonly<Record<string, string | undefined>>;
  }>,
): Promise<PlatformPublicProductionComposition> {
  const environment = input.environment ?? process.env;
  const [workloads, keyRing, eventKeyRing, tls, redemptionSecrets] = await Promise.all([
    loadProductWorkloadRegistry(required(environment, "PLATFORM_PRODUCT_WORKLOAD_REGISTRY_FILE")),
    loadSessionAccessKeyRing(required(environment, "PLATFORM_SESSION_ACCESS_KEY_RING_FILE")),
    loadAuthorizationEventKeyRing(
      required(environment, "PLATFORM_AUTHORIZATION_EVENT_KEY_RING_FILE"),
    ),
    loadTls(environment),
    loadRedemptionSecretCodec(required(environment, "PLATFORM_COMMERCE_REDEMPTION_KEY_RING_FILE")),
  ]);
  const signer = await createSessionAccessGrantSigner(keyRing);
  const eventSigner = await createSessionAuthorizationEventSigner(eventKeyRing);
  const unitOfWork = new PlatformUnitOfWork(input.database);
  const repository = new PostgresSessionAuthorizationRepository();
  const modelOptions = input.modelOptions ?? new PostgresProductModelOptionCatalogReader();
  const publisher = new SignedSessionAuthorizationPublisher(
    new PostgresAuthorizationFeedRepository(),
    eventSigner,
  );
  const [
    passwordHasher,
    verificationCredentials,
    sessionCredentials,
    refreshCredentials,
    reauthenticationCredentials,
    auditDigest,
    deliverySealer,
    totpSecretProtector,
  ] = await Promise.all([
    loadIdentityPasswordHasher(
      required(environment, "PLATFORM_IDENTITY_PASSWORD_PEPPER_RING_FILE"),
    ),
    loadOpaqueCredentialCodec(
      required(environment, "PLATFORM_IDENTITY_VERIFICATION_DIGEST_KEY_FILE"),
    ),
    loadOpaqueCredentialCodec(required(environment, "PLATFORM_IDENTITY_SESSION_DIGEST_KEY_FILE")),
    loadOpaqueCredentialCodec(required(environment, "PLATFORM_IDENTITY_REFRESH_DIGEST_KEY_FILE")),
    loadOpaqueCredentialCodec(required(environment, "PLATFORM_IDENTITY_REAUTH_DIGEST_KEY_FILE")),
    loadIdentityAuditDigester(required(environment, "PLATFORM_IDENTITY_AUDIT_DIGEST_KEY_FILE")),
    loadVerificationDeliverySealer(required(environment, "PLATFORM_IDENTITY_DELIVERY_KEY_FILE")),
    loadIdentityTotpSecretProtector(required(environment, "PLATFORM_IDENTITY_TOTP_KEY_RING_FILE")),
  ]);
  const scopedPublisher = new SignedScopedSessionAuthorizationPublisher(
    new PostgresScopedAuthorizationFeedRepository(),
    eventSigner,
  );
  const identityRepository = new PostgresIdentityRepository();
  const dummyPasswordHash = await passwordHasher.hash(`dummy-${randomUUID()}-${randomUUID()}`);
  const identity = new IdentityApplicationService({
    unitOfWork,
    repository: identityRepository,
    receipts: new CommandReceiptRepository(),
    outbox: new OutboxRepository(),
    passwordHasher,
    dummyPasswordHash,
    verificationCredentials,
    sessionCredentials,
    refreshCredentials,
    totpSecretProtector,
    totpVerifier: createIdentityTotpVerifier(),
    dummyTotpSecret: generateSecret(),
    auditDigest,
    deliverySealer,
    subjectAuthorization: new SubjectAuthorizationMutation(scopedPublisher),
    sessionAuthorization: new IdentitySessionAuthorizationMutation(scopedPublisher),
    reference: randomUUID,
  });
  const identitySecurityManagement = new IdentitySecurityManagementService({
    unitOfWork,
    repository: new PostgresIdentitySecurityManagementRepository(),
    receiptRecovery: identityRepository,
    receipts: new CommandReceiptRepository(),
    outbox: new OutboxRepository(),
    totpEnrollmentIssuer: createIdentityTotpEnrollmentIssuer(),
    recoveryCodeIssuer: createIdentityRecoveryCodeIssuer(),
    totpSecretProtector,
    totpVerifier: createIdentityTotpVerifier(),
    passwordHasher,
    dummyPasswordHash,
    reauthenticationCredentials,
    dummyTotpSecret: generateSecret(),
    auditDigest,
    reference: randomUUID,
  });
  const authorizationOperations = createAuthorizationPublicOperations({
    exchangeProductContext: new ExchangeProductContextService(unitOfWork, repository, modelOptions),
    getPersonalContext: new GetPersonalContextService(unitOfWork, repository),
    issueSessionAccessGrant: new IssueSessionAccessGrantService(
      unitOfWork,
      repository,
      signer,
      publisher,
    ),
  });
  const identityOperations = createIdentityPublicOperations(identity, identitySecurityManagement);
  const redemptionRepository = new PostgresRedemptionRepository();
  const commerceRepository = new PostgresCommerceRepository();
  const redemptionConfirmationRepository = new PostgresRedemptionConfirmationRepository({ commerce: commerceRepository });
  const commerceFence = new CommerceCommandFence(
    unitOfWork,
    commerceRepository,
    (transaction, context, operation) => authorizeCommerceCommand(transaction, context, operation, new Date().toISOString()),
  );
  const commerceOperations = createCommercePublicOperations({
    preview: new PreviewRedemptionService({
      unitOfWork,
      fence: commerceFence,
      repository: redemptionRepository,
      secrets: redemptionSecrets,
    }),
    confirm: new ConfirmRedemptionService({
      unitOfWork,
      fence: commerceFence,
      repository: redemptionConfirmationRepository,
      secrets: redemptionSecrets,
    }),
    queries: new RedemptionQueryService({ unitOfWork, repository: redemptionConfirmationRepository }),
    accountQueries: new AccountReadService({ unitOfWork, repository: new PostgresAccountReadRepository() }),
  });
  const handler = createPlatformPublicHttpHandler({
    workloads,
    sessions: input.database,
    operations: [...authorizationOperations, ...identityOperations, ...commerceOperations],
    requiredOperationIds: [...AUTHORIZATION_PUBLIC_OPERATION_IDS, ...IDENTITY_LAUNCH_OPERATION_IDS, ...COMMERCE_PUBLIC_OPERATION_IDS],
    grantSigner: signer,
    sessionCredentialDigest: sessionCredentials.digest,
  });
  return Object.freeze({
    handler,
    secure: true as const,
    createServer: (listener: RequestListener) => createHttpsServer(tls, listener),
  });
}

async function loadRedemptionSecretCodec(path: string) {
  const root = record(JSON.parse(await readBoundedSecret(path, 64 * 1024)) as unknown, "REDEMPTION_KEY_RING_INVALID");
  exactCommerce(root, [
    "version", "currentCodeLookupKeyRevision", "codeLookupKeys",
    "currentPreviewCredentialKeyRevision", "previewCredentialKeys", "requestAuditKeyBase64url",
  ]);
  if (
    root.version !== 1 || typeof root.currentCodeLookupKeyRevision !== "string" ||
    typeof root.currentPreviewCredentialKeyRevision !== "string" || typeof root.requestAuditKeyBase64url !== "string" ||
    !Array.isArray(root.codeLookupKeys) || !Array.isArray(root.previewCredentialKeys)
  ) throw new Error("REDEMPTION_KEY_RING_INVALID");
  return createRedemptionSecretCodec({
    currentCodeLookupKeyRevision: root.currentCodeLookupKeyRevision,
    codeLookupKeys: root.codeLookupKeys.map(redemptionKey),
    currentPreviewCredentialKeyRevision: root.currentPreviewCredentialKeyRevision,
    previewCredentialKeys: root.previewCredentialKeys.map(redemptionKey),
    requestAuditKey: secretBytes(root.requestAuditKeyBase64url, 32),
  });
}

function redemptionKey(value: unknown) {
  const key = record(value, "REDEMPTION_KEY_RING_INVALID");
  exactCommerce(key, ["keyRevision", "keyBase64url"]);
  if (typeof key.keyRevision !== "string" || typeof key.keyBase64url !== "string") {
    throw new Error("REDEMPTION_KEY_RING_INVALID");
  }
  return Object.freeze({ keyRevision: key.keyRevision, key: secretBytes(key.keyBase64url, 32) });
}

function exactCommerce(value: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(value).some((key) => !names.includes(key))) throw new Error("REDEMPTION_KEY_RING_UNKNOWN_FIELD");
}

async function loadIdentityPasswordHasher(path: string) {
  const root = record(
    JSON.parse(await readBoundedSecret(path, 64 * 1024)) as unknown,
    "IDENTITY_PASSWORD_PEPPER_RING_INVALID",
  );
  exactIdentity(root, [
    "version",
    "currentPepperVersion",
    "peppers",
    "memoryCostKiB",
    "timeCost",
    "parallelism",
  ]);
  if (
    root.version !== 1 ||
    typeof root.currentPepperVersion !== "number" ||
    typeof root.memoryCostKiB !== "number" ||
    typeof root.timeCost !== "number" ||
    typeof root.parallelism !== "number" ||
    !Array.isArray(root.peppers)
  )
    throw new Error("IDENTITY_PASSWORD_PEPPER_RING_INVALID");
  const peppers = root.peppers.map((value) => {
    const pepper = record(value, "IDENTITY_PASSWORD_PEPPER_RING_INVALID");
    exactIdentity(pepper, ["version", "secretBase64url"]);
    if (typeof pepper.version !== "number" || typeof pepper.secretBase64url !== "string") {
      throw new Error("IDENTITY_PASSWORD_PEPPER_RING_INVALID");
    }
    return Object.freeze({
      version: pepper.version,
      secret: secretBytes(pepper.secretBase64url, 32),
    });
  });
  return createIdentityPasswordHasher({
    currentPepperVersion: root.currentPepperVersion,
    peppers,
    memoryCostKiB: root.memoryCostKiB,
    timeCost: root.timeCost,
    parallelism: root.parallelism,
  });
}

async function loadOpaqueCredentialCodec(path: string) {
  return createOpaqueCredentialCodec(secretBytes((await readBoundedSecret(path, 256)).trim(), 32));
}

async function loadIdentityAuditDigester(path: string) {
  return createIdentityAuditDigester(secretBytes((await readBoundedSecret(path, 256)).trim(), 32));
}

async function loadVerificationDeliverySealer(path: string) {
  const root = record(
    JSON.parse(await readBoundedSecret(path, 4096)) as unknown,
    "IDENTITY_DELIVERY_KEY_INVALID",
  );
  exactIdentity(root, ["version", "keyRevision", "keyBase64url"]);
  if (
    root.version !== 1 ||
    typeof root.keyRevision !== "string" ||
    typeof root.keyBase64url !== "string"
  ) {
    throw new Error("IDENTITY_DELIVERY_KEY_INVALID");
  }
  return createVerificationEnvelopeSealer({
    keyRevision: root.keyRevision,
    key: secretBytes(root.keyBase64url, 32),
  });
}

export async function loadIdentityTotpSecretProtector(path: string) {
  const root = record(
    JSON.parse(await readBoundedPrivateSecret(path, 64 * 1024)) as unknown,
    "IDENTITY_TOTP_KEY_RING_INVALID",
  );
  exactIdentity(root, ["version", "currentKeyRevision", "keys"]);
  if (
    root.version !== 1 ||
    typeof root.currentKeyRevision !== "string" ||
    !Array.isArray(root.keys) ||
    root.keys.length < 1 ||
    root.keys.length > 32
  ) {
    throw new Error("IDENTITY_TOTP_KEY_RING_INVALID");
  }
  const keys = root.keys.map((value) => {
    const key = record(value, "IDENTITY_TOTP_KEY_RING_INVALID");
    exactIdentity(key, ["keyRevision", "keyBase64url"]);
    if (typeof key.keyRevision !== "string" || typeof key.keyBase64url !== "string") {
      throw new Error("IDENTITY_TOTP_KEY_RING_INVALID");
    }
    return Object.freeze({
      keyRevision: key.keyRevision,
      key: secretBytes(key.keyBase64url, 32),
    });
  });
  return createIdentityTotpSecretProtector({
    currentKeyRevision: root.currentKeyRevision,
    keys: Object.freeze(keys),
  });
}

async function readBoundedPrivateSecret(path: string, maximumBytes: number): Promise<string> {
  if (!path.startsWith("/")) throw new Error("PLATFORM_SECRET_FILE_MUST_BE_ABSOLUTE");
  let handle;
  try {
    handle = await open(path, fileSystemConstants.O_RDONLY | fileSystemConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw new Error("IDENTITY_TOTP_KEY_RING_PERMISSIONS_INVALID");
    }
    if (metadata.size < 1 || metadata.size > maximumBytes)
      throw new Error("PLATFORM_SECRET_FILE_INVALID");
    const value = await handle.readFile("utf8");
    if (Buffer.byteLength(value, "utf8") > maximumBytes)
      throw new Error("PLATFORM_SECRET_FILE_INVALID");
    return value;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "IDENTITY_TOTP_KEY_RING_PERMISSIONS_INVALID" ||
        error.message === "PLATFORM_SECRET_FILE_INVALID" ||
        error.message === "PLATFORM_SECRET_FILE_MUST_BE_ABSOLUTE")
    )
      throw error;
    throw new Error("IDENTITY_TOTP_KEY_RING_PERMISSIONS_INVALID", { cause: error });
  } finally {
    await handle?.close();
  }
}

function secretBytes(value: string, length: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("IDENTITY_SECRET_ENCODING_INVALID");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== length || bytes.toString("base64url") !== value) {
    throw new Error("IDENTITY_SECRET_ENCODING_INVALID");
  }
  return bytes;
}

function exactIdentity(value: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(value).some((key) => !names.includes(key))) {
    throw new Error("IDENTITY_SECRET_CONFIG_UNKNOWN_FIELD");
  }
}

async function loadTls(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<ServerOptions> {
  const [key, cert, ca] = await Promise.all([
    readBoundedSecret(required(environment, "PLATFORM_PUBLIC_TLS_KEY_FILE"), 64 * 1024),
    readBoundedSecret(required(environment, "PLATFORM_PUBLIC_TLS_CERT_FILE"), 64 * 1024),
    readBoundedSecret(required(environment, "PLATFORM_PUBLIC_TLS_CLIENT_CA_FILE"), 256 * 1024),
  ]);
  if (
    !key.includes("BEGIN PRIVATE KEY") ||
    !cert.includes("BEGIN CERTIFICATE") ||
    !ca.includes("BEGIN CERTIFICATE")
  ) {
    throw new Error("PLATFORM_PUBLIC_TLS_MATERIAL_INVALID");
  }
  return Object.freeze({
    key,
    cert,
    ca,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3" as const,
    honorCipherOrder: true,
  });
}

export async function loadSessionAccessKeyRing(path: string): Promise<SessionAccessKeyRingConfig> {
  const parsed = JSON.parse(await readBoundedSecret(path, 512 * 1024)) as unknown;
  const root = record(parsed, "SESSION_ACCESS_KEY_RING_INVALID");
  exact(root, ["version", "issuer", "maximumTtlSeconds", "keys"]);
  if (root.version !== 2 || !Array.isArray(root.keys))
    throw new Error("SESSION_ACCESS_KEY_RING_INVALID");
  const keys = root.keys.map((raw): SessionAccessSigningKeyConfig => {
    const key = record(raw, "SESSION_ACCESS_KEY_RING_INVALID");
    exact(key, [
      "keyRevision",
      "publicKeyPem",
      "privateKeyPem",
      "current",
      "notBefore",
      "notAfter",
    ]);
    if (
      typeof key.keyRevision !== "string" ||
      typeof key.publicKeyPem !== "string" ||
      typeof key.current !== "boolean" ||
      typeof key.notBefore !== "string" ||
      typeof key.notAfter !== "string" ||
      (key.privateKeyPem !== undefined && typeof key.privateKeyPem !== "string")
    )
      throw new Error("SESSION_ACCESS_KEY_RING_INVALID");
    return Object.freeze({
      keyRevision: key.keyRevision,
      publicKeyPem: key.publicKeyPem,
      current: key.current,
      notBefore: key.notBefore,
      notAfter: key.notAfter,
      ...(key.privateKeyPem === undefined ? {} : { privateKeyPem: key.privateKeyPem }),
    });
  });
  if (typeof root.issuer !== "string" || typeof root.maximumTtlSeconds !== "number") {
    throw new Error("SESSION_ACCESS_KEY_RING_INVALID");
  }
  return Object.freeze({
    issuer: root.issuer,
    maximumTtlSeconds: root.maximumTtlSeconds,
    keys: Object.freeze(keys),
  });
}

export async function loadAuthorizationEventKeyRing(
  path: string,
): Promise<AuthorizationEventKeyRingConfig> {
  const parsed = JSON.parse(await readBoundedSecret(path, 512 * 1024)) as unknown;
  const root = record(parsed, "AUTHORIZATION_EVENT_KEY_RING_INVALID");
  exactAuthorization(root, ["version", "keys"]);
  if (root.version !== 1 || !Array.isArray(root.keys))
    throw new Error("AUTHORIZATION_EVENT_KEY_RING_INVALID");
  const keys = root.keys.map((raw): AuthorizationEventSigningKeyConfig => {
    const key = record(raw, "AUTHORIZATION_EVENT_KEY_RING_INVALID");
    exactAuthorization(key, [
      "keyRevision",
      "publicKeyPem",
      "privateKeyPem",
      "current",
      "notBefore",
      "notAfter",
    ]);
    if (
      typeof key.keyRevision !== "string" ||
      typeof key.publicKeyPem !== "string" ||
      typeof key.current !== "boolean" ||
      typeof key.notBefore !== "string" ||
      typeof key.notAfter !== "string" ||
      (key.privateKeyPem !== undefined && typeof key.privateKeyPem !== "string")
    )
      throw new Error("AUTHORIZATION_EVENT_KEY_RING_INVALID");
    return Object.freeze({
      keyRevision: key.keyRevision,
      publicKeyPem: key.publicKeyPem,
      current: key.current,
      notBefore: key.notBefore,
      notAfter: key.notAfter,
      ...(key.privateKeyPem === undefined ? {} : { privateKeyPem: key.privateKeyPem }),
    });
  });
  return Object.freeze({ keys: Object.freeze(keys) });
}

export async function readBoundedSecret(path: string, maximumBytes: number): Promise<string> {
  if (!path.startsWith("/")) throw new Error("PLATFORM_SECRET_FILE_MUST_BE_ABSOLUTE");
  const value = await readFile(path, "utf8");
  if (value.length < 1 || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error("PLATFORM_SECRET_FILE_INVALID");
  }
  return value;
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(value).some((key) => !names.includes(key))) {
    throw new Error("SESSION_ACCESS_KEY_RING_UNKNOWN_FIELD");
  }
}

function exactAuthorization(value: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(value).some((key) => !names.includes(key))) {
    throw new Error("AUTHORIZATION_EVENT_KEY_RING_UNKNOWN_FIELD");
  }
}
