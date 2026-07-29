import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { IdentityTotpSecretEnvelope } from "./identity-security-ports.js";

export type IdentitySecuritySessionBinding = Readonly<{
  siteRef: string;
  siteReleaseRef: string;
  subjectRef: string;
  sessionRef: string;
  subjectGeneration: string;
  sessionEpoch: string;
  credentialEpoch: string;
  authenticatedAt: string;
  authenticationMethods: readonly ("password" | "totp" | "recovery_code")[];
}>;

export type IdentitySecurityOwnerMaterial = Readonly<{
  accountRef: string;
  subjectRef: string;
  sessionRef: string;
  emailNormalized: string;
  identityIssuerLabel: string;
  accountSecurityEpoch: string;
  subjectGeneration: string;
  sessionEpoch: string;
  credentialEpoch: string;
  authenticatedAt: string;
  authenticationMethods: readonly ("password" | "totp" | "recovery_code")[];
}>;

export type TotpEnrollmentMaterial = Readonly<{
  accountRef: string;
  subjectRef: string;
  sessionRef: string;
  transactionRef: string;
  expiresAt: string;
  authenticatorRef: string;
  accountSecurityEpoch: string;
  envelope: IdentityTotpSecretEnvelope;
  lastAcceptedTimeStep: number | null;
}>;

export type RecoveryCodeDigest = Readonly<{ codeDigest: string }>;

export interface IdentitySecurityManagementRepository {
  loadSecurityOwnerMaterial(
    transaction: PlatformTransaction,
    input: Readonly<{
      binding: IdentitySecuritySessionBinding;
      now: string;
    }>,
  ): Promise<IdentitySecurityOwnerMaterial | null>;
  beginTotpEnrollment(
    transaction: PlatformTransaction,
    input: Readonly<{
      binding: IdentitySecuritySessionBinding;
      accountRef: string;
      expectedAccountSecurityEpoch: string;
      commandId: string;
      requestDigest: string;
      transactionRef: string;
      authenticatorRef: string;
      envelope: IdentityTotpSecretEnvelope;
      now: string;
      expiresAt: string;
    }>,
  ): Promise<boolean>;
  supersedeTotpEnrollment(
    transaction: PlatformTransaction,
    input: Readonly<{
      binding: IdentitySecuritySessionBinding;
      accountRef: string;
      expectedAccountSecurityEpoch: string;
      priorCommandId: string;
      priorTransactionRef: string;
      newCommandId: string;
      requestDigest: string;
      workloadIdentityId: string;
      capabilityDigest: string;
      transactionRef: string;
      authenticatorRef: string;
      envelope: IdentityTotpSecretEnvelope;
      now: string;
      expiresAt: string;
    }>,
  ): Promise<boolean>;
  loadTotpEnrollmentMaterial(
    transaction: PlatformTransaction,
    input: Readonly<{
      binding: IdentitySecuritySessionBinding;
      transactionRef: string;
      now: string;
    }>,
  ): Promise<TotpEnrollmentMaterial | null>;
  confirmTotpEnrollment(
    transaction: PlatformTransaction,
    input: Readonly<{
      binding: IdentitySecuritySessionBinding;
      transactionRef: string;
      timeStep: number | null;
      commandId: string;
      requestDigest: string;
      setRef: string;
      recoveryCodeDigests: readonly RecoveryCodeDigest[];
      now: string;
    }>,
  ): Promise<Readonly<{ accountRef: string; accountSecurityEpoch: string }> | null>;
  appendSecurityEvent(
    transaction: PlatformTransaction,
    input: Readonly<{
      eventId: string;
      siteRef: string;
      accountRef: string;
      subjectRef: string;
      sessionRef: string | null;
      eventType: string;
      accountSecurityEpoch: string;
      payloadDigest: string;
      correlationId: string;
      causationId: string;
      occurredAt: string;
    }>,
  ): Promise<void>;
}
