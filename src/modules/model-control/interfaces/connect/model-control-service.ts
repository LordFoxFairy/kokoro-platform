import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import { KokoroErrorDetailSchema, RetryClass } from
  "../../../../interfaces/connect/generated-model-control/kokoro/common/v1/error_pb.js";
import {
  CommandDigestAlgorithmV2,
  CommandIdentityV2Schema,
  CommandReceiptStateV2,
  CommandReceiptV2Schema,
} from
  "../../../../interfaces/connect/generated-model-control/kokoro/common/v2/command_envelope_pb.js";
import type {
  AuthenticatedOperatorCommandContext,
  AuthenticatedOperatorQueryContext,
} from
  "../../../../interfaces/connect/generated-model-control/kokoro/platform/admin/v2/admin_shared_pb.js";
import {
  AdminModelBindingSchema,
  AdminModelDefinitionSchema,
  AdminModelInventoryRevisionSchema,
  AdminModelOptionSchema,
  AdminModelProductRouteSchema,
  AdminModelProviderSchema,
  AdminSiteModelPolicySchema,
  AdminSiteReleaseCatalogSchema,
  ModelControlService,
  ModelAdminPageInfoSchema,
  ModelOptionLifecycle,
  ModelProduct,
  ModelRouteRole,
  ProviderAdapterKind,
  ProviderHealth,
  ProviderOperationalStatus,
  SiteModelAssignmentMode,
  SiteModelCatalogMode,
  type CanonicalModelInventory,
  type ModelOptionDraft,
  type ProviderAvailability,
} from
  "../../../../interfaces/connect/generated-model-control/kokoro/platform/model/v1/model_control_pb.js";
import {
  activateInventoryRequestDigest,
  changeSitePolicyRequestDigest,
  importInventoryRequestDigest,
  materializeModelOptionsRequestDigest,
  publishSiteReleaseCatalogRequestDigest,
  type VerifiedAuthenticatedAdminAxes,
} from "../../../../interfaces/connect/generated-model-control/command-envelope-digest.js";
import {
  MODEL_CONTROL_ADMIN_ERRORS,
  modelControlAdminErrorDetail,
  type ModelControlAdminErrorKind,
} from "../../../../interfaces/connect/generated-model-control/model-control-errors.js";
import type { VerifiedRequestSecurityContext } from
  "../../../../shared/security-context/index.js";
import type { ControlCommandReceiptTimestampReader } from
  "../../../admin/infrastructure/postgres/control-command-receipt-reader.js";
import type {
  ModelInventoryActivationAdministration,
  ModelInventoryImportAdministration,
  SiteModelPolicyAdministration,
} from "../../application/contracts/model-control-ports.js";
import type {
  ModelOptionMaterializationAdministration,
  SiteReleaseModelCatalogAdministration,
} from "../../application/contracts/product-model-option-ports.js";
import type {
  CanonicalModelInventory as DomainModelInventory,
  ModelProduct as DomainModelProduct,
  ModelRouteRole as DomainModelRouteRole,
  ProviderAdapterKind as DomainProviderAdapterKind,
} from "../../domain/model-catalog.js";
import type { ModelOptionDraft as DomainModelOptionDraft } from
  "../../domain/product-model-option.js";
import type { ProviderOperationalAvailability } from
  "../../domain/provider-availability.js";
import type { SiteModelPolicy } from "../../domain/site-model-policy.js";
import { withCommandReceiptConflictMapping } from
  "../../../../interfaces/connect/command-receipt-conflict.js";
import {
  permitBinding,
  scopedBinding,
  type AdminPageCursorCodec,
  type AdminQueryPermit,
  type AdminQueryResolver,
} from "../../../admin/interfaces/connect/admin-query-service.js";
import type {
  AdminModelBinding as ReadModelBinding,
  AdminModelDefinition as ReadModelDefinition,
  AdminModelInventoryRevision as ReadInventoryRevision,
  AdminModelOption as ReadModelOption,
  AdminModelProductRoute as ReadProductRoute,
  AdminModelProvider as ReadModelProvider,
  AdminSiteModelPolicy as ReadSiteModelPolicy,
  AdminSiteReleaseCatalog as ReadSiteReleaseCatalog,
  PostgresModelControlAdminReader,
} from "../../infrastructure/postgres/model-control-admin-reader.js";

export type ModelControlConnectService = ServiceImpl<typeof ModelControlService>;

export type ModelControlAdminOperation =
  | "model.inventory.import"
  | "model.inventory.activate"
  | "model.site-policy.change"
  | "model.option.materialize"
  | "model.site-release-catalog.publish";

export interface ModelControlAdminResolver {
  resolveModelControlCommand(
    claimed: AuthenticatedOperatorCommandContext,
    transport: HandlerContext,
    request: Readonly<{
      operation: ModelControlAdminOperation;
      siteRef: string | null;
      resourceRefs: readonly string[];
      scope: "global" | "site";
      purpose: string;
      contextScopes: readonly string[];
    }>,
  ): Promise<Readonly<{
    context: VerifiedRequestSecurityContext;
    axes: VerifiedAuthenticatedAdminAxes;
  }>>;
}

export function createModelControlConnectService(input: Readonly<{
  owners: Readonly<{
    importInventory: Pick<ModelInventoryImportAdministration, "import">;
    activateInventory: Pick<ModelInventoryActivationAdministration, "activate">;
    changeSitePolicy: Pick<SiteModelPolicyAdministration, "change">;
    materializeModelOptions: Pick<ModelOptionMaterializationAdministration, "materialize">;
    publishSiteReleaseCatalog: Pick<SiteReleaseModelCatalogAdministration, "publish">;
  }>;
  resolver: ModelControlAdminResolver & AdminQueryResolver;
  receipts: ControlCommandReceiptTimestampReader;
  reader: Pick<PostgresModelControlAdminReader,
    "listInventoryRevisions" | "getInventoryRevision" | "listInventoryProviders" |
    "listInventoryModels" | "listInventoryBindings" | "listInventoryProductRoutes" |
    "listModelOptions" | "listSiteModelPolicies" | "listSiteReleaseCatalogs">;
  cursors: AdminPageCursorCodec;
}>): ModelControlConnectService {
  const implementation: ModelControlConnectService = {
    async listInventoryRevisions(request, transport) {
      const permit = await resolveRead(input.resolver, required(request.context,
        "MODEL_CONTROL_QUERY_CONTEXT_REQUIRED"), transport, "model.inventory.read", null, [],
      inventoryFields);
      const page = resolvePage(input.cursors, request.page, permit, "model-inventories", null, {});
      const result = await input.reader.listInventoryRevisions(permit, {
        before: page.cursor === null ? null : {
          importedAt: cursorInstant(page.cursor, "at"),
          inventoryDigest: cursorDigest(page.cursor, "digest"),
        }, limit: page.limit + 1, asOf: page.asOf,
      });
      const visible = result.items.slice(0, page.limit); const last = visible.at(-1);
      return { revisions: visible.map(inventoryRevisionMessage), page: pageInfo(input.cursors,
        result.asOf, page, last === undefined ? null : {
          at: last.importedAt, digest: last.inventoryDigest,
        }, result.items.length > page.limit) };
    },

    async getInventoryRevision(request, transport) {
      const context = required(request.context, "MODEL_CONTROL_QUERY_CONTEXT_REQUIRED");
      const permit = await resolveRead(input.resolver, context, transport, "model.inventory.read",
        null, [request.inventoryDigest], inventoryFields);
      const result = await input.reader.getInventoryRevision(permit, request.inventoryDigest);
      if (result.item === null) throw new ModelControlBoundaryFailure("inventoryRevisionNotFound");
      return { revision: inventoryRevisionMessage(result.item), asOf: timestamp(result.asOf) };
    },

    async listInventoryProviders(request, transport) {
      const permit = await inventoryPermit(input.resolver, request.context, transport,
        request.inventoryDigest, providerFields);
      const page = resolvePage(input.cursors, request.page, permit, "model-providers", null,
        { inventoryDigest: request.inventoryDigest });
      const result = await input.reader.listInventoryProviders(permit, request.inventoryDigest, {
        afterProviderKey: page.cursor?.after ?? null, limit: page.limit + 1, asOf: page.asOf,
      });
      return keyPage(input.cursors, result, page, (item) => item.providerKey,
        (item) => providerMessage(item), "providers");
    },

    async listInventoryModels(request, transport) {
      const permit = await inventoryPermit(input.resolver, request.context, transport,
        request.inventoryDigest, modelFields);
      const page = resolvePage(input.cursors, request.page, permit, "model-definitions", null,
        { inventoryDigest: request.inventoryDigest });
      const result = await input.reader.listInventoryModels(permit, request.inventoryDigest, {
        afterModelKey: page.cursor?.after ?? null, limit: page.limit + 1, asOf: page.asOf,
      });
      return keyPage(input.cursors, result, page, (item) => item.modelKey,
        (item) => modelMessage(item), "models");
    },

    async listInventoryBindings(request, transport) {
      const permit = await inventoryPermit(input.resolver, request.context, transport,
        request.inventoryDigest, bindingFields);
      const page = resolvePage(input.cursors, request.page, permit, "model-bindings", null,
        { inventoryDigest: request.inventoryDigest });
      const result = await input.reader.listInventoryBindings(permit, request.inventoryDigest, {
        afterBindingKey: page.cursor?.after ?? null, limit: page.limit + 1, asOf: page.asOf,
      });
      return keyPage(input.cursors, result, page, (item) => item.bindingKey,
        (item) => bindingMessage(item), "bindings");
    },

    async listInventoryProductRoutes(request, transport) {
      const permit = await inventoryPermit(input.resolver, request.context, transport,
        request.inventoryDigest, routeFields);
      const page = resolvePage(input.cursors, request.page, permit, "model-routes", null,
        { inventoryDigest: request.inventoryDigest });
      const cursor = page.cursor;
      const result = await input.reader.listInventoryProductRoutes(permit, request.inventoryDigest, {
        after: cursor === null ? null : { product: cursor.product!, role: cursor.role!,
          position: cursorInteger(cursor, "position"), modelKey: cursor.model! },
        limit: page.limit + 1, asOf: page.asOf,
      });
      const visible = result.items.slice(0, page.limit); const last = visible.at(-1);
      return { routes: visible.map(routeMessage), page: pageInfo(input.cursors, result.asOf, page,
        last === undefined ? null : { product: last.product, role: last.role,
          position: String(last.position), model: last.modelKey }, result.items.length > page.limit) };
    },

    async listModelOptions(request, transport) {
      const context = required(request.context, "MODEL_CONTROL_QUERY_CONTEXT_REQUIRED");
      const inventoryDigest = request.inventoryDigest ?? null;
      const surface = request.surface === undefined ? null : productId(request.surface);
      const resources = inventoryDigest === null ? [] : [inventoryDigest];
      const permit = await resolveRead(input.resolver, context, transport, "model.option.read", null,
        resources, optionFields);
      const page = resolvePage(input.cursors, request.page, permit, "model-options", null,
        { inventoryDigest, surface });
      const result = await input.reader.listModelOptions(permit, { inventoryDigest, surface }, {
        before: page.cursor === null ? null : { createdAt: cursorInstant(page.cursor, "at"),
          revisionRef: page.cursor.revision! }, limit: page.limit + 1, asOf: page.asOf,
      });
      const visible = result.items.slice(0, page.limit); const last = visible.at(-1);
      return { options: visible.map(optionMessage), page: pageInfo(input.cursors, result.asOf, page,
        last === undefined ? null : { at: last.createdAt, revision: last.revisionRef },
        result.items.length > page.limit) };
    },

    async listSiteModelPolicies(request, transport) {
      const context = required(request.context, "MODEL_CONTROL_QUERY_CONTEXT_REQUIRED");
      const permit = await resolveRead(input.resolver, context, transport, "model.site-policy.read",
        request.siteId, [request.siteId], policyFields);
      const page = resolvePage(input.cursors, request.page, permit, "site-model-policies",
        request.siteId, {});
      const result = await input.reader.listSiteModelPolicies(permit, request.siteId, {
        before: page.cursor === null ? null : { changedAt: cursorInstant(page.cursor, "at"),
          product: page.cursor.product!, revision: page.cursor.revision! },
        limit: page.limit + 1, asOf: page.asOf,
      });
      const visible = result.items.slice(0, page.limit); const last = visible.at(-1);
      return { policies: visible.map(policyMessage), page: pageInfo(input.cursors, result.asOf, page,
        last === undefined ? null : { at: last.changedAt, product: last.product,
          revision: last.revision }, result.items.length > page.limit) };
    },

    async listSiteReleaseCatalogs(request, transport) {
      const context = required(request.context, "MODEL_CONTROL_QUERY_CONTEXT_REQUIRED");
      const permit = await resolveRead(input.resolver, context, transport,
        "model.site-release-catalog.read", request.siteId, [request.siteId], catalogFields);
      const page = resolvePage(input.cursors, request.page, permit, "site-release-model-catalogs",
        request.siteId, {});
      const result = await input.reader.listSiteReleaseCatalogs(permit, request.siteId, {
        before: page.cursor === null ? null : { publishedAt: cursorInstant(page.cursor, "at"),
          modelOptionCatalogRef: page.cursor.catalog! }, limit: page.limit + 1, asOf: page.asOf,
      });
      const visible = result.items.slice(0, page.limit); const last = visible.at(-1);
      return { catalogs: visible.map(catalogMessage), page: pageInfo(input.cursors, result.asOf, page,
        last === undefined ? null : { at: last.publishedAt, catalog: last.modelOptionCatalogRef },
        result.items.length > page.limit) };
    },

    async importInventory(request, transport) {
      const context = required(request.context, "MODEL_CONTROL_CONTEXT_REQUIRED");
      const effect = required(request.effect, "MODEL_INVENTORY_IMPORT_EFFECT_REQUIRED");
      const inventory = required(effect.inventory, "MODEL_INVENTORY_REQUIRED");
      const verified = await input.resolver.resolveModelControlCommand(context, transport, {
        operation: "model.inventory.import",
        siteRef: null,
        resourceRefs: [inventory.sourceReference],
        scope: "global",
        purpose: "model_control_administration",
        contextScopes: ["model:inventory:import"],
      });
      const identity = commandIdentity(context);
      requireDigest(identity.requestDigest, importInventoryRequestDigest(context, effect, verified.axes));
      const receipt = await withCommandReceiptConflictMapping(() => input.owners.importInventory.import({
        importId: identity.commandId,
        idempotencyKey: identity.idempotencyKey,
        inventory: inventoryDocument(inventory),
        ...(effect.providerAvailability.length === 0
          ? {}
          : { providerAvailability: effect.providerAvailability.map(providerAvailability) }),
      }, verified.context));
      return {
        inventoryDigest: receipt.digest,
        counts: {
          providers: receipt.counts.providers,
          models: receipt.counts.models,
          bindings: receipt.counts.bindings,
          productRoutes: receipt.counts.productRoutes,
        },
        replayed: receipt.replayed,
        receipt: await commandReceipt(input.receipts, verified.context, identity,
          "model.inventory.import"),
      };
    },

    async activateInventory(request, transport) {
      const context = required(request.context, "MODEL_CONTROL_CONTEXT_REQUIRED");
      const effect = required(request.effect, "MODEL_INVENTORY_ACTIVATION_EFFECT_REQUIRED");
      const verified = await input.resolver.resolveModelControlCommand(context, transport, {
        operation: "model.inventory.activate",
        siteRef: null,
        resourceRefs: [effect.targetDigest],
        scope: "global",
        purpose: "model_control_administration",
        contextScopes: ["model:inventory:activate"],
      });
      const identity = commandIdentity(context);
      requireDigest(identity.requestDigest,
        activateInventoryRequestDigest(context, effect, verified.axes));
      const receipt = await withCommandReceiptConflictMapping(() => input.owners.activateInventory.activate({
        activationId: identity.commandId,
        idempotencyKey: identity.idempotencyKey,
        targetDigest: effect.targetDigest,
        expectedPointerRevision: effect.expectedPointerRevision.toString(),
      }, verified.context));
      return {
        targetDigest: receipt.targetDigest,
        activatedRevision: uint64(receipt.activatedRevision,
          "MODEL_INVENTORY_ACTIVATED_REVISION_INVALID"),
        replayed: receipt.replayed,
        receipt: await commandReceipt(input.receipts, verified.context, identity,
          "model.inventory.activate"),
      };
    },

    async changeSitePolicy(request, transport) {
      const context = required(request.context, "MODEL_CONTROL_CONTEXT_REQUIRED");
      const effect = required(request.effect, "MODEL_SITE_POLICY_EFFECT_REQUIRED");
      const verified = await input.resolver.resolveModelControlCommand(context, transport, {
        operation: "model.site-policy.change",
        siteRef: request.siteId,
        resourceRefs: [request.siteId],
        scope: "site",
        purpose: "model_control_administration",
        contextScopes: ["model:site-policy:manage"],
      });
      const identity = commandIdentity(context);
      requireDigest(identity.requestDigest,
        changeSitePolicyRequestDigest(context, request.siteId, effect, verified.axes));
      const receipt = await withCommandReceiptConflictMapping(() => input.owners.changeSitePolicy.change({
        changeId: identity.commandId,
        idempotencyKey: identity.idempotencyKey,
        expectedRevision: effect.expectedRevision.toString(),
        policy: siteModelPolicy(request.siteId, effect),
      }, verified.context));
      return {
        siteId: request.siteId,
        policyDigest: receipt.policyDigest,
        revision: uint64(receipt.revision, "MODEL_SITE_POLICY_REVISION_INVALID"),
        replayed: receipt.replayed,
        receipt: await commandReceipt(input.receipts, verified.context, identity,
          "model.site-policy.change"),
      };
    },

    async materializeModelOptions(request, transport) {
      const context = required(request.context, "MODEL_CONTROL_CONTEXT_REQUIRED");
      const effect = required(request.effect, "MODEL_OPTION_MATERIALIZATION_EFFECT_REQUIRED");
      const verified = await input.resolver.resolveModelControlCommand(context, transport, {
        operation: "model.option.materialize",
        siteRef: null,
        resourceRefs: [effect.inventoryDigest, ...effect.options.map(({ optionKey }) => optionKey)],
        scope: "global",
        purpose: "model_control_administration",
        contextScopes: ["model:option:materialize"],
      });
      const identity = commandIdentity(context);
      requireDigest(identity.requestDigest,
        materializeModelOptionsRequestDigest(context, effect, verified.axes));
      const receipt = await withCommandReceiptConflictMapping(() => input.owners.materializeModelOptions.materialize({
        materializationId: identity.commandId,
        idempotencyKey: identity.idempotencyKey,
        inventoryDigest: effect.inventoryDigest,
        options: effect.options.map(modelOptionDraft),
      }, verified.context));
      return {
        inventoryDigest: receipt.inventoryDigest,
        sourceDigest: receipt.sourceDigest,
        materializationDigest: receipt.materializationDigest,
        optionRevisionRefs: [...receipt.optionRevisionRefs],
        replayed: receipt.replayed,
        receipt: await commandReceipt(input.receipts, verified.context, identity,
          "model.option.materialize"),
      };
    },

    async publishSiteReleaseCatalog(request, transport) {
      const context = required(request.context, "MODEL_CONTROL_CONTEXT_REQUIRED");
      const effect = required(request.effect, "MODEL_SITE_RELEASE_CATALOG_EFFECT_REQUIRED");
      const verified = await input.resolver.resolveModelControlCommand(context, transport, {
        operation: "model.site-release-catalog.publish",
        siteRef: request.siteId,
        resourceRefs: [request.siteId, effect.siteReleaseRef, effect.inventoryDigest],
        scope: "site",
        purpose: "site_release",
        contextScopes: ["model:site-release:publish"],
      });
      const identity = commandIdentity(context);
      requireDigest(identity.requestDigest,
        publishSiteReleaseCatalogRequestDigest(context, request.siteId, effect, verified.axes));
      const receipt = await withCommandReceiptConflictMapping(() => input.owners.publishSiteReleaseCatalog.publish({
        publicationId: identity.commandId,
        idempotencyKey: identity.idempotencyKey,
        siteId: request.siteId,
        siteReleaseRef: effect.siteReleaseRef,
        inventoryDigest: effect.inventoryDigest,
        surfaces: effect.surfaces.map((surface) => ({
          surfaceId: product(surface.surface),
          allowedModelOptionRevisionRefs: [...surface.allowedOptionRevisionRefs],
          defaultModelOptionRevisionRef: surface.defaultOptionRevisionRef,
        })),
      }, verified.context));
      return {
        siteId: receipt.siteId,
        siteReleaseRef: receipt.siteReleaseRef,
        modelOptionCatalogRef: receipt.modelOptionCatalogRef,
        catalogDigest: receipt.catalogDigest,
        publishedAt: timestampFromDate(canonicalDate(receipt.publishedAt,
          "MODEL_SITE_RELEASE_CATALOG_TIME_INVALID")),
        replayed: receipt.replayed,
        receipt: await commandReceipt(input.receipts, verified.context, identity,
          "model.site-release-catalog.publish"),
      };
    },
  };
  return withModelControlErrorBoundary(implementation);
}

function withModelControlErrorBoundary(service: ModelControlConnectService): ModelControlConnectService {
  return {
    listInventoryRevisions: modelHandler(service.listInventoryRevisions),
    getInventoryRevision: modelHandler(service.getInventoryRevision),
    listInventoryProviders: modelHandler(service.listInventoryProviders),
    listInventoryModels: modelHandler(service.listInventoryModels),
    listInventoryBindings: modelHandler(service.listInventoryBindings),
    listInventoryProductRoutes: modelHandler(service.listInventoryProductRoutes),
    listModelOptions: modelHandler(service.listModelOptions),
    listSiteModelPolicies: modelHandler(service.listSiteModelPolicies),
    listSiteReleaseCatalogs: modelHandler(service.listSiteReleaseCatalogs),
    importInventory: modelHandler(service.importInventory),
    activateInventory: modelHandler(service.activateInventory),
    changeSitePolicy: modelHandler(service.changeSitePolicy),
    materializeModelOptions: modelHandler(service.materializeModelOptions),
    publishSiteReleaseCatalog: modelHandler(service.publishSiteReleaseCatalog),
  };
}

function modelHandler<Request, Response>(handler: (
  request: Request,
  context: HandlerContext,
) => Response | Promise<Response>): (request: Request, context: HandlerContext) => Promise<Response> {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      throw modelControlConnectError(error, modelRequestId(request, context));
    }
  };
}

class ModelControlBoundaryFailure extends Error {
  constructor(readonly kind: ModelControlAdminErrorKind) {
    super(MODEL_CONTROL_ADMIN_ERRORS[kind].domainCode);
    this.name = "ModelControlBoundaryFailure";
  }
}

function modelControlConnectError(error: unknown, requestId: string): ConnectError {
  if (error instanceof ConnectError && error.findDetails(KokoroErrorDetailSchema).length > 0) return error;
  if (error instanceof ModelControlBoundaryFailure) return contractedModelError(error.kind, requestId, error);
  if (error instanceof ConnectError && error.code === Code.AlreadyExists) {
    return contractedModelError("commandReceiptConflict", requestId, error);
  }
  if (error instanceof Error &&
      (error.message === "ADMIN_PAGE_TOKEN_INVALID" || error.message === "MODEL_ADMIN_PAGE_TOKEN_INVALID")) {
    return contractedModelError("adminPageTokenInvalid", requestId, error);
  }
  if (error instanceof ConnectError) {
    const code = publicModelControlCode(error.code);
    const fallback = connectFallback(code);
    return detailedModelError(code, fallback.domainCode, fallback.safeMessage,
      fallback.retryClass, requestId, error.metadata, error);
  }
  if (error instanceof Error && /^MODEL_/u.test(error.message) && !internalModelFailure(error.message)) {
    return detailedModelError(Code.InvalidArgument, "model.control.invalid_request",
      "Invalid model control request", RetryClass.NEVER, requestId, undefined, error);
  }
  return detailedModelError(Code.Internal, "model.control.internal", "Model control request failed",
    RetryClass.NEVER, requestId, undefined, error);
}

function publicModelControlCode(code: Code): Code {
  return [Code.Canceled, Code.InvalidArgument, Code.DeadlineExceeded, Code.NotFound,
    Code.AlreadyExists, Code.PermissionDenied, Code.ResourceExhausted, Code.FailedPrecondition,
    Code.Aborted, Code.Unavailable, Code.Unauthenticated].includes(code) ? code : Code.Internal;
}

function contractedModelError(kind: ModelControlAdminErrorKind, requestId: string,
  cause: unknown): ConnectError {
  const contract = MODEL_CONTROL_ADMIN_ERRORS[kind];
  const code = contract.connectCode === "not_found" ? Code.NotFound
    : contract.connectCode === "already_exists" ? Code.AlreadyExists : Code.InvalidArgument;
  return new ConnectError(contract.safeMessage, code, undefined,
    [modelControlAdminErrorDetail(kind, requestId)], cause);
}

function detailedModelError(code: Code, domainCode: string, safeMessage: string,
  retryClass: RetryClass, requestId: string, metadata: HeadersInit | undefined,
  cause: unknown): ConnectError {
  return new ConnectError(safeMessage, code, metadata, [{ desc: KokoroErrorDetailSchema,
    value: create(KokoroErrorDetailSchema, { domainCode, retryClass,
      requestId: safeRequestId(requestId), correlationId: safeRequestId(requestId), safeMessage }) }], cause);
}

function connectFallback(code: Code): Readonly<{ domainCode: string; safeMessage: string;
  retryClass: RetryClass }> {
  if (code === Code.InvalidArgument) return { domainCode: "model.control.invalid_request",
    safeMessage: "Invalid model control request", retryClass: RetryClass.NEVER };
  if (code === Code.Unauthenticated) return { domainCode: "workload.unauthenticated",
    safeMessage: "Workload authentication failed", retryClass: RetryClass.NEVER };
  if (code === Code.PermissionDenied) return { domainCode: "workload.permission_denied",
    safeMessage: "Workload permission denied", retryClass: RetryClass.NEVER };
  if (code === Code.NotFound) return { domainCode: "model.resource.not_found",
    safeMessage: "Model resource not found", retryClass: RetryClass.NEVER };
  if (code === Code.FailedPrecondition) return { domainCode: "model.control.precondition_failed",
    safeMessage: "Model control precondition failed", retryClass: RetryClass.NEVER };
  if (code === Code.ResourceExhausted) return { domainCode: "model.control.resource_exhausted",
    safeMessage: "Model control capacity exhausted", retryClass: RetryClass.AFTER_DELAY };
  if (code === Code.Aborted) return { domainCode: "model.control.aborted",
    safeMessage: "Model control request aborted", retryClass: RetryClass.SAME_IDENTITY };
  if (code === Code.DeadlineExceeded) return { domainCode: "model.control.deadline_exceeded",
    safeMessage: "Model control deadline exceeded", retryClass: RetryClass.RECONCILE_RECEIPT };
  if (code === Code.Unavailable) return { domainCode: "model.control.unavailable",
    safeMessage: "Model control is unavailable", retryClass: RetryClass.AFTER_DELAY };
  if (code === Code.Canceled) return { domainCode: "model.control.canceled",
    safeMessage: "Model control request canceled", retryClass: RetryClass.NEVER };
  return { domainCode: "model.control.internal", safeMessage: "Model control request failed",
    retryClass: RetryClass.NEVER };
}

function modelRequestId(request: unknown, context: HandlerContext): string {
  const header = (context as Partial<HandlerContext>).requestHeader?.get("x-request-id");
  if (header !== null && header !== undefined) return safeRequestId(header);
  if (request !== null && typeof request === "object") {
    const claimed = (request as { context?: unknown }).context;
    if (claimed !== null && typeof claimed === "object") {
      const value = (claimed as { requestId?: unknown }).requestId;
      if (typeof value === "string") return safeRequestId(value);
    }
  }
  return "model-control";
}

function safeRequestId(value: string): string {
  return /^[A-Za-z0-9._:-]{1,128}$/u.test(value) ? value : "model-control";
}

function internalModelFailure(code: string): boolean {
  return /(?:RECEIPT|ROW|WATERMARK|COMMAND_RESULT|TIME)_INVALID$/u.test(code)
    || code === "MODEL_SELECTION_DECISION_NOT_PERSISTED";
}

interface ResolvedModelPage {
  readonly limit: number;
  readonly cursor: Readonly<Record<string, string>> | null;
  readonly binding: string;
  readonly kind: string;
  readonly asOf: string | null;
}

async function resolveRead(resolver: AdminQueryResolver, context: AuthenticatedOperatorQueryContext,
  transport: HandlerContext, operation: AdminQueryPermit["operation"], siteRef: string | null,
  resourceRefs: readonly string[], fieldRefs: readonly string[]): Promise<AdminQueryPermit> {
  return resolver.resolve(context, transport, { operation, siteRef, resourceRefs, fieldRefs });
}

function inventoryPermit(resolver: AdminQueryResolver,
  context: AuthenticatedOperatorQueryContext | undefined, transport: HandlerContext,
  inventoryDigest: string, fields: readonly string[]): Promise<AdminQueryPermit> {
  return resolveRead(resolver, required(context, "MODEL_CONTROL_QUERY_CONTEXT_REQUIRED"), transport,
    "model.inventory.read", null, [inventoryDigest], fields);
}

function resolvePage(cursors: AdminPageCursorCodec,
  requested: Readonly<{ pageSize: number; pageToken?: string | undefined }> | undefined,
  permit: AdminQueryPermit, kind: string, siteRef: string | null,
  filters: Readonly<Record<string, string | null>>): ResolvedModelPage {
  const limit = requested === undefined ? 50 : pageSize(requested.pageSize);
  const cursor = requested?.pageToken === undefined ? null : cursors.decode(requested.pageToken);
  if (cursor !== null) requireModelCursor(cursor, kind);
  const base = siteRef === null ? permitBinding(permit) : scopedBinding(permit, siteRef);
  const binding = modelFilterBinding(base, kind, filters);
  if (cursor !== null && cursor.binding !== binding) throw pageTokenError();
  return Object.freeze({ limit, cursor, binding, kind, asOf: cursor?.watermark ?? null });
}

function requireModelCursor(cursor: Readonly<Record<string, string>>, kind: string): void {
  const keys: Readonly<Record<string, readonly string[]>> = Object.freeze({
    "model-inventories": ["at", "binding", "digest", "kind", "watermark"],
    "model-providers": ["after", "binding", "kind", "watermark"],
    "model-definitions": ["after", "binding", "kind", "watermark"],
    "model-bindings": ["after", "binding", "kind", "watermark"],
    "model-routes": ["binding", "kind", "model", "position", "product", "role", "watermark"],
    "model-options": ["at", "binding", "kind", "revision", "watermark"],
    "site-model-policies": ["at", "binding", "kind", "product", "revision", "watermark"],
    "site-release-model-catalogs": ["at", "binding", "catalog", "kind", "watermark"],
  });
  const expected = keys[kind];
  if (expected === undefined || cursor.kind !== kind ||
      Object.keys(cursor).sort().join(",") !== [...expected].sort().join(",")) throw pageTokenError();
  cursorInstant(cursor, "watermark");
}

function modelFilterBinding(base: string, kind: string,
  filters: Readonly<Record<string, string | null>>): string {
  const entries = Object.entries(filters).sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update("kokoro.model-admin-page.v1").update("\0").update(base)
    .update("\0").update(kind).update("\0").update(JSON.stringify(Object.fromEntries(entries)))
    .digest("hex");
}

function pageInfo(cursors: AdminPageCursorCodec, asOf: string, page: ResolvedModelPage,
  key: Readonly<Record<string, string>> | null, hasMore: boolean) {
  return create(ModelAdminPageInfoSchema, { asOf: timestamp(asOf),
    ...(hasMore && key !== null ? { nextPageToken: cursors.encode({ kind: page.kind,
      binding: page.binding, watermark: asOf, ...key }) } : {}) });
}

function keyPage<Item, Message, Field extends string>(cursors: AdminPageCursorCodec,
  result: Readonly<{ items: readonly Item[]; asOf: string }>, page: ResolvedModelPage,
  reference: (item: Item) => string, message: (item: Item) => Message, field: Field):
  { [Key in Field]: Message[] } & { page: ReturnType<typeof pageInfo> } {
  const visible = result.items.slice(0, page.limit); const last = visible.at(-1);
  return { [field]: visible.map(message), page: pageInfo(cursors, result.asOf, page,
    last === undefined ? null : { after: reference(last) }, result.items.length > page.limit) } as
    { [Key in Field]: Message[] } & { page: ReturnType<typeof pageInfo> };
}

function pageSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 200) throw new Error("MODEL_ADMIN_PAGE_SIZE_INVALID");
  return value;
}
function pageTokenError(): Error { return new Error("MODEL_ADMIN_PAGE_TOKEN_INVALID"); }
function cursorInstant(cursor: Readonly<Record<string, string>>, field: string): string {
  const value = cursor[field];
  if (value === undefined || !Number.isFinite(Date.parse(value))) throw pageTokenError();
  return new Date(value).toISOString();
}
function cursorDigest(cursor: Readonly<Record<string, string>>, field: string): string {
  const value = cursor[field];
  if (value === undefined || !/^[a-f0-9]{64}$/u.test(value)) throw pageTokenError();
  return value;
}
function cursorInteger(cursor: Readonly<Record<string, string>>, field: string): number {
  const value = cursor[field]; const parsed = value === undefined ? Number.NaN : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000) throw pageTokenError();
  return parsed;
}

function inventoryRevisionMessage(row: ReadInventoryRevision) {
  return create(AdminModelInventoryRevisionSchema, { inventoryDigest: row.inventoryDigest,
    sourceReference: row.sourceReference, counts: row.counts, importedAt: timestamp(row.importedAt),
    active: row.active, ...(row.activePointerRevision === null ? {}
      : { activePointerRevision: BigInt(row.activePointerRevision) }) });
}
function providerMessage(row: ReadModelProvider) { return create(AdminModelProviderSchema, {
  providerKey: row.providerKey, provider: row.provider, accountKey: row.accountKey,
  adapterKind: wireAdapterKind(row.adapterKind), priority: row.priority,
  secretReferencePresent: row.secretReferencePresent, status: wireProviderStatus(row.status),
  health: wireProviderHealth(row.health), availabilityEpoch: BigInt(row.availabilityEpoch),
  ...(row.observedAt === null ? {} : { observedAt: timestamp(row.observedAt) }),
}); }
function modelMessage(row: ReadModelDefinition) { return create(AdminModelDefinitionSchema, {
  modelKey: row.modelKey, displayName: row.displayName, enabled: row.enabled,
  inputModalities: [...row.inputModalities], outputModalities: [...row.outputModalities],
  capabilities: [...row.capabilities], ...(row.contextWindow === null ? {} : { contextWindow: row.contextWindow }),
}); }
function bindingMessage(row: ReadModelBinding) { return create(AdminModelBindingSchema, row); }
function routeMessage(row: ReadProductRoute) { return create(AdminModelProductRouteSchema, {
  ...row, product: modelProduct(row.product), role: modelRouteRole(row.role),
  requiredCapabilities: [...row.requiredCapabilities],
}); }
function optionMessage(row: ReadModelOption) { return create(AdminModelOptionSchema, {
  ...row, surface: modelProduct(row.surface), lifecycle: optionLifecycle(row.lifecycle),
  inputModalities: [...row.inputModalities], outputModalities: [...row.outputModalities],
  supportedEfforts: [...row.supportedEfforts], badges: [...row.badges], createdAt: timestamp(row.createdAt),
  ...(row.description === null ? { description: undefined } : { description: row.description }),
  ...(row.tier === null ? { tier: undefined } : { tier: row.tier }),
}); }
function policyMessage(row: ReadSiteModelPolicy) { return create(AdminSiteModelPolicySchema, {
  ...row, product: modelProduct(row.product), revision: BigInt(row.revision),
  catalogMode: row.catalogMode === "follow_active" ? SiteModelCatalogMode.FOLLOW_ACTIVE
    : SiteModelCatalogMode.PINNED,
  assignmentMode: row.assignmentMode === "inherit" ? SiteModelAssignmentMode.INHERIT
    : SiteModelAssignmentMode.REPLACE,
  changedAt: timestamp(row.changedAt),
  ...(row.catalogDigest === null ? { catalogDigest: undefined } : { catalogDigest: row.catalogDigest }),
}); }
function catalogMessage(row: ReadSiteReleaseCatalog) { return create(AdminSiteReleaseCatalogSchema, {
  ...row, publishedAt: timestamp(row.publishedAt),
}); }
function timestamp(value: string) { const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("MODEL_ADMIN_TIME_INVALID");
  return timestampFromDate(date); }
function modelProduct(value: ReadProductRoute["product"]): ModelProduct { return {
  chat: ModelProduct.CHAT, music: ModelProduct.MUSIC, image: ModelProduct.IMAGE, video: ModelProduct.VIDEO,
}[value]; }
function productId(value: ModelProduct): ReadProductRoute["product"] {
  const result = { [ModelProduct.CHAT]: "chat", [ModelProduct.MUSIC]: "music",
    [ModelProduct.IMAGE]: "image", [ModelProduct.VIDEO]: "video" } as const;
  const product = result[value as keyof typeof result];
  if (product === undefined) throw new Error("MODEL_ADMIN_PRODUCT_INVALID"); return product;
}
function modelRouteRole(value: ReadProductRoute["role"]): ModelRouteRole {
  return value === "main" ? ModelRouteRole.MAIN : ModelRouteRole.GENERATION;
}
function wireAdapterKind(value: ReadModelProvider["adapterKind"]): ProviderAdapterKind {
  return value === "litellm" ? ProviderAdapterKind.LITELLM : ProviderAdapterKind.DIRECT;
}
function wireProviderStatus(value: ReadModelProvider["status"]): ProviderOperationalStatus {
  return value === "active" ? ProviderOperationalStatus.ACTIVE : ProviderOperationalStatus.DISABLED;
}
function wireProviderHealth(value: ReadModelProvider["health"]): ProviderHealth { return {
  unknown: ProviderHealth.UNKNOWN, healthy: ProviderHealth.HEALTHY,
  degraded: ProviderHealth.DEGRADED, down: ProviderHealth.DOWN,
}[value]; }
function optionLifecycle(value: ReadModelOption["lifecycle"]): ModelOptionLifecycle {
  return value === "active" ? ModelOptionLifecycle.ACTIVE : ModelOptionLifecycle.DISABLED;
}

const inventoryFields = ["inventory_digest", "source_reference", "counts", "imported_at",
  "active", "active_pointer_revision"] as const;
const providerFields = ["provider_key", "provider", "account_key", "adapter_kind", "priority",
  "secret_reference_present", "status", "health", "availability_epoch", "observed_at"] as const;
const modelFields = ["model_key", "display_name", "input_modalities", "output_modalities",
  "capabilities", "context_window", "enabled"] as const;
const bindingFields = ["binding_key", "model_key", "provider_key", "upstream_model",
  "gateway_model_name", "priority", "enabled"] as const;
const routeFields = ["product", "role", "model_key", "position", "required_capabilities"] as const;
const optionFields = ["revision_ref", "inventory_digest", "option_key", "surface", "label",
  "description", "tier", "lifecycle", "input_modalities", "output_modalities", "supported_efforts",
  "badges", "created_at"] as const;
const policyFields = ["site_id", "product", "revision", "policy_digest", "enabled", "catalog_mode",
  "catalog_digest", "assignment_mode", "assignment_count", "current", "changed_at"] as const;
const catalogFields = ["site_id", "site_release_ref", "model_option_catalog_ref", "catalog_digest",
  "inventory_digest", "surface_count", "published_at"] as const;

function inventoryDocument(inventory: CanonicalModelInventory): DomainModelInventory {
  return {
    schemaVersion: 1,
    source: { kind: "platform-native", reference: inventory.sourceReference },
    providers: inventory.providers.map((provider) => ({
      key: provider.key,
      provider: provider.provider,
      accountKey: provider.accountKey,
      secretRef: provider.secretRef,
      adapterKind: adapterKind(provider.adapterKind),
      priority: provider.priority,
    })),
    models: inventory.models.map((model) => ({
      key: model.key,
      displayName: model.displayName,
      inputModalities: [...model.inputModalities],
      outputModalities: [...model.outputModalities],
      capabilities: [...model.capabilities],
      contextWindow: model.contextWindow ?? null,
      enabled: model.enabled,
    })),
    bindings: inventory.bindings.map((binding) => ({
      key: binding.key,
      modelKey: binding.modelKey,
      providerKey: binding.providerKey,
      upstreamModel: binding.upstreamModel,
      gatewayModelName: binding.gatewayModelName,
      priority: binding.priority,
      enabled: binding.enabled,
    })),
    productRoutes: inventory.productRoutes.map((route) => ({
      product: product(route.product),
      role: routeRole(route.role),
      modelKey: route.modelKey,
      position: route.position,
      requiredCapabilities: [...route.requiredCapabilities],
    })),
  };
}

function providerAvailability(value: ProviderAvailability): ProviderOperationalAvailability {
  return {
    providerKey: value.providerKey,
    status: providerStatus(value.status),
    health: providerHealth(value.health),
    epoch: value.epoch.toString(),
    observationRef: value.observationRef ?? null,
    observedAt: value.observedAt === undefined
      ? null
      : instant(value.observedAt, "MODEL_PROVIDER_OBSERVED_AT_INVALID"),
  };
}

function siteModelPolicy(
  siteId: string,
  effect: Parameters<typeof changeSitePolicyRequestDigest>[2],
): SiteModelPolicy {
  const catalog = effect.catalogMode === SiteModelCatalogMode.FOLLOW_ACTIVE
    ? followActiveCatalog(effect.catalogDigest)
    : effect.catalogMode === SiteModelCatalogMode.PINNED
      ? pinnedCatalog(effect.catalogDigest)
      : invalid("MODEL_SITE_CATALOG_MODE_INVALID");
  return {
    schemaVersion: 1,
    siteId,
    product: product(effect.product),
    enabled: effect.enabled,
    catalog,
    assignmentMode: assignmentMode(effect.assignmentMode),
    assignments: effect.assignments.map((assignment) => ({
      role: routeRole(assignment.role),
      modelKey: assignment.modelKey,
      position: assignment.position,
      requiredCapabilities: [...assignment.requiredCapabilities],
      enabled: assignment.enabled,
    })),
  };
}

function modelOptionDraft(value: ModelOptionDraft): DomainModelOptionDraft {
  const orchestration = required(value.orchestration, "MODEL_OPTION_ORCHESTRATION_REQUIRED");
  const generation = required(value.generation, "MODEL_OPTION_GENERATION_REQUIRED");
  return {
    schemaVersion: 1,
    optionKey: value.optionKey,
    surface: product(value.surface),
    label: value.label,
    description: value.description ?? null,
    tier: value.tier ?? null,
    lifecycle: lifecycle(value.lifecycle),
    composition: {
      orchestration: {
        primaryModelKey: orchestration.primaryModelKey,
        fallbackModelKeys: [...orchestration.fallbackModelKeys],
      },
      generation: {
        primaryModelKey: generation.primaryModelKey,
        fallbackModelKeys: [...generation.fallbackModelKeys],
      },
    },
  };
}

function product(value: ModelProduct): DomainModelProduct {
  if (value === ModelProduct.CHAT) return "chat";
  if (value === ModelProduct.MUSIC) return "music";
  if (value === ModelProduct.IMAGE) return "image";
  if (value === ModelProduct.VIDEO) return "video";
  return invalid("MODEL_PRODUCT_INVALID");
}

function routeRole(value: ModelRouteRole): DomainModelRouteRole {
  if (value === ModelRouteRole.MAIN) return "main";
  if (value === ModelRouteRole.GENERATION) return "generation";
  return invalid("MODEL_ROUTE_ROLE_INVALID");
}

function adapterKind(value: ProviderAdapterKind): DomainProviderAdapterKind {
  if (value === ProviderAdapterKind.LITELLM) return "litellm";
  if (value === ProviderAdapterKind.DIRECT) return "direct";
  return invalid("MODEL_PROVIDER_ADAPTER_INVALID");
}

function providerStatus(value: ProviderOperationalStatus): ProviderOperationalAvailability["status"] {
  if (value === ProviderOperationalStatus.ACTIVE) return "active";
  if (value === ProviderOperationalStatus.DISABLED) return "disabled";
  return invalid("MODEL_PROVIDER_STATUS_INVALID");
}

function providerHealth(value: ProviderHealth): ProviderOperationalAvailability["health"] {
  if (value === ProviderHealth.UNKNOWN) return "unknown";
  if (value === ProviderHealth.HEALTHY) return "healthy";
  if (value === ProviderHealth.DEGRADED) return "degraded";
  if (value === ProviderHealth.DOWN) return "down";
  return invalid("MODEL_PROVIDER_HEALTH_INVALID");
}

function assignmentMode(value: SiteModelAssignmentMode): SiteModelPolicy["assignmentMode"] {
  if (value === SiteModelAssignmentMode.INHERIT) return "inherit";
  if (value === SiteModelAssignmentMode.REPLACE) return "replace";
  return invalid("MODEL_SITE_ASSIGNMENT_MODE_INVALID");
}

function lifecycle(value: ModelOptionLifecycle): DomainModelOptionDraft["lifecycle"] {
  if (value === ModelOptionLifecycle.ACTIVE) return "active";
  if (value === ModelOptionLifecycle.DISABLED) return "disabled";
  return invalid("MODEL_OPTION_LIFECYCLE_INVALID");
}

function followActiveCatalog(digest: string | undefined): SiteModelPolicy["catalog"] {
  if (digest !== undefined) throw new Error("MODEL_SITE_ACTIVE_CATALOG_DIGEST_FORBIDDEN");
  return { mode: "follow_active", digest: null };
}

function pinnedCatalog(digest: string | undefined): SiteModelPolicy["catalog"] {
  if (digest === undefined) throw new Error("MODEL_SITE_PINNED_CATALOG_DIGEST_REQUIRED");
  return { mode: "pinned", digest };
}

function commandIdentity(context: AuthenticatedOperatorCommandContext) {
  const identity = required(context.command, "MODEL_CONTROL_COMMAND_IDENTITY_REQUIRED");
  if (identity.digestAlgorithm !== CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE) {
    throw new Error("MODEL_CONTROL_COMMAND_DIGEST_ALGORITHM_INVALID");
  }
  return identity;
}

async function commandReceipt(
  reader: ControlCommandReceiptTimestampReader,
  context: VerifiedRequestSecurityContext,
  identity: ReturnType<typeof commandIdentity>,
  operation: ModelControlAdminOperation,
) {
  const recordedAt = await reader.read(context, { commandId: identity.commandId, operation });
  return create(CommandReceiptV2Schema, {
    identity: create(CommandIdentityV2Schema, {
      commandId: identity.commandId,
      idempotencyKey: identity.idempotencyKey,
      digestAlgorithm: identity.digestAlgorithm,
      requestDigest: identity.requestDigest,
    }),
    operation,
    state: CommandReceiptStateV2.COMMITTED,
    recordedAt: timestampFromDate(canonicalDate(recordedAt,
      "MODEL_CONTROL_RECEIPT_TIME_INVALID")),
  });
}

function instant(
  value: Readonly<{ seconds: bigint; nanos: number }>,
  code: string,
): string {
  const millis = Number(value.seconds) * 1000 + Math.floor(value.nanos / 1_000_000);
  if (!Number.isSafeInteger(millis)) throw new Error(code);
  return canonicalDate(new Date(millis).toISOString(), code).toISOString();
}

function canonicalDate(value: string, code: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error(code);
  return date;
}

function uint64(value: string, code: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(code);
  const result = BigInt(value);
  if (result > 18446744073709551615n) throw new Error(code);
  return result;
}

function requireDigest(actual: string, expected: string): void {
  if (actual !== expected) throw new Error("MODEL_CONTROL_COMMAND_DIGEST_INVALID");
}

function required<Value>(value: Value | undefined, code: string): Value {
  if (value === undefined) throw new Error(code);
  return value;
}

function invalid(code: string): never {
  throw new Error(code);
}
