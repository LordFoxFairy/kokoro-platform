import type { VerifiedRequestSecurityContext } from "../../../shared/security-context/index.js";
import type { SiteAuthorityReceipt } from "./contracts/site-authority-ports.js";
import {
  siteActivationEffectDigest,
  siteTrafficStopEffectDigest,
} from "./contracts/site-effect-approval.js";
import type {
  SiteEffectApprovalReceipt,
  SiteEffectApprovalService,
} from "./services/site-effect-approval-service.js";
import type { SiteLifecycleService } from "./services/site-lifecycle-service.js";
import type { SiteTrafficStopService } from "./services/site-traffic-stop-service.js";

type ActivationInput = Parameters<SiteLifecycleService["beginActivation"]>[0];
type TrafficStopInput = Parameters<SiteTrafficStopService["requestTrafficStop"]>[0];

interface SiteApprovalPort {
  request: SiteEffectApprovalService["request"];
  approve: SiteEffectApprovalService["approve"];
}
interface SiteLifecyclePort {
  beginActivation: SiteLifecycleService["beginActivation"];
}
interface SiteTrafficStopPort {
  requestTrafficStop: SiteTrafficStopService["requestTrafficStop"];
}

/** Typed in-process Site control plane. Platform never calls its own owner over RPC. */
export class SiteDangerousAdminHandler {
  constructor(
    private readonly approvals: SiteApprovalPort,
    private readonly lifecycle: SiteLifecyclePort,
    private readonly trafficStop: SiteTrafficStopPort,
  ) {}

  requestActivationApproval(
    input: Readonly<Omit<ActivationInput, "commandId" | "idempotencyKey" | "attemptRef">>,
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteEffectApprovalReceipt> {
    return this.approvals.request({
      approvalRef: input.approvalRef,
      siteRef: input.siteRef,
      operation: "site.activation.begin",
      effectDigest: siteActivationEffectDigest(input),
    }, context);
  }

  async approveAndActivate(
    input: ActivationInput,
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteAuthorityReceipt> {
    await this.approvals.approve({
      approvalRef: input.approvalRef,
      siteRef: input.siteRef,
      operation: "site.activation.begin",
      effectDigest: siteActivationEffectDigest(input),
    }, context);
    return this.lifecycle.beginActivation(input, context);
  }

  requestTrafficStopApproval(
    input: Readonly<Pick<TrafficStopInput, "approvalRef" | "siteRef" | "action">>,
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteEffectApprovalReceipt> {
    return this.approvals.request({
      approvalRef: input.approvalRef,
      siteRef: input.siteRef,
      operation: `site.traffic-stop.${input.action}`,
      effectDigest: siteTrafficStopEffectDigest(input),
    }, context);
  }

  async approveAndStopTraffic(
    input: TrafficStopInput,
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteAuthorityReceipt> {
    await this.approvals.approve({
      approvalRef: input.approvalRef,
      siteRef: input.siteRef,
      operation: `site.traffic-stop.${input.action}`,
      effectDigest: siteTrafficStopEffectDigest(input),
    }, context);
    return this.trafficStop.requestTrafficStop(input, context);
  }
}
