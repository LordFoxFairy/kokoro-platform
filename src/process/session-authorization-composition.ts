import { createSecureServer, type Http2SecureServer, type SecureServerOptions } from "node:http2";
import type { Http2ServerRequest, Http2ServerResponse } from "node:http2";
import { TLSSocket } from "node:tls";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { PlatformTransactionalDatabaseClient } from "../infrastructure/postgres/client.js";
import { createSessionAuthorizationFeedService } from "../interfaces/connect/session-authorization.js";
import { SessionAuthorizationService } from "../interfaces/connect/generated-authorization/kokoro/platform/authorization/v1/session_authorization_pb.js";
import {
  createSessionAuthorizationVerificationKeySet,
  type AuthorizationPublicVerificationKeyConfig,
} from "../modules/authorization/infrastructure/jose/session-authorization-verification-key-set.js";
import { PostgresAuthorizationFeedRepository } from "../modules/authorization/infrastructure/postgres/authorization-feed-repository.js";
import { readBoundedSecret } from "./platform-public-composition.js";

export type SessionAuthorizationRequestListener = (
  request: Http2ServerRequest,
  response: Http2ServerResponse,
) => void;

export interface SessionAuthorizationProductionComposition {
  readonly handler: SessionAuthorizationRequestListener;
  createServer(listener: SessionAuthorizationRequestListener): Http2SecureServer;
}

export async function createSessionAuthorizationProductionComposition(input: Readonly<{
  database: PlatformTransactionalDatabaseClient;
  environment?: Readonly<Record<string, string | undefined>>;
}>): Promise<SessionAuthorizationProductionComposition> {
  const environment = input.environment ?? process.env;
  const [eventKeys, grantKeys, tls, peers, cursorSecret] = await Promise.all([
    loadAuthorizationVerificationKeys(
      required(environment, "PLATFORM_AUTHORIZATION_EVENT_VERIFICATION_KEY_SET_FILE"),
      "event_signing",
    ),
    loadAuthorizationVerificationKeys(
      required(environment, "PLATFORM_SESSION_ACCESS_VERIFICATION_KEY_SET_FILE"),
      "session_access_grant",
    ),
    loadTls(environment),
    loadPeers(required(environment, "PLATFORM_AUTHORIZATION_MTLS_PEERS_FILE")),
    loadCursorSecret(required(environment, "PLATFORM_AUTHORIZATION_CURSOR_SECRET_FILE")),
  ]);
  const verificationKeySet = await createSessionAuthorizationVerificationKeySet([
    ...eventKeys,
    ...grantKeys,
  ]);
  const repository = new PostgresAuthorizationFeedRepository();
  const service = createSessionAuthorizationFeedService({
    database: input.database,
    repository,
    verificationKeySet,
    cursorSecret,
  });
  const connect = connectNodeAdapter({
    routes: (router) => router.service(SessionAuthorizationService, service),
    connect: true,
    grpc: false,
    grpcWeb: false,
    acceptCompression: [],
    readMaxBytes: 32 * 1024,
    writeMaxBytes: 8 * 1024 * 1024,
    maxTimeoutMs: 30_000,
  });
  const handler: SessionAuthorizationRequestListener = (request, response) => {
    if (!authorizedPeer(request, peers)) {
      response.statusCode = 401;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("unauthorized");
      return;
    }
    Promise.resolve(connect(request, response)).catch(() => {
      if (!response.headersSent) {
        response.statusCode = 503;
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.end("unavailable");
      } else {
        response.destroy();
      }
    });
  };
  return Object.freeze({
    handler,
    createServer: (listener: SessionAuthorizationRequestListener) => createSecureServer(tls, listener),
  });
}

type Peer = Readonly<{ fingerprint256: string; sanUri: string }>;

async function loadPeers(path: string): Promise<readonly Peer[]> {
  const parsed = JSON.parse(await readBoundedSecret(path, 256 * 1024)) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PLATFORM_AUTHORIZATION_MTLS_PEERS_INVALID");
  }
  const root = parsed as Record<string, unknown>;
  if (Object.keys(root).sort().join(",") !== "peers,version" || root.version !== 1 || !Array.isArray(root.peers)) {
    throw new Error("PLATFORM_AUTHORIZATION_MTLS_PEERS_INVALID");
  }
  const identities = new Set<string>();
  const peers = root.peers.map((entry): Peer => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("PLATFORM_AUTHORIZATION_MTLS_PEERS_INVALID");
    }
    const peer = entry as Record<string, unknown>;
    if (
      Object.keys(peer).sort().join(",") !== "fingerprint256,sanUri" ||
      typeof peer.fingerprint256 !== "string" || !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u.test(peer.fingerprint256) ||
      typeof peer.sanUri !== "string" || !peer.sanUri.startsWith("spiffe://") ||
      identities.has(`${peer.fingerprint256}\0${peer.sanUri}`)
    ) throw new Error("PLATFORM_AUTHORIZATION_MTLS_PEERS_INVALID");
    identities.add(`${peer.fingerprint256}\0${peer.sanUri}`);
    return Object.freeze({ fingerprint256: peer.fingerprint256, sanUri: peer.sanUri });
  });
  if (peers.length < 1 || peers.length > 32) throw new Error("PLATFORM_AUTHORIZATION_MTLS_PEERS_INVALID");
  return Object.freeze(peers);
}

function authorizedPeer(request: Http2ServerRequest, peers: readonly Peer[]): boolean {
  const socket = request.socket;
  if (!(socket instanceof TLSSocket) || socket.authorized !== true || socket.authorizationError != null) return false;
  const certificate = socket.getPeerCertificate();
  const now = Date.now();
  const validFrom = Date.parse(certificate.valid_from);
  const validTo = Date.parse(certificate.valid_to);
  if (
    !certificate.fingerprint256 || !certificate.subjectaltname ||
    !Number.isFinite(validFrom) || !Number.isFinite(validTo) || validFrom > now || validTo <= now
  ) return false;
  const sanUris = certificate.subjectaltname.split(/,\s*/u)
    .filter((entry) => entry.startsWith("URI:"))
    .map((entry) => entry.slice(4));
  return peers.some((peer) =>
    peer.fingerprint256 === certificate.fingerprint256 && sanUris.includes(peer.sanUri));
}

async function loadTls(environment: Readonly<Record<string, string | undefined>>): Promise<SecureServerOptions> {
  const [key, cert, ca] = await Promise.all([
    readBoundedSecret(required(environment, "PLATFORM_AUTHORIZATION_TLS_KEY_FILE"), 64 * 1024),
    readBoundedSecret(required(environment, "PLATFORM_AUTHORIZATION_TLS_CERT_FILE"), 64 * 1024),
    readBoundedSecret(required(environment, "PLATFORM_AUTHORIZATION_TLS_CLIENT_CA_FILE"), 256 * 1024),
  ]);
  if (!key.includes("BEGIN PRIVATE KEY") || !cert.includes("BEGIN CERTIFICATE") || !ca.includes("BEGIN CERTIFICATE")) {
    throw new Error("PLATFORM_AUTHORIZATION_TLS_MATERIAL_INVALID");
  }
  return Object.freeze({
    key,
    cert,
    ca,
    requestCert: true,
    rejectUnauthorized: true,
    allowHTTP1: false,
    minVersion: "TLSv1.3",
  });
}

async function loadCursorSecret(path: string): Promise<Uint8Array> {
  const raw = await readBoundedSecret(path, 256);
  const encoded = raw.trim();
  if (!/^[A-Za-z0-9_-]{43,172}$/u.test(encoded)) throw new Error("PLATFORM_AUTHORIZATION_CURSOR_SECRET_INVALID");
  const value = Buffer.from(encoded, "base64url");
  if (
    value.byteLength < 32 || value.byteLength > 128 || value.toString("base64url") !== encoded
  ) throw new Error("PLATFORM_AUTHORIZATION_CURSOR_SECRET_INVALID");
  return new Uint8Array(value);
}

export async function loadAuthorizationVerificationKeys(
  path: string,
  expectedPurpose: AuthorizationPublicVerificationKeyConfig["purpose"],
): Promise<readonly AuthorizationPublicVerificationKeyConfig[]> {
  const parsed = JSON.parse(await readBoundedSecret(path, 512 * 1024)) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AUTHORIZATION_VERIFICATION_KEY_SET_INVALID");
  }
  const root = parsed as Record<string, unknown>;
  if (
    Object.keys(root).sort().join(",") !== "keys,purpose,version" || root.version !== 1 ||
    root.purpose !== expectedPurpose || !Array.isArray(root.keys)
  ) throw new Error("AUTHORIZATION_VERIFICATION_KEY_SET_INVALID");
  return Object.freeze(root.keys.map((raw): AuthorizationPublicVerificationKeyConfig => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("AUTHORIZATION_VERIFICATION_KEY_SET_INVALID");
    }
    const key = raw as Record<string, unknown>;
    if (
      Object.keys(key).sort().join(",") !== "current,keyRevision,notAfter,notBefore,publicKeyPem" ||
      typeof key.keyRevision !== "string" || typeof key.publicKeyPem !== "string" ||
      typeof key.current !== "boolean" || typeof key.notBefore !== "string" ||
      typeof key.notAfter !== "string"
    ) throw new Error("AUTHORIZATION_VERIFICATION_KEY_SET_INVALID");
    return Object.freeze({
      purpose: expectedPurpose,
      keyRevision: key.keyRevision,
      publicKeyPem: key.publicKeyPem,
      current: key.current,
      notBefore: key.notBefore,
      notAfter: key.notAfter,
    });
  }));
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
