import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  CheckActiveRequestSchema,
  ResolveSessionAttachmentsRequestSchema,
} from "../../src/generated/proto/kokoro/platform/asset/v1/asset_eligibility_pb.js";
import { AssetEligibilityError } from
  "../../src/modules/asset/application/services/asset-eligibility.js";
import { createAssetEligibilityConnectService } from
  "../../src/modules/asset/interfaces/connect/asset-eligibility-service.js";

const caller = Object.freeze({
  identity: "spiffe://kokoro/session", environment: "production", region: "us-east-1",
});
const context = { signal: new AbortController().signal } as HandlerContext;

function request() {
  return create(ResolveSessionAttachmentsRequestSchema, {
    siteId: "site-a", sessionAccessGrant: "opaque-grant-a", sessionId: "session-a",
    purpose: "chat.attachment",
    attachments: [{ assetRef: "asset-a", assetVersionRef: "version-a", assetGrantRef: "grant-a" }],
  });
}

describe("AssetEligibility Connect provider", () => {
  it("exposes authenticated readiness and immutable attachment metadata", async () => {
    const application = {
      checkActive: vi.fn(async () => ({ contractRevision: "platform-asset-eligibility@v1" })),
      resolveSessionAttachments: vi.fn(async () => [{
        assetRef: "asset-a", assetVersionRef: "version-a", assetGrantRef: "grant-a",
        checksumSha256: "a".repeat(64), safeDisplayName: "notes.txt",
        detectedMediaType: "text/plain", sizeBytes: 42n, eligibilityEpoch: 9n,
      }]),
    };
    const service = createAssetEligibilityConnectService({
      application: application as never,
      caller: { resolve: () => caller },
    });

    await expect(service.checkActive(create(CheckActiveRequestSchema), context)).resolves.toMatchObject({
      contractRevision: "platform-asset-eligibility@v1",
    });
    await expect(service.resolveSessionAttachments(request(), context)).resolves.toMatchObject({
      attachments: [{
        assetRef: "asset-a", assetVersionRef: "version-a", assetGrantRef: "grant-a",
        checksumSha256: "a".repeat(64), safeDisplayName: "notes.txt",
        detectedMediaType: "text/plain", sizeBytes: 42n, eligibilityEpoch: 9n,
      }],
    });
    expect(application.resolveSessionAttachments).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-a", purpose: "chat.attachment" }), caller, context.signal,
    );
  });

  it.each([
    ["CALLER_NOT_AUTHORIZED", Code.PermissionDenied],
    ["INPUT_INVALID", Code.InvalidArgument],
    ["NOT_ACCEPTED", Code.PermissionDenied],
    ["REQUEST_CANCELED", Code.Canceled],
  ] as const)("maps %s to a bounded Connect error", async (errorCode, connectCode) => {
    const service = createAssetEligibilityConnectService({
      application: {
        checkActive: async () => ({ contractRevision: "platform-asset-eligibility@v1" }),
        resolveSessionAttachments: async () => { throw new AssetEligibilityError(errorCode); },
      } as never,
      caller: { resolve: () => caller },
    });
    const failure = await Promise.resolve(service.resolveSessionAttachments(request(), context))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConnectError);
    expect((failure as ConnectError).code).toBe(connectCode);
    expect((failure as ConnectError).rawMessage).not.toContain(errorCode);
  });

  it("does not expose unexpected owner or database errors", async () => {
    const service = createAssetEligibilityConnectService({
      application: {
        checkActive: async () => ({ contractRevision: "platform-asset-eligibility@v1" }),
        resolveSessionAttachments: async () => { throw new Error("secret relation name"); },
      } as never,
      caller: { resolve: () => caller },
    });
    const failure = await Promise.resolve(service.resolveSessionAttachments(request(), context))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConnectError);
    expect((failure as ConnectError).code).toBe(Code.Unavailable);
    expect((failure as ConnectError).rawMessage).toBe("asset eligibility unavailable");
  });
});
