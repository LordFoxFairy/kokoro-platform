import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createSecureServer, type Http2SecureServer, type SecureServerOptions } from "node:http2";
import type { Http2ServerRequest, Http2ServerResponse } from "node:http2";
import { TLSSocket } from "node:tls";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { PlatformTransactionalDatabaseClient } from "../infrastructure/postgres/client.js";
import { AdminIdentityService } from
  "../generated/proto/kokoro/platform/identity/v1/admin_identity_pb.js";
import { AdminQueryService } from
  "../generated/proto/kokoro/platform/admin/v2/admin_query_pb.js";
import { AdminCommandService as AdminCommandDescriptor } from
  "../generated/proto/kokoro/platform/admin/v2/admin_command_pb.js";
import { SiteLifecycleService } from
  "../generated/proto/kokoro/platform/site/v1/site_lifecycle_pb.js";
import { SitePublicationService } from
  "../generated/proto/kokoro/platform/site/v1/site_publication_pb.js";
import { AdminCreditService } from
  "../generated/proto/kokoro/platform/credit/v1/admin_credit_pb.js";
import { SiteProvisioningService } from
  "../generated/proto/kokoro/platform/site/v1/site_provisioning_pb.js";
import { ModelControlService } from
  "../generated/proto/kokoro/platform/model/v1/model_control_pb.js";
import { ProductCatalogPublicationService } from
  "../generated/proto/kokoro/platform/product/v1/product_catalog_publication_pb.js";
import { PlatformUnitOfWork } from "../shared/unit-of-work/index.js";
import { CommandReceiptRepository } from "../shared/outbox-inbox/receipt.js";
import { OutboxRepository } from "../shared/outbox-inbox/outbox.js";
import { AdminCommandService as AdminCommandApplicationService,
  AdminLocalCommandRegistry } from "../modules/admin-control/application/admin-command-service.js";
import { AdminApprovalService } from
  "../modules/admin-control/application/admin-approval-service.js";
import { PostgresAdminAuthorityRepository } from
  "../modules/admin-control/infrastructure/postgres/admin-authority-repository.js";
import { createAdminAuthorityCommandHandler } from
  "../modules/admin-control/infrastructure/postgres/admin-authority-command-handler.js";
import { PostgresAdminCommandReceiptReader } from
  "../modules/admin-control/infrastructure/postgres/admin-command-receipt-reader.js";
import { createAdminCommandConnectService } from
  "../modules/admin-control/interfaces/connect/admin-command-service.js";
import { AdminOidcService, type AdminOidcRegistration, type AdminWorkloadAxes } from
  "../modules/admin/application/services/admin-oidc-service.js";
import { AdminOperatorSessionApplicationService } from
  "../modules/admin/infrastructure/postgres/admin-operator-session-service.js";
import { PostgresAdminOidcStore } from
  "../modules/admin/infrastructure/postgres/admin-oidc-store.js";
import { PostgresAdminOperatorResolver } from
  "../modules/admin/infrastructure/postgres/admin-operator-resolver.js";
import { PostgresAdminSessionAuthenticator } from
  "../modules/admin/infrastructure/postgres/admin-session-authenticator.js";
import { PostgresAdminQueryReader } from
  "../modules/admin/infrastructure/postgres/admin-query-reader.js";
import { createOpenIdClientAdminProvider } from
  "../modules/admin/infrastructure/oidc/openid-client-admin-provider.js";
import { AesGcmAdminOidcTransactionProtector, AdminSessionDeliverySealer } from
  "../modules/admin/infrastructure/jose/admin-session-delivery.js";
import { AdminControlPlaneResolver, type VerifiedAdminPeer } from
  "../modules/admin/infrastructure/security/admin-control-plane-resolver.js";
import { HmacAdminPageCursorCodec } from
  "../modules/admin/infrastructure/security/admin-page-cursor.js";
import { createAdminIdentityConnectService } from
  "../modules/admin/interfaces/connect/admin-identity-service.js";
import { createAdminQueryConnectService } from
  "../modules/admin/interfaces/connect/admin-query-service.js";
import { createSiteLifecycleConnectService } from
  "../modules/site/interfaces/connect/site-lifecycle-service.js";
import { createSiteProvisioningConnectService } from
  "../modules/site/interfaces/connect/site-provisioning-service.js";
import { createSitePublicationConnectService } from
  "../modules/site/interfaces/connect/site-publication-service.js";
import { createModelControlConnectService } from
  "../modules/model-control/interfaces/connect/model-control-service.js";
import { createAdminCreditConnectService } from
  "../modules/credit/interfaces/connect/admin-credit-service.js";
import { PostgresAdminCreditReader } from
  "../modules/credit/infrastructure/postgres/admin-credit-reader.js";
import { readBoundedPrivateFile, readBoundedRegularFile } from "./secret-files.js";
import { createPlatformSiteAdminComposition } from "./site-admin-composition.js";
import { createSessionAuthorizationEventSigner } from
  "../modules/authorization/infrastructure/jose/session-authorization-event-signer.js";
import { loadAuthorizationEventKeyRing } from "./platform-public-composition.js";
import { createPlatformSiteProvisioningComposition } from
  "./site-provisioning-admin-composition.js";
import {
  Ed25519SiteReleaseCertificationAuthority,
  parseSiteReleaseCertificationKeys,
} from
  "../modules/site/infrastructure/crypto/site-release-certification-authority.js";
import { PostgresControlCommandReceiptTimestampReader } from
  "../modules/admin/infrastructure/postgres/control-command-receipt-reader.js";
import { createProductModelOptionAdministrationComposition } from
  "./model-option-admin-composition.js";
import { PostgresModelControlAdminReader } from
  "../modules/model-control/infrastructure/postgres/model-control-admin-reader.js";
import type { ProductPublicationDocumentResolver } from
  "../modules/product-catalog/application/contracts/product-publication-document-resolver.js";
import { ContentAddressedProductPublicationDocumentResolver } from
  "../modules/product-catalog/infrastructure/filesystem/content-addressed-product-publication-document-resolver.js";
import { createProductCatalogPublicationConnectService } from
  "../modules/product-catalog/interfaces/connect/product-catalog-publication-service.js";
import { createProductCatalogAdministrationComposition } from
  "./product-catalog-admin-composition.js";
import { createSitePublicationAuthorityProductionComposition } from
  "./site-publication-authority-composition.js";
import { PostgresSiteEffectiveAccessSnapshotAuthority } from
  "../modules/site/infrastructure/postgres/site-effective-access-snapshot-authority.js";
import { PostgresSiteWebBuildIntentIssuerAuthority } from
  "../modules/site/infrastructure/postgres/site-web-build-intent-issuer-authority.js";
import { PostgresSiteReleaseCertificationTrustAuthority } from
  "../modules/site/infrastructure/postgres/site-release-certification-trust-authority.js";
import {
  Ed25519SiteWebBuildIntentSigner,
  type SiteWebBuildIntentSigningKey,
} from "../modules/site/infrastructure/crypto/ed25519-site-web-build-intent-signer.js";

export type AdminRequestListener = (
  request: Http2ServerRequest,
  response: Http2ServerResponse,
) => void;

export interface AdminProductionComposition {
  readonly handler: AdminRequestListener;
  createServer(listener: AdminRequestListener): Http2SecureServer;
}

interface AdminPeer extends VerifiedAdminPeer {
  readonly fingerprint256: string;
  readonly sanUri: string;
}

interface RegisteredOidcClient {
  readonly axes: AdminWorkloadAxes;
  readonly registration: AdminOidcRegistration;
  readonly clientSecret: string;
}

export async function createAdminProductionComposition(input: Readonly<{
  database: PlatformTransactionalDatabaseClient;
  environment?: Readonly<Record<string, string | undefined>>;
  clock?: () => Date;
  productPublicationDocuments?: ProductPublicationDocumentResolver;
}>): Promise<AdminProductionComposition> {
  const environment = input.environment ?? process.env;
  const [tls, peers, oidcClients, transactionKey, cursorKey, keyRing,
    authorizationEventKeyRing, siteCertificationKeys, siteWebBuildIntentKeys] = await Promise.all([
    loadTls(environment),
    loadPeers(required(environment, "PLATFORM_ADMIN_MTLS_PEERS_FILE")),
    loadOidcClients(required(environment, "PLATFORM_ADMIN_OIDC_CLIENTS_FILE")),
    loadSecretKey(required(environment, "PLATFORM_ADMIN_OIDC_TRANSACTION_KEY_FILE"),
      "PLATFORM_ADMIN_OIDC_TRANSACTION_KEY_INVALID"),
    loadSecretKey(required(environment, "PLATFORM_ADMIN_CURSOR_KEY_FILE"),
      "PLATFORM_ADMIN_CURSOR_KEY_INVALID"),
    loadJoseKeyRing(required(environment, "PLATFORM_ADMIN_JOSE_KEY_RING_FILE")),
    loadAuthorizationEventKeyRing(required(environment, "PLATFORM_AUTHORIZATION_EVENT_KEY_RING_FILE")),
    loadSiteCertificationKeys(
      required(environment, "PLATFORM_SITE_RELEASE_CERTIFICATION_KEYS_FILE"),
    ),
    loadSiteWebBuildIntentKeys(
      required(environment, "PLATFORM_SITE_WEB_BUILD_INTENT_KEYS_FILE"),
    ),
  ]);
  assertPeerRegistrations(peers, oidcClients);
  const provider = await createOpenIdClientAdminProvider({
    clients: oidcClients.map((client) => ({
      registration: client.registration,
      clientSecret: client.clientSecret,
    })),
  });
  const authorizationEventSigner = await createSessionAuthorizationEventSigner(
    authorizationEventKeyRing,
  );
  const protector = new AesGcmAdminOidcTransactionProtector(transactionKey);
  const delivery = await AdminSessionDeliverySealer.create({
    issuer: keyRing.issuer,
    signingKeys: keyRing.signingKeys,
    deliveryKeys: keyRing.deliveryKeys,
    reference: randomUUID,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  const registration = Object.freeze({
    resolve(axes: AdminWorkloadAxes): AdminOidcRegistration {
      const client = oidcClients.find((candidate) => sameAxes(candidate.axes, axes));
      if (client === undefined) throw new Error("ADMIN_OIDC_REGISTRATION_NOT_FOUND");
      return client.registration;
    },
  });
  const oidc = new AdminOidcService({
    store: new PostgresAdminOidcStore(input.database),
    provider,
    registration,
    protector,
    recoveryDigester: (value) => domainDigest("kokoro.admin-session-recovery.v1", value),
    credentialDigester: (value) => domainDigest(
      "kokoro.admin-session-credential.v1", Buffer.from(value, "utf8")),
    operator: new PostgresAdminOperatorResolver(input.database),
    delivery,
    references: randomUUID,
    credential: () => randomBytes(32).toString("base64url"),
    secrets: oidcSecrets,
    clock: input.clock ?? (() => new Date()),
  });
  const peerContext = new AsyncLocalStorage<AdminPeer>();
  const resolver = new AdminControlPlaneResolver({
    peer: () => peerContext.getStore(),
    authenticator: new PostgresAdminSessionAuthenticator(input.database),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  const sessions = new AdminOperatorSessionApplicationService({
    unitOfWork: input.database,
    provider,
    registration,
    protector,
    secrets: oidcSecrets,
    reference: randomUUID,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  const identityService = createAdminIdentityConnectService({ oidc, sessions, resolver });
  const cursors = new HmacAdminPageCursorCodec(cursorKey);
  const queryService = createAdminQueryConnectService({
    resolver,
    reader: new PostgresAdminQueryReader(input.database),
    cursors,
  });
  const creditService = createAdminCreditConnectService({
    resolver, reader: new PostgresAdminCreditReader(input.database),
    cursors,
  });
  const unitOfWork = new PlatformUnitOfWork(input.database);
  const authorityRepository = new PostgresAdminAuthorityRepository();
  const receipts = new CommandReceiptRepository();
  const outbox = new OutboxRepository();
  const registry = new AdminLocalCommandRegistry([createAdminAuthorityCommandHandler()]);
  const commands = new AdminCommandApplicationService({
    unitOfWork,
    registry,
    repository: authorityRepository,
    receipts,
    reference: randomUUID,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  const approvals = new AdminApprovalService({
    unitOfWork,
    registry,
    repository: authorityRepository,
    receipts,
    executionQueue: outbox,
    reference: randomUUID,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  const commandService = createAdminCommandConnectService({
    commands,
    approvals,
    receipts: new PostgresAdminCommandReceiptReader(unitOfWork),
    resolver,
  });
  const siteLifecycleService = createSiteLifecycleConnectService({
    owner: createPlatformSiteAdminComposition(input.database, authorizationEventSigner).site,
    resolver,
  });
  const siteProvisioning = createPlatformSiteProvisioningComposition(
    input.database,
    new Ed25519SiteReleaseCertificationAuthority(siteCertificationKeys),
    input.clock === undefined ? {} : { now: () => input.clock!().toISOString() },
  );
  const controlReceiptTimestamps = new PostgresControlCommandReceiptTimestampReader(unitOfWork);
  const siteProvisioningService = createSiteProvisioningConnectService({
    owner: siteProvisioning.publication,
    resolver,
    receipts: controlReceiptTimestamps,
  });
  const modelControl = createProductModelOptionAdministrationComposition(
    input.database,
    input.clock === undefined ? {} : { now: () => input.clock!().toISOString() },
  );
  const modelControlService = createModelControlConnectService({
    owners: {
      importInventory: modelControl.importInventory,
      activateInventory: modelControl.activateInventory,
      changeSitePolicy: modelControl.changeSitePolicy,
      materializeModelOptions: modelControl.materialize,
      publishSiteReleaseCatalog: modelControl.publishSiteRelease,
    },
    resolver,
    receipts: controlReceiptTimestamps,
    reader: new PostgresModelControlAdminReader(input.database),
    cursors,
  });
  const productCatalogOwner = createProductCatalogAdministrationComposition(
    input.database,
    input.productPublicationDocuments ?? new ContentAddressedProductPublicationDocumentResolver(
      required(environment, "PLATFORM_PUBLICATION_DOCUMENT_ROOT"),
    ),
  );
  const productCatalogService = createProductCatalogPublicationConnectService({
    owner: productCatalogOwner,
    resolver,
  });
  const sitePublication = createSitePublicationAuthorityProductionComposition(input.database, {
    effectiveAccess: new PostgresSiteEffectiveAccessSnapshotAuthority(),
    intentAuthority: new PostgresSiteWebBuildIntentIssuerAuthority(),
    intentSigner: new Ed25519SiteWebBuildIntentSigner(siteWebBuildIntentKeys),
    certificationTrustAuthority: new PostgresSiteReleaseCertificationTrustAuthority(),
    publicationDocumentRoot: required(environment, "PLATFORM_PUBLICATION_DOCUMENT_ROOT"),
    ...(input.clock === undefined ? {} : { now: () => input.clock!().toISOString() }),
  });
  const sitePublicationService = createSitePublicationConnectService({
    owner: sitePublication.authority,
    resolver,
    receipts: controlReceiptTimestamps,
  });
  const connect = connectNodeAdapter({
    routes: (router) => {
      router.service(AdminIdentityService, identityService);
      router.service(AdminQueryService, queryService);
      router.service(AdminCommandDescriptor, commandService);
      router.service(SiteLifecycleService, siteLifecycleService);
      router.service(SiteProvisioningService, siteProvisioningService);
      router.service(SitePublicationService, sitePublicationService);
      router.service(ModelControlService, modelControlService);
      router.service(ProductCatalogPublicationService, productCatalogService);
      router.service(AdminCreditService, creditService);
    },
    connect: true,
    grpc: false,
    grpcWeb: false,
    acceptCompression: [],
    // Canonical ModelControl imports are deliberately bounded but can exceed small admin payloads.
    readMaxBytes: 16 * 1024 * 1024,
    // Read projections remain bounded independently from command request payloads.
    writeMaxBytes: 8 * 1024 * 1024,
    maxTimeoutMs: 10_000,
  });
  const handler: AdminRequestListener = (request, response) => {
    const peer = authenticatePeer(request, peers);
    if (peer === null) {
      response.statusCode = 401;
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("unauthorized");
      return;
    }
    peerContext.run(peer, () => {
      Promise.resolve(connect(request, response)).catch(() => {
        if (!response.headersSent) {
          response.statusCode = 503;
          response.setHeader("cache-control", "no-store");
          response.setHeader("content-type", "text/plain; charset=utf-8");
          response.end("unavailable");
        } else response.destroy();
      });
    });
  };
  return Object.freeze({
    handler,
    createServer: (listener: AdminRequestListener) => createSecureServer(tls, listener),
  });
}

async function loadSiteCertificationKeys(path: string) {
  return parseSiteReleaseCertificationKeys(JSON.parse(await readTrustFile(path, 256 * 1024)));
}

async function loadSiteWebBuildIntentKeys(
  path: string,
): Promise<readonly SiteWebBuildIntentSigningKey[]> {
  const root = record(JSON.parse(await readBoundedPrivateFile(
    path,
    256 * 1024,
    "PLATFORM_SITE_WEB_BUILD_INTENT_KEY_RING_INVALID",
  )), "PLATFORM_SITE_WEB_BUILD_INTENT_KEY_RING_INVALID");
  if (root.version !== 1 || !Array.isArray(root.keys) ||
      Object.keys(root).sort().join(",") !== "keys,version" ||
      root.keys.length < 1 || root.keys.length > 64) {
    throw new Error("PLATFORM_SITE_WEB_BUILD_INTENT_KEY_RING_INVALID");
  }
  const keys = await Promise.all(root.keys.map(async (value): Promise<SiteWebBuildIntentSigningKey> => {
    const key = record(value, "PLATFORM_SITE_WEB_BUILD_INTENT_KEY_RING_INVALID");
    const names = Object.keys(key).sort().join(",");
    if (names !== "keyId,keyVersion,privateKeyFile,publicKeyFile,publicKeyFingerprint" &&
        names !== "keyId,keyVersion,publicKeyFile,publicKeyFingerprint") {
      throw new Error("PLATFORM_SITE_WEB_BUILD_INTENT_KEY_RING_INVALID");
    }
    const privateKeyFile = key.privateKeyFile;
    return Object.freeze({
      keyId: text(key.keyId),
      keyVersion: BigInt(positiveDecimalText(key.keyVersion)),
      publicKeyFingerprint: text(key.publicKeyFingerprint),
      publicKeyPem: await readTrustFile(text(key.publicKeyFile), 64 * 1024),
      ...(privateKeyFile === undefined ? {} : {
        privateKeyPem: await readBoundedPrivateFile(
          text(privateKeyFile),
          64 * 1024,
          "PLATFORM_SITE_WEB_BUILD_INTENT_PRIVATE_KEY_INVALID",
        ),
      }),
    });
  }));
  if (!keys.some((key) => key.privateKeyPem !== undefined)) {
    throw new Error("PLATFORM_SITE_WEB_BUILD_INTENT_PRIVATE_KEY_REQUIRED");
  }
  return Object.freeze(keys);
}

function oidcSecrets(): Readonly<{ verifier: string; challenge: string; nonce: string }> {
  const verifier = randomBytes(48).toString("base64url");
  return Object.freeze({
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    nonce: randomBytes(32).toString("base64url"),
  });
}

async function loadTls(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<SecureServerOptions> {
  const [key, cert, ca] = await Promise.all([
    readBoundedPrivateFile(required(environment, "PLATFORM_ADMIN_TLS_KEY_FILE"), 64 * 1024,
      "PLATFORM_ADMIN_TLS_KEY_FILE_INVALID"),
    readTrustFile(required(environment, "PLATFORM_ADMIN_TLS_CERT_FILE"), 64 * 1024),
    readTrustFile(required(environment, "PLATFORM_ADMIN_TLS_CLIENT_CA_FILE"), 256 * 1024),
  ]);
  if (!key.includes("BEGIN PRIVATE KEY") || !cert.includes("BEGIN CERTIFICATE") ||
      !ca.includes("BEGIN CERTIFICATE")) throw new Error("PLATFORM_ADMIN_TLS_MATERIAL_INVALID");
  return Object.freeze({ key, cert, ca, requestCert: true, rejectUnauthorized: true,
    allowHTTP1: false, minVersion: "TLSv1.3" });
}

async function loadPeers(path: string): Promise<readonly AdminPeer[]> {
  const root = record(JSON.parse(await readTrustFile(path, 256 * 1024)),
    "PLATFORM_ADMIN_MTLS_PEERS_INVALID");
  if (root.version !== 1 || !Array.isArray(root.peers) ||
      Object.keys(root).sort().join(",") !== "peers,version") {
    throw new Error("PLATFORM_ADMIN_MTLS_PEERS_INVALID");
  }
  const seen = new Set<string>();
  const seenFingerprints = new Set<string>();
  const peers = root.peers.map((value): AdminPeer => {
    const peer = record(value, "PLATFORM_ADMIN_MTLS_PEERS_INVALID");
    if (Object.keys(peer).sort().join(",") !==
        "audience,bindingEpoch,environment,fingerprint256,managedDeviceRef,region,sanUri" ||
        typeof peer.fingerprint256 !== "string" ||
        !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u.test(peer.fingerprint256) ||
        typeof peer.sanUri !== "string" || !peer.sanUri.startsWith("spiffe://") ||
        !positiveIntegerString(peer.bindingEpoch) || seen.has(peer.sanUri) ||
        seenFingerprints.has(peer.fingerprint256)) {
      throw new Error("PLATFORM_ADMIN_MTLS_PEERS_INVALID");
    }
    seen.add(peer.sanUri);
    seenFingerprints.add(peer.fingerprint256);
    return Object.freeze({
      fingerprint256: peer.fingerprint256,
      sanUri: peer.sanUri,
      workloadIdentityRef: peer.sanUri,
      environment: text(peer.environment), region: text(peer.region),
      audience: text(peer.audience), managedDeviceRef: text(peer.managedDeviceRef),
      bindingEpoch: BigInt(String(peer.bindingEpoch)),
    });
  });
  if (peers.length < 1 || peers.length > 32) throw new Error("PLATFORM_ADMIN_MTLS_PEERS_INVALID");
  return Object.freeze(peers);
}

async function loadOidcClients(path: string): Promise<readonly RegisteredOidcClient[]> {
  const root = record(JSON.parse(await readTrustFile(path, 512 * 1024)),
    "PLATFORM_ADMIN_OIDC_CLIENTS_INVALID");
  if (root.version !== 1 || !Array.isArray(root.clients) ||
      Object.keys(root).sort().join(",") !== "clients,version") {
    throw new Error("PLATFORM_ADMIN_OIDC_CLIENTS_INVALID");
  }
  const clients = await Promise.all(root.clients.map(async (value): Promise<RegisteredOidcClient> => {
    const client = record(value, "PLATFORM_ADMIN_OIDC_CLIENTS_INVALID");
    if (Object.keys(client).sort().join(",") !==
        "audience,clientId,clientSecretFile,deliveryKeyRevision,environment,exactCallbackUri,issuer,managedDeviceRef,oidcAudience,region,returnIntentRefs,signingKeyRevision,workloadIdentityRef" ||
        !Array.isArray(client.returnIntentRefs) || client.returnIntentRefs.length < 1) {
      throw new Error("PLATFORM_ADMIN_OIDC_CLIENTS_INVALID");
    }
    const axes = Object.freeze({
      workloadIdentityRef: text(client.workloadIdentityRef), environment: text(client.environment),
      region: text(client.region), managedDeviceRef: text(client.managedDeviceRef),
      audience: text(client.audience),
    });
    return Object.freeze({
      axes,
      registration: Object.freeze({
        issuer: secureUrl(client.issuer), clientId: text(client.clientId),
        oidcAudience: text(client.oidcAudience), exactCallbackUri: secureUrl(client.exactCallbackUri),
        returnIntentRefs: Object.freeze(client.returnIntentRefs.map(text)),
        signingKeyRevision: text(client.signingKeyRevision),
        deliveryKeyRevision: text(client.deliveryKeyRevision),
      }),
      clientSecret: (await readBoundedPrivateFile(text(client.clientSecretFile), 8 * 1024,
        "PLATFORM_ADMIN_OIDC_CLIENT_SECRET_INVALID")).trim(),
    });
  }));
  if (clients.length < 1 || clients.length > 32) throw new Error("PLATFORM_ADMIN_OIDC_CLIENTS_INVALID");
  return Object.freeze(clients);
}

async function loadJoseKeyRing(path: string): Promise<Readonly<{
  issuer: string;
  signingKeys: readonly Readonly<{ revision: string; privateKeyPem: string }>[];
  deliveryKeys: readonly Readonly<{ revision: string; publicKeyPem: string }>[];
}>> {
  const root = record(JSON.parse(await readBoundedPrivateFile(path, 256 * 1024,
    "PLATFORM_ADMIN_JOSE_KEY_RING_INVALID")), "PLATFORM_ADMIN_JOSE_KEY_RING_INVALID");
  if (root.version !== 1 || typeof root.issuer !== "string" ||
      !Array.isArray(root.signingKeys) || !Array.isArray(root.deliveryKeys) ||
      Object.keys(root).sort().join(",") !== "deliveryKeys,issuer,signingKeys,version") {
    throw new Error("PLATFORM_ADMIN_JOSE_KEY_RING_INVALID");
  }
  const signingKeys = await Promise.all(root.signingKeys.map(async (value) => {
    const key = record(value, "PLATFORM_ADMIN_JOSE_KEY_RING_INVALID");
    if (Object.keys(key).sort().join(",") !== "privateKeyFile,revision") {
      throw new Error("PLATFORM_ADMIN_JOSE_KEY_RING_INVALID");
    }
    return Object.freeze({ revision: text(key.revision),
      privateKeyPem: await readBoundedPrivateFile(text(key.privateKeyFile), 64 * 1024,
        "PLATFORM_ADMIN_JOSE_SIGNING_KEY_INVALID") });
  }));
  const deliveryKeys = await Promise.all(root.deliveryKeys.map(async (value) => {
    const key = record(value, "PLATFORM_ADMIN_JOSE_KEY_RING_INVALID");
    if (Object.keys(key).sort().join(",") !== "publicKeyFile,revision") {
      throw new Error("PLATFORM_ADMIN_JOSE_KEY_RING_INVALID");
    }
    return Object.freeze({ revision: text(key.revision),
      publicKeyPem: await readTrustFile(text(key.publicKeyFile), 64 * 1024) });
  }));
  return Object.freeze({ issuer: secureUrl(root.issuer),
    signingKeys: Object.freeze(signingKeys), deliveryKeys: Object.freeze(deliveryKeys) });
}

async function loadSecretKey(path: string, code: string): Promise<Uint8Array> {
  const encoded = (await readBoundedPrivateFile(path, 256, code)).trim();
  const value = Buffer.from(encoded, "base64url");
  if (value.byteLength !== 32 || value.toString("base64url") !== encoded) throw new Error(code);
  return new Uint8Array(value);
}

function authenticatePeer(request: Http2ServerRequest, peers: readonly AdminPeer[]): AdminPeer | null {
  const socket = request.socket;
  if (!(socket instanceof TLSSocket) || socket.authorized !== true || socket.authorizationError != null) return null;
  const certificate = socket.getPeerCertificate();
  const now = Date.now();
  const validFrom = Date.parse(certificate.valid_from);
  const validTo = Date.parse(certificate.valid_to);
  if (!certificate.fingerprint256 || !certificate.subjectaltname ||
      !Number.isFinite(validFrom) || !Number.isFinite(validTo) ||
      validFrom > now || validTo <= now) return null;
  const sans = certificate.subjectaltname.split(/,\s*/u)
    .filter((entry) => entry.startsWith("URI:")).map((entry) => entry.slice(4));
  return peers.find((peer) => peer.fingerprint256 === certificate.fingerprint256 &&
    sans.length === 1 && sans[0] === peer.sanUri) ?? null;
}

function assertPeerRegistrations(
  peers: readonly AdminPeer[],
  clients: readonly RegisteredOidcClient[],
): void {
  if (peers.some((peer) => !clients.some((client) => sameAxes(peer, client.axes)))) {
    throw new Error("PLATFORM_ADMIN_PEER_REGISTRATION_MISSING");
  }
}

function sameAxes(left: AdminWorkloadAxes, right: AdminWorkloadAxes): boolean {
  return left.workloadIdentityRef === right.workloadIdentityRef &&
    left.environment === right.environment && left.region === right.region &&
    left.managedDeviceRef === right.managedDeviceRef && left.audience === right.audience;
}

function domainDigest(context: string, value: Uint8Array): string {
  return createHash("sha256").update(context).update("\0").update(value).digest("hex");
}

function readTrustFile(path: string, maximumBytes: number): Promise<string> {
  return readBoundedRegularFile(path, maximumBytes, "PLATFORM_ADMIN_TRUST_FILE_INVALID");
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

function text(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) {
    throw new Error("PLATFORM_ADMIN_CONFIGURATION_INVALID");
  }
  return value;
}

function secureUrl(value: unknown): string {
  const url = new URL(text(value));
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("PLATFORM_ADMIN_CONFIGURATION_INVALID");
  }
  return url.href;
}

function positiveIntegerString(value: unknown): boolean {
  return (typeof value === "string" || typeof value === "number") &&
    /^[1-9][0-9]{0,18}$/u.test(String(value));
}

function positiveDecimalText(value: unknown): string {
  const textValue = String(value);
  if (!/^[1-9][0-9]{0,19}$/u.test(textValue) ||
      BigInt(textValue) > 18_446_744_073_709_551_615n) {
    throw new Error("PLATFORM_SITE_WEB_BUILD_INTENT_KEY_RING_INVALID");
  }
  return textValue;
}
