import { createHash } from "node:crypto";
import { canonicalDigest, canonicalJson } from
  "../../../product-catalog/domain/canonical-product-document.js";
import type { SiteReleaseAssemblyPort } from
  "../contracts/site-publication-authority-ports.js";
import type { CandidateAuthorityBinding, ImmutableRevisionBinding, SitePublicationNode } from
  "../../domain/site-publication-authority.js";

export class SiteReleaseAssembler implements SiteReleaseAssemblyPort {
  readonly #now: () => string;
  constructor(options: Readonly<{ now?: () => string }> = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async assemble(
    _transaction: Parameters<SiteReleaseAssemblyPort["assemble"]>[0],
    input: Parameters<SiteReleaseAssemblyPort["assemble"]>[1],
  ) {
    const inventory = required(input.predecessors["surface-inventory"], "SURFACE_INVENTORY");
    const intent = required(input.predecessors["web-build-intent"], "WEB_BUILD_INTENT");
    const evidence = required(input.predecessors["release-evidence"], "RELEASE_EVIDENCE");
    const certification = required(input.predecessors["release-certification"], "RELEASE_CERTIFICATION");
    const candidateDocument = object(input.candidate.document, "CANDIDATE");
    const intentDocument = object(intent.document, "INTENT");
    const evidenceDocument = object(evidence.document, "EVIDENCE");
    const certificationDocument = object(certification.document, "CERTIFICATION");
    const compiledWebManifest = revision(evidenceDocument.compiledWebManifest, "COMPILED_MANIFEST");
    const webArtifactProvenance = revision(evidenceDocument.webArtifactProvenance, "PROVENANCE");
    const webCompositionRegistry = revision(intentDocument.webCompositionRegistry, "REGISTRY");
    const webBuildToolchain = revision(intentDocument.webBuildToolchain, "TOOLCHAIN");
    const webArtifactDigest = string(evidenceDocument.webArtifactDigest, "WEB_ARTIFACT_DIGEST");
    const certificationEpoch = decimal(certificationDocument.certificationRevocationEpoch,
      "CERTIFICATION_REVOCATION_EPOCH");
    const publishedAt = instant(this.#now());
    const releaseRef = releaseReference(input.candidate.binding.digest);
    const document = Object.freeze({
      contract: "kokoro.site-release.v1",
      schemaRevision: "1",
      siteReleaseRef: releaseRef,
      revision: input.candidate.binding.version.toString(),
      state: "published",
      siteRef: input.candidate.siteRef,
      environment: input.candidate.environment,
      siteReleaseCandidate: wireCandidate(input.candidate.binding),
      launchProductProfile: wire(input.candidate.launchProductProfile),
      productSurfaceCatalog: wire(input.candidate.productSurfaceCatalog),
      surfaceInventory: wire(inventory.binding),
      webBuildIntent: wire(intent.binding),
      compiledWebManifest: wire(compiledWebManifest),
      webArtifactProvenance: wire(webArtifactProvenance),
      webArtifactDigest,
      releaseCertification: wire(certification.binding),
      certificationRevocationEpoch: certificationEpoch,
      businessBindings: candidateDocument.businessBindings,
      bootstrapBindings: Object.freeze({
        compiledWebManifest: wire(compiledWebManifest),
        productSurfaceCatalog: wire(input.candidate.productSurfaceCatalog),
        surfaceInventory: wire(inventory.binding),
        webCompositionRegistry: wire(webCompositionRegistry),
        webBuildToolchain: wire(webBuildToolchain),
      }),
      contractFloor: intentDocument.contractFloor,
      publishedAt,
    });
    const canonicalBytes = Buffer.from(canonicalJson(document), "utf8");
    return Object.freeze({
      binding: Object.freeze({ ref: releaseRef, revision: input.candidate.binding.version,
        digest: canonicalDigest(document) }),
      source: Object.freeze({ canonicalBytes, parsedDocument: document, digest: canonicalDigest(document) }),
    });
  }
}

function required(value: SitePublicationNode | undefined, code: string): SitePublicationNode {
  if (value === undefined) throw new Error(`SITE_PUBLICATION_${code}_REQUIRED`);
  return value;
}
function object(value: unknown, code: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`SITE_PUBLICATION_${code}_INVALID`);
  }
  return value as Readonly<Record<string, unknown>>;
}
function revision(value: unknown, code: string): ImmutableRevisionBinding {
  const record = object(value, code);
  if (typeof record.ref !== "string" || typeof record.revision !== "string" ||
      !/^[1-9][0-9]*$/u.test(record.revision) || typeof record.digest !== "string") {
    throw new Error(`SITE_PUBLICATION_${code}_INVALID`);
  }
  return Object.freeze({ ref: record.ref, revision: BigInt(record.revision), digest: record.digest });
}
function wire(value: ImmutableRevisionBinding) {
  return Object.freeze({ ref: value.ref, revision: value.revision.toString(), digest: value.digest });
}
function wireCandidate(value: CandidateAuthorityBinding): Readonly<{
  ref: string; version: string; authorizationEpoch: string; digest: string;
}> {
  return Object.freeze({ ref: value.ref, version: value.version.toString(),
    authorizationEpoch: value.authorizationEpoch.toString(), digest: value.digest });
}
function releaseReference(candidateDigest: string): string {
  return `site-release.${createHash("sha256").update("kokoro.site-release.ref.v1\0")
    .update(candidateDigest).digest("hex")}`;
}
function string(value: unknown, code: string): string {
  if (typeof value !== "string") throw new Error(`SITE_PUBLICATION_${code}_INVALID`);
  return value;
}
function decimal(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`SITE_PUBLICATION_${code}_INVALID`);
  }
  return value;
}
function instant(value: string): string {
  if (!/^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u.test(value) ||
      new Date(value).toISOString() !== value) throw new Error("SITE_PUBLICATION_TIME_INVALID");
  return value;
}
