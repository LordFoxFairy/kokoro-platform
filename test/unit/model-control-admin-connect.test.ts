import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { KokoroErrorDetailSchema } from
  "../../src/interfaces/connect/generated-model-control/kokoro/common/v1/error_pb.js";
import { MODEL_CONTROL_ADMIN_ERRORS } from
  "../../src/interfaces/connect/generated-model-control/model-control-errors.js";
import { AuthenticatedOperatorQueryContextSchema } from
  "../../src/interfaces/connect/generated-model-control/kokoro/platform/admin/v2/admin_shared_pb.js";
import {
  GetInventoryRevisionRequestSchema,
  ListInventoryProvidersRequestSchema,
  ListSiteModelPoliciesRequestSchema,
  ModelAdminPageSchema,
  ProviderOperationalStatus,
} from
  "../../src/interfaces/connect/generated-model-control/kokoro/platform/model/v1/model_control_pb.js";
import { HmacAdminPageCursorCodec } from
  "../../src/modules/admin/infrastructure/security/admin-page-cursor.js";
import type { AdminQueryPermit } from
  "../../src/modules/admin/interfaces/connect/admin-query-service.js";
import { createModelControlConnectService } from
  "../../src/modules/model-control/interfaces/connect/model-control-service.js";

const context = create(AuthenticatedOperatorQueryContextSchema, { requestId: "request:model:1" });
const transport = {} as HandlerContext;
const asOf = "2026-07-30T12:00:00.000Z";
const digest = "a".repeat(64);
const globalPermit: AdminQueryPermit = Object.freeze({ operatorRef: "operator:1",
  environment: "production", region: "us-east-1", operation: "model.inventory.read",
  authorityBindingDigest: "b".repeat(64),
  scope: { kind: "global" as const, grantRef: "grant:global" } });

describe("ModelControl Admin Connect reads", () => {
  it("returns the generated not-found classification for an absent immutable inventory", async () => {
    const reader = readerDouble();
    reader.getInventoryRevision.mockResolvedValue({ asOf, item: null });
    const service = serviceWith(reader, resolverDouble(globalPermit));

    const error = await errorOf(service.getInventoryRevision(create(GetInventoryRevisionRequestSchema, {
      context, inventoryDigest: digest,
    }), transport));

    expect(error.code).toBe(Code.NotFound);
    expect(error.findDetails(KokoroErrorDetailSchema)).toMatchObject([{
      domainCode: MODEL_CONTROL_ADMIN_ERRORS.inventoryRevisionNotFound.domainCode,
      safeMessage: MODEL_CONTROL_ADMIN_ERRORS.inventoryRevisionNotFound.safeMessage,
      requestId: "request:model:1",
    }]);
  });

  it("returns the generated invalid-argument classification for a malformed page token", async () => {
    const service = serviceWith(readerDouble(), resolverDouble(globalPermit));

    const error = await errorOf(service.listInventoryProviders(create(ListInventoryProvidersRequestSchema, {
      context, inventoryDigest: digest,
      page: create(ModelAdminPageSchema, { pageSize: 1, pageToken: "malformed" }),
    }), transport));

    expect(error.code).toBe(Code.InvalidArgument);
    expect(error.findDetails(KokoroErrorDetailSchema)).toMatchObject([{
      domainCode: MODEL_CONTROL_ADMIN_ERRORS.adminPageTokenInvalid.domainCode,
      safeMessage: MODEL_CONTROL_ADMIN_ERRORS.adminPageTokenInvalid.safeMessage,
    }]);
  });

  it("returns only the safe provider projection and carries the DB watermark across pages", async () => {
    const reader = readerDouble();
    reader.listInventoryProviders.mockResolvedValueOnce({ asOf, items: [provider("provider-a"),
      provider("provider-b")] }).mockResolvedValueOnce({ asOf, items: [] });
    const resolver = resolverDouble(globalPermit);
    const service = serviceWith(reader, resolver);
    const first = await service.listInventoryProviders(create(ListInventoryProvidersRequestSchema, {
      context, inventoryDigest: digest, page: create(ModelAdminPageSchema, { pageSize: 1 }),
    }), transport);

    expect(first.providers).toHaveLength(1);
    expect(first.providers![0]).toMatchObject({ providerKey: "provider-a",
      secretReferencePresent: true, status: ProviderOperationalStatus.ACTIVE });
    expect(first.providers![0]).not.toHaveProperty("secretRef");
    expect(resolver.resolve).toHaveBeenCalledWith(context, transport, expect.objectContaining({
      operation: "model.inventory.read", resourceRefs: [digest],
      fieldRefs: expect.not.arrayContaining(["secret_ref"]),
    }));

    await service.listInventoryProviders(create(ListInventoryProvidersRequestSchema, {
      context, inventoryDigest: digest,
      page: create(ModelAdminPageSchema, { pageSize: 1, pageToken: first.page!.nextPageToken }),
    }), transport);
    expect(reader.listInventoryProviders).toHaveBeenLastCalledWith(globalPermit, digest,
      { afterProviderKey: "provider-a", limit: 2, asOf });
  });

  it("binds Site policy reads to the exact Site authority and rejects cursor authority drift", async () => {
    const sitePermit: AdminQueryPermit = Object.freeze({ ...globalPermit,
      operation: "model.site-policy.read",
      scope: { kind: "site" as const, siteRefs: ["site:alpha"] } });
    const reader = readerDouble();
    reader.listSiteModelPolicies.mockResolvedValue({ asOf, items: [{ siteId: "site:alpha",
      product: "chat", revision: "2", policyDigest: digest, enabled: true,
      catalogMode: "follow_active", catalogDigest: null, assignmentMode: "inherit",
      assignmentCount: 0, current: true, changedAt: "2026-07-30T11:00:00.000Z" }] });
    const resolver = resolverDouble(sitePermit); const service = serviceWith(reader, resolver);
    const first = await service.listSiteModelPolicies(create(ListSiteModelPoliciesRequestSchema, {
      context, siteId: "site:alpha", page: create(ModelAdminPageSchema, { pageSize: 1 }),
    }), transport);
    expect(reader.listSiteModelPolicies).toHaveBeenCalledWith(sitePermit, "site:alpha",
      { before: null, limit: 2, asOf: null });
    expect(first.policies![0]).toMatchObject({ siteId: "site:alpha", revision: 2n, current: true });

    reader.listSiteModelPolicies.mockResolvedValueOnce({ asOf, items: [
      ...(await reader.listSiteModelPolicies.mock.results[0]!.value).items,
      { ...(await reader.listSiteModelPolicies.mock.results[0]!.value).items[0], revision: "1" },
    ] });
    const paged = await service.listSiteModelPolicies(create(ListSiteModelPoliciesRequestSchema, {
      context, siteId: "site:alpha", page: create(ModelAdminPageSchema, { pageSize: 1 }),
    }), transport);
    resolver.resolve.mockResolvedValueOnce(Object.freeze({ ...sitePermit, operatorRef: "operator:2" }));
    const error = await errorOf(service.listSiteModelPolicies(create(ListSiteModelPoliciesRequestSchema, {
      context, siteId: "site:alpha", page: create(ModelAdminPageSchema, {
        pageSize: 1, pageToken: paged.page!.nextPageToken,
      }),
    }), transport));
    expect(error.code).toBe(Code.InvalidArgument);
    expect(error.findDetails(KokoroErrorDetailSchema)).toMatchObject([{
      domainCode: MODEL_CONTROL_ADMIN_ERRORS.adminPageTokenInvalid.domainCode,
    }]);
  });
});

async function errorOf(value: unknown | Promise<unknown>): Promise<ConnectError> {
  return ConnectError.from(await Promise.resolve(value)
    .then(() => { throw new Error("expected rejection"); }, (error) => error));
}

function provider(providerKey: string) { return { providerKey, provider: "openai", accountKey: "primary",
  adapterKind: "litellm" as const, priority: 0, secretReferencePresent: true,
  status: "active" as const, health: "healthy" as const, availabilityEpoch: "1", observedAt: null }; }

function resolverDouble(permit: AdminQueryPermit) { return {
  resolve: vi.fn(async () => permit),
  resolveModelControlCommand: vi.fn(async () => { throw new Error("unexpected command"); }),
}; }

function readerDouble() { return {
  listInventoryRevisions: vi.fn(), getInventoryRevision: vi.fn(),
  listInventoryProviders: vi.fn(), listInventoryModels: vi.fn(), listInventoryBindings: vi.fn(),
  listInventoryProductRoutes: vi.fn(), listModelOptions: vi.fn(),
  listSiteModelPolicies: vi.fn(), listSiteReleaseCatalogs: vi.fn(),
}; }

function serviceWith(reader: ReturnType<typeof readerDouble>, resolver: ReturnType<typeof resolverDouble>) {
  const unexpected = vi.fn(async () => { throw new Error("unexpected command"); });
  return createModelControlConnectService({ resolver, reader,
    cursors: new HmacAdminPageCursorCodec(new Uint8Array(32).fill(7)),
    receipts: { read: vi.fn(async () => asOf) },
    owners: { importInventory: { import: unexpected }, activateInventory: { activate: unexpected },
      changeSitePolicy: { change: unexpected }, materializeModelOptions: { materialize: unexpected },
      publishSiteReleaseCatalog: { publish: unexpected } },
  });
}
