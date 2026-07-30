import type {
  IdentitySessionCurrentFact,
  ProjectMembershipCurrentFact,
  SubjectCurrentFact,
} from "../../../authorization/application/contracts/scoped-session-authorization-port.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { IdentityTotpSecretEnvelope } from "./identity-security-ports.js";

export type VerificationRecord = Readonly<{
  transactionRef: string;
  accountRef: string;
  subjectRef: string;
  emailNormalized: string;
  secretDigest: string;
  state: "pending" | "consumed" | "expired" | "locked" | "superseded";
  attemptCount: number;
  maxAttempts: number;
  resendCount: number;
  expiresAt: string;
  lastDeliveryAt: string | null;
}>;

export type AccountPasswordRecord = Readonly<{
  accountRef: string;
  subjectRef: string;
  passwordHash: string;
  pepperVersion: number;
  credentialEpoch: string;
}>;

export type IdentitySessionSafeFact = Readonly<{
  sessionRef: string;
  status: "active" | "revoked" | "expired";
  current: boolean;
  deviceLabel: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}>;

export type SupersededIdentitySessionOwner = Readonly<{
  accountRef: string;
  subjectRef: string;
  authenticationMethods: readonly ("password" | "totp" | "recovery_code")[];
  revoked: IdentitySessionCurrentFact;
}>;

export type PersonalBootstrapAuthorizationFacts = Readonly<{
  subject: SubjectCurrentFact;
  membership: ProjectMembershipCurrentFact;
}>;

export type IdentityAuthenticationMaterial = Readonly<{
  accountRef: string;
  subjectRef: string;
  transactionRef: string;
  challengeKind: "totp" | "recovery";
  expiresAt: string;
  recoverySetRef: string | null;
  authenticator: Readonly<{
    authenticatorRef: string;
    envelope: IdentityTotpSecretEnvelope;
    lastAcceptedTimeStep: number | null;
  }> | null;
  recoveryCodeDigests: readonly string[];
}>;

export type IdentityRefreshCredentialRecord = Readonly<{
  accountRef: string;
  subjectRef: string;
  sessionRef: string;
  familyRef: string;
  generation: number;
  currentGeneration: number;
  credentialState: "active" | "consumed" | "revoked";
  familyState: "active" | "revoked" | "expired";
  sessionState: "active" | "revoked" | "expired";
  credentialExpiresAt: string;
  absoluteExpiresAt: string;
}>;

export interface IdentityRepository {
  createVerification(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string;
    accountRef: string;
    subjectRef: string;
    transactionRef: string;
    emailNormalized: string;
    passwordHash: string;
    pepperVersion: number;
    secretDigest: string;
    requestDigest: string;
    expiresAt: string;
    acceptedAt: string;
    legalAcceptances: readonly Readonly<{
      termRef: string;
      evidenceDigest: string;
      workloadIdentityId: string;
      siteReleaseRef: string;
    }>[];
  }>): Promise<"created" | "undisclosed">;
  recordVerificationDelivery(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string; transactionRef: string; deliveryRef: string; eventId: string;
  }>): Promise<void>;
  findPendingVerificationByEmail(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string; emailNormalized: string; now: string;
  }>): Promise<VerificationRecord | null>;
  rotateVerificationSecret(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string; transactionRef: string; expectedResendCount: number;
    secretDigest: string; expiresAt: string; now: string;
  }>): Promise<void>;
  loadVerificationForUpdate(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string; transactionRef: string;
  }>): Promise<VerificationRecord | null>;
  recordVerificationFailure(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string; transactionRef: string; now: string;
  }>): Promise<void>;
  activateVerification(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string; transactionRef: string; accountRef: string; subjectRef: string;
    now: string; displayName: string; workspaceRef: string; billingAccountRef: string;
    projectRef: string; executionSpaceRef: string; executionNamespace: string;
    namespaceIntentRef: string; namespaceEventId: string;
  }>): Promise<PersonalBootstrapAuthorizationFacts>;
  bindReceiptRecoveryCapability(transaction: PlatformTransaction, input: Readonly<{
    commandId: string; siteRef: string; siteReleaseRef: string; siteProjectBindingRef: string;
    workloadIdentityId: string; bindingEpoch: string; purpose: string;
    transactionRef: string | null; capabilityDigest: string; expiresAt: string; now: string;
  }>): Promise<void>;
  findAccountPassword(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string; emailNormalized: string;
  }>): Promise<AccountPasswordRecord | null>;
  recordIdentityPasswordFailure(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string; accountRef: string; subjectRef: string; passwordCredentialEpoch: string; now: string;
  }>): Promise<void>;
  beginIdentityAuthentication(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string; accountRef: string; subjectRef: string; passwordCredentialEpoch: string;
    transactionRef: string; initiatingCommandId: string; requestDigest: string; now: string; expiresAt: string;
  }>): Promise<Readonly<
    | { kind: "password_only" }
    | { kind: "locked" }
    | { kind: "capacity_exceeded" }
    | { kind: "pending"; transactionRef: string; challengeKind: "totp" | "recovery"; expiresAt: string }
  >>;
  loadIdentityAuthenticationMaterial(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string; transactionRef: string; now: string;
  }>): Promise<IdentityAuthenticationMaterial | null>;
  consumeIdentityAuthentication(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string; transactionRef: string; now: string;
    proof: Readonly<
      | { kind: "totp"; timeStep: number }
      | { kind: "recovery_code"; codeDigest: string }
      | { kind: "invalid" }
    >;
  }>): Promise<Readonly<
    | { kind: "accepted"; accountRef: string; subjectRef: string; authenticationMethod: "totp" | "recovery_code" }
    | { kind: "rejected" }
  >>;
  createIdentitySession(transaction: PlatformTransaction, input: Readonly<{
    commandId: string; requestDigest: string; siteRef: string; accountRef: string; subjectRef: string;
    sessionRef: string; familyRef: string; sessionCredentialDigest: string;
    refreshCredentialDigest: string; authenticatedAt: string; sessionExpiresAt: string;
    refreshExpiresAt: string; retainUntil: string; deviceLabel: string;
    authenticationMethods: readonly ("password" | "totp" | "recovery_code")[];
  }>): Promise<IdentitySessionCurrentFact>;
  consumeIdentitySessionDeliveryRecovery(transaction: PlatformTransaction, input: Readonly<{
    priorCommandId: string; newCommandId: string; siteRef: string; siteReleaseRef: string;
    siteProjectBindingRef: string; workloadIdentityId: string; bindingEpoch: string;
    purpose: "createIdentitySession" | "completeSessionMfa"; transactionRef: string | null;
    capabilityDigest: string; now: string; retainUntil: string;
  }>): Promise<SupersededIdentitySessionOwner | null>;
  loadIdentityRefreshCredential(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string; credentialDigest: string;
  }>): Promise<IdentityRefreshCredentialRecord | null>;
  rotateIdentityRefreshCredential(transaction: PlatformTransaction, input: Readonly<{
    commandId: string; requestDigest: string; siteRef: string; subjectRef: string;
    sessionRef: string; familyRef: string; expectedGeneration: number; newGeneration: number;
    sessionCredentialDigest: string; refreshCredentialDigest: string; now: string;
    sessionExpiresAt: string; refreshExpiresAt: string; retainUntil: string;
  }>): Promise<IdentitySessionCurrentFact>;
  revokeIdentityRefreshFamilyForReplay(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string; subjectRef: string; sessionRef: string; familyRef: string;
    expectedCurrentGeneration: number; now: string; retainUntil: string;
  }>): Promise<IdentitySessionCurrentFact>;
  supersedeIdentityRefreshDelivery(transaction: PlatformTransaction, input: Readonly<{
    priorCommandId: string; newCommandId: string; requestDigest: string; siteRef: string;
    siteReleaseRef: string; siteProjectBindingRef: string; workloadIdentityId: string;
    bindingEpoch: string; purpose: "refreshIdentitySession"; capabilityDigest: string;
    sessionCredentialDigest: string; refreshCredentialDigest: string; now: string;
    sessionExpiresAt: string; retainUntil: string;
  }>): Promise<Readonly<{
    current: IdentitySessionCurrentFact; sessionRef: string; refreshExpiresAt: string;
  }> | null>;
  listIdentitySessions(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string; subjectRef: string; currentSessionRef: string; now: string;
  }>): Promise<readonly IdentitySessionSafeFact[]>;
  selectSessionsForRevocation(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string; subjectRef: string; currentSessionRef: string;
    target: "current" | "single" | "others" | "all"; sessionRef: string | null;
  }>): Promise<readonly string[]>;
  revokeExactIdentitySession(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string; subjectRef: string; sessionRef: string; now: string; retainUntil: string; reason: string;
  }>): Promise<IdentitySessionCurrentFact>;
}
