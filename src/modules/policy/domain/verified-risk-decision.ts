const verifiedRiskBrand: unique symbol = Symbol("VerifiedRiskDecisionSnapshot");

export interface RiskDecisionSnapshot {
  readonly riskDecisionId: string; readonly policyRevision: string; readonly decision: "allow" | "challenge" | "deny";
  readonly operation: string; readonly environment: string; readonly region: string; readonly siteId: string | null;
  readonly subjectId: string; readonly subjectGeneration: string; readonly resourceDigest: string; readonly requestDigest: string;
  readonly riskEpoch: string; readonly issuedAt: string; readonly expiresAt: string; readonly issuer: string;
  readonly signatureKeyVersion: string; readonly signature: string;
}
export type VerifiedRiskDecisionSnapshot = RiskDecisionSnapshot & { readonly [verifiedRiskBrand]: true };
const verifiedRiskSnapshots = new WeakSet<object>();

export interface RiskSignatureVerifier {
  /** Verifies the signature over the canonical complete snapshot payload using trusted key material. */
  verify(snapshot: RiskDecisionSnapshot): Promise<{ readonly riskDecisionId: string; readonly issuer: string; readonly signatureKeyVersion: string }>;
}

export async function verifyRiskDecisionSnapshot(
  input: RiskDecisionSnapshot,
  options: { readonly now: string; readonly verifier: RiskSignatureVerifier },
): Promise<VerifiedRiskDecisionSnapshot> {
  const now = parseInstant(options.now);
  if (!digest(input.resourceDigest) || !digest(input.requestDigest) || !epoch(input.riskEpoch) || !epoch(input.subjectGeneration) || input.signature.length === 0) throw new Error("RISK_SNAPSHOT_SHAPE_INVALID");
  if (now < parseInstant(input.issuedAt) || now >= parseInstant(input.expiresAt)) throw new Error("RISK_SNAPSHOT_EXPIRED");
  const claims = await options.verifier.verify(input);
  if (claims.riskDecisionId !== input.riskDecisionId || claims.issuer !== input.issuer || claims.signatureKeyVersion !== input.signatureKeyVersion || claims.issuer.length === 0 || claims.signatureKeyVersion.length === 0) throw new Error("RISK_SIGNATURE_ATTESTATION_MISMATCH");
  const snapshot = Object.freeze(Object.defineProperty({ ...input }, verifiedRiskBrand, { value: true })) as VerifiedRiskDecisionSnapshot;
  verifiedRiskSnapshots.add(snapshot);
  return snapshot;
}

export function isVerifiedRiskDecisionSnapshot(value: VerifiedRiskDecisionSnapshot): boolean {
  return verifiedRiskSnapshots.has(value);
}

function parseInstant(value: string): number { const parsed = Date.parse(value); if (!Number.isFinite(parsed)) throw new Error("RISK_SNAPSHOT_TIME_INVALID"); return parsed; }
function digest(value: string): boolean { return /^[a-f0-9]{64}$/u.test(value); }
function epoch(value: string): boolean { return /^(?:0|[1-9][0-9]*)$/u.test(value); }
