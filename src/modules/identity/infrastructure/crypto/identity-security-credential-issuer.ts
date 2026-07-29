import { randomBytes } from "node:crypto";
import { generateSecret, generateURI } from "otplib";
import type {
  IdentityRecoveryCodeIssuerPort,
  IdentityTotpEnrollmentIssuerPort,
} from "../../application/contracts/identity-security-ports.js";

export function createIdentityTotpEnrollmentIssuer(): IdentityTotpEnrollmentIssuerPort {
  return Object.freeze({
    async issue(input: Parameters<IdentityTotpEnrollmentIssuerPort["issue"]>[0]) {
      const secret = generateSecret();
      const otpauthUri = await generateURI({
        strategy: "totp",
        issuer: input.issuer,
        label: input.accountLabel,
        secret,
      });
      return Object.freeze({ secret, otpauthUri });
    },
  });
}

export function createIdentityRecoveryCodeIssuer(): IdentityRecoveryCodeIssuerPort {
  return Object.freeze({
    issue() {
      const codes = new Set<string>();
      while (codes.size < 10) codes.add(randomBytes(18).toString("base64url"));
      return Object.freeze([...codes]);
    },
  });
}
