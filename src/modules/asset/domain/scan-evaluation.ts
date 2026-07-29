import type { BlobCandidate } from "./blob-candidate.js";

export interface AssetInspectionPolicy {
  readonly policyRevisionRef: string;
  readonly purpose: string;
  readonly allowedDetectedMediaTypes: readonly string[];
  readonly scannerDefinitionRef: string;
  readonly scannerRevisionRef: string;
  readonly signatureRevisionRef: string;
  readonly contentSafetyRequired: boolean;
}

export interface AssetScanObservation {
  readonly scannerDefinitionRef: string;
  readonly scannerRevisionRef: string;
  readonly signatureRevisionRef: string;
  readonly detectedMediaType: string;
  readonly magicSignatureRef: string;
  readonly containerSummaryDigest: string;
  readonly malwareDisposition: "clean" | "detected" | "unavailable";
  readonly contentSafetyDisposition: "allow" | "deny" | "not_required" | "unavailable";
  readonly evidenceRef: string;
  readonly evidenceDigest: string;
  readonly occurredAt: string;
}

export interface AssetScanEvaluation {
  readonly evaluationRef: string;
  readonly siteRef: string;
  readonly candidateRef: string;
  readonly candidateVersion: bigint;
  readonly policyRevisionRef: string;
  readonly scannerDefinitionRef: string;
  readonly scannerRevisionRef: string;
  readonly signatureRevisionRef: string;
  readonly detectedMediaType: string;
  readonly magicSignatureRef: string;
  readonly containerSummaryDigest: string;
  readonly malwareDisposition: AssetScanObservation["malwareDisposition"];
  readonly contentSafetyDisposition: AssetScanObservation["contentSafetyDisposition"];
  readonly evidenceRef: string;
  readonly evidenceDigest: string;
  readonly outcome: "clean" | "rejected" | "unavailable";
  readonly reasonCode: string;
  readonly occurredAt: string;
}

export type AssetScanDecision =
  | Readonly<{ disposition: "clean"; evaluation: AssetScanEvaluation }>
  | Readonly<{ disposition: "rejected" | "unavailable"; code: string; evaluation: AssetScanEvaluation }>;

export function evaluateAssetScan(input: Readonly<{
  evaluationRef: string;
  candidate: BlobCandidate;
  policy: AssetInspectionPolicy;
  observation: AssetScanObservation;
}>): AssetScanDecision {
  identifier(input.evaluationRef, "ASSET_SCAN_EVALUATION_REF_INVALID");
  if (input.candidate.state !== "scanning" && input.candidate.state !== "scan_unavailable") {
    throw new Error("ASSET_BLOB_CANDIDATE_NOT_SCANNING");
  }
  verifyPolicy(input.policy);
  verifyObservation(input.observation);
  if (
    input.policy.policyRevisionRef !== input.candidate.policyRevisionRef ||
    input.policy.purpose !== input.candidate.purpose
  ) throw new Error("ASSET_SCAN_POLICY_MISMATCH");
  if (
    input.observation.scannerDefinitionRef !== input.policy.scannerDefinitionRef ||
    input.observation.scannerRevisionRef !== input.policy.scannerRevisionRef ||
    input.observation.signatureRevisionRef !== input.policy.signatureRevisionRef
  ) throw new Error("ASSET_SCANNER_EVIDENCE_REVISION_MISMATCH");
  if (Date.parse(input.observation.occurredAt) < Date.parse(input.candidate.observedAt)) {
    throw new Error("ASSET_SCAN_PRECEDES_OBJECT_OBSERVATION");
  }

  const detectedType = canonicalMediaType(input.observation.detectedMediaType);
  const allowed = input.policy.allowedDetectedMediaTypes.includes(detectedType);
  let disposition: AssetScanDecision["disposition"] = "clean";
  let code = "ASSET_SCAN_CLEAN";
  if (!allowed) {
    disposition = "rejected";
    code = "ASSET_DETECTED_MEDIA_TYPE_NOT_ALLOWED";
  } else if (detectedType !== input.candidate.clientMediaType) {
    disposition = "rejected";
    code = "ASSET_DETECTED_MEDIA_TYPE_CONFLICT";
  } else if (input.observation.malwareDisposition === "detected") {
    disposition = "rejected";
    code = "ASSET_MALWARE_DETECTED";
  } else if (input.observation.malwareDisposition === "unavailable") {
    disposition = "unavailable";
    code = "ASSET_MALWARE_SCAN_UNAVAILABLE";
  } else if (input.observation.contentSafetyDisposition === "deny") {
    disposition = "rejected";
    code = "ASSET_CONTENT_SAFETY_DENIED";
  } else if (
    input.policy.contentSafetyRequired &&
    input.observation.contentSafetyDisposition !== "allow"
  ) {
    disposition = "unavailable";
    code = "ASSET_CONTENT_SAFETY_UNAVAILABLE";
  } else if (
    !input.policy.contentSafetyRequired &&
    input.observation.contentSafetyDisposition === "unavailable"
  ) {
    disposition = "unavailable";
    code = "ASSET_CONTENT_SAFETY_UNAVAILABLE";
  }

  const evaluation = Object.freeze({
    evaluationRef: input.evaluationRef,
    siteRef: input.candidate.siteRef,
    candidateRef: input.candidate.candidateRef,
    candidateVersion: input.candidate.expectedVersion,
    policyRevisionRef: input.policy.policyRevisionRef,
    scannerDefinitionRef: input.observation.scannerDefinitionRef,
    scannerRevisionRef: input.observation.scannerRevisionRef,
    signatureRevisionRef: input.observation.signatureRevisionRef,
    detectedMediaType: detectedType,
    magicSignatureRef: input.observation.magicSignatureRef,
    containerSummaryDigest: input.observation.containerSummaryDigest,
    malwareDisposition: input.observation.malwareDisposition,
    contentSafetyDisposition: input.observation.contentSafetyDisposition,
    evidenceRef: input.observation.evidenceRef,
    evidenceDigest: input.observation.evidenceDigest,
    outcome: disposition,
    reasonCode: code,
    occurredAt: input.observation.occurredAt,
  }) satisfies AssetScanEvaluation;
  return disposition === "clean"
    ? Object.freeze({ disposition, evaluation })
    : Object.freeze({ disposition, code, evaluation });
}

function verifyPolicy(value: AssetInspectionPolicy): void {
  identifier(value.policyRevisionRef, "ASSET_SCAN_POLICY_INVALID");
  bounded(value.purpose, "ASSET_SCAN_POLICY_INVALID");
  identifier(value.scannerDefinitionRef, "ASSET_SCAN_POLICY_INVALID");
  identifier(value.scannerRevisionRef, "ASSET_SCAN_POLICY_INVALID");
  identifier(value.signatureRevisionRef, "ASSET_SCAN_POLICY_INVALID");
  if (
    value.allowedDetectedMediaTypes.length < 1 || value.allowedDetectedMediaTypes.length > 64 ||
    new Set(value.allowedDetectedMediaTypes).size !== value.allowedDetectedMediaTypes.length
  ) throw new Error("ASSET_SCAN_POLICY_INVALID");
  value.allowedDetectedMediaTypes.forEach(canonicalMediaType);
}

function verifyObservation(value: AssetScanObservation): void {
  identifier(value.scannerDefinitionRef, "ASSET_SCAN_OBSERVATION_INVALID");
  identifier(value.scannerRevisionRef, "ASSET_SCAN_OBSERVATION_INVALID");
  identifier(value.signatureRevisionRef, "ASSET_SCAN_OBSERVATION_INVALID");
  identifier(value.magicSignatureRef, "ASSET_SCAN_OBSERVATION_INVALID");
  identifier(value.evidenceRef, "ASSET_SCAN_OBSERVATION_INVALID");
  digest(value.containerSummaryDigest, "ASSET_SCAN_OBSERVATION_INVALID");
  digest(value.evidenceDigest, "ASSET_SCAN_OBSERVATION_INVALID");
  canonicalMediaType(value.detectedMediaType);
  if (!Number.isFinite(Date.parse(value.occurredAt))) throw new Error("ASSET_SCAN_OBSERVATION_INVALID");
}

function identifier(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value)) throw new Error(code);
}

function bounded(value: string, code: string): void {
  if (value.length < 1 || value.length > 128) throw new Error(code);
}

function digest(value: string, code: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(code);
}

function canonicalMediaType(value: string): string {
  const result = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/u.test(result)) {
    throw new Error("ASSET_DETECTED_MEDIA_TYPE_INVALID");
  }
  return result;
}
