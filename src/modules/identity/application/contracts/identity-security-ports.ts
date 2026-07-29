import type { JsonValue } from "../../../../shared/outbox-inbox/receipt.js";

export type IdentityPasswordHash = Readonly<{ passwordHash: string; pepperVersion: number }>;
export interface IdentityPasswordHasherPort {
  hash(password: string): Promise<IdentityPasswordHash>;
  verify(password: string, stored: IdentityPasswordHash): Promise<boolean>;
}

export type IssuedOpaqueCredential = Readonly<{ credential: string; digest: string }>;
export interface OpaqueCredentialPort {
  issue(): IssuedOpaqueCredential;
  digest(credential: string): string;
}

export type IdentityAuditDigesterPort = (value: JsonValue) => string;

export type VerificationDeliveryContent = Readonly<{
  siteRef: string; transactionRef: string; email: string;
  verificationSecret: string; expiresAt: string;
}>;
export type SealedVerificationEnvelope = Readonly<{
  algorithm: "A256GCM"; keyRevision: string; nonce: string;
  ciphertext: string; authenticationTag: string;
}>;
export interface VerificationEnvelopeSealerPort {
  seal(content: VerificationDeliveryContent): SealedVerificationEnvelope;
}

export type IdentityTotpSecretEnvelope = Readonly<{
  algorithm: "A256GCM";
  keyRevision: string;
  nonce: string;
  ciphertext: string;
  authenticationTag: string;
}>;

export type IdentityTotpSecretBinding = Readonly<{
  siteRef: string;
  accountRef: string;
  subjectRef: string;
  authenticatorRef: string;
}>;

export interface IdentityTotpSecretProtectorPort {
  seal(secret: string, binding: IdentityTotpSecretBinding): IdentityTotpSecretEnvelope;
  unseal(envelope: IdentityTotpSecretEnvelope, binding: IdentityTotpSecretBinding): string;
}

export interface IdentityTotpVerifierPort {
  verify(input: Readonly<{
    secret: string;
    code: string;
    epochSeconds: number;
    afterTimeStep: number | null;
  }>): Promise<Readonly<{ valid: false } | { valid: true; timeStep: number }>>;
}
