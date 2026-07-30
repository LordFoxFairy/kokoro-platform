import { create, toBinary } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import type { CapabilityCatalogPublicationService } from
  "../../application/capability-catalog-publication-service.js";
import type { McpSecretService } from "../../application/mcp-secret-service.js";
import { SecretNotResolvableError } from "../../domain/errors.js";
import type { CapabilityCatalogPublicationRecord } from
  "../../domain/capability-publication-repository.js";
import {
  CapabilityCatalogSnapshotSchema,
  CatalogProjectionState,
  FreezeCatalogEffectSchema,
  FreezeCatalogResponseSchema,
  FrozenCatalogPublicationSchema,
  GetCatalogPublicationResponseSchema,
  HubCatalogService,
  HubRuntimeService,
  McpSecretMaterialSchema,
  ResolveMcpSecretsResponseSchema,
  SignatureAlgorithm,
  type CapabilityCatalogSnapshot,
  type FreezeCatalogEffect,
  type FrozenCatalogPublication,
} from "./generated-capability-catalog/kokoro/platform/capability/v1/capability_catalog_pb.js";
import {
  CommandDigestAlgorithm,
  CommandReceiptSchema,
  CommandReceiptState,
} from "./generated-capability-catalog/kokoro/common/v1/receipt_pb.js";
import { createHash } from "node:crypto";

export type HubCatalogConnectService = ServiceImpl<typeof HubCatalogService>;
export type HubRuntimeConnectService = ServiceImpl<typeof HubRuntimeService>;

export function freezeCatalogRequestDigest(effect: FreezeCatalogEffect): string {
  const hash = createHash("sha256");
  hash.update(FreezeCatalogEffectSchema.typeName, "utf8");
  hash.update(Uint8Array.of(0));
  hash.update(toBinary(FreezeCatalogEffectSchema, effect, { writeUnknownFields: false }));
  return hash.digest("hex");
}

export function createHubCatalogConnectService(input: Readonly<{
  publication: Pick<CapabilityCatalogPublicationService, "freeze" | "get">;
  caller: Readonly<{ resolve(context: HandlerContext): Readonly<{ identity: string }> }>;
  platformCallerIdentity: string;
}>): HubCatalogConnectService {
  requireIdentity(input.platformCallerIdentity);
  return {
    freezeCatalog: (request, context) => safe(async () => {
      authorize(context, input.caller, input.platformCallerIdentity);
      if (request.command === undefined || request.effect?.snapshot === undefined ||
          request.command.digestAlgorithm !== CommandDigestAlgorithm.SHA256_PROTOBUF_V1 ||
          request.command.requestDigest !== freezeCatalogRequestDigest(request.effect)) {
        throw new ConnectError("catalog freeze command invalid", Code.InvalidArgument);
      }
      const record = await input.publication.freeze({
        commandId: request.command.commandId,
        idempotencyKey: request.command.idempotencyKey,
        requestDigest: request.command.requestDigest,
        siteId: request.effect.siteId,
        siteReleaseRef: request.effect.siteReleaseRef,
        snapshot: mapSnapshot(request.effect.snapshot),
      });
      return create(FreezeCatalogResponseSchema, {
        receipt: receipt(record),
        publication: publication(record),
        projectionState: projectionState(record.projectionState),
        replayed: record.replayed,
      });
    }),
    getCatalogPublication: (request, context) => safe(async () => {
      authorize(context, input.caller, input.platformCallerIdentity);
      if (request.digestAlgorithm !== CommandDigestAlgorithm.SHA256_PROTOBUF_V1) {
        throw new ConnectError("catalog publication query invalid", Code.InvalidArgument);
      }
      const record = await input.publication.get(request);
      if (record === null) throw new ConnectError("catalog publication not found", Code.NotFound);
      return create(GetCatalogPublicationResponseSchema, {
        receipt: receipt(record),
        publication: publication(record),
        projectionState: projectionState(record.projectionState),
        ...(record.lastProjectionErrorCode === undefined
          ? {} : { lastProjectionErrorCode: record.lastProjectionErrorCode }),
      });
    }),
  };
}

export function createHubRuntimeConnectService(input: Readonly<{
  secrets: Pick<McpSecretService, "resolve">;
  caller: Readonly<{ resolve(context: HandlerContext): Readonly<{ identity: string }> }>;
  agentCallerIdentity: string;
}>): HubRuntimeConnectService {
  requireIdentity(input.agentCallerIdentity);
  return {
    resolveMcpSecrets: (request, context) => safeSecret(async () => {
      authorize(context, input.caller, input.agentCallerIdentity);
      if (!reference(request.namespace, 256) || request.handles.length < 1 || request.handles.length > 128 ||
          new Set(request.handles).size !== request.handles.length ||
          request.handles.some((handle) => !/^srt_[0-9a-f]{32}$/u.test(handle))) {
        throw new ConnectError("MCP secret request invalid", Code.InvalidArgument);
      }
      const values = await input.secrets.resolve(request.namespace, request.handles);
      return create(ResolveMcpSecretsResponseSchema, {
        secrets: request.handles.map((handle) => {
          const value = values[handle];
          if (value === undefined || value.length < 1 || Buffer.byteLength(value, "utf8") > 8_192) {
            throw new Error("MCP_SECRET_NOT_RESOLVABLE");
          }
          return create(McpSecretMaterialSchema, { handle, value });
        }),
      });
    }),
  };
}

function mapSnapshot(snapshot: CapabilityCatalogSnapshot): object {
  return {
    schemaVersion: snapshot.schemaVersion,
    agentOptions: snapshot.agentOptions.map(({ optionRef, agent, label }) => ({ optionRef, agent, label })),
    ...(snapshot.defaultAgentOptionRef === undefined
      ? {} : { defaultAgentOptionRef: snapshot.defaultAgentOptionRef }),
    tools: [...snapshot.tools],
    skillOptions: snapshot.skillOptions.map((item) => ({
      optionRef: item.optionRef,
      label: item.label,
      name: item.name,
      contentHash: item.contentHash,
      description: item.description,
      scope: item.scope,
      ...(item.prerequisiteRef === undefined ? {} : { prerequisiteRef: item.prerequisiteRef }),
    })),
    mcpOptions: snapshot.mcpOptions.map((item) => {
      const revision = Number(item.revision);
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new ConnectError("catalog snapshot invalid", Code.InvalidArgument);
      }
      return {
        optionRef: item.optionRef,
        label: item.label,
        scope: item.scope,
        name: item.name,
        revision,
        configHash: item.configHash,
        ...(item.prerequisiteRef === undefined ? {} : { prerequisiteRef: item.prerequisiteRef }),
      };
    }),
    subagents: [...snapshot.subagents],
  };
}

function publication(record: CapabilityCatalogPublicationRecord): FrozenCatalogPublication {
  const value = record.publication;
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

function receipt(record: CapabilityCatalogPublicationRecord) {
  return create(CommandReceiptSchema, {
    identity: {
      commandId: record.commandId,
      idempotencyKey: record.idempotencyKey,
      digestAlgorithm: CommandDigestAlgorithm.SHA256_PROTOBUF_V1,
      requestDigest: record.requestDigest,
    },
    operation: "capability_catalog.freeze",
    state: CommandReceiptState.COMMITTED,
    recordedAt: timestampFromDate(new Date(record.recordedAt)),
  });
}

function projectionState(value: CapabilityCatalogPublicationRecord["projectionState"]): CatalogProjectionState {
  return value === "pending" ? CatalogProjectionState.PENDING
    : value === "committed" ? CatalogProjectionState.COMMITTED
      : value === "rejected" ? CatalogProjectionState.REJECTED
        : CatalogProjectionState.OUTCOME_UNKNOWN;
}

function authorize(
  context: HandlerContext,
  caller: Readonly<{ resolve(context: HandlerContext): Readonly<{ identity: string }> }>,
  expected: string,
): void {
  if (caller.resolve(context).identity !== expected) {
    throw new ConnectError("caller not authorized", Code.PermissionDenied);
  }
}

function requireIdentity(identity: string): void {
  if (!identity.startsWith("spiffe://") || identity.length > 512) {
    throw new Error("HUB_CONNECT_CALLER_IDENTITY_INVALID");
  }
}

function reference(value: string, maximum: number): boolean {
  return value.length >= 1 && value.length <= maximum && value.trim() === value;
}

async function safe<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    const code = error instanceof Error ? error.message : "";
    if (code.includes("INVALID") || code.includes("DUPLICATE") || code.includes("NOT_CURRENT") ||
        (error instanceof Error && error.name === "ZodError")) {
      throw new ConnectError("catalog freeze invalid", Code.InvalidArgument);
    }
    if (code.includes("CONFLICT")) throw new ConnectError("catalog freeze conflict", Code.AlreadyExists);
    throw new ConnectError("catalog service unavailable", Code.Unavailable);
  }
}

async function safeSecret<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    if (error instanceof SecretNotResolvableError) {
      throw new ConnectError("MCP secret material not resolvable", Code.NotFound);
    }
    throw new ConnectError("MCP secret service unavailable", Code.Unavailable);
  }
}
