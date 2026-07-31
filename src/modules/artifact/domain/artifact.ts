export const ARTIFACT_DELIVERY_MAX_RANGE_BYTES = 8_388_608;

export type ArtifactOwnerScope = Readonly<{
  siteRef: string;
  subjectRef: string;
  subjectGeneration: bigint;
  projectRef: string;
}>;

export type ArtifactVersionState =
  | "reserved"
  | "retrieving"
  | "staged"
  | "validating"
  | "trust_pending"
  | "promotion_authorized"
  | "promoting"
  | "ready_private"
  | "restricted"
  | "failed"
  | "reconciling"
  | "purge_pending"
  | "purged";

export type ArtifactStagedReceipt = Readonly<{
  artifactVersionRef: string;
  stagedObjectRef: string;
  contentSha256: string;
  byteSize: bigint;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  state: "staged";
}>;

export type ArtifactTrustDecision =
  | Readonly<{ kind: "allow"; decisionRef: string; contentSha256: string }>
  | Readonly<{ kind: "restrict"; decisionRef: string; contentSha256: string; reasonCode: string }>;

export type ArtifactReadyReceipt = Readonly<{
  artifactVersionRef: string;
  readyObjectRef: string;
  contentSha256: string;
  byteSize: bigint;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  trustDecisionRef: string;
  state: "ready_private";
}>;

export type ArtifactByteRange = Readonly<{ start: number; endInclusive: number }>;

export function parseArtifactByteRange(
  header: string | undefined,
  totalBytes: number,
): ArtifactByteRange | undefined {
  if (header === undefined) return undefined;
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1) throw new Error("ARTIFACT_SIZE_INVALID");
  if (header.includes(",")) throw new Error("ARTIFACT_RANGE_MULTIPLE_UNSUPPORTED");
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header);
  if (match === null || (match[1] === "" && match[2] === "")) throw new Error("ARTIFACT_RANGE_INVALID");
  let start: number;
  let endInclusive: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) throw new Error("ARTIFACT_RANGE_INVALID");
    start = Math.max(0, totalBytes - suffix);
    endInclusive = totalBytes - 1;
  } else {
    start = Number(match[1]);
    endInclusive = match[2] === "" ? totalBytes - 1 : Number(match[2]);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || start < 0 ||
      start >= totalBytes || endInclusive < start || endInclusive >= totalBytes) {
    throw new Error("ARTIFACT_RANGE_UNSATISFIABLE");
  }
  if (endInclusive - start + 1 > ARTIFACT_DELIVERY_MAX_RANGE_BYTES) {
    throw new Error("ARTIFACT_RANGE_TOO_LARGE");
  }
  return Object.freeze({ start, endInclusive });
}

export function sameArtifactOwnerScope(left: ArtifactOwnerScope, right: ArtifactOwnerScope): boolean {
  return left.siteRef === right.siteRef && left.subjectRef === right.subjectRef &&
    left.subjectGeneration === right.subjectGeneration && left.projectRef === right.projectRef;
}

export function snapshotArtifactOwnerScope(input: ArtifactOwnerScope): ArtifactOwnerScope {
  for (const value of [input.siteRef, input.subjectRef, input.projectRef]) reference(value);
  if (typeof input.subjectGeneration !== "bigint" || input.subjectGeneration < 1n ||
      input.subjectGeneration > 9_223_372_036_854_775_807n) {
    throw new Error("ARTIFACT_OWNER_SCOPE_INVALID");
  }
  return Object.freeze({ ...input });
}

function reference(value: string): void {
  if (value.length < 1 || value.length > 256 || value.trim() !== value || hasControlCharacter(value)) {
    throw new Error("ARTIFACT_OWNER_SCOPE_INVALID");
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
