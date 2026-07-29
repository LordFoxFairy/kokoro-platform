import { readFile } from "node:fs/promises";
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
import type { AuthorizationEventKeyRingConfig, AuthorizationEventSigningKeyConfig } from "../modules/authorization/infrastructure/jose/session-authorization-event-signer.js";
import { PostgresProductModelOptionCatalogReader } from "../modules/model-control/infrastructure/postgres/product-model-option-repository.js";
import { loadProductWorkloadRegistry } from "../modules/authorization/infrastructure/transport/product-workload-registry.js";
import { PlatformUnitOfWork } from "../shared/unit-of-work/unit-of-work.js";
import { createPlatformPublicHttpHandler, type PlatformPublicHttpHandler } from "../interfaces/http/platform-public.js";

export interface PlatformPublicProductionComposition {
  readonly handler: PlatformPublicHttpHandler;
  readonly secure: true;
  createServer(listener: RequestListener): Server;
}

export async function createPlatformPublicProductionComposition(input: Readonly<{
  database: PlatformTransactionalDatabaseClient;
  modelOptions?: ModelOptionCatalogReadPort;
  environment?: Readonly<Record<string, string | undefined>>;
}>): Promise<PlatformPublicProductionComposition> {
  const environment = input.environment ?? process.env;
  const [workloads, keyRing, eventKeyRing, tls] = await Promise.all([
    loadProductWorkloadRegistry(required(environment, "PLATFORM_PRODUCT_WORKLOAD_REGISTRY_FILE")),
    loadSessionAccessKeyRing(required(environment, "PLATFORM_SESSION_ACCESS_KEY_RING_FILE")),
    loadAuthorizationEventKeyRing(required(environment, "PLATFORM_AUTHORIZATION_EVENT_KEY_RING_FILE")),
    loadTls(environment),
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
  const handler = createPlatformPublicHttpHandler({
    workloads,
    sessions: input.database,
    exchangeProductContext: new ExchangeProductContextService(
      unitOfWork,
      repository,
      modelOptions,
    ),
    getPersonalContext: new GetPersonalContextService(unitOfWork, repository),
    issueSessionAccessGrant: new IssueSessionAccessGrantService(
      unitOfWork,
      repository,
      signer,
      publisher,
    ),
    grantSigner: signer,
  });
  return Object.freeze({
    handler,
    secure: true as const,
    createServer: (listener: RequestListener) => createHttpsServer(tls, listener),
  });
}

async function loadTls(environment: Readonly<Record<string, string | undefined>>): Promise<ServerOptions> {
  const [key, cert, ca] = await Promise.all([
    readBoundedSecret(required(environment, "PLATFORM_PUBLIC_TLS_KEY_FILE"), 64 * 1024),
    readBoundedSecret(required(environment, "PLATFORM_PUBLIC_TLS_CERT_FILE"), 64 * 1024),
    readBoundedSecret(required(environment, "PLATFORM_PUBLIC_TLS_CLIENT_CA_FILE"), 256 * 1024),
  ]);
  if (!key.includes("BEGIN PRIVATE KEY") || !cert.includes("BEGIN CERTIFICATE") || !ca.includes("BEGIN CERTIFICATE")) {
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
  if (root.version !== 2 || !Array.isArray(root.keys)) throw new Error("SESSION_ACCESS_KEY_RING_INVALID");
  const keys = root.keys.map((raw): SessionAccessSigningKeyConfig => {
    const key = record(raw, "SESSION_ACCESS_KEY_RING_INVALID");
    exact(key, ["keyRevision", "publicKeyPem", "privateKeyPem", "current", "notBefore", "notAfter"]);
    if (
      typeof key.keyRevision !== "string" || typeof key.publicKeyPem !== "string" ||
      typeof key.current !== "boolean" || typeof key.notBefore !== "string" ||
      typeof key.notAfter !== "string" ||
      (key.privateKeyPem !== undefined && typeof key.privateKeyPem !== "string")
    ) throw new Error("SESSION_ACCESS_KEY_RING_INVALID");
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

export async function loadAuthorizationEventKeyRing(path: string): Promise<AuthorizationEventKeyRingConfig> {
  const parsed = JSON.parse(await readBoundedSecret(path, 512 * 1024)) as unknown;
  const root = record(parsed, "AUTHORIZATION_EVENT_KEY_RING_INVALID");
  exactAuthorization(root, ["version", "keys"]);
  if (root.version !== 1 || !Array.isArray(root.keys)) throw new Error("AUTHORIZATION_EVENT_KEY_RING_INVALID");
  const keys = root.keys.map((raw): AuthorizationEventSigningKeyConfig => {
    const key = record(raw, "AUTHORIZATION_EVENT_KEY_RING_INVALID");
    exactAuthorization(key, ["keyRevision", "publicKeyPem", "privateKeyPem", "current", "notBefore", "notAfter"]);
    if (
      typeof key.keyRevision !== "string" || typeof key.publicKeyPem !== "string" ||
      typeof key.current !== "boolean" || typeof key.notBefore !== "string" ||
      typeof key.notAfter !== "string" ||
      (key.privateKeyPem !== undefined && typeof key.privateKeyPem !== "string")
    ) throw new Error("AUTHORIZATION_EVENT_KEY_RING_INVALID");
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
