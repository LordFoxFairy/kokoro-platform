import {
  canonicalDigest,
  verifyCanonicalDocument,
  type CanonicalJsonValue,
  type ResolvedCanonicalDocument,
} from "../../product-catalog/domain/canonical-product-document.js";
import {
  validateReleaseCertificationShape,
  validateSiteReleaseCandidateShape,
  validateSiteReleaseShape,
  validateSurfaceInventoryShape,
  validateWebBuildIntentShape,
  validateWebBuildMaterialBundleShape,
} from "../../../generated/schema/site-publication/validator.js";
import {
  isDeploymentEnvironment,
  type DeploymentEnvironment,
} from "../../../shared/deployment-environment.js";

export interface ImmutableRevisionBinding {
  readonly ref: string;
  readonly revision: bigint;
  readonly digest: string;
}

export interface CandidateAuthorityBinding {
  readonly ref: string;
  readonly version: bigint;
  readonly authorizationEpoch: bigint;
  readonly digest: string;
}

export interface SiteReleaseCandidateAuthority {
  readonly binding: CandidateAuthorityBinding;
  readonly siteRef: string;
  readonly environment: DeploymentEnvironment;
  readonly launchProductProfile: ImmutableRevisionBinding;
  readonly productSurfaceCatalog: ImmutableRevisionBinding;
  readonly businessBindingsDigest: string;
  readonly state: "authorized" | "revoked";
  readonly document: CanonicalJsonValue;
  readonly canonicalBytes: Uint8Array;
}

export type SitePublicationNodeKind =
  | "surface-inventory"
  | "web-build-material-bundle"
  | "web-build-intent"
  | "release-evidence"
  | "release-certification"
  | "site-release";

export interface SitePublicationNode {
  readonly kind: SitePublicationNodeKind;
  readonly binding: ImmutableRevisionBinding;
  readonly candidate: CandidateAuthorityBinding;
  readonly siteRef: string;
  readonly document: CanonicalJsonValue;
  readonly canonicalBytes: Uint8Array;
}

export function authorizeSiteReleaseCandidate(input: Readonly<{
  siteRef: string;
  environment: string;
  candidateRef: string;
  expectedCandidateVersion: bigint;
  candidateAuthorizationEpoch: bigint;
  launchProductProfile: ImmutableRevisionBinding;
  productSurfaceCatalog: ImmutableRevisionBinding;
  businessBindingsDigest: string;
}>, source: ResolvedCanonicalDocument): SiteReleaseCandidateAuthority {
  positive(input.expectedCandidateVersion, "SITE_PUBLICATION_CANDIDATE_VERSION_INVALID");
  positive(input.candidateAuthorizationEpoch, "SITE_PUBLICATION_CANDIDATE_EPOCH_INVALID");
  assertRevisionBinding(input.launchProductProfile);
  assertRevisionBinding(input.productSurfaceCatalog);
  digest(input.businessBindingsDigest);
  const verified = verifyCanonicalDocument(source);
  if (!validateSiteReleaseCandidateShape(verified.parsedDocument)) {
    throw new Error("SITE_PUBLICATION_CANDIDATE_SCHEMA_INVALID");
  }
  const document = record(verified.parsedDocument, "SITE_PUBLICATION_CANDIDATE_DOCUMENT_INVALID");
  exact(document.contract, "kokoro.site-release-candidate.v1",
    "SITE_PUBLICATION_CANDIDATE_CONTRACT_INVALID");
  exact(document.schemaRevision, "1", "SITE_PUBLICATION_CANDIDATE_SCHEMA_INVALID");
  exact(document.state, "authorized", "SITE_PUBLICATION_CANDIDATE_STATE_INVALID");
  if (document.siteRef !== input.siteRef || document.environment !== input.environment) {
    throw new Error("SITE_PUBLICATION_CANDIDATE_SCOPE_MISMATCH");
  }
  exact(document.candidateRef, input.candidateRef, "SITE_PUBLICATION_CANDIDATE_REF_MISMATCH");
  exactDecimal(document.revision, input.expectedCandidateVersion,
    "SITE_PUBLICATION_CANDIDATE_VERSION_MISMATCH");
  exactDecimal(document.candidateAuthorizationEpoch, input.candidateAuthorizationEpoch,
    "SITE_PUBLICATION_CANDIDATE_EPOCH_MISMATCH");
  assertWireRevision(document.launchProductProfile, input.launchProductProfile,
    "SITE_PUBLICATION_PROFILE_BINDING_MISMATCH");
  assertWireRevision(document.productSurfaceCatalog, input.productSurfaceCatalog,
    "SITE_PUBLICATION_CATALOG_BINDING_MISMATCH");
  if (canonicalDigest(document.businessBindings) !== input.businessBindingsDigest) {
    throw new Error("SITE_PUBLICATION_BUSINESS_BINDINGS_DIGEST_MISMATCH");
  }
  return deepFreeze({
    binding: {
      ref: input.candidateRef,
      version: input.expectedCandidateVersion,
      authorizationEpoch: input.candidateAuthorizationEpoch,
      digest: verified.digest,
    },
    siteRef: input.siteRef,
    environment: environment(input.environment),
    launchProductProfile: input.launchProductProfile,
    productSurfaceCatalog: input.productSurfaceCatalog,
    businessBindingsDigest: input.businessBindingsDigest,
    state: "authorized",
    document: verified.parsedDocument,
    canonicalBytes: verified.canonicalBytes,
  });
}

export function revokeSiteReleaseCandidateAuthorization(
  current: SiteReleaseCandidateAuthority,
  expected: CandidateAuthorityBinding,
  expectedAuthorizationEpoch: bigint,
): Readonly<{
  candidate: SiteReleaseCandidateAuthority;
  previousAuthorizationEpoch: bigint;
  authorizationEpoch: bigint;
}> {
  if (current.state !== "authorized") throw new Error("SITE_PUBLICATION_CANDIDATE_ALREADY_REVOKED");
  if (!sameCandidate(current.binding, expected) ||
      current.binding.authorizationEpoch !== expectedAuthorizationEpoch) {
    throw new Error("SITE_PUBLICATION_CANDIDATE_REVOKE_BINDING_MISMATCH");
  }
  if (expectedAuthorizationEpoch >= 18_446_744_073_709_551_614n) {
    throw new Error("SITE_PUBLICATION_CANDIDATE_EPOCH_EXHAUSTED");
  }
  const authorizationEpoch = expectedAuthorizationEpoch + 1n;
  const candidate = deepFreeze({
    ...current,
    binding: { ...current.binding, authorizationEpoch },
    state: "revoked" as const,
  });
  return deepFreeze({
    candidate,
    previousAuthorizationEpoch: expectedAuthorizationEpoch,
    authorizationEpoch,
  });
}

export function admitSitePublicationNode(
  kind: SitePublicationNodeKind,
  input: Readonly<{
    binding: ImmutableRevisionBinding;
    source: ResolvedCanonicalDocument;
    candidate: SiteReleaseCandidateAuthority;
    predecessors: Readonly<Partial<Record<SitePublicationNodeKind, SitePublicationNode>>>;
  }>,
): SitePublicationNode {
  if (input.candidate.state !== "authorized") throw new Error("SITE_PUBLICATION_CANDIDATE_REVOKED");
  assertRevisionBinding(input.binding);
  const verified = verifyCanonicalDocument(input.source);
  if (verified.digest !== input.binding.digest) throw new Error("SITE_PUBLICATION_NODE_DIGEST_MISMATCH");
  if (!validateNodeShape(kind, verified.parsedDocument)) {
    throw new Error("SITE_PUBLICATION_NODE_SCHEMA_INVALID");
  }
  const document = record(verified.parsedDocument, "SITE_PUBLICATION_NODE_DOCUMENT_INVALID");
  exact(document.contract, contractFor(kind), "SITE_PUBLICATION_NODE_CONTRACT_INVALID");
  assertDocumentIdentity(kind, document, input.binding);
  if (kind !== "web-build-material-bundle" || document.siteRef !== undefined) {
    exact(document.siteRef, input.candidate.siteRef, "SITE_PUBLICATION_SITE_BINDING_MISMATCH");
  }
  if (kind === "web-build-material-bundle") {
    const bindings = record(input.candidate.document, "SITE_PUBLICATION_CANDIDATE_DOCUMENT_INVALID");
    const business = record(bindings.businessBindings, "SITE_PUBLICATION_BUSINESS_BINDINGS_INVALID");
    assertWireRevision(business.webBuildMaterialBundle, input.binding,
      "SITE_PUBLICATION_MATERIAL_BINDING_MISMATCH");
  } else assertWireCandidate(document.siteReleaseCandidate, input.candidate.binding);
  if (document.launchProductProfile !== undefined) {
    assertWireRevision(document.launchProductProfile, input.candidate.launchProductProfile,
      "SITE_PUBLICATION_PROFILE_BINDING_MISMATCH");
  }
  if (document.productSurfaceCatalog !== undefined) {
    assertWireRevision(document.productSurfaceCatalog, input.candidate.productSurfaceCatalog,
      "SITE_PUBLICATION_CATALOG_BINDING_MISMATCH");
  }
  for (const predecessor of predecessorBindings(kind, document)) {
    const admitted = input.predecessors[predecessor.kind];
    if (admitted === undefined || !sameRevisionBinding(admitted.binding, predecessor.binding) ||
        !sameCandidate(admitted.candidate, input.candidate.binding)) {
      throw new Error(`SITE_PUBLICATION_${predecessor.kind.toUpperCase().replaceAll("-", "_")}_MISMATCH`);
    }
  }
  assertCrossNodeEvidence(kind, document, input.predecessors);
  return deepFreeze({ kind, binding: input.binding, candidate: input.candidate.binding,
    siteRef: input.candidate.siteRef, document: verified.parsedDocument,
    canonicalBytes: verified.canonicalBytes });
}

function predecessorBindings(kind: SitePublicationNodeKind, document: Readonly<Record<string, unknown>>) {
  const dependencies: Readonly<Partial<Record<SitePublicationNodeKind,
    readonly Readonly<{ kind: SitePublicationNodeKind; field: string }>[]>>> = {
    "web-build-intent": [
      { kind: "surface-inventory", field: "surfaceInventory" },
      { kind: "web-build-material-bundle", field: "webBuildMaterialBundle" },
    ],
    "release-evidence": [{ kind: "web-build-intent", field: "webBuildIntent" }],
    "release-certification": [
      { kind: "surface-inventory", field: "surfaceInventory" },
      { kind: "web-build-intent", field: "webBuildIntent" },
      { kind: "release-evidence", field: "evidenceBundle" },
    ],
    "site-release": [
      { kind: "surface-inventory", field: "surfaceInventory" },
      { kind: "web-build-intent", field: "webBuildIntent" },
      { kind: "release-certification", field: "releaseCertification" },
    ],
  };
  return (dependencies[kind] ?? []).map((dependency) => ({
    kind: dependency.kind,
    binding: wireRevision(document[dependency.field], "SITE_PUBLICATION_PREDECESSOR_INVALID"),
  }));
}

function assertCrossNodeEvidence(
  kind: SitePublicationNodeKind,
  document: Readonly<Record<string, unknown>>,
  predecessors: Readonly<Partial<Record<SitePublicationNodeKind, SitePublicationNode>>>,
): void {
  if (kind !== "release-certification") return;
  const evidence = predecessors["release-evidence"];
  if (evidence === undefined) throw new Error("SITE_PUBLICATION_RELEASE_EVIDENCE_MISMATCH");
  const evidenceDocument = record(evidence.document, "SITE_PUBLICATION_RELEASE_EVIDENCE_INVALID");
  assertWireRevision(document.compiledWebManifest,
    wireRevision(evidenceDocument.compiledWebManifest, "SITE_PUBLICATION_RELEASE_EVIDENCE_INVALID"),
    "SITE_PUBLICATION_COMPILED_WEB_MANIFEST_MISMATCH");
  assertWireRevision(document.webArtifactProvenance,
    wireRevision(evidenceDocument.webArtifactProvenance, "SITE_PUBLICATION_RELEASE_EVIDENCE_INVALID"),
    "SITE_PUBLICATION_WEB_ARTIFACT_PROVENANCE_MISMATCH");
  if (document.webArtifactDigest !== evidenceDocument.webArtifactDigest) {
    throw new Error("SITE_PUBLICATION_WEB_ARTIFACT_DIGEST_MISMATCH");
  }
}

function assertDocumentIdentity(
  kind: SitePublicationNodeKind,
  document: Readonly<Record<string, unknown>>,
  binding: ImmutableRevisionBinding,
): void {
  const refFields: Readonly<Record<SitePublicationNodeKind, string>> = {
    "surface-inventory": "inventoryRevisionRef",
    "web-build-material-bundle": "bundleRef",
    "web-build-intent": "intentRef",
    "release-evidence": "releaseEvidenceRef",
    "release-certification": "certificationRef",
    "site-release": "siteReleaseRef",
  };
  exact(document[refFields[kind]], binding.ref, "SITE_PUBLICATION_NODE_REF_MISMATCH");
  exactDecimal(document.revision, binding.revision, "SITE_PUBLICATION_NODE_REVISION_MISMATCH");
}

function contractFor(kind: SitePublicationNodeKind): string {
  return ({
    "surface-inventory": "kokoro.surface-inventory.v1",
    "web-build-material-bundle": "kokoro.web-build-material-bundle.v1",
    "web-build-intent": "kokoro.web-build-intent.v1",
    "release-evidence": "kokoro.site-release-evidence.v1",
    "release-certification": "kokoro.release-certification-instance.v1",
    "site-release": "kokoro.site-release.v1",
  } as const)[kind];
}

function validateNodeShape(kind: SitePublicationNodeKind, value: unknown): boolean {
  switch (kind) {
    case "surface-inventory": return validateSurfaceInventoryShape(value);
    case "web-build-material-bundle": return validateWebBuildMaterialBundleShape(value);
    case "web-build-intent": return validateWebBuildIntentShape(value);
    case "release-certification": return validateReleaseCertificationShape(value);
    case "site-release": return validateSiteReleaseShape(value);
    // ReleaseEvidence is a Platform-owned aggregate of separately schema-checked
    // attestor facts and intentionally has no Root JSON document schema.
    case "release-evidence": return true;
  }
}

function assertWireCandidate(value: unknown, binding: CandidateAuthorityBinding): void {
  const candidate = record(value, "SITE_PUBLICATION_CANDIDATE_BINDING_INVALID");
  if (candidate.ref !== binding.ref || candidate.version !== binding.version.toString() ||
      candidate.authorizationEpoch !== binding.authorizationEpoch.toString() ||
      candidate.digest !== binding.digest) {
    throw new Error("SITE_PUBLICATION_CANDIDATE_BINDING_MISMATCH");
  }
}

function assertWireRevision(value: unknown, binding: ImmutableRevisionBinding, code: string): void {
  if (!sameRevisionBinding(wireRevision(value, code), binding)) throw new Error(code);
}

function wireRevision(value: unknown, code: string): ImmutableRevisionBinding {
  const binding = record(value, code);
  if (typeof binding.ref !== "string" || typeof binding.revision !== "string" ||
      !/^[1-9][0-9]*$/u.test(binding.revision) || typeof binding.digest !== "string") {
    throw new Error(code);
  }
  return Object.freeze({ ref: binding.ref, revision: BigInt(binding.revision), digest: binding.digest });
}

function assertRevisionBinding(binding: ImmutableRevisionBinding): void {
  if (binding.ref.length < 3) throw new Error("SITE_PUBLICATION_REVISION_REF_INVALID");
  positive(binding.revision, "SITE_PUBLICATION_REVISION_INVALID");
  digest(binding.digest);
}
function sameRevisionBinding(left: ImmutableRevisionBinding, right: ImmutableRevisionBinding): boolean {
  return left.ref === right.ref && left.revision === right.revision && left.digest === right.digest;
}
function sameCandidate(left: CandidateAuthorityBinding, right: CandidateAuthorityBinding): boolean {
  return left.ref === right.ref && left.version === right.version &&
    left.authorizationEpoch === right.authorizationEpoch && left.digest === right.digest;
}
function exact(actual: unknown, expected: string, code: string): void {
  if (actual !== expected) throw new Error(code);
}
function exactDecimal(actual: unknown, expected: bigint, code: string): void {
  if (actual !== expected.toString()) throw new Error(code);
}
function positive(value: bigint, code: string): void {
  if (value < 1n || value > 18_446_744_073_709_551_615n) throw new Error(code);
}
function digest(value: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error("SITE_PUBLICATION_DIGEST_INVALID");
}
function record(value: unknown, code: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Readonly<Record<string, unknown>>;
}
function environment(value: string): SiteReleaseCandidateAuthority["environment"] {
  if (!isDeploymentEnvironment(value)) {
    throw new Error("SITE_PUBLICATION_ENVIRONMENT_INVALID");
  }
  return value;
}
function deepFreeze<T>(value: T): T {
  const stack: object[] = value !== null && typeof value === "object" ? [value] : [];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (ArrayBuffer.isView(current)) continue;
    if (Object.isFrozen(current)) continue;
    for (const child of Object.values(current)) if (child !== null && typeof child === "object") stack.push(child);
    Object.freeze(current);
  }
  return value;
}
