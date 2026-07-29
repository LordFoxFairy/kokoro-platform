import type { IdentitySessionCurrentFact, SubjectCurrentFact } from "../../../authorization/application/contracts/scoped-session-authorization-port.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";

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
  revoked: IdentitySessionCurrentFact;
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
  }>): Promise<SubjectCurrentFact>;
  bindReceiptRecoveryCapability(transaction: PlatformTransaction, input: Readonly<{
    commandId: string; siteRef: string; workloadIdentityId: string; purpose: string;
    transactionRef: string | null; capabilityDigest: string; expiresAt: string; now: string;
  }>): Promise<void>;
  findAccountPassword(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string; emailNormalized: string;
  }>): Promise<AccountPasswordRecord | null>;
  createIdentitySession(transaction: PlatformTransaction, input: Readonly<{
    commandId: string; requestDigest: string; siteRef: string; accountRef: string; subjectRef: string;
    sessionRef: string; familyRef: string; sessionCredentialDigest: string;
    refreshCredentialDigest: string; authenticatedAt: string; sessionExpiresAt: string;
    refreshExpiresAt: string; retainUntil: string; deviceLabel: string;
  }>): Promise<IdentitySessionCurrentFact>;
  consumeIdentitySessionDeliveryRecovery(transaction: PlatformTransaction, input: Readonly<{
    priorCommandId: string; newCommandId: string; siteRef: string; workloadIdentityId: string;
    purpose: "createIdentitySession"; capabilityDigest: string; now: string; retainUntil: string;
  }>): Promise<SupersededIdentitySessionOwner | null>;
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
