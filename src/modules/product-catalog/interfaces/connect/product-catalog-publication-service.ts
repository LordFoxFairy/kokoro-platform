import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import {
  CommandDigestAlgorithmV2,
  CommandIdentityV2Schema,
  CommandReceiptStateV2,
  CommandReceiptV2Schema,
} from "../../../../interfaces/connect/generated-product-catalog-publication/kokoro/common/v2/command_envelope_pb.js";
import type { AuthenticatedOperatorCommandContext } from
  "../../../../interfaces/connect/generated-product-catalog-publication/kokoro/platform/admin/v2/admin_shared_pb.js";
import {
  ProductCatalogPublicationService as ProductCatalogPublicationDescriptor,
} from "../../../../interfaces/connect/generated-product-catalog-publication/kokoro/platform/product/v1/product_catalog_publication_pb.js";
import {
  ImmutableContractRevisionBindingSchema,
  type ImmutableContractRevisionBinding,
} from "../../../../interfaces/connect/generated-product-catalog-publication/kokoro/platform/publication/v1/publication_common_pb.js";
import {
  publishLaunchProductProfileRequestDigest,
  publishProductSurfaceCatalogRequestDigest,
  type VerifiedAuthenticatedAdminAxes,
} from "../../../../interfaces/connect/generated-product-catalog-publication/command-envelope-digest.js";
import { withCommandReceiptConflictMapping } from
  "../../../../interfaces/connect/command-receipt-conflict.js";
import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { ProductCatalogPublicationAdministration } from
  "../../application/services/product-catalog-publication-service.js";
import type { ImmutableRevisionBinding } from "../../domain/product-publication.js";

export type ProductCatalogPublicationConnectService =
  ServiceImpl<typeof ProductCatalogPublicationDescriptor>;

export type ProductCatalogPublicationAdminOperation =
  | "product.catalog.publish"
  | "product.launch-profile.publish";

export interface ProductCatalogPublicationAdminResolver {
  resolveProductCatalogPublicationCommand(
    claimed: AuthenticatedOperatorCommandContext,
    transport: HandlerContext,
    request: Readonly<{
      operation: ProductCatalogPublicationAdminOperation;
      resourceRefs: readonly string[];
    }>,
  ): Promise<Readonly<{
    context: VerifiedRequestSecurityContext;
    axes: VerifiedAuthenticatedAdminAxes;
  }>>;
}

export function createProductCatalogPublicationConnectService(input: Readonly<{
  owner: Pick<ProductCatalogPublicationAdministration, "publishCatalog" | "publishProfile">;
  resolver: ProductCatalogPublicationAdminResolver;
}>): ProductCatalogPublicationConnectService {
  return {
    async publishProductSurfaceCatalog(request, transport) {
      try {
        const context = required(request.context, "PRODUCT_CATALOG_CONTEXT_REQUIRED");
        const effect = required(request.effect, "PRODUCT_CATALOG_EFFECT_REQUIRED");
        const wireBinding = required(effect.catalogRevision, "PRODUCT_CATALOG_BINDING_REQUIRED");
        const verified = await input.resolver.resolveProductCatalogPublicationCommand(context, transport, {
          operation: "product.catalog.publish",
          resourceRefs: [wireBinding.ref],
        });
        const identity = commandIdentity(context);
        requireDigest(identity.requestDigest,
          publishProductSurfaceCatalogRequestDigest(context, effect, verified.axes));
        const binding = domainBinding(wireBinding);
        const result = await withCommandReceiptConflictMapping(() => input.owner.publishCatalog({
          commandId: identity.commandId,
          idempotencyKey: identity.idempotencyKey,
          requestDigest: identity.requestDigest,
          binding,
          expectedHeadRevision: effect.expectedCatalogHeadRevision,
          reason: effect.reason,
        }, verified.context));
        return {
          catalogRevision: wireRevision(result.binding),
          replayed: result.replayed,
          receipt: receipt(identity, "product.catalog.publish", result.recordedAt),
        };
      } catch (error) {
        throw mapError(error);
      }
    },

    async publishLaunchProductProfile(request, transport) {
      try {
        const context = required(request.context, "LAUNCH_PRODUCT_PROFILE_CONTEXT_REQUIRED");
        const effect = required(request.effect, "LAUNCH_PRODUCT_PROFILE_EFFECT_REQUIRED");
        const profileWire = required(effect.profileRevision, "LAUNCH_PRODUCT_PROFILE_BINDING_REQUIRED");
        const catalogWire = required(effect.productSurfaceCatalog, "PRODUCT_CATALOG_BINDING_REQUIRED");
        const verified = await input.resolver.resolveProductCatalogPublicationCommand(context, transport, {
          operation: "product.launch-profile.publish",
          resourceRefs: [profileWire.ref, catalogWire.ref],
        });
        const identity = commandIdentity(context);
        requireDigest(identity.requestDigest,
          publishLaunchProductProfileRequestDigest(context, effect, verified.axes));
        const result = await withCommandReceiptConflictMapping(() => input.owner.publishProfile({
          commandId: identity.commandId,
          idempotencyKey: identity.idempotencyKey,
          requestDigest: identity.requestDigest,
          binding: domainBinding(profileWire),
          catalogBinding: domainBinding(catalogWire),
          expectedHeadRevision: effect.expectedProfileHeadRevision,
          reason: effect.reason,
        }, verified.context));
        return {
          profileRevision: wireRevision(result.binding),
          replayed: result.replayed,
          receipt: receipt(identity, "product.launch-profile.publish", result.recordedAt),
        };
      } catch (error) {
        throw mapError(error);
      }
    },
  };
}

function commandIdentity(context: AuthenticatedOperatorCommandContext) {
  const identity = required(context.command, "PRODUCT_PUBLICATION_COMMAND_IDENTITY_REQUIRED");
  if (identity.digestAlgorithm !== CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE) {
    throw new Error("PRODUCT_PUBLICATION_DIGEST_ALGORITHM_INVALID");
  }
  return identity;
}

function domainBinding(value: ImmutableContractRevisionBinding): ImmutableRevisionBinding {
  return Object.freeze({ ref: value.ref, revision: value.revision, digest: value.digest });
}

function wireRevision(value: ImmutableRevisionBinding) {
  return create(ImmutableContractRevisionBindingSchema, value);
}

function receipt(
  identity: ReturnType<typeof commandIdentity>,
  operation: ProductCatalogPublicationAdminOperation,
  recordedAt: string,
) {
  const instant = new Date(recordedAt);
  if (!Number.isFinite(instant.getTime())) throw new Error("PRODUCT_PUBLICATION_RECEIPT_TIME_INVALID");
  return create(CommandReceiptV2Schema, {
    identity: create(CommandIdentityV2Schema, identity),
    operation,
    state: CommandReceiptStateV2.COMMITTED,
    recordedAt: timestampFromDate(instant),
  });
}

function requireDigest(declared: string, expected: string): void {
  if (!/^[a-f0-9]{64}$/u.test(declared) || declared !== expected) {
    throw new Error("PRODUCT_PUBLICATION_REQUEST_DIGEST_MISMATCH");
  }
}

function required<Value>(value: Value | undefined, code: string): Value {
  if (value === undefined) throw new Error(code);
  return value;
}

function mapError(error: unknown): unknown {
  if (error instanceof ConnectError) return error;
  const message = error instanceof Error ? error.message : "PRODUCT_PUBLICATION_INTERNAL_FAILURE";
  if (message === "PRODUCT_PUBLICATION_DOCUMENT_SOURCE_UNAVAILABLE") {
    return new ConnectError("immutable publication source unavailable", Code.Unimplemented);
  }
  if (message.endsWith("_HEAD_CONFLICT") || message.endsWith("_REVISION_SEQUENCE_INVALID") ||
      message.includes("_CLOSURE_") || message.endsWith("_CATALOG_NOT_FOUND")) {
    return new ConnectError(message, Code.FailedPrecondition);
  }
  if (message.endsWith("_REVISION_CONFLICT")) return new ConnectError(message, Code.AlreadyExists);
  if (message.startsWith("PRODUCT_") || message.startsWith("LAUNCH_") ||
      message.startsWith("command_envelope_")) return new ConnectError(message, Code.InvalidArgument);
  return error;
}
