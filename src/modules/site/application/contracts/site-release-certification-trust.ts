import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { ImmutableRevisionBinding } from "../../domain/site-publication-authority.js";

export interface SiteReleaseCertificationTrustAuthorityPort {
  resolve(transaction: PlatformTransaction, input: Readonly<{
    certification: ImmutableRevisionBinding;
    producerIdentityRef: string;
  }>): Promise<Readonly<{
    producerRegistration: Readonly<{ ref: string; digest: string; epoch: bigint }>;
    trustPolicy: Readonly<{ ref: string; digest: string; epoch: bigint }>;
    keyId: string;
    keyVersion: bigint;
    publicKeySpkiPem: string;
    signingKeyFingerprint: string;
    keyStatus: "active" | "revoked";
    keyValidFrom: string;
    keyValidUntil: string;
    signatureDomain: "application/vnd.kokoro.release-certification-instance.v1+json";
    environment: string;
    detachedSignature: Uint8Array;
  }>>;
}
