export interface RedemptionSecretPort {
  readonly currentCodeLookupKeyRevision: string;
  codeLookupCandidates(code: string, siteId: string): readonly Readonly<{
    keyRevision: string;
    batchSelector: string;
    lookupDigest: string;
  }>[];
  safeCodeFingerprint(code: string, siteId: string): string;
  previewCredential(previewRef: string, keyRevision?: string): string;
  verifyPreviewCredential(credential: string): Readonly<{
    keyRevision: string;
    previewRef: string;
    credentialDigest: string;
  }> | null;
  previewRequestDigest(input: Readonly<{
    siteId: string;
    subjectId: string;
    subjectGeneration: string;
    code: string;
  }>): string;
  confirmRequestDigest(input: Readonly<{
    siteId: string;
    subjectId: string;
    subjectGeneration: string;
    previewCredential: string;
    legalAcceptanceRefs: readonly string[];
  }>): string;
}

export interface RedemptionCodeIssuancePort {
  issueCode(siteId: string, batchRef: string): Readonly<{
    code: string;
    keyRevision: string;
    batchSelector: string;
    lookupDigest: string;
    safeFingerprint: string;
  }>;
}
