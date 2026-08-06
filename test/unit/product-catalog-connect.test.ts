import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { KokoroErrorDetailSchema } from
  "../../src/generated/proto/kokoro/common/v1/error_pb.js";
import { AuthenticatedOperatorCommandContextSchema } from
  "../../src/generated/proto/kokoro/platform/admin/v2/admin_shared_pb.js";
import { ImmutableContractRevisionBindingSchema } from
  "../../src/generated/proto/kokoro/platform/publication/v1/publication_common_pb.js";
import {
  PublishProductSurfaceCatalogEffectSchema,
  PublishProductSurfaceCatalogRequestSchema,
} from
  "../../src/generated/proto/kokoro/platform/product/v1/product_catalog_publication_pb.js";
import { createProductCatalogPublicationConnectService } from
  "../../src/modules/product-catalog/interfaces/connect/product-catalog-publication-service.js";

const transport = {} as HandlerContext;

describe("Product Catalog Connect error policy", () => {
  it.each([
    ["ADMIN_SESSION_UNAUTHENTICATED", Code.Unauthenticated,
      "Admin session authentication failed", "admin.session.unauthenticated"],
    ["ADMIN_PERMISSION_DENIED", Code.PermissionDenied,
      "Admin operation is not permitted", "admin.permission_denied"],
    ["ADMIN_STEP_UP_REQUIRED", Code.FailedPrecondition,
      "Fresh phishing-resistant authentication is required", "admin.step_up_required"],
  ] as const)("maps %s to its stable public status", async (cause, code, safeMessage, domainCode) => {
    const service = provider(new Error(cause));
    const error = ConnectError.from(await Promise.resolve(
      service.publishProductSurfaceCatalog(request(), transport),
    )
      .catch((failure: unknown) => failure));

    expect(error).toMatchObject({ code, rawMessage: safeMessage });
    expect(error.rawMessage).not.toContain(cause);
    expect(error.findDetails(KokoroErrorDetailSchema)).toMatchObject([{ domainCode, safeMessage }]);
  });

  it.each([
    new Error("database password leaked by driver"),
    new ConnectError("raw upstream unknown", Code.Unknown),
  ])("masks unclassified internal failures", async (cause) => {
    const service = provider(cause);
    const error = ConnectError.from(await Promise.resolve(
      service.publishProductSurfaceCatalog(request(), transport),
    )
      .catch((failure: unknown) => failure));

    expect(error).toMatchObject({ code: Code.Internal,
      rawMessage: "Product publication request failed" });
    expect(error.rawMessage).not.toContain(cause.message);
    expect(error.findDetails(KokoroErrorDetailSchema)).toMatchObject([{
      domainCode: "product.publication.internal",
      safeMessage: "Product publication request failed",
    }]);
  });
});

function provider(error: Error) {
  return createProductCatalogPublicationConnectService({
    owner: {
      publishCatalog: vi.fn(async () => { throw new Error("owner must not be called"); }),
      publishProfile: vi.fn(async () => { throw new Error("owner must not be called"); }),
    },
    resolver: {
      resolveProductCatalogPublicationCommand: vi.fn(async () => { throw error; }),
    },
  });
}

function request() {
  return create(PublishProductSurfaceCatalogRequestSchema, {
    context: create(AuthenticatedOperatorCommandContextSchema),
    effect: create(PublishProductSurfaceCatalogEffectSchema, {
      catalogRevision: create(ImmutableContractRevisionBindingSchema, {
        ref: "catalog.main", revision: 1n, digest: `sha256:${"a".repeat(64)}`,
      }),
      expectedCatalogHeadRevision: 0n,
      reason: "release catalog",
    }),
  });
}
