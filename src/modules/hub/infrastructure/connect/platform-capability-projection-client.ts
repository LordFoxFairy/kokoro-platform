import { create, toBinary } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { createHash } from "node:crypto";
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { createConnectTransport, type ConnectTransportOptions } from "@connectrpc/connect-node";
import {
  CapabilityProjectionDeliveryError,
  type CapabilityProjectionDelivery,
  type PlatformCapabilityProjectionClient,
} from "@kokoro/hub";
import {
  CapabilityCatalogProjectionService,
  CapabilityCatalogSnapshotSchema,
  CatalogProjectionState,
  FrozenCatalogPublicationSchema,
  SignatureAlgorithm,
} from "../../../../generated/proto/kokoro/platform/capability/v1/capability_catalog_pb.js";
import {
  CommandDigestAlgorithm,
  CommandReceiptState,
} from "../../../../generated/proto/kokoro/common/v1/receipt_pb.js";

export { CapabilityProjectionDeliveryError } from "@kokoro/hub";

export type PlatformCapabilityProjectionMtlsConfig = Readonly<{
  baseUrl: string;
  serverName: string;
  certificatePem: string;
  privateKeyPem: string;
  certificateAuthorityPem: string;
  timeoutMs?: number;
}>;

export function createPlatformCapabilityProjectionClientForTransport(
  transport: Transport,
): PlatformCapabilityProjectionClient {
  const client = createClient(CapabilityCatalogProjectionService, transport);
  return Object.freeze({
    async project(delivery: CapabilityProjectionDelivery, signal: AbortSignal): Promise<void> {
      const publication = wirePublication(delivery);
      const commandId = projectionCommandId(delivery);
      const idempotencyKey = `hub-projection:${delivery.publication.agentCatalogRef}`;
      const requestDigest = projectionRequestDigest(publication);
      try {
        const response = await client.projectCatalog({
          command: {
            commandId,
            idempotencyKey,
            digestAlgorithm: CommandDigestAlgorithm.SHA256_PROTOBUF_V1,
            requestDigest,
          },
          publication,
        }, { signal });
        assertCommitted(response, delivery, commandId, idempotencyKey, requestDigest);
        return;
      } catch (error) {
        if (terminal(error)) {
          throw new CapabilityProjectionDeliveryError("rejected", stableErrorCode(error));
        }
        if (signal.aborted) throw new CapabilityProjectionDeliveryError("retry", "PROJECTION_CANCELED");
      }

      // The effect may have committed even though the response was lost. Reconcile the exact
      // fenced command and never issue a second identity.
      try {
        const recovered = await client.getProjectionReceipt({
          commandId,
          idempotencyKey,
          digestAlgorithm: CommandDigestAlgorithm.SHA256_PROTOBUF_V1,
          requestDigest,
          siteId: delivery.publication.siteId,
        }, { signal });
        if (recovered.projectionState !== CatalogProjectionState.COMMITTED ||
            recovered.agentCatalogRef !== delivery.publication.agentCatalogRef ||
            recovered.receipt?.identity?.commandId !== commandId ||
            recovered.receipt.identity.idempotencyKey !== idempotencyKey ||
            recovered.receipt.identity.requestDigest !== requestDigest ||
            recovered.receipt.identity.digestAlgorithm !== CommandDigestAlgorithm.SHA256_PROTOBUF_V1 ||
            recovered.receipt.operation !== "capability_catalog.project" ||
            recovered.receipt.state !== CommandReceiptState.COMMITTED) {
          throw new CapabilityProjectionDeliveryError("rejected", "PROJECTION_RECEIPT_MISMATCH");
        }
      } catch (error) {
        if (error instanceof CapabilityProjectionDeliveryError) throw error;
        if (terminal(error) && error instanceof ConnectError && error.code !== Code.NotFound) {
          throw new CapabilityProjectionDeliveryError("rejected", stableErrorCode(error));
        }
        throw new CapabilityProjectionDeliveryError(
          "retry",
          signal.aborted ? "PROJECTION_CANCELED" : "PROJECTION_OUTCOME_UNKNOWN",
        );
      }
    },
  });
}

export function createPlatformCapabilityProjectionClient(
  config: PlatformCapabilityProjectionMtlsConfig,
): PlatformCapabilityProjectionClient {
  return createPlatformCapabilityProjectionClientForTransport(
    createConnectTransport(buildProjectionTransportOptions(config)),
  );
}

export function buildProjectionTransportOptions(
  config: PlatformCapabilityProjectionMtlsConfig,
): ConnectTransportOptions {
  let parsed: URL;
  try { parsed = new URL(config.baseUrl); } catch {
    throw new Error("HUB_PLATFORM_PROJECTION_MTLS_CONFIG_INVALID");
  }
  const timeoutMs = config.timeoutMs ?? 5_000;
  const baseUrl = parsed.href.endsWith("/") ? parsed.href.slice(0, -1) : parsed.href;
  const supplied = config.baseUrl.endsWith("/") ? config.baseUrl.slice(0, -1) : config.baseUrl;
  if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.username !== "" ||
      parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" || baseUrl !== supplied ||
      !hostname(config.serverName) || !certificate(config.certificatePem) ||
      !privateKey(config.privateKeyPem) || !certificate(config.certificateAuthorityPem) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) {
    throw new Error("HUB_PLATFORM_PROJECTION_MTLS_CONFIG_INVALID");
  }
  return {
    baseUrl,
    httpVersion: "2",
    useBinaryFormat: true,
    defaultTimeoutMs: timeoutMs,
    readMaxBytes: 2 * 1024 * 1024,
    writeMaxBytes: 2 * 1024 * 1024,
    acceptCompression: [],
    nodeOptions: {
      ca: config.certificateAuthorityPem,
      cert: config.certificatePem,
      key: config.privateKeyPem,
      servername: config.serverName,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
    },
  };
}

function wirePublication(delivery: CapabilityProjectionDelivery) {
  const value = delivery.publication;
  return create(FrozenCatalogPublicationSchema, {
    siteId: value.siteId,
    siteReleaseRef: value.siteReleaseRef,
    agentCatalogRef: value.agentCatalogRef,
    snapshotDigest: value.snapshotDigest,
    snapshot: create(CapabilityCatalogSnapshotSchema, {
      schemaVersion: 1,
      agentOptions: value.snapshot.agentOptions.map((item) => ({ ...item })),
      ...(value.snapshot.defaultAgentOptionRef === undefined
        ? {} : { defaultAgentOptionRef: value.snapshot.defaultAgentOptionRef }),
      tools: [...value.snapshot.tools],
      skillOptions: value.snapshot.skillOptions.map((item) => ({ ...item })),
      mcpOptions: value.snapshot.mcpOptions.map((item) => ({ ...item, revision: BigInt(item.revision) })),
      subagents: [...value.snapshot.subagents],
    }),
    frozenAt: timestampFromDate(new Date(value.frozenAt)),
    signingKeyRef: value.signingKeyRef,
    signatureAlgorithm: SignatureAlgorithm.ED25519_SHA256_V1,
    signaturePayloadDigest: value.signaturePayloadDigest,
    signature: new Uint8Array(value.signature),
  });
}

function projectionRequestDigest(publication: ReturnType<typeof wirePublication>): string {
  const hash = createHash("sha256");
  hash.update(FrozenCatalogPublicationSchema.typeName, "utf8");
  hash.update(Uint8Array.of(0));
  hash.update(toBinary(FrozenCatalogPublicationSchema, publication, { writeUnknownFields: false }));
  return hash.digest("hex");
}

function projectionCommandId(delivery: CapabilityProjectionDelivery): string {
  const digest = createHash("sha256")
    .update(delivery.publication.siteId)
    .update(Uint8Array.of(0))
    .update(delivery.publication.siteReleaseRef)
    .digest("hex");
  return `hub-projection:${digest}`;
}

function assertCommitted(
  response: Readonly<{
    projectionState: CatalogProjectionState;
    agentCatalogRef: string;
    receipt?: Readonly<{
      identity?: Readonly<{
        commandId: string;
        idempotencyKey: string;
        requestDigest: string;
        digestAlgorithm: CommandDigestAlgorithm;
      }> | undefined;
      state: CommandReceiptState;
      operation: string;
    }> | undefined;
  }>,
  delivery: CapabilityProjectionDelivery,
  commandId: string,
  idempotencyKey: string,
  requestDigest: string,
): void {
  const receipt = response.receipt;
  if (response.projectionState !== CatalogProjectionState.COMMITTED ||
      response.agentCatalogRef !== delivery.publication.agentCatalogRef || receipt?.identity === undefined ||
      receipt.identity.commandId !== commandId || receipt.identity.idempotencyKey !== idempotencyKey ||
      receipt.identity.requestDigest !== requestDigest ||
      receipt.identity.digestAlgorithm !== CommandDigestAlgorithm.SHA256_PROTOBUF_V1 ||
      receipt.operation !== "capability_catalog.project" ||
      receipt.state !== CommandReceiptState.COMMITTED) {
    throw new CapabilityProjectionDeliveryError("rejected", "PROJECTION_RESPONSE_MISMATCH");
  }
}

function terminal(error: unknown): boolean {
  if (error instanceof CapabilityProjectionDeliveryError) return error.disposition === "rejected";
  return error instanceof ConnectError && [
    Code.InvalidArgument,
    Code.PermissionDenied,
    Code.Unauthenticated,
    Code.FailedPrecondition,
    Code.AlreadyExists,
  ].includes(error.code);
}

function stableErrorCode(error: unknown): string {
  return error instanceof ConnectError ? `PROJECTION_CONNECT_${Code[error.code] ?? "ERROR"}`.toUpperCase()
    : error instanceof CapabilityProjectionDeliveryError ? error.stableCode
      : "PROJECTION_REJECTED";
}

function hostname(value: string): boolean {
  return value.length >= 1 && value.length <= 253 && value.trim() === value && !/[/:@\s]/u.test(value);
}
function certificate(value: string): boolean {
  return value.includes("-----BEGIN CERTIFICATE-----") && value.includes("-----END CERTIFICATE-----");
}
function privateKey(value: string): boolean {
  return value.includes("-----BEGIN PRIVATE KEY-----") && value.includes("-----END PRIVATE KEY-----");
}
