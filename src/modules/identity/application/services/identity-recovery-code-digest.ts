import type { IdentityAuditDigesterPort } from "../contracts/identity-security-ports.js";

export function digestIdentityRecoveryCode(
  digest: IdentityAuditDigesterPort,
  input: Readonly<{
    siteRef: string;
    accountRef: string;
    recoverySetRef: string;
    code: string;
  }>,
): string {
  return digest({
    purpose: "identity_recovery_code",
    siteRef: input.siteRef,
    accountRef: input.accountRef,
    recoverySetRef: input.recoverySetRef,
    code: input.code.normalize("NFC"),
  });
}
