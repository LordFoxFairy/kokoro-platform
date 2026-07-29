import { AsyncLocalStorage } from "node:async_hooks";
import { createSecureServer, type Http2SecureServer, type SecureServerOptions } from "node:http2";
import type { Http2ServerRequest, Http2ServerResponse } from "node:http2";
import { TLSSocket } from "node:tls";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { PlatformTransactionalDatabaseClient } from "../infrastructure/postgres/client.js";
import { resolvePlatformTransaction } from "../shared/unit-of-work/platform-transaction.js";
import { AdmissionService } from "../interfaces/connect/generated/kokoro/platform/admission/v1/admission_pb.js";
import { AdmissionApplicationService } from "../modules/admission/application/admission-service.js";
import type { AdmissionCaller, AdmissionOwnerAuthority } from "../modules/admission/application/admission-ports.js";
import {
  PlatformAdmissionOwnerAuthority,
  assertPlatformAdmissionOwnerPorts,
  type PlatformAdmissionOwnerPorts,
} from "../modules/admission/application/platform-admission-owner-authority.js";
import {
  GaRunRequestDraftFactory,
  type GaRunRequestDraftSealer,
} from "../modules/admission/application/ga-run-request-draft-factory.js";
import { HpkeGaRunRequestDraftSealer } from "../modules/admission/infrastructure/hpke/ga-run-request-draft-sealer.js";
import { PostgresAdmissionCommandJournal } from "../modules/admission/infrastructure/postgres/admission-command-journal.js";
import { PostgresAdmissionLifecycleOwner } from "../modules/admission/infrastructure/postgres/admission-lifecycle-owner.js";
import { PostgresAdmissionModelOwner } from "../modules/admission/infrastructure/postgres/admission-model-owner.js";
import {
  PostgresAdmissionCapabilityOwner,
  PostgresAdmissionRuntimePolicyOwner,
} from "../modules/admission/infrastructure/postgres/admission-runtime-owners.js";
import { PostgresAdmissionSiteOwner } from "../modules/admission/infrastructure/postgres/admission-site-owner.js";
import { createAdmissionConnectService } from "../modules/admission/interfaces/connect/admission-service.js";
import { readBoundedSecret } from "./platform-public-composition.js";

export interface AdmissionDraftComposition {
  readonly gaRunRequestDraftFactory: GaRunRequestDraftFactory;
}

export interface AdmissionApplicationComposition extends AdmissionDraftComposition {
  readonly application: AdmissionApplicationService;
}

/**
 * Required Admission application dependency. Production startup must provide a
 * real audience-bound sealer; there is no plaintext or development fallback.
 */
export function createAdmissionApplicationComposition(
  input: Readonly<{
    gaRunRequestDraftSealer: GaRunRequestDraftSealer;
    gaDispatchAudience: string;
  }>,
): AdmissionDraftComposition;
export function createAdmissionApplicationComposition(
  input: Readonly<{
    gaRunRequestDraftSealer: GaRunRequestDraftSealer;
    gaDispatchAudience: string;
    authority: AdmissionOwnerAuthority;
    journal: ConstructorParameters<typeof AdmissionApplicationService>[0]["journal"];
    clock?: () => Date;
  }>,
): AdmissionApplicationComposition;
export function createAdmissionApplicationComposition(
  input: Readonly<{
    gaRunRequestDraftSealer: GaRunRequestDraftSealer;
    gaDispatchAudience: string;
    authority?: AdmissionOwnerAuthority;
    journal?: ConstructorParameters<typeof AdmissionApplicationService>[0]["journal"];
    clock?: () => Date;
  }>,
): AdmissionDraftComposition | AdmissionApplicationComposition {
  if (input.gaRunRequestDraftSealer === undefined || input.gaRunRequestDraftSealer === null) {
    throw new Error("ADMISSION_GA_DRAFT_SEALER_REQUIRED");
  }
  const gaRunRequestDraftFactory = new GaRunRequestDraftFactory({
      sealer: input.gaRunRequestDraftSealer,
      expectedAudience: input.gaDispatchAudience,
      ...(input.clock === undefined ? {} : { clock: input.clock }),
    });
  if (input.authority === undefined && input.journal === undefined) {
    return Object.freeze({ gaRunRequestDraftFactory });
  }
  if (input.authority === undefined || input.journal === undefined) {
    throw new Error("ADMISSION_APPLICATION_DEPENDENCIES_REQUIRED");
  }
  return Object.freeze({ gaRunRequestDraftFactory, application: new AdmissionApplicationService({
      authority: input.authority,
      journal: input.journal,
      gaRunRequestDraftFactory,
      ...(input.clock === undefined ? {} : { clock: input.clock }),
    }),
  });
}

export type AdmissionRequestListener = (
  request: Http2ServerRequest,
  response: Http2ServerResponse,
) => void;

export interface AdmissionProductionComposition {
  readonly handler: AdmissionRequestListener;
  createServer(listener: AdmissionRequestListener): Http2SecureServer;
}

export type AdmissionProductionOwnerPorts = Omit<
  PlatformAdmissionOwnerPorts,
  "unitOfWork" | "lifecycle" | "site" | "model" | "runtimePolicy" | "capability"
>;

/**
 * Production owns the Admission orchestration and transaction boundary. Runtime
 * composition may provide concrete owner adapters, but cannot replace the
 * authority with an alternate implementation.
 */
export function createPlatformAdmissionOwnerAuthority(input: Readonly<{
  database: Pick<PlatformTransactionalDatabaseClient, "internalTransaction">;
  ownerPorts: AdmissionProductionOwnerPorts;
  clock?: () => Date;
}>): PlatformAdmissionOwnerAuthority {
  const ports: PlatformAdmissionOwnerPorts = {
    ...input.ownerPorts,
    site: new PostgresAdmissionSiteOwner(),
    model: new PostgresAdmissionModelOwner(),
    runtimePolicy: new PostgresAdmissionRuntimePolicyOwner(),
    capability: new PostgresAdmissionCapabilityOwner(),
    lifecycle: new PostgresAdmissionLifecycleOwner(),
    unitOfWork: {
      execute: (command, work) => input.database.internalTransaction(
        "admission.command",
        async (transaction) => {
          await resolvePlatformTransaction(transaction).query(
            `SELECT set_config('app.site_id',$1,true),
                    set_config('app.caller_identity',$2,true)`,
            [command.siteId, command.caller.identity],
          );
          return work(transaction);
        },
      ),
    },
  };
  assertPlatformAdmissionOwnerPorts(ports);
  return new PlatformAdmissionOwnerAuthority({
    ports,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
}

/**
 * Production Admission is a private HTTP/2 Connect service. The outer listener
 * authenticates the exact client certificate and scopes the caller before any
 * protobuf handler can execute.
 */
export async function createAdmissionProductionComposition(input: Readonly<{
  database: Pick<PlatformTransactionalDatabaseClient, "internalTransaction">;
  ownerPorts: AdmissionProductionOwnerPorts;
  gaDispatchAudience: string;
  environment?: Readonly<Record<string, string | undefined>>;
  clock?: () => Date;
}>): Promise<AdmissionProductionComposition> {
  const environment = input.environment ?? process.env;
  const [tls, peerRegistry, gaRunRequestDraftSealer] = await Promise.all([
    loadAdmissionTls(environment),
    loadAdmissionPeers(
      required(environment, "PLATFORM_ADMISSION_MTLS_PEERS_FILE"),
      required(environment, "PLATFORM_ADMISSION_ENVIRONMENT"),
      required(environment, "PLATFORM_ADMISSION_REGION"),
    ),
    loadAdmissionHpkeSealer(
      required(environment, "PLATFORM_ADMISSION_HPKE_PUBLIC_KEY_RING_FILE"),
      input.gaDispatchAudience,
      input.clock,
    ),
  ]);
  const callers = new AsyncLocalStorage<AdmissionCaller>();
  const authority = createPlatformAdmissionOwnerAuthority({
    database: input.database,
    ownerPorts: input.ownerPorts,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  const application = createAdmissionApplicationComposition({
    authority,
    journal: new PostgresAdmissionCommandJournal(input.database, {
      ...(input.clock === undefined ? {} : { clock: input.clock }),
    }),
    gaRunRequestDraftSealer,
    gaDispatchAudience: input.gaDispatchAudience,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  }).application;
  const service = createAdmissionConnectService({
    application,
    caller: {
      resolve: () => {
        const caller = callers.getStore();
        if (caller === undefined) throw new Error("ADMISSION_VERIFIED_CALLER_REQUIRED");
        return caller;
      },
    },
  });
  const connect = connectNodeAdapter({
    routes: (router) => router.service(AdmissionService, service),
    connect: true,
    grpc: false,
    grpcWeb: false,
    acceptCompression: [],
    readMaxBytes: 1024 * 1024,
    writeMaxBytes: 2 * 1024 * 1024,
    maxTimeoutMs: 30_000,
  });
  const handler: AdmissionRequestListener = (request, response) => {
    const caller = authenticateAdmissionPeer(request, peerRegistry);
    if (caller === null) {
      response.statusCode = 401;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("unauthorized");
      return;
    }
    callers.run(caller, () => {
      Promise.resolve(connect(request, response)).catch(() => {
        if (!response.headersSent) {
          response.statusCode = 503;
          response.setHeader("content-type", "text/plain; charset=utf-8");
          response.end("unavailable");
        } else {
          response.destroy();
        }
      });
    });
  };
  return Object.freeze({
    handler,
    createServer: (listener: AdmissionRequestListener) => createSecureServer(tls, listener),
  });
}

async function loadAdmissionHpkeSealer(
  path: string,
  expectedAudience: string,
  clock: (() => Date) | undefined,
): Promise<HpkeGaRunRequestDraftSealer> {
  let keyRing: unknown;
  try {
    keyRing = JSON.parse(await readBoundedSecret(path, 256 * 1024));
  } catch {
    throw new Error("PLATFORM_ADMISSION_HPKE_PUBLIC_KEY_RING_INVALID");
  }
  return HpkeGaRunRequestDraftSealer.create({
    keyRing,
    expectedAudience,
    ...(clock === undefined ? {} : { clock }),
  });
}

interface AdmissionPeer extends AdmissionCaller {
  readonly fingerprint256: string;
  readonly sanUri: string;
}

async function loadAdmissionPeers(
  path: string,
  environment: string,
  region: string,
): Promise<readonly AdmissionPeer[]> {
  const parsed = JSON.parse(await readBoundedSecret(path, 256 * 1024)) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PLATFORM_ADMISSION_MTLS_PEERS_INVALID");
  }
  const root = parsed as Record<string, unknown>;
  if (Object.keys(root).sort().join(",") !== "peers,version" || root.version !== 1 || !Array.isArray(root.peers)) {
    throw new Error("PLATFORM_ADMISSION_MTLS_PEERS_INVALID");
  }
  const identities = new Set<string>();
  const peers = root.peers.map((raw): AdmissionPeer => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("PLATFORM_ADMISSION_MTLS_PEERS_INVALID");
    }
    const peer = raw as Record<string, unknown>;
    if (
      Object.keys(peer).sort().join(",") !== "fingerprint256,sanUri" ||
      typeof peer.fingerprint256 !== "string" ||
      !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u.test(peer.fingerprint256) ||
      typeof peer.sanUri !== "string" || !peer.sanUri.startsWith("spiffe://") ||
      identities.has(peer.sanUri)
    ) throw new Error("PLATFORM_ADMISSION_MTLS_PEERS_INVALID");
    identities.add(peer.sanUri);
    return Object.freeze({
      identity: peer.sanUri,
      environment,
      region,
      fingerprint256: peer.fingerprint256,
      sanUri: peer.sanUri,
    });
  });
  if (peers.length < 1 || peers.length > 32) throw new Error("PLATFORM_ADMISSION_MTLS_PEERS_INVALID");
  return Object.freeze(peers);
}

function authenticateAdmissionPeer(
  request: Http2ServerRequest,
  peers: readonly AdmissionPeer[],
): AdmissionCaller | null {
  const socket = request.socket;
  if (!(socket instanceof TLSSocket) || socket.authorized !== true || socket.authorizationError != null) return null;
  const certificate = socket.getPeerCertificate();
  const now = Date.now();
  const validFrom = Date.parse(certificate.valid_from);
  const validTo = Date.parse(certificate.valid_to);
  if (
    !certificate.fingerprint256 || !certificate.subjectaltname ||
    !Number.isFinite(validFrom) || !Number.isFinite(validTo) || validFrom > now || validTo <= now
  ) return null;
  const sanUris = certificate.subjectaltname.split(/,\s*/u)
    .filter((entry) => entry.startsWith("URI:"))
    .map((entry) => entry.slice(4));
  const peer = peers.find((candidate) =>
    candidate.fingerprint256 === certificate.fingerprint256 && sanUris.includes(candidate.sanUri));
  return peer === undefined
    ? null
    : Object.freeze({ identity: peer.identity, environment: peer.environment, region: peer.region });
}

async function loadAdmissionTls(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<SecureServerOptions> {
  const [key, cert, ca] = await Promise.all([
    readBoundedSecret(required(environment, "PLATFORM_ADMISSION_TLS_KEY_FILE"), 64 * 1024),
    readBoundedSecret(required(environment, "PLATFORM_ADMISSION_TLS_CERT_FILE"), 64 * 1024),
    readBoundedSecret(required(environment, "PLATFORM_ADMISSION_TLS_CLIENT_CA_FILE"), 256 * 1024),
  ]);
  if (!key.includes("BEGIN PRIVATE KEY") || !cert.includes("BEGIN CERTIFICATE") || !ca.includes("BEGIN CERTIFICATE")) {
    throw new Error("PLATFORM_ADMISSION_TLS_MATERIAL_INVALID");
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

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
