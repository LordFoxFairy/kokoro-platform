import type {
  ArtifactByteRange,
  ArtifactOwnerScope,
  ArtifactReadyReceipt,
  ArtifactStagedReceipt,
  ArtifactTrustDecision,
} from "../domain/artifact.js";

export interface ArtifactObjectStore {
  stage(input: Readonly<{
    ownerScope: ArtifactOwnerScope;
    artifactRef: string;
    artifactVersionRef: string;
    bytes: Uint8Array;
    mediaType: "image/png" | "image/jpeg" | "image/webp";
  }>): Promise<ArtifactStagedReceipt>;
  promote(input: Readonly<{
    stagedReceipt: ArtifactStagedReceipt;
    trustDecision: ArtifactTrustDecision;
  }>): Promise<ArtifactReadyReceipt>;
  describeReady(input: Readonly<{
    ownerScope: ArtifactOwnerScope;
    artifactRef: string;
    artifactVersionRef: string;
  }>): Promise<ArtifactReadyReceipt | null>;
  openReady(input: Readonly<{
    ownerScope: ArtifactOwnerScope;
    artifactRef: string;
    artifactVersionRef: string;
    range?: ArtifactByteRange | undefined;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    body: AsyncIterable<Uint8Array>;
    byteSize: number;
    mediaType: "image/png" | "image/jpeg" | "image/webp";
  }>>;
}

export type ArtifactDeliveryPurpose = "preview" | "download" | "export";

export type StoredArtifactDeliveryAuthorization = Readonly<{
  authorizationRef: string;
  capabilityDigest: string;
  ownerScope: ArtifactOwnerScope;
  artifactRef: string;
  artifactVersionRef: string;
  purpose: ArtifactDeliveryPurpose;
  audience: "site-bff.artifact-delivery";
  issuedAt: string;
  expiresAt: string;
  revocationEpoch: bigint;
  revokedAt?: string | undefined;
}>;

export interface ArtifactDeliveryAuthorizationRepository {
  create(record: StoredArtifactDeliveryAuthorization): Promise<void>;
  findByCapabilityDigest(capabilityDigest: string): Promise<StoredArtifactDeliveryAuthorization | null>;
  findByReference(authorizationRef: string): Promise<StoredArtifactDeliveryAuthorization | null>;
  revoke(input: Readonly<{ authorizationRef: string; revokedAt: string; expectedRevocationEpoch: bigint }>):
    Promise<StoredArtifactDeliveryAuthorization | null>;
}
