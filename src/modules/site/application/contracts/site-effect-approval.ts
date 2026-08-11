import { createHash } from "node:crypto";
import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";

export type SiteDangerousOperation =
  | "site.activation.begin"
  | "site.traffic-stop.suspend"
  | "site.traffic-stop.decommission";

export interface SiteEffectApprovalAuthority {
  consume(
    transaction: PlatformTransaction,
    input: Readonly<{ approvalRef: string; siteRef: string; operation: SiteDangerousOperation;
      environment: string; region: string; effectDigest: string }>,
    context: VerifiedRequestSecurityContext,
  ): Promise<void>;
}

export interface SiteEffectApprovalAdministration extends SiteEffectApprovalAuthority {
  request(
    transaction: PlatformTransaction,
    input: Readonly<{
      approvalRef: string;
      siteRef: string;
      environment: string;
      region: string;
      operation: SiteDangerousOperation;
      effectDigest: string;
      reason: string;
      commandId: string;
      idempotencyKey: string;
      requestDigest: string;
      makerSubjectRef: string;
      requestedAt: string;
      expiresAt: string;
    }>,
  ): Promise<Readonly<{
    approvalRef: string;
    state: "pending" | "approved" | "consumed";
    recordedAt: string;
    expiresAt: string;
  }>>;
  approve(
    transaction: PlatformTransaction,
    input: Readonly<{
      approvalRef: string;
      siteRef: string;
      environment: string;
      region: string;
      operation: SiteDangerousOperation;
      effectDigest: string;
      checkerSubjectRef: string;
      decidedAt: string;
    }>,
  ): Promise<void>;
}

export function siteActivationEffectDigest(input: Readonly<{
  siteRef: string; candidateReleaseRef: string; expectedActiveReleaseRef: string | null;
  activationFactsDigest: string; audience: string; sessionContractRevision: string; reason: string;
}>): string {
  return effectDigest("site.activation.begin", {
    siteRef: input.siteRef,
    candidateReleaseRef: input.candidateReleaseRef,
    expectedActiveReleaseRef: input.expectedActiveReleaseRef,
    activationFactsDigest: input.activationFactsDigest,
    audience: input.audience,
    sessionContractRevision: input.sessionContractRevision,
    reason: input.reason,
  });
}

export function siteTrafficStopEffectDigest(input: Readonly<{
  siteRef: string; action: "suspend" | "decommission"; reason: string;
}>): string {
  return effectDigest(`site.traffic-stop.${input.action}`, {
    siteRef: input.siteRef,
    action: input.action,
    reason: input.reason,
  });
}

function effectDigest(operation: string, input: object): string {
  const payload = JSON.stringify(Object.fromEntries(Object.entries(input).sort(([left], [right]) =>
    left.localeCompare(right))));
  return createHash("sha256").update("kokoro-site-dangerous-effect-v1\0").update(operation)
    .update("\0").update(payload).digest("hex");
}
