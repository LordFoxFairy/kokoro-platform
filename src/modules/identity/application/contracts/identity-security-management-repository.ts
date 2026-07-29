import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { IdentityTotpSecretEnvelope } from "./identity-security-ports.js";

export class IdentitySecurityAtomicRejection extends Error {
  constructor() {
    super("IDENTITY_SECURITY_ATOMIC_REJECTION");
    this.name = "IdentitySecurityAtomicRejection";
  }
}

export type IdentitySecuritySessionBinding = Readonly<{
  siteRef: string;
  siteReleaseRef: string;
  siteProjectBindingRef: string;
  workloadIdentityId: string;
  bindingEpoch: string;
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
  authStrengthPolicyRevision: string;
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

export type IdentitySensitiveOperation =
  | "beginTotpEnrollment"
  | "disableTotp"
  | "regenerateRecoveryCodes";

export type IdentityReauthenticationTarget = Readonly<{
  audience: "platform-public";
  operationId: IdentitySensitiveOperation;
  resourceKind: "identity_account";
}>;

export type IdentityReauthenticationMaterial = IdentitySecurityOwnerMaterial & Readonly<{
  passwordHash: string;
  pepperVersion: number;
  passwordCredentialEpoch: string;
  authStrengthPolicyRevision: string;
  recoverySetRef: string | null;
  authenticator: Readonly<{
    authenticatorRef: string;
    envelope: IdentityTotpSecretEnvelope;
    lastAcceptedTimeStep: number | null;
  }> | null;
}>;

export type IdentityReauthenticationChallengeMaterial = Readonly<{
  accountRef: string;
  subjectRef: string;
  sessionRef: string;
  transactionRef: string;
  target: IdentityReauthenticationTarget;
  authStrengthPolicyRevision: string;
  expiresAt: string;
  authenticator: Readonly<{
    authenticatorRef: string;
    envelope: IdentityTotpSecretEnvelope;
    lastAcceptedTimeStep: number | null;
  }> | null;
  recoverySetRef: string | null;
  recoveryCodeDigests: readonly string[];
}>;

export type IdentityReauthenticationChallengeProof = Readonly<
  | { kind: "totp"; timeStep: number }
  | { kind: "recovery_code"; codeDigest: string }
  | { kind: "invalid" }
>;

export type IdentityReauthenticationProofBinding = Readonly<{
  proofDigest: string;
  workloadIdentityId: string;
  expectedAuthStrengthPolicyRevision: string;
  target: IdentityReauthenticationTarget;
}>;

export interface IdentitySecurityManagementRepository {
  loadReauthenticationMaterial(
    transaction: PlatformTransaction,
    input: Readonly<{ binding: IdentitySecuritySessionBinding; now: string }>,
  ): Promise<IdentityReauthenticationMaterial | null>;
  recordReauthenticationFailure(
    transaction: PlatformTransaction,
    input: Readonly<{
      binding: IdentitySecuritySessionBinding;
      accountRef: string;
      passwordCredentialEpoch: string;
      now: string;
    }>,
  ): Promise<void>;
  issueReauthenticationProof(
    transaction: PlatformTransaction,
    input: Readonly<{
      binding: IdentitySecuritySessionBinding;
      accountRef: string;
      expectedAccountSecurityEpoch: string;
      passwordCredentialEpoch: string;
      workloadIdentityId: string;
      commandId: string;
      requestDigest: string;
      proofDigest: string;
      target: IdentityReauthenticationTarget;
      authStrengthPolicyRevision: string;
      now: string;
      expiresAt: string;
    }>,
  ): Promise<boolean>;
  beginReauthenticationChallenge(
    transaction: PlatformTransaction,
    input: Readonly<{
      binding: IdentitySecuritySessionBinding;
      accountRef: string;
      expectedAccountSecurityEpoch: string;
      passwordCredentialEpoch: string;
      workloadIdentityId: string;
      commandId: string;
      requestDigest: string;
      transactionRef: string;
      target: IdentityReauthenticationTarget;
      authStrengthPolicyRevision: string;
      authenticatorRef: string;
      recoverySetRef: string | null;
      now: string;
      expiresAt: string;
    }>,
  ): Promise<boolean>;
  loadReauthenticationChallengeMaterial(
    transaction: PlatformTransaction,
    input: Readonly<{
      binding: IdentitySecuritySessionBinding;
      workloadIdentityId: string;
      transactionRef: string;
      target: IdentityReauthenticationTarget;
      now: string;
    }>,
  ): Promise<IdentityReauthenticationChallengeMaterial | null>;
  completeReauthenticationChallenge(
    transaction: PlatformTransaction,
    input: Readonly<{
      binding: IdentitySecuritySessionBinding;
      workloadIdentityId: string;
      commandId: string;
      requestDigest: string;
      transactionRef: string;
      target: IdentityReauthenticationTarget;
      proofDigest: string;
      proof: IdentityReauthenticationChallengeProof;
      now: string;
      expiresAt: string;
    }>,
  ): Promise<Readonly<{
    accountRef: string;
    accountSecurityEpoch: string;
    target: IdentityReauthenticationTarget;
    authStrengthPolicyRevision: string;
  }> | null>;
  supersedeReauthenticationProof(
    transaction: PlatformTransaction,
    input: Readonly<{
      binding: IdentitySecuritySessionBinding;
      accountRef: string;
      expectedAccountSecurityEpoch: string;
      expectedAuthStrengthPolicyRevision: string;
      priorCommandId: string;
      newCommandId: string;
      requestDigest: string;
      workloadIdentityId: string;
      capabilityDigest: string;
      proofDigest: string;
      now: string;
      expiresAt: string;
    }>,
  ): Promise<Readonly<{
    target: IdentityReauthenticationTarget;
    authStrengthPolicyRevision: string;
  }> | null>;
  consumeReauthenticationProof(
    transaction: PlatformTransaction,
    input: Readonly<{
      binding: IdentitySecuritySessionBinding;
      accountRef: string;
      commandId: string;
      proof: IdentityReauthenticationProofBinding;
      now: string;
    }>,
  ): Promise<boolean>;
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
      proof: IdentityReauthenticationProofBinding;
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
      expectedAuthStrengthPolicyRevision: string;
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
  loadActiveTotpMaterial(
    transaction: PlatformTransaction,
    input: Readonly<{ binding: IdentitySecuritySessionBinding; now: string }>,
  ): Promise<IdentityReauthenticationMaterial | null>;
  disableTotp(
    transaction: PlatformTransaction,
    input: Readonly<{
      binding: IdentitySecuritySessionBinding;
      accountRef: string;
      authenticatorRef: string;
      timeStep: number | null;
      commandId: string;
      proof: IdentityReauthenticationProofBinding;
      now: string;
    }>,
  ): Promise<Readonly<{ accountRef: string; accountSecurityEpoch: string }> | null>;
  regenerateRecoveryCodes(
    transaction: PlatformTransaction,
    input: Readonly<{
      binding: IdentitySecuritySessionBinding;
      accountRef: string;
      commandId: string;
      requestDigest: string;
      setRef: string;
      recoveryCodeDigests: readonly RecoveryCodeDigest[];
      proof: IdentityReauthenticationProofBinding;
      now: string;
    }>,
  ): Promise<Readonly<{ accountRef: string; accountSecurityEpoch: string }> | null>;
  supersedeRecoveryCodes(
    transaction: PlatformTransaction,
    input: Readonly<{
      binding: IdentitySecuritySessionBinding;
      accountRef: string;
      priorCommandId: string;
      newCommandId: string;
      expectedAuthStrengthPolicyRevision: string;
      requestDigest: string;
      workloadIdentityId: string;
      capabilityDigest: string;
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
