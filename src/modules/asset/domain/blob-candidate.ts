import {
  verifyUploadIntent,
  verifyUploadSession,
  type AssetUploadIntent,
  type AssetUploadSession,
} from "./upload-intent.js";

export interface BlobCandidate {
  readonly candidateRef: string;
  readonly siteRef: string;
  readonly subjectRef: string;
  readonly subjectGeneration: bigint;
  readonly projectRef: string;
  readonly purpose: string;
  readonly intentRef: string;
  readonly sessionRef: string;
  readonly storageTenantRef: string;
  readonly storageRegion: string;
  readonly quarantineObjectRef: string;
  readonly providerVersionRef: string;
  readonly providerEtagDigest: string;
  readonly observedSize: bigint;
  readonly checksumSha256: string;
  readonly clientMediaType: string;
  readonly policyRevisionRef: string;
  readonly state: "checksum_verified" | "scanning" | "scan_unavailable" | "promotion_ready" | "rejected";
  readonly expectedVersion: bigint;
  readonly completionRequestedAt: string;
  readonly observedAt: string;
}

export type QuarantineObjectObservation =
  | Readonly<{ disposition: "absent"; observedAt: string }>
  | Readonly<{
    disposition: "present";
    providerVersionRef: string;
    providerEtagDigest: string;
    size: bigint;
    checksumSha256: string | null;
    observedAt: string;
  }>;

export type QuarantineObservationDecision =
  | Readonly<{ disposition: "retry"; code: "ASSET_QUARANTINE_OBJECT_NOT_VISIBLE" }>
  | Readonly<{ disposition: "checksum_required"; maximumBytes: bigint }>
  | Readonly<{
    disposition: "rejected";
    code: "ASSET_OBJECT_SIZE_MISMATCH" | "ASSET_OBJECT_CHECKSUM_MISMATCH";
  }>
  | Readonly<{ disposition: "candidate"; candidate: BlobCandidate }>;

export function evaluateQuarantineObservation(input: Readonly<{
  candidateRef: string;
  intent: AssetUploadIntent;
  session: AssetUploadSession;
  observation: QuarantineObjectObservation;
}>): QuarantineObservationDecision {
  const intent = verifyUploadIntent(input.intent);
  const session = verifyUploadSession(input.session);
  identifier(input.candidateRef, "ASSET_BLOB_CANDIDATE_REF_INVALID");
  if (session.state !== "completing" && session.state !== "reconciling_upload") {
    throw new Error("ASSET_UPLOAD_NOT_COMPLETING");
  }
  if (intent.state !== "admitted" || session.completionRequestedAt === null) {
    throw new Error("ASSET_UPLOAD_COMPLETION_AUTHORITY_INVALID");
  }
  if (
    intent.intentRef !== session.intentRef || intent.siteRef !== session.siteRef ||
    intent.subjectRef !== session.subjectRef || intent.subjectGeneration !== session.subjectGeneration ||
    intent.projectRef !== session.projectRef || intent.purpose !== session.purpose
  ) throw new Error("ASSET_UPLOAD_COMPLETION_AUTHORITY_INVALID");
  instant(input.observation.observedAt, "ASSET_OBJECT_OBSERVATION_TIME_INVALID");
  if (Date.parse(input.observation.observedAt) < Date.parse(session.completionRequestedAt)) {
    throw new Error("ASSET_OBJECT_OBSERVATION_PRECEDES_COMPLETION");
  }
  if (input.observation.disposition === "absent") {
    return Object.freeze({ disposition: "retry", code: "ASSET_QUARANTINE_OBJECT_NOT_VISIBLE" });
  }
  identifier(input.observation.providerVersionRef, "ASSET_PROVIDER_VERSION_INVALID");
  digest(input.observation.providerEtagDigest, "ASSET_PROVIDER_ETAG_DIGEST_INVALID");
  if (input.observation.size !== intent.expectedSize) {
    return Object.freeze({ disposition: "rejected", code: "ASSET_OBJECT_SIZE_MISMATCH" });
  }
  if (input.observation.checksumSha256 === null) {
    return Object.freeze({ disposition: "checksum_required", maximumBytes: intent.expectedSize });
  }
  digest(input.observation.checksumSha256, "ASSET_OBJECT_CHECKSUM_INVALID");
  if (input.observation.checksumSha256 !== intent.expectedChecksumSha256) {
    return Object.freeze({ disposition: "rejected", code: "ASSET_OBJECT_CHECKSUM_MISMATCH" });
  }
  return Object.freeze({
    disposition: "candidate",
    candidate: Object.freeze({
      candidateRef: input.candidateRef,
      siteRef: intent.siteRef,
      subjectRef: intent.subjectRef,
      subjectGeneration: intent.subjectGeneration,
      projectRef: intent.projectRef,
      purpose: intent.purpose,
      intentRef: intent.intentRef,
      sessionRef: session.sessionRef,
      storageTenantRef: session.storageTenantRef,
      storageRegion: session.storageRegion,
      quarantineObjectRef: session.quarantineObjectRef,
      providerVersionRef: input.observation.providerVersionRef,
      providerEtagDigest: input.observation.providerEtagDigest,
      observedSize: input.observation.size,
      checksumSha256: input.observation.checksumSha256,
      clientMediaType: intent.clientMediaType,
      policyRevisionRef: intent.policyRevisionRef,
      state: "checksum_verified",
      expectedVersion: 1n,
      completionRequestedAt: session.completionRequestedAt,
      observedAt: input.observation.observedAt,
    }),
  });
}

export function verifyBlobCandidate(value: BlobCandidate): BlobCandidate {
  identifier(value.candidateRef, "ASSET_BLOB_CANDIDATE_REF_INVALID");
  identifier(value.siteRef, "ASSET_SITE_REF_INVALID");
  identifier(value.subjectRef, "ASSET_SUBJECT_REF_INVALID");
  identifier(value.projectRef, "ASSET_PROJECT_REF_INVALID");
  identifier(value.intentRef, "ASSET_UPLOAD_INTENT_REF_INVALID");
  identifier(value.sessionRef, "ASSET_UPLOAD_SESSION_REF_INVALID");
  identifier(value.storageTenantRef, "ASSET_STORAGE_TENANT_INVALID");
  identifier(value.providerVersionRef, "ASSET_PROVIDER_VERSION_INVALID");
  identifier(value.policyRevisionRef, "ASSET_POLICY_REVISION_INVALID");
  digest(value.providerEtagDigest, "ASSET_PROVIDER_ETAG_DIGEST_INVALID");
  digest(value.checksumSha256, "ASSET_OBJECT_CHECKSUM_INVALID");
  instant(value.completionRequestedAt, "ASSET_UPLOAD_COMPLETION_TIME_INVALID");
  instant(value.observedAt, "ASSET_OBJECT_OBSERVATION_TIME_INVALID");
  if (
    value.subjectGeneration < 1n || value.observedSize < 1n || value.expectedVersion < 1n ||
    Date.parse(value.observedAt) < Date.parse(value.completionRequestedAt) ||
    !new Set<BlobCandidate["state"]>(["checksum_verified", "scanning", "scan_unavailable",
      "promotion_ready", "rejected"]).has(value.state)
  ) throw new Error("ASSET_BLOB_CANDIDATE_VALUE_INVALID");
  return Object.freeze({ ...value });
}

function identifier(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u.test(value)) throw new Error(code);
}

function digest(value: string, code: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(code);
}

function instant(value: string, code: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(code);
}
