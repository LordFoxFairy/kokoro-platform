export type DispatchOwnerEvidenceKind = "no_dispatch" | "outcome_unknown";

export interface DispatchOwnerEvidence {
  readonly evidenceRef: string;
  readonly evidenceVersion: "1";
  readonly kind: DispatchOwnerEvidenceKind;
  readonly siteId: string;
  readonly sessionId: string;
  readonly dispatchId: string;
  readonly launchId: string;
  readonly runId: string;
  readonly authorizationSegmentRef: string;
  readonly authorizationSegmentVersion: string;
  readonly leaseGeneration: string;
  readonly payloadSha256: string;
  readonly recordedAt: string;
}

export type DispatchOwnerEvidenceLookupResult =
  | Readonly<{ kind: "found"; evidence: DispatchOwnerEvidence }>
  | Readonly<{ kind: "not_found" }>;

export interface DispatchOwnerEvidenceLookup {
  get(
    request: Readonly<{ siteId: string; sessionId: string; evidenceRef: string }>,
    signal: AbortSignal,
  ): Promise<DispatchOwnerEvidenceLookupResult>;
}

export interface ExpectedDispatchOwnerEvidence {
  readonly kind: DispatchOwnerEvidenceKind;
  readonly siteId: string;
  readonly sessionId: string;
  readonly evidenceRef: string;
  readonly launchId: string;
  readonly runId: string;
  readonly authorizationSegmentRef: string;
  readonly authorizationSegmentVersion: string;
}

export function requireDispatchOwnerEvidence(
  result: DispatchOwnerEvidenceLookupResult,
  expected: ExpectedDispatchOwnerEvidence,
): DispatchOwnerEvidence {
  if (result.kind !== "found") {
    throw new Error("DISPATCH_OWNER_EVIDENCE_NOT_FOUND");
  }
  const evidence = result.evidence;
  if (
    evidence.evidenceVersion !== "1" ||
    evidence.kind !== expected.kind ||
    evidence.siteId !== expected.siteId ||
    evidence.sessionId !== expected.sessionId ||
    evidence.evidenceRef !== expected.evidenceRef ||
    evidence.launchId !== expected.launchId ||
    evidence.runId !== expected.runId
  ) {
    throw new Error("DISPATCH_OWNER_EVIDENCE_IDENTITY_MISMATCH");
  }
  if (
    evidence.authorizationSegmentRef !== expected.authorizationSegmentRef ||
    evidence.authorizationSegmentVersion !== expected.authorizationSegmentVersion
  ) {
    throw new Error("DISPATCH_OWNER_EVIDENCE_SEGMENT_MISMATCH");
  }
  return evidence;
}
