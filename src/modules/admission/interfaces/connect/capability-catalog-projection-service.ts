import { createHash } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import {
  CapabilityCatalogProjectionService as ConnectDefinition,
  CatalogProjectionState,
  FrozenCatalogPublicationSchema,
  GetProjectionReceiptResponseSchema,
  ProjectCatalogResponseSchema,
  SignatureAlgorithm,
  type FrozenCatalogPublication,
} from "../../../../interfaces/connect/generated-capability-catalog/kokoro/platform/capability/v1/capability_catalog_pb.js";
import {
  CommandDigestAlgorithm,
  CommandReceiptSchema,
  CommandReceiptState,
} from "../../../../interfaces/connect/generated-capability-catalog/kokoro/common/v1/receipt_pb.js";
import type { CapabilityCatalogPublication } from
  "../../infrastructure/crypto/capability-publication-verifier.js";
import type { PostgresCapabilityCatalogProjectionRepository } from
  "../../infrastructure/postgres/capability-catalog-projection-repository.js";

export type CapabilityCatalogProjectionConnectService = ServiceImpl<typeof ConnectDefinition>;

export function capabilityProjectionRequestDigest(publication: FrozenCatalogPublication): string {
  const hash = createHash("sha256");
  hash.update(FrozenCatalogPublicationSchema.typeName, "utf8");
  hash.update(Uint8Array.of(0));
  hash.update(toBinary(FrozenCatalogPublicationSchema, publication, { writeUnknownFields: false }));
  return hash.digest("hex");
}

export function createCapabilityCatalogProjectionConnectService(input: Readonly<{
  repository: Pick<PostgresCapabilityCatalogProjectionRepository, "project" | "lookup">;
  verifyPublication: (publication: CapabilityCatalogPublication) => CapabilityCatalogPublication;
  caller: Readonly<{ resolve(context: HandlerContext): Readonly<{ identity: string }> }>;
  hubCallerIdentity: string;
}>): CapabilityCatalogProjectionConnectService {
  if (!input.hubCallerIdentity.startsWith("spiffe://") || typeof input.caller?.resolve !== "function") {
    throw new Error("CAPABILITY_PROJECTION_VERIFIED_CALLER_REQUIRED");
  }
  return {
    projectCatalog: (request, context) => safe(async () => {
      const callerIdentity = authorize(input, context);
      if (request.command === undefined || request.publication === undefined ||
          request.command.digestAlgorithm !== CommandDigestAlgorithm.SHA256_PROTOBUF_V1 ||
          request.command.requestDigest !== capabilityProjectionRequestDigest(request.publication)) {
        throw new ConnectError("capability projection command invalid", Code.InvalidArgument);
      }
      const publication = input.verifyPublication(mapPublication(request.publication));
      const result = await input.repository.project({
        callerIdentity,
        commandId: request.command.commandId,
        idempotencyKey: request.command.idempotencyKey,
        requestDigest: request.command.requestDigest,
        publication,
      });
      return create(ProjectCatalogResponseSchema, {
        receipt: create(CommandReceiptSchema, {
          identity: request.command,
          operation: "capability_catalog.project",
          state: CommandReceiptState.COMMITTED,
          recordedAt: timestampFromDate(new Date(result.recordedAt)),
        }),
        agentCatalogRef: result.agentCatalogRef,
        projectionState: CatalogProjectionState.COMMITTED,
        replayed: result.replayed,
      });
    }),
    getProjectionReceipt: (request, context) => safe(async () => {
      const callerIdentity = authorize(input, context);
      if (request.digestAlgorithm !== CommandDigestAlgorithm.SHA256_PROTOBUF_V1) {
        throw new ConnectError("capability projection receipt query invalid", Code.InvalidArgument);
      }
      const result = await input.repository.lookup({
        siteId: request.siteId,
        callerIdentity,
        commandId: request.commandId,
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
      });
      if (result === null) throw new ConnectError("capability projection receipt not found", Code.NotFound);
      return create(GetProjectionReceiptResponseSchema, {
        receipt: create(CommandReceiptSchema, {
          identity: {
            commandId: request.commandId,
            idempotencyKey: request.idempotencyKey,
            digestAlgorithm: request.digestAlgorithm,
            requestDigest: request.requestDigest,
          },
          operation: "capability_catalog.project",
          state: CommandReceiptState.COMMITTED,
          recordedAt: timestampFromDate(new Date(result.recordedAt)),
        }),
        agentCatalogRef: result.agentCatalogRef,
        projectionState: CatalogProjectionState.COMMITTED,
      });
    }),
  };
}

function authorize(
  input: Parameters<typeof createCapabilityCatalogProjectionConnectService>[0],
  context: HandlerContext,
): string {
  const identity = input.caller.resolve(context).identity;
  if (identity !== input.hubCallerIdentity) {
    throw new ConnectError("capability projection caller not authorized", Code.PermissionDenied);
  }
  return identity;
}

function mapPublication(value: FrozenCatalogPublication): CapabilityCatalogPublication {
  if (value.snapshot === undefined || value.frozenAt === undefined ||
      value.snapshot.schemaVersion !== 1 ||
      value.signatureAlgorithm !== SignatureAlgorithm.ED25519_SHA256_V1) {
    throw new ConnectError("capability publication invalid", Code.InvalidArgument);
  }
  return Object.freeze({
    siteId: value.siteId,
    siteReleaseRef: value.siteReleaseRef,
    agentCatalogRef: value.agentCatalogRef,
    snapshotDigest: value.snapshotDigest,
    snapshot: Object.freeze({
      schemaVersion: 1,
      agentOptions: Object.freeze(value.snapshot.agentOptions.map((item) => Object.freeze({
        optionRef: item.optionRef, agent: item.agent, label: item.label,
      }))),
      ...(value.snapshot.defaultAgentOptionRef === undefined
        ? {} : { defaultAgentOptionRef: value.snapshot.defaultAgentOptionRef }),
      tools: Object.freeze([...value.snapshot.tools]),
      skillOptions: Object.freeze(value.snapshot.skillOptions.map((item) => Object.freeze({
        optionRef: item.optionRef, label: item.label, name: item.name,
        contentHash: item.contentHash, description: item.description, scope: item.scope,
        ...(item.prerequisiteRef === undefined ? {} : { prerequisiteRef: item.prerequisiteRef }),
      }))),
      mcpOptions: Object.freeze(value.snapshot.mcpOptions.map((item) => {
        const revision = Number(item.revision);
        if (!Number.isSafeInteger(revision) || revision < 1) {
          throw new ConnectError("capability publication invalid", Code.InvalidArgument);
        }
        return Object.freeze({
          optionRef: item.optionRef, label: item.label, scope: item.scope, name: item.name,
          revision, configHash: item.configHash,
          ...(item.prerequisiteRef === undefined ? {} : { prerequisiteRef: item.prerequisiteRef }),
        });
      })),
      subagents: Object.freeze([...value.snapshot.subagents]),
    }),
    frozenAt: timestampDate(value.frozenAt).toISOString(),
    signingKeyRef: value.signingKeyRef,
    signatureAlgorithm: "ed25519-sha256-v1",
    signaturePayloadDigest: value.signaturePayloadDigest,
    signature: new Uint8Array(value.signature),
  });
}

async function safe<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    const code = error instanceof Error ? error.message : "";
    if (code.includes("SIGNATURE") || code.includes("DIGEST") || code.includes("CANONICAL") ||
        code.includes("INVALID")) {
      throw new ConnectError("capability publication invalid", Code.InvalidArgument);
    }
    if (code.includes("BINDING") || code.includes("CONFLICT")) {
      throw new ConnectError("capability projection conflict", Code.FailedPrecondition);
    }
    if (code.includes("IN_PROGRESS")) {
      throw new ConnectError("capability projection in progress", Code.Aborted);
    }
    throw new ConnectError("capability projection unavailable", Code.Unavailable);
  }
}
