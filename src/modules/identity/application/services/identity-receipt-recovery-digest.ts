import type { ProductWorkloadIdentity } from
  "../../../authorization/domain/session-access-grant.js";
import type { IdentityAuditDigesterPort } from
  "../contracts/identity-security-ports.js";

export type IdentityReceiptRecoveryAuthority = Pick<ProductWorkloadIdentity,
  "siteRef" | "siteReleaseRef" | "siteProjectBindingRef" |
  "workloadIdentityId" | "bindingEpoch">;

export function digestIdentityReceiptRecoveryCapability(
  digest: IdentityAuditDigesterPort,
  purpose: string,
  capability: string,
  authority: IdentityReceiptRecoveryAuthority,
): string {
  return digest({
    purpose,
    capability,
    siteRef: authority.siteRef,
    siteReleaseRef: authority.siteReleaseRef,
    siteProjectBindingRef: authority.siteProjectBindingRef,
    workloadIdentityId: authority.workloadIdentityId,
    bindingEpoch: authority.bindingEpoch,
  });
}
