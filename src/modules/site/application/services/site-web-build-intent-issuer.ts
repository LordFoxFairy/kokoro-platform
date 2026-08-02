import { canonicalDigest, canonicalJson } from
  "../../../product-catalog/domain/canonical-product-document.js";
import type {
  SiteWebBuildIntentAssemblyPort,
  SiteWebBuildIntentIssuerAuthorityPort,
} from "../contracts/site-publication-authority-ports.js";
import type { CandidateAuthorityBinding, ImmutableRevisionBinding } from
  "../../domain/site-publication-authority.js";

export class SiteWebBuildIntentIssuer implements SiteWebBuildIntentAssemblyPort {
  constructor(
    private readonly authority: SiteWebBuildIntentIssuerAuthorityPort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async issue(
    transaction: Parameters<SiteWebBuildIntentAssemblyPort["issue"]>[0],
    input: Parameters<SiteWebBuildIntentAssemblyPort["issue"]>[1],
  ) {
    const inventory = input.predecessors["surface-inventory"];
    if (inventory === undefined) throw new Error("SITE_PUBLICATION_SURFACE_INVENTORY_REQUIRED");
    const material = input.predecessors["web-build-material-bundle"];
    if (material === undefined) throw new Error("SITE_PUBLICATION_BUILD_MATERIAL_REQUIRED");
    const candidateDocument = object(input.candidate.document, "SITE_PUBLICATION_CANDIDATE_INVALID");
    const inventoryDocument = object(inventory.document, "SITE_PUBLICATION_INVENTORY_INVALID");
    const authority = await this.authority.resolve(transaction, {
      siteRef: input.candidate.siteRef,
      environment: input.candidate.environment,
    });
    const issuedAt = instant(this.now());
    if (issuedAt < instant(authority.keyValidFrom) || issuedAt >= instant(authority.keyValidUntil)) {
      throw new Error("SITE_PUBLICATION_INTENT_SIGNING_KEY_INACTIVE");
    }
    const document = Object.freeze({
      contract: "kokoro.web-build-intent.v1",
      schemaRevision: "1",
      intentRef: input.binding.ref,
      revision: input.binding.revision.toString(),
      siteReleaseCandidate: wireCandidate(input.candidate.binding),
      siteRef: input.candidate.siteRef,
      environment: input.candidate.environment,
      audience: "kokoro.web-release-composition.build.v1",
      launchProductProfile: wire(input.candidate.launchProductProfile),
      shellRequirementRefs: refs(inventoryDocument.shellRequirementRefs),
      productSurfaceCatalog: wire(input.candidate.productSurfaceCatalog),
      surfaceInventory: wire(inventory.binding),
      webCompositionRegistry: wire(authority.webCompositionRegistry),
      webBuildToolchain: wire(authority.webBuildToolchain),
      webBuildMaterialBundle: wire(material.binding),
      contractFloor: [...authority.contractFloor]
        .sort((left, right) => left.contractRef.localeCompare(right.contractRef))
        .map((value) => Object.freeze({ contractRef: value.contractRef,
          minimumMajor: value.minimumMajor.toString() })),
      modelRequirements: candidateDocument.modelRequirements,
      businessBindings: candidateDocument.businessBindings,
      issuedAt,
      issuer: Object.freeze({
        issuerRef: authority.issuerRef,
        producerRegistry: authority.producerRegistry,
        producerRegistryEpoch: authority.producerRegistryEpoch.toString(),
        trustPolicy: authority.trustPolicy,
        trustPolicyEpoch: authority.trustPolicyEpoch.toString(),
        signingKeyId: authority.signingKeyId,
        keyVersion: authority.keyVersion.toString(),
        publicKeyFingerprint: authority.publicKeyFingerprint,
        keyStatus: "active",
        keyValidFrom: authority.keyValidFrom,
        keyValidUntil: authority.keyValidUntil,
        signatureAudience: "kokoro.web-build-intent.v1",
        environment: input.candidate.environment,
      }),
    });
    const canonicalBytes = Buffer.from(canonicalJson(document), "utf8");
    const digest = canonicalDigest(document);
    if (digest !== input.binding.digest) throw new Error("SITE_PUBLICATION_INTENT_DIGEST_MISMATCH");
    return Object.freeze({ canonicalBytes, parsedDocument: document, digest });
  }
}

function wire(value: ImmutableRevisionBinding) {
  return Object.freeze({ ref: value.ref, revision: value.revision.toString(), digest: value.digest });
}
function wireCandidate(value: CandidateAuthorityBinding) {
  return Object.freeze({ ref: value.ref, version: value.version.toString(),
    authorizationEpoch: value.authorizationEpoch.toString(), digest: value.digest });
}
function object(value: unknown, code: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Readonly<Record<string, unknown>>;
}
function refs(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 ||
      value.some((entry) => typeof entry !== "string")) {
    throw new Error("SITE_PUBLICATION_SHELL_REQUIREMENTS_INVALID");
  }
  const values = value as string[];
  if (new Set(values).size !== values.length) {
    throw new Error("SITE_PUBLICATION_SHELL_REQUIREMENTS_DUPLICATE");
  }
  return Object.freeze([...values].sort());
}
function instant(value: string): string {
  if (!/^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u.test(value) ||
      new Date(value).toISOString() !== value) throw new Error("SITE_PUBLICATION_TIME_INVALID");
  return value;
}
