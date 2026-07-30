import { create, toBinary } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import type { CapabilityCatalogPublicationService } from
  "../../application/capability-catalog-publication-service.js";
import {
  ExecutionAssemblyError,
  type ExecutionAssemblyService,
} from "../../application/execution-assembly-service.js";
import { SecretNotResolvableError } from "../../domain/errors.js";
import type { CapabilityCatalogPublicationRecord } from
  "../../domain/capability-publication-repository.js";
import {
  CapabilityCatalogSnapshotSchema,
  CatalogProjectionState,
  FreezeCatalogEffectSchema,
  FreezeCatalogResponseSchema,
  FrozenCatalogPublicationSchema,
  FetchSkillArtifactResponseSchema,
  GetCatalogPublicationResponseSchema,
  HubCatalogService,
  HubRuntimeService,
  McpAssemblyConfigSchema,
  ResolveExecutionAssemblyResponseSchema,
  SignatureAlgorithm,
  SkillArtifactManifestSchema,
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
  assembly: Pick<ExecutionAssemblyService, "resolve" | "fetchArtifact">;
  caller: Readonly<{ resolve(context: HandlerContext): Readonly<{ identity: string }> }>;
  agentCallerIdentity: string;
}>): HubRuntimeConnectService {
  requireIdentity(input.agentCallerIdentity);
  return {
    resolveExecutionAssembly: (request, context) => safeAssembly(async () => {
      authorize(context, input.caller, input.agentCallerIdentity);
      const result = await input.assembly.resolve({
        namespace: request.namespace,
        agentCatalogRef: request.agentCatalogRef,
        skills: request.skillGrants.map((grant) => ({
          optionRef: grant.optionRef,
          scope: grant.scope,
          name: grant.name,
          contentHash: grant.contentHash,
          description: grant.description,
        })),
        mcpServers: request.mcpGrants.map((grant) => {
          const revision = Number(grant.revision);
          if (!Number.isSafeInteger(revision) || revision < 1) {
            throw new ExecutionAssemblyError("HUB_EXECUTION_ASSEMBLY_REQUEST_INVALID");
          }
          return {
            optionRef: grant.optionRef,
            scope: grant.scope,
            name: grant.name,
            revision,
            configHash: grant.configHash,
          };
        }),
      });
      return create(ResolveExecutionAssemblyResponseSchema, {
        agentCatalogRef: result.agentCatalogRef,
        assemblyDigest: result.assemblyDigest,
        skills: result.skills.map((skill) => create(SkillArtifactManifestSchema, {
          optionRef: skill.optionRef,
          scope: skill.scope,
          name: skill.name,
          contentHash: skill.contentHash,
          description: skill.description,
          artifactRef: skill.artifactRef,
          artifactSize: BigInt(skill.artifactSize),
          artifactSha256: skill.artifactSha256,
        })),
        mcpServers: result.mcpServers.map((server) => create(McpAssemblyConfigSchema, {
          optionRef: server.optionRef,
          scope: server.scope,
          name: server.name,
          revision: BigInt(server.revision),
          configHash: server.configHash,
          transport: server.transport,
          url: server.url,
          allowedTools: [...server.allowedTools],
          ...(server.authorizationValue === undefined
            ? {} : { authorizationValue: server.authorizationValue }),
        })),
      });
    }),
    fetchSkillArtifact: async function* (request, context) {
      authorize(context, input.caller, input.agentCallerIdentity);
      try {
        if (request.grant === undefined) {
          throw new ExecutionAssemblyError("HUB_SKILL_ARTIFACT_REQUEST_INVALID");
        }
        const expectedSize = Number(request.expectedSize);
        if (!Number.isSafeInteger(expectedSize)) {
          throw new ExecutionAssemblyError("HUB_SKILL_ARTIFACT_REQUEST_INVALID");
        }
        const data = await input.assembly.fetchArtifact({
          namespace: request.namespace,
          agentCatalogRef: request.agentCatalogRef,
          grant: {
            optionRef: request.grant.optionRef,
            scope: request.grant.scope,
            name: request.grant.name,
            contentHash: request.grant.contentHash,
            description: request.grant.description,
          },
          artifactRef: request.artifactRef,
          expectedSize,
          expectedSha256: request.expectedSha256,
        });
        for (let offset = 0; offset < data.byteLength; offset += 64 * 1024) {
          yield create(FetchSkillArtifactResponseSchema, {
            artifactRef: request.artifactRef,
            offset: BigInt(offset),
            data: new Uint8Array(data.subarray(offset, offset + 64 * 1024)),
          });
        }
      } catch (error) {
        throw mapAssemblyError(error);
      }
    },
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

async function safeAssembly<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    throw mapAssemblyError(error);
  }
}

function mapAssemblyError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (error instanceof SecretNotResolvableError) {
    return new ConnectError("execution assembly unavailable", Code.FailedPrecondition);
  }
  if (error instanceof ExecutionAssemblyError) {
    if (error.code.endsWith("REQUEST_INVALID")) {
      return new ConnectError("execution assembly request invalid", Code.InvalidArgument);
    }
    if (error.code.includes("CATALOG_NOT_FOUND") || error.code.includes("NOT_AUTHORIZED") ||
        error.code.includes("CAPABILITY_REVOKED") || error.code.includes("SELECTION_INVALID") ||
        error.code.includes("NOT_RESOLVABLE")) {
      return new ConnectError("execution assembly unavailable", Code.FailedPrecondition);
    }
  }
  return new ConnectError("execution assembly service unavailable", Code.Unavailable);
}
