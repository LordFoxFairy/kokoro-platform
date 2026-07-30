import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { HandlerContext, ServiceImpl } from "@connectrpc/connect";
import {
  CommandDigestAlgorithmV2,
  CommandIdentityV2Schema,
  CommandReceiptStateV2,
  CommandReceiptV2Schema,
} from
  "../../../../interfaces/connect/generated-model-control/kokoro/common/v2/command_envelope_pb.js";
import type { AuthenticatedOperatorCommandContext } from
  "../../../../interfaces/connect/generated-model-control/kokoro/platform/admin/v2/admin_shared_pb.js";
import {
  ModelControlService,
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
  resolver: ModelControlAdminResolver;
  receipts: ControlCommandReceiptTimestampReader;
}>): ModelControlConnectService {
  return {
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
      const receipt = await input.owners.importInventory.import({
        importId: identity.commandId,
        idempotencyKey: identity.idempotencyKey,
        inventory: inventoryDocument(inventory),
        ...(effect.providerAvailability.length === 0
          ? {}
          : { providerAvailability: effect.providerAvailability.map(providerAvailability) }),
      }, verified.context);
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
      const receipt = await input.owners.activateInventory.activate({
        activationId: identity.commandId,
        idempotencyKey: identity.idempotencyKey,
        targetDigest: effect.targetDigest,
        expectedPointerRevision: effect.expectedPointerRevision.toString(),
      }, verified.context);
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
      const receipt = await input.owners.changeSitePolicy.change({
        changeId: identity.commandId,
        idempotencyKey: identity.idempotencyKey,
        expectedRevision: effect.expectedRevision.toString(),
        policy: siteModelPolicy(request.siteId, effect),
      }, verified.context);
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
      const receipt = await input.owners.materializeModelOptions.materialize({
        materializationId: identity.commandId,
        idempotencyKey: identity.idempotencyKey,
        inventoryDigest: effect.inventoryDigest,
        options: effect.options.map(modelOptionDraft),
      }, verified.context);
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
      const receipt = await input.owners.publishSiteReleaseCatalog.publish({
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
      }, verified.context);
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
}

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
