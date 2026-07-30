import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import {
  AssetEligibilityService,
  CheckActiveResponseSchema,
  ReadySessionAttachmentSchema,
  ResolveSessionAttachmentsResponseSchema,
} from "../../../../interfaces/connect/generated-asset-eligibility/kokoro/platform/asset/v1/asset_eligibility_pb.js";
import type { AdmissionCaller } from "../../../admission/application/admission-ports.js";
import {
  AssetEligibilityApplicationService,
  AssetEligibilityError,
} from "../../application/services/asset-eligibility.js";

export type AssetEligibilityConnectService = ServiceImpl<typeof AssetEligibilityService>;

export interface VerifiedAssetEligibilityCallerResolver {
  resolve(context: HandlerContext): AdmissionCaller;
}

export function createAssetEligibilityConnectService(input: Readonly<{
  application: AssetEligibilityApplicationService;
  caller: VerifiedAssetEligibilityCallerResolver;
}>): AssetEligibilityConnectService {
  if (typeof input.caller?.resolve !== "function") {
    throw new Error("ASSET_ELIGIBILITY_VERIFIED_CALLER_RESOLVER_REQUIRED");
  }
  return {
    checkActive: (_request, context) => safeInvoke(async () => {
      const active = await input.application.checkActive(input.caller.resolve(context), context.signal);
      return create(CheckActiveResponseSchema, { contractRevision: active.contractRevision });
    }),
    resolveSessionAttachments: (request, context) => safeInvoke(async () => {
      const attachments = await input.application.resolveSessionAttachments(
        request,
        input.caller.resolve(context),
        context.signal,
      );
      return create(ResolveSessionAttachmentsResponseSchema, {
        attachments: attachments.map((attachment) => create(ReadySessionAttachmentSchema, attachment)),
      });
    }),
  };
}

async function safeInvoke<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    if (error instanceof AssetEligibilityError) {
      if (error.code === "INPUT_INVALID") {
        throw new ConnectError("asset eligibility request invalid", Code.InvalidArgument);
      }
      if (error.code === "REQUEST_CANCELED") {
        throw new ConnectError("asset eligibility request canceled", Code.Canceled);
      }
      throw new ConnectError("asset eligibility not accepted", Code.PermissionDenied);
    }
    throw new ConnectError("asset eligibility unavailable", Code.Unavailable);
  }
}
