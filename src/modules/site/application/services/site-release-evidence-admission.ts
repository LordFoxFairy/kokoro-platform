import { createHash } from "node:crypto";
import { canonicalDigest, canonicalJson, verifyCanonicalDocument } from
  "../../../product-catalog/domain/canonical-product-document.js";
import {
  validateCompiledWebManifestShape,
  validateWebArtifactProvenanceShape,
} from "../../../../generated/schema/site-publication/validator.js";
import type { SiteReleaseEvidenceAdmissionPort } from
  "../contracts/site-publication-authority-ports.js";
import type { SiteReleaseEvidenceTrustPort } from
  "../contracts/site-release-evidence-trust.js";
import type { SitePublicationDocumentResolver } from
  "../contracts/site-publication-authority-ports.js";
import type { CandidateAuthorityBinding, ImmutableRevisionBinding } from
  "../../domain/site-publication-authority.js";

export class SiteReleaseEvidenceAdmission implements SiteReleaseEvidenceAdmissionPort {
  constructor(
    private readonly documents: Pick<SitePublicationDocumentResolver, "resolve">,
    private readonly trust: SiteReleaseEvidenceTrustPort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async verify(
    transaction: Parameters<SiteReleaseEvidenceAdmissionPort["verify"]>[0],
    input: Parameters<SiteReleaseEvidenceAdmissionPort["verify"]>[1],
  ) {
    const intent = input.predecessors["web-build-intent"];
    if (intent === undefined) throw new Error("SITE_PUBLICATION_WEB_BUILD_INTENT_REQUIRED");
    const inventory = input.predecessors["surface-inventory"];
    if (inventory === undefined) throw new Error("SITE_PUBLICATION_SURFACE_INVENTORY_REQUIRED");
    const [manifestSource, provenanceSource] = await Promise.all([
      this.documents.resolve({ kind: "compiled-web-manifest", binding: input.compiledWebManifest }),
      this.documents.resolve({ kind: "web-artifact-provenance", binding: input.webArtifactProvenance }),
    ]);
    const manifest = verifyCanonicalDocument(manifestSource);
    const provenance = verifyCanonicalDocument(provenanceSource);
    if (!validateCompiledWebManifestShape(manifest.parsedDocument) ||
        !validateWebArtifactProvenanceShape(provenance.parsedDocument)) {
      throw new Error("SITE_PUBLICATION_ATTESTOR_DOCUMENT_SCHEMA_INVALID");
    }
    if (manifest.digest !== input.compiledWebManifest.digest ||
        provenance.digest !== input.webArtifactProvenance.digest) {
      throw new Error("SITE_PUBLICATION_ATTESTOR_DOCUMENT_DIGEST_MISMATCH");
    }
    const manifestDocument = object(manifest.parsedDocument);
    const provenanceDocument = object(provenance.parsedDocument);
    const intentDocument = object(intent.document);
    assertCandidate(manifestDocument.siteReleaseCandidate, input.candidate.binding);
    assertRevision(manifestDocument.webBuildIntent, intent.binding);
    assertRevision(manifestDocument.surfaceInventory, inventory.binding);
    assertRevision(manifestDocument.catalog, input.candidate.productSurfaceCatalog);
    assertRevision(manifestDocument.registry, revision(intentDocument.webCompositionRegistry));
    assertRevision(manifestDocument.toolchain, revision(intentDocument.webBuildToolchain));
    const external = object(object(provenanceDocument.predicate).buildDefinition);
    const parameters = object(external.externalParameters);
    assertCandidate(parameters.siteReleaseCandidate, input.candidate.binding);
    assertRevision(parameters.webBuildIntent, intent.binding);
    assertRevision(parameters.compiledWebManifest, input.compiledWebManifest);
    assertRevision(parameters.toolchain, revision(intentDocument.webBuildToolchain));
    if (parameters.siteRef !== input.candidate.siteRef) {
      throw new Error("SITE_PUBLICATION_ATTESTOR_SITE_MISMATCH");
    }
    const subject = array(provenanceDocument.subject);
    if (subject.length !== 1 || object(object(subject[0]).digest).sha256 !== unprefixed(input.webArtifactDigest)) {
      throw new Error("SITE_PUBLICATION_WEB_ARTIFACT_SUBJECT_MISMATCH");
    }
    const trust = await this.trust.verify(transaction, {
      candidate: input.candidate, producerIdentityRef: input.producerIdentityRef,
      provenanceBinding: input.webArtifactProvenance,
      provenanceStatement: provenance.parsedDocument,
      webArtifactDigest: input.webArtifactDigest,
      artifactInspectionEvidence: input.artifactInspectionEvidence,
      journeyEvidence: input.journeyEvidence,
      securityEvidence: input.securityEvidence,
    });
    const document = Object.freeze({
      contract: "kokoro.site-release-evidence.v1", schemaRevision: "1",
      releaseEvidenceRef: evidenceRef(input.candidate.binding, input.webArtifactDigest), revision: "1",
      siteRef: input.candidate.siteRef, siteReleaseCandidate: wireCandidate(input.candidate.binding),
      webBuildIntent: wire(intent.binding), compiledWebManifest: wire(input.compiledWebManifest),
      webArtifactProvenance: wire(input.webArtifactProvenance),
      webArtifactDigest: input.webArtifactDigest,
      artifactInspectionEvidence: wire(input.artifactInspectionEvidence),
      journeyEvidence: wire(input.journeyEvidence), securityEvidence: wire(input.securityEvidence),
      producerIdentityRef: input.producerIdentityRef,
      producerRegistration: wire(trust.producerRegistration), trustPolicy: wire(trust.trustPolicy),
      signingKeyId: trust.signingKeyId, signingKeyVersion: trust.signingKeyVersion.toString(),
      signatureAudience: trust.signatureAudience, verifiedAt: instant(this.now()),
    });
    const binding = Object.freeze({ ref: document.releaseEvidenceRef, revision: 1n,
      digest: canonicalDigest(document) });
    return Object.freeze({ binding, source: Object.freeze({
      canonicalBytes: Buffer.from(canonicalJson(document), "utf8"),
      parsedDocument: document, digest: binding.digest,
    }) });
  }
}

function evidenceRef(candidate: CandidateAuthorityBinding, artifactDigest: string): string {
  return `release-evidence.${createHash("sha256").update("kokoro.release-evidence.ref.v1\0")
    .update(candidate.digest).update("\0").update(artifactDigest).digest("hex")}`;
}
function wire(value: ImmutableRevisionBinding) {
  return Object.freeze({ ref: value.ref, revision: value.revision.toString(), digest: value.digest });
}
function wireCandidate(value: CandidateAuthorityBinding) {
  return Object.freeze({ ref: value.ref, version: value.version.toString(),
    authorizationEpoch: value.authorizationEpoch.toString(), digest: value.digest });
}
function assertRevision(value: unknown, expected: ImmutableRevisionBinding): void {
  const actual = object(value);
  if (actual.ref !== expected.ref || actual.revision !== expected.revision.toString() ||
      actual.digest !== expected.digest) throw new Error("SITE_PUBLICATION_ATTESTOR_BINDING_MISMATCH");
}
function revision(value: unknown): ImmutableRevisionBinding {
  const actual = object(value);
  if (typeof actual.ref !== "string" || typeof actual.revision !== "string" ||
      !/^[1-9][0-9]*$/u.test(actual.revision) || typeof actual.digest !== "string") {
    throw new Error("SITE_PUBLICATION_ATTESTOR_BINDING_INVALID");
  }
  return Object.freeze({ ref: actual.ref, revision: BigInt(actual.revision), digest: actual.digest });
}
function assertCandidate(value: unknown, expected: CandidateAuthorityBinding): void {
  const actual = object(value);
  if (actual.ref !== expected.ref || actual.version !== expected.version.toString() ||
      actual.authorizationEpoch !== expected.authorizationEpoch.toString() ||
      actual.digest !== expected.digest) throw new Error("SITE_PUBLICATION_ATTESTOR_CANDIDATE_MISMATCH");
}
function object(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SITE_PUBLICATION_ATTESTOR_DOCUMENT_INVALID");
  }
  return value as Readonly<Record<string, unknown>>;
}
function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error("SITE_PUBLICATION_ATTESTOR_DOCUMENT_INVALID");
  return value;
}
function unprefixed(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error("SITE_PUBLICATION_WEB_ARTIFACT_DIGEST_INVALID");
  return value.slice(7);
}
function instant(value: string): string {
  if (!/^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u.test(value) ||
      new Date(value).toISOString() !== value) throw new Error("SITE_PUBLICATION_TIME_INVALID");
  return value;
}
