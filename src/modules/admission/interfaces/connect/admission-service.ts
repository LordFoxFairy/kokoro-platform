import type { HandlerContext, ServiceImpl } from "@connectrpc/connect";
import {
  AdmissionService,
} from "../../../../interfaces/connect/generated/kokoro/platform/admission/v1/admission_pb.js";
import type { AdmissionCaller } from "../../application/admission-ports.js";
import type { AdmissionApplicationService } from "../../application/admission-service.js";

export type AdmissionConnectService = ServiceImpl<typeof AdmissionService>;

/**
 * Resolves only a caller already authenticated by the outer mTLS listener.
 * Implementations must not trust browser headers or request protobuf fields.
 */
export interface VerifiedAdmissionCallerResolver {
  resolve(context: HandlerContext): AdmissionCaller;
}

export function createAdmissionConnectService(input: Readonly<{
  application: AdmissionApplicationService;
  caller: VerifiedAdmissionCallerResolver;
}>): AdmissionConnectService {
  if (typeof input.caller?.resolve !== "function") {
    throw new Error("ADMISSION_VERIFIED_CALLER_RESOLVER_REQUIRED");
  }
  return {
    prepareRun: (request, context) =>
      input.application.prepareRun(request, input.caller.resolve(context)),
    finalizeRunAuthorization: (request, context) =>
      input.application.finalizeRunAuthorization(request, input.caller.resolve(context)),
    releaseRunAuthorization: (request, context) =>
      input.application.releaseRunAuthorization(request, input.caller.resolve(context)),
    reconcileRunAuthorization: (request, context) =>
      input.application.reconcileRunAuthorization(request, input.caller.resolve(context)),
    getCommandReceipt: (request, context) =>
      input.application.getCommandReceipt(request, input.caller.resolve(context)),
  };
}
