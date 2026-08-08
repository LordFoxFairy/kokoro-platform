import { createHash } from "node:crypto";
import { canonicalDigest, canonicalJson } from
  "../../../product-catalog/domain/canonical-product-document.js";
import { validateWebBuildIntentShape } from
  "../../../../generated/schema/site-publication/validator.js";
import type {
  SiteWebBuildIntentAssemblyPort,
  SiteWebBuildIntentIssuerAuthorityPort,
  SiteWebBuildIntentSignerPort,
} from "../contracts/site-publication-authority-ports.js";
import type { CandidateAuthorityBinding, ImmutableRevisionBinding } from
  "../../domain/site-publication-authority.js";
import {
  createSiteWebBuildIntentDsseEnvelope,
  decodeSiteWebBuildIntentDssePayload,
  SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE,
} from "../../domain/site-web-build-intent-dsse.js";

export class SiteWebBuildIntentIssuer implements SiteWebBuildIntentAssemblyPort {
  constructor(
    private readonly authority: SiteWebBuildIntentIssuerAuthorityPort,
    private readonly signer: SiteWebBuildIntentSignerPort,
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
    const intentRef = reference(input.commandId, input.candidate.binding.digest);
    const revision = input.candidate.binding.version;
    const document = Object.freeze({
      contract: "kokoro.web-build-intent.v1",
      schemaRevision: "1",
      intentRef,
      revision: revision.toString(),
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
        .sort((left, right) => compare(left.contractRef, right.contractRef))
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
    const envelope = await this.signer.sign({
      key: signingKey(authority),
      payloadType: SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE,
      payload: canonicalBytes,
    });
    return Object.freeze({
      binding: Object.freeze({ ref: intentRef, revision, digest }),
      source: Object.freeze({ canonicalBytes, parsedDocument: document, digest }),
      envelope,
    });
  }

  async verify(
    transaction: Parameters<SiteWebBuildIntentAssemblyPort["verify"]>[0],
    input: Parameters<SiteWebBuildIntentAssemblyPort["verify"]>[1],
  ): Promise<void> {
    const document = object(input.node.document, "SITE_WEB_BUILD_INTENT_DOCUMENT_INVALID");
    if (input.node.kind !== "web-build-intent" || !validateWebBuildIntentShape(document) ||
        document.intentRef !== input.node.binding.ref ||
        document.revision !== input.node.binding.revision.toString() ||
        document.siteRef !== input.candidate.siteRef ||
        document.environment !== input.candidate.environment ||
        canonicalDigest(document) !== input.node.binding.digest ||
        canonicalJson(document) !== Buffer.from(input.node.canonicalBytes).toString("utf8")) {
      throw new Error("SITE_WEB_BUILD_INTENT_DOCUMENT_INVALID");
    }
    const envelope = createSiteWebBuildIntentDsseEnvelope(input.envelope);
    if (!Buffer.from(decodeSiteWebBuildIntentDssePayload(envelope))
      .equals(Buffer.from(input.node.canonicalBytes))) {
      throw new Error("SITE_WEB_BUILD_INTENT_ENVELOPE_PAYLOAD_MISMATCH");
    }
    const issuer = object(document.issuer, "SITE_WEB_BUILD_INTENT_DOCUMENT_INVALID");
    const key = Object.freeze({
      keyId: text(issuer.signingKeyId, "SITE_WEB_BUILD_INTENT_DOCUMENT_INVALID"),
      keyVersion: decimal(issuer.keyVersion, "SITE_WEB_BUILD_INTENT_DOCUMENT_INVALID"),
      publicKeyFingerprint: text(
        issuer.publicKeyFingerprint,
        "SITE_WEB_BUILD_INTENT_DOCUMENT_INVALID",
      ),
    });
    if (envelope.signatures[0].keyid !== key.keyId) {
      throw new Error("SITE_WEB_BUILD_INTENT_SIGNING_KEY_MISMATCH");
    }
    const authority = await this.authority.resolveExact(transaction, {
      siteRef: input.candidate.siteRef,
      environment: input.candidate.environment,
      key,
    });
    if (!same(document.webCompositionRegistry, wire(authority.webCompositionRegistry)) ||
        !same(document.webBuildToolchain, wire(authority.webBuildToolchain)) ||
        !same(document.contractFloor, floor(authority.contractFloor)) ||
        !same(issuer, issuerDocument(authority, input.candidate.environment))) {
      throw new Error("SITE_WEB_BUILD_INTENT_AUTHORITY_MISMATCH");
    }
    const issuedAt = instant(text(document.issuedAt, "SITE_WEB_BUILD_INTENT_DOCUMENT_INVALID"));
    if (issuedAt < instant(authority.keyValidFrom) || issuedAt >= instant(authority.keyValidUntil)) {
      throw new Error("SITE_PUBLICATION_INTENT_SIGNING_KEY_INACTIVE");
    }
    await this.signer.verify({ key, envelope });
  }
}

function reference(commandId: string, candidateDigest: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    .test(commandId)) throw new Error("SITE_PUBLICATION_COMMAND_ID_INVALID");
  if (!/^sha256:[0-9a-f]{64}$/u.test(candidateDigest)) {
    throw new Error("SITE_PUBLICATION_CANDIDATE_DIGEST_INVALID");
  }
  return `web-build-intent.${createHash("sha256")
    .update("kokoro.web-build-intent.ref.v1\0", "utf8")
    .update(commandId, "utf8")
    .update("\0", "utf8")
    .update(candidateDigest, "utf8")
    .digest("hex")}`;
}

function wire(value: ImmutableRevisionBinding) {
  return Object.freeze({ ref: value.ref, revision: value.revision.toString(), digest: value.digest });
}
function wireCandidate(value: CandidateAuthorityBinding) {
  return Object.freeze({ ref: value.ref, version: value.version.toString(),
    authorizationEpoch: value.authorizationEpoch.toString(), digest: value.digest });
}
function signingKey(value: Awaited<ReturnType<SiteWebBuildIntentIssuerAuthorityPort["resolve"]>>) {
  return Object.freeze({
    keyId: value.signingKeyId,
    keyVersion: value.keyVersion,
    publicKeyFingerprint: value.publicKeyFingerprint,
  });
}
function issuerDocument(
  authority: Awaited<ReturnType<SiteWebBuildIntentIssuerAuthorityPort["resolve"]>>,
  environment: string,
) {
  return Object.freeze({
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
    environment,
  });
}
function floor(values: Awaited<ReturnType<SiteWebBuildIntentIssuerAuthorityPort["resolve"]>>["contractFloor"]) {
  return [...values].sort((left, right) => compare(left.contractRef, right.contractRef))
    .map((value) => Object.freeze({
      contractRef: value.contractRef,
      minimumMajor: value.minimumMajor.toString(),
    }));
}
function object(value: unknown, code: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Readonly<Record<string, unknown>>;
}
function text(value: unknown, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  return value;
}
function decimal(value: unknown, code: string): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) throw new Error(code);
  const result = BigInt(value);
  if (result > 18_446_744_073_709_551_615n) throw new Error(code);
  return result;
}
function same(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left as never) === canonicalJson(right as never);
  } catch {
    return false;
  }
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
