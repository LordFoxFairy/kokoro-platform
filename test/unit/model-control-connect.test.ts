import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { KokoroErrorDetailSchema } from
  "../../src/interfaces/connect/generated-model-control/kokoro/common/v1/error_pb.js";
import { MODEL_CONTROL_ADMIN_ERRORS } from
  "../../src/interfaces/connect/generated-model-control/model-control-errors.js";
import {
  CommandDigestAlgorithmV2,
  CommandIdentityV2Schema,
  CommandReceiptStateV2,
  OperatorAssuranceLevel,
} from
  "../../src/interfaces/connect/generated-model-control/kokoro/common/v2/command_envelope_pb.js";
import {
  AuthenticatedOperatorCommandContextSchema,
  GlobalScopeSchema,
  OperatorScopeSchema,
  SecurityEpochsSchema,
  SiteScopeSchema,
} from
  "../../src/interfaces/connect/generated-model-control/kokoro/platform/admin/v2/admin_shared_pb.js";
import {
  ActivateInventoryEffectSchema,
  ActivateInventoryRequestSchema,
  CanonicalModelInventorySchema,
  ChangeSitePolicyEffectSchema,
  ChangeSitePolicyRequestSchema,
  ImportInventoryEffectSchema,
  ImportInventoryRequestSchema,
  MaterializeModelOptionsEffectSchema,
  MaterializeModelOptionsRequestSchema,
  ModelOptionDraftSchema,
  ModelOptionLifecycle,
  ModelOptionRoleSelectionSchema,
  ModelProduct,
  ModelRouteRole,
  ProviderAdapterKind,
  ProviderHealth,
  ProviderOperationalStatus,
  PublishSiteReleaseCatalogEffectSchema,
  PublishSiteReleaseCatalogRequestSchema,
  SiteModelAssignmentMode,
  SiteModelCatalogMode,
} from
  "../../src/interfaces/connect/generated-model-control/kokoro/platform/model/v1/model_control_pb.js";
import {
  activateInventoryRequestDigest,
  changeSitePolicyRequestDigest,
  importInventoryRequestDigest,
  materializeModelOptionsRequestDigest,
  publishSiteReleaseCatalogRequestDigest,
  type VerifiedAuthenticatedAdminAxes,
} from "../../src/interfaces/connect/generated-model-control/command-envelope-digest.js";
import { createModelControlConnectService } from
  "../../src/modules/model-control/interfaces/connect/model-control-service.js";
import type { VerifiedRequestSecurityContext } from
  "../../src/shared/security-context/index.js";
import { CommandReceiptConflictError } from
  "../../src/shared/outbox-inbox/receipt.js";

const transport = {} as HandlerContext;
const verifiedContext = Object.freeze({}) as VerifiedRequestSecurityContext;
const recordedAt = "2026-07-29T12:02:00.000Z";
const unexpectedRead = vi.fn(async () => { throw new Error("unexpected model read"); });
const readDependencies = {
  reader: {
    listInventoryRevisions: unexpectedRead, getInventoryRevision: unexpectedRead,
    listInventoryProviders: unexpectedRead, listInventoryModels: unexpectedRead,
    listInventoryBindings: unexpectedRead, listInventoryProductRoutes: unexpectedRead,
    listModelOptions: unexpectedRead, listSiteModelPolicies: unexpectedRead,
    listSiteReleaseCatalogs: unexpectedRead,
  },
  cursors: { encode: vi.fn(() => "page-token"), decode: vi.fn(() => ({})) },
};
const resolveUnexpectedRead = vi.fn(async () => { throw new Error("unexpected model read"); });

describe("ModelControl Connect provider", () => {
  it("maps every typed command to its owner under the required global or exact-Site scope", async () => {
    const owners = ownerDoubles();
    const resolver = {
      resolve: resolveUnexpectedRead,
      resolveModelControlCommand: vi.fn(async (
        _claimed: unknown,
        _transport: HandlerContext,
        _request: Readonly<{ operation: string; scope: string; siteRef: string | null }>,
      ) => ({ context: verifiedContext, axes })),
    };
    const receipts = { read: vi.fn(async () => recordedAt) };
    const service = createModelControlConnectService({ owners, resolver, receipts, ...readDependencies });

    const imported = await service.importInventory(importRequest(), transport);
    const activated = await service.activateInventory(activationRequest(), transport);
    const changed = await service.changeSitePolicy(policyRequest(), transport);
    const materialized = await service.materializeModelOptions(materializationRequest(), transport);
    const published = await service.publishSiteReleaseCatalog(publicationRequest(), transport);

    expect(owners.importInventory.import).toHaveBeenCalledWith({
      importId: commandId,
      idempotencyKey: "idempotency-key-0001",
      inventory: {
        schemaVersion: 1,
        source: { kind: "platform-native", reference: "inventory:2026-07-29" },
        providers: [{
          key: "provider-a", provider: "openai-compatible", accountKey: "primary",
          secretRef: "secret://provider-a", adapterKind: "litellm", priority: 0,
        }],
        models: [{
          key: "chat-primary", displayName: "Chat", inputModalities: ["text"],
          outputModalities: ["text"], capabilities: ["chat"], contextWindow: 128000,
          enabled: true,
        }],
        bindings: [{
          key: "binding:chat-primary", modelKey: "chat-primary", providerKey: "provider-a",
          upstreamModel: "chat-primary", gatewayModelName: "chat-primary", priority: 0,
          enabled: true,
        }],
        productRoutes: [{
          product: "chat", role: "main", modelKey: "chat-primary", position: 0,
          requiredCapabilities: ["chat"],
        }],
      },
      providerAvailability: [{
        providerKey: "provider-a", status: "active", health: "healthy", epoch: "7",
        observationRef: "health:7", observedAt: "2026-07-29T12:00:00.000Z",
      }],
    }, verifiedContext);
    expect(owners.activateInventory.activate).toHaveBeenCalledWith({
      activationId: commandId,
      idempotencyKey: "idempotency-key-0001",
      targetDigest: digest,
      expectedPointerRevision: "3",
    }, verifiedContext);
    expect(owners.changeSitePolicy.change).toHaveBeenCalledWith({
      changeId: commandId,
      idempotencyKey: "idempotency-key-0001",
      expectedRevision: "4",
      policy: {
        schemaVersion: 1,
        siteId: "site:alpha",
        product: "music",
        enabled: true,
        catalog: { mode: "pinned", digest },
        assignmentMode: "replace",
        assignments: [{
          role: "main", modelKey: "chat-primary", position: 0,
          requiredCapabilities: ["chat"], enabled: true,
        }, {
          role: "generation", modelKey: "music-primary", position: 0,
          requiredCapabilities: ["music.generate"], enabled: true,
        }],
      },
    }, verifiedContext);
    expect(owners.materializeModelOptions.materialize).toHaveBeenCalledWith({
      materializationId: commandId,
      idempotencyKey: "idempotency-key-0001",
      inventoryDigest: digest,
      options: [{
        schemaVersion: 1,
        optionKey: "chat.standard",
        surface: "chat",
        label: "Standard",
        description: null,
        tier: "standard",
        lifecycle: "active",
        composition: {
          orchestration: { primaryModelKey: "chat-primary", fallbackModelKeys: [] },
          generation: { primaryModelKey: "chat-primary", fallbackModelKeys: [] },
        },
      }],
    }, verifiedContext);
    expect(owners.publishSiteReleaseCatalog.publish).toHaveBeenCalledWith({
      publicationId: commandId,
      idempotencyKey: "idempotency-key-0001",
      siteId: "site:alpha",
      siteReleaseRef: "release:7",
      inventoryDigest: digest,
      surfaces: [{
        surfaceId: "chat",
        allowedModelOptionRevisionRefs: [optionRevisionRef],
        defaultModelOptionRevisionRef: optionRevisionRef,
      }],
    }, verifiedContext);

    expect(resolver.resolveModelControlCommand.mock.calls.map(([, , request]) => request))
      .toEqual([
        expect.objectContaining({ operation: "model.inventory.import", scope: "global" }),
        expect.objectContaining({ operation: "model.inventory.activate", scope: "global" }),
        expect.objectContaining({ operation: "model.site-policy.change", scope: "site",
          siteRef: "site:alpha" }),
        expect.objectContaining({ operation: "model.option.materialize", scope: "global" }),
        expect.objectContaining({ operation: "model.site-release-catalog.publish", scope: "site",
          siteRef: "site:alpha" }),
      ]);
    expect([imported, activated, changed, materialized, published].every((result) =>
      result.receipt?.state === CommandReceiptStateV2.COMMITTED)).toBe(true);
    expect(receipts.read).toHaveBeenCalledTimes(5);
    expect(published.publishedAt).toEqual(timestampFromDate(new Date(publishedAt)));
  });

  it("rejects digest drift before invoking the domain owner", async () => {
    const owners = ownerDoubles();
    const request = activationRequest();
    request.context!.command!.requestDigest = "f".repeat(64);
    const service = createModelControlConnectService({
      owners,
      resolver: {
        resolve: resolveUnexpectedRead,
        resolveModelControlCommand: vi.fn(async () => ({ context: verifiedContext, axes })),
      },
      receipts: { read: vi.fn(async () => recordedAt) },
      ...readDependencies,
    });

    const error = ConnectError.from(await Promise.resolve(service.activateInventory(request, transport))
      .catch((failure: unknown) => failure));
    expect(error.code).toBe(Code.InvalidArgument);
    expect(error.findDetails(KokoroErrorDetailSchema)).toMatchObject([{
      domainCode: "model.control.invalid_request",
      safeMessage: "Invalid model control request",
    }]);
    expect(owners.activateInventory.activate).not.toHaveBeenCalled();
  });

  it("preserves the application default when provider availability is omitted", async () => {
    const owners = ownerDoubles();
    const service = createModelControlConnectService({
      owners,
      resolver: {
        resolve: resolveUnexpectedRead,
        resolveModelControlCommand: vi.fn(async () => ({ context: verifiedContext, axes })),
      },
      receipts: { read: vi.fn(async () => recordedAt) },
      ...readDependencies,
    });

    await service.importInventory(importRequest(false), transport);

    const importedInput = (owners.importInventory.import.mock.calls as unknown as
      ReadonlyArray<readonly [Record<string, unknown>]>)[0]?.[0];
    expect(importedInput).not.toHaveProperty(
      "providerAvailability",
    );
  });

  it("returns the generated typed conflict for all five command receipt collisions", async () => {
    const owners = ownerDoubles();
    const service = createModelControlConnectService({
      owners,
      resolver: {
        resolve: resolveUnexpectedRead,
        resolveModelControlCommand: vi.fn(async () => ({ context: verifiedContext, axes })),
      },
      receipts: { read: vi.fn(async () => recordedAt) },
      ...readDependencies,
    });

    const cases = [
      [owners.importInventory.import, () => service.importInventory(importRequest(), transport)],
      [owners.activateInventory.activate, () => service.activateInventory(activationRequest(), transport)],
      [owners.changeSitePolicy.change, () => service.changeSitePolicy(policyRequest(), transport)],
      [owners.materializeModelOptions.materialize,
        () => service.materializeModelOptions(materializationRequest(), transport)],
      [owners.publishSiteReleaseCatalog.publish,
        () => service.publishSiteReleaseCatalog(publicationRequest(), transport)],
    ] as const;
    for (const [owner, invoke] of cases) {
      owner.mockRejectedValueOnce(new CommandReceiptConflictError("identity"));
      const error = ConnectError.from(await Promise.resolve(invoke()).catch((cause: unknown) => cause));
      expect(error.code).toBe(Code.AlreadyExists);
      expect(error.findDetails(KokoroErrorDetailSchema)).toMatchObject([{
        domainCode: MODEL_CONTROL_ADMIN_ERRORS.commandReceiptConflict.domainCode,
        safeMessage: MODEL_CONTROL_ADMIN_ERRORS.commandReceiptConflict.safeMessage,
      }]);
    }
  });

  it("maps an unrelated owner error to a safe Internal response without message matching", async () => {
    const owners = ownerDoubles();
    const cause = new Error("COMMAND_IDENTITY_CONFLICT");
    owners.activateInventory.activate.mockRejectedValueOnce(cause);
    const service = createModelControlConnectService({
      owners,
      resolver: {
        resolve: resolveUnexpectedRead,
        resolveModelControlCommand: vi.fn(async () => ({ context: verifiedContext, axes })),
      },
      receipts: { read: vi.fn(async () => recordedAt) },
      ...readDependencies,
    });

    const error = ConnectError.from(await Promise.resolve(service.activateInventory(activationRequest(), transport))
      .catch((failure: unknown) => failure));
    expect(error.code).toBe(Code.Internal);
    expect(error.findDetails(KokoroErrorDetailSchema)).toMatchObject([{
      domainCode: "model.control.internal",
      safeMessage: "Model control request failed",
    }]);
    expect(error.cause).toBe(cause);
  });

  it("normalizes a naked upstream Unknown status to a detailed Internal response", async () => {
    const owners = ownerDoubles();
    owners.activateInventory.activate.mockRejectedValueOnce(new ConnectError("raw upstream error", Code.Unknown));
    const service = createModelControlConnectService({
      owners,
      resolver: {
        resolve: resolveUnexpectedRead,
        resolveModelControlCommand: vi.fn(async () => ({ context: verifiedContext, axes })),
      },
      receipts: { read: vi.fn(async () => recordedAt) },
      ...readDependencies,
    });

    const error = ConnectError.from(await Promise.resolve(service.activateInventory(activationRequest(), transport))
      .catch((failure: unknown) => failure));
    expect(error.code).toBe(Code.Internal);
    expect(error.findDetails(KokoroErrorDetailSchema)).toMatchObject([{
      domainCode: "model.control.internal",
      safeMessage: "Model control request failed",
    }]);
  });
});

const commandId = "018f1212-1212-7212-8212-121212121212";
const digest = "a".repeat(64);
const optionRevisionRef = `model-option:sha256:${"b".repeat(64)}`;
const publishedAt = "2026-07-29T12:01:00.000Z";
const authenticatedAt = timestampFromDate(new Date("2026-07-29T11:55:00.000Z"));
const stepUpAt = timestampFromDate(new Date("2026-07-29T11:59:00.000Z"));
const axes: VerifiedAuthenticatedAdminAxes = Object.freeze({
  workloadIdentityRef: "spiffe://kokoro/web-admin", audience: "platform-admin",
  actorRef: "operator:7", operatorGeneration: 2n, operatorSessionRef: "session:9",
  environment: "production", region: "us-east-1", managedDeviceRef: "device:3",
  assuranceLevel: OperatorAssuranceLevel.PHISHING_RESISTANT,
  factorClasses: Object.freeze(["oidc", "webauthn"]), authenticatedAt, stepUpAt,
  operatorAttestationRef: "attestation:7", operatorAttestationDigest: "c".repeat(64),
});

function ownerDoubles() {
  return {
    importInventory: { import: vi.fn(async () => ({
      importId: commandId, digest, replayed: false,
      counts: { providers: 1, models: 1, bindings: 1, productRoutes: 1 },
    })) },
    activateInventory: { activate: vi.fn(async () => ({
      activationId: commandId, importId: commandId, targetDigest: digest,
      expectedRevision: "3", activatedRevision: "4", replayed: false,
    })) },
    changeSitePolicy: { change: vi.fn(async () => ({
      changeId: commandId, policyDigest: digest, revision: "5", replayed: false,
    })) },
    materializeModelOptions: { materialize: vi.fn(async () => ({
      materializationId: commandId, sourceDigest: "d".repeat(64), inventoryDigest: digest,
      materializationDigest: "e".repeat(64), optionRevisionRefs: [optionRevisionRef],
      replayed: false,
    })) },
    publishSiteReleaseCatalog: { publish: vi.fn(async () => ({
      publicationId: commandId, siteId: "site:alpha", siteReleaseRef: "release:7",
      modelOptionCatalogRef: `site-release-model-catalog:sha256:${"f".repeat(64)}`,
      catalogDigest: "f".repeat(64), publishedAt, replayed: false,
    })) },
  };
}

function commandContext(scope: "global" | "site") {
  return create(AuthenticatedOperatorCommandContextSchema, {
    command: create(CommandIdentityV2Schema, {
      commandId,
      idempotencyKey: "idempotency-key-0001",
      digestAlgorithm: CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE,
      requestDigest: "0".repeat(64),
    }),
    actorRef: axes.actorRef,
    operatorGeneration: axes.operatorGeneration,
    operatorSessionRef: axes.operatorSessionRef,
    environment: axes.environment,
    region: axes.region,
    managedDeviceRef: axes.managedDeviceRef,
    assuranceLevel: axes.assuranceLevel,
    factorClasses: [...axes.factorClasses],
    authenticatedAt,
    stepUpAt,
    operatorAttestationRef: axes.operatorAttestationRef,
    operatorAttestationDigest: axes.operatorAttestationDigest,
    securityEpochs: create(SecurityEpochsSchema, {
      operatorSecurityEpoch: 1n,
      sessionEpoch: 1n,
      restrictionEpoch: 1n,
      policyEpoch: 1n,
      ...(scope === "site" ? { siteSecurityEpoch: 1n } : {}),
    }),
    scope: create(OperatorScopeSchema, {
      kind: scope === "site"
        ? { case: "site", value: create(SiteScopeSchema, {
            siteIds: ["site:alpha"], environment: axes.environment, region: axes.region,
          }) }
        : { case: "global", value: create(GlobalScopeSchema, {
            grantId: "grant:global", environment: axes.environment, region: axes.region,
          }) },
    }),
  });
}

function inventory() {
  return create(CanonicalModelInventorySchema, {
    sourceReference: "inventory:2026-07-29",
    providers: [{
      key: "provider-a", provider: "openai-compatible", accountKey: "primary",
      secretRef: "secret://provider-a", adapterKind: ProviderAdapterKind.LITELLM, priority: 0,
    }],
    models: [{
      key: "chat-primary", displayName: "Chat", inputModalities: ["text"],
      outputModalities: ["text"], capabilities: ["chat"], contextWindow: 128000,
      enabled: true,
    }],
    bindings: [{
      key: "binding:chat-primary", modelKey: "chat-primary", providerKey: "provider-a",
      upstreamModel: "chat-primary", gatewayModelName: "chat-primary", priority: 0,
      enabled: true,
    }],
    productRoutes: [{
      product: ModelProduct.CHAT, role: ModelRouteRole.MAIN, modelKey: "chat-primary",
      position: 0, requiredCapabilities: ["chat"],
    }],
  });
}

function importRequest(includeAvailability = true) {
  const context = commandContext("global");
  const effect = create(ImportInventoryEffectSchema, {
    inventory: inventory(),
    providerAvailability: includeAvailability
      ? [{
          providerKey: "provider-a", status: ProviderOperationalStatus.ACTIVE,
          health: ProviderHealth.HEALTHY, epoch: 7n, observationRef: "health:7",
          observedAt: timestampFromDate(new Date("2026-07-29T12:00:00.000Z")),
        }]
      : [],
  });
  context.command!.requestDigest = importInventoryRequestDigest(context, effect, axes);
  return create(ImportInventoryRequestSchema, { context, effect });
}

function activationRequest() {
  const context = commandContext("global");
  const effect = create(ActivateInventoryEffectSchema, {
    targetDigest: digest, expectedPointerRevision: 3n,
  });
  context.command!.requestDigest = activateInventoryRequestDigest(context, effect, axes);
  return create(ActivateInventoryRequestSchema, { context, effect });
}

function policyRequest() {
  const context = commandContext("site");
  const effect = create(ChangeSitePolicyEffectSchema, {
    product: ModelProduct.MUSIC,
    enabled: true,
    catalogMode: SiteModelCatalogMode.PINNED,
    catalogDigest: digest,
    assignmentMode: SiteModelAssignmentMode.REPLACE,
    assignments: [{
      role: ModelRouteRole.MAIN, modelKey: "chat-primary", position: 0,
      requiredCapabilities: ["chat"], enabled: true,
    }, {
      role: ModelRouteRole.GENERATION, modelKey: "music-primary", position: 0,
      requiredCapabilities: ["music.generate"], enabled: true,
    }],
    expectedRevision: 4n,
  });
  context.command!.requestDigest = changeSitePolicyRequestDigest(
    context, "site:alpha", effect, axes,
  );
  return create(ChangeSitePolicyRequestSchema, { context, siteId: "site:alpha", effect });
}

function materializationRequest() {
  const context = commandContext("global");
  const selection = create(ModelOptionRoleSelectionSchema, {
    primaryModelKey: "chat-primary", fallbackModelKeys: [],
  });
  const effect = create(MaterializeModelOptionsEffectSchema, {
    inventoryDigest: digest,
    options: [create(ModelOptionDraftSchema, {
      optionKey: "chat.standard", surface: ModelProduct.CHAT, label: "Standard",
      tier: "standard", lifecycle: ModelOptionLifecycle.ACTIVE,
      orchestration: selection, generation: selection,
    })],
  });
  context.command!.requestDigest = materializeModelOptionsRequestDigest(context, effect, axes);
  return create(MaterializeModelOptionsRequestSchema, { context, effect });
}

function publicationRequest() {
  const context = commandContext("site");
  const effect = create(PublishSiteReleaseCatalogEffectSchema, {
    siteReleaseRef: "release:7", inventoryDigest: digest,
    surfaces: [{
      surface: ModelProduct.CHAT,
      allowedOptionRevisionRefs: [optionRevisionRef],
      defaultOptionRevisionRef: optionRevisionRef,
    }],
  });
  context.command!.requestDigest = publishSiteReleaseCatalogRequestDigest(
    context, "site:alpha", effect, axes,
  );
  return create(PublishSiteReleaseCatalogRequestSchema, {
    context, siteId: "site:alpha", effect,
  });
}
