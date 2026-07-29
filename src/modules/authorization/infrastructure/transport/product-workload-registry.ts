import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { TLSSocket } from "node:tls";
import type {
  RequestSecurityContext,
  TrustedCallerCryptographicVerifier,
  VerifiedTrustedCallerClaims,
} from "../../../../shared/security-context/request-security-context.js";
import type { ProductWorkloadIdentity, RuntimeEnvironment } from "../../domain/session-access-grant.js";
import { SessionAuthorizationError } from "../../domain/session-access-grant.js";
import { PLATFORM_PUBLIC_OPERATIONS } from "../../../../interfaces/http/generated/platform-public/operations.gen.js";

const ALLOWED_OPERATIONS = new Set(Object.keys(PLATFORM_PUBLIC_OPERATIONS));

declare const verifiedCsrfEvidenceBrand: unique symbol;
export type VerifiedCsrfEvidence = Readonly<{
  readonly workloadIdentityId: string;
  readonly digest: string;
  readonly [verifiedCsrfEvidenceBrand]: true;
}>;
const issuedCsrfEvidence = new WeakSet<object>();

export class ProductWorkloadRegistry implements TrustedCallerCryptographicVerifier {
  readonly #byFingerprint: ReadonlyMap<string, ProductWorkloadIdentity>;
  readonly #registryRevision: string;

  private constructor(
    byFingerprint: ReadonlyMap<string, ProductWorkloadIdentity>,
    registryRevision: string,
  ) {
    this.#byFingerprint = byFingerprint;
    this.#registryRevision = registryRevision;
  }

  static parse(input: unknown): ProductWorkloadRegistry {
    const root = object(input, "PRODUCT_WORKLOAD_REGISTRY_INVALID");
    exact(root, ["version", "registryRevision", "registrations"]);
    if (root.version !== 1) throw new Error("PRODUCT_WORKLOAD_REGISTRY_VERSION_UNSUPPORTED");
    const registryRevision = reference(root.registryRevision, 128);
    if (!Array.isArray(root.registrations) || root.registrations.length < 1 || root.registrations.length > 1024) {
      throw new Error("PRODUCT_WORKLOAD_REGISTRY_INVALID");
    }
    const byFingerprint = new Map<string, ProductWorkloadIdentity>();
    const workloadIds = new Set<string>();
    for (const raw of root.registrations) {
      const item = object(raw, "PRODUCT_WORKLOAD_REGISTRATION_INVALID");
      exact(item, [
        "certificateSha256",
        "workloadIdentityId",
        "siteProjectBindingRef",
        "deploymentRef",
        "siteRef",
        "siteReleaseRef",
        "webArtifactDigest",
        "sessionContractRevision",
        "environment",
        "region",
        "audience",
        "allowedOperations",
        "bindingEpoch",
        "siteSecurityEpoch",
        "policyEpoch",
        "csrfSha256",
      ]);
      const certificateSha256 = digest(item.certificateSha256);
      const workloadIdentityId = reference(item.workloadIdentityId, 256);
      if (byFingerprint.has(certificateSha256) || workloadIds.has(workloadIdentityId)) {
        throw new Error("PRODUCT_WORKLOAD_REGISTRATION_DUPLICATE");
      }
      workloadIds.add(workloadIdentityId);
      const environment = reference(item.environment, 32);
      if (!["development", "preview", "production"].includes(environment)) {
        throw new Error("PRODUCT_WORKLOAD_ENVIRONMENT_INVALID");
      }
      if (!Array.isArray(item.allowedOperations) || item.allowedOperations.length < 1) {
        throw new Error("PRODUCT_WORKLOAD_OPERATIONS_INVALID");
      }
      const allowedOperations = item.allowedOperations.map((operation) => reference(operation, 128));
      if (
        new Set(allowedOperations).size !== allowedOperations.length ||
        allowedOperations.some((operation) => !ALLOWED_OPERATIONS.has(operation))
      ) throw new Error("PRODUCT_WORKLOAD_OPERATIONS_INVALID");
      const bindingEpoch = positiveEpoch(item.bindingEpoch);
      const siteSecurityEpoch = positiveEpoch(item.siteSecurityEpoch);
      const policyEpoch = positiveEpoch(item.policyEpoch);
      const registration: ProductWorkloadIdentity = Object.freeze({
        certificateSha256,
        workloadIdentityId,
        siteProjectBindingRef: reference(item.siteProjectBindingRef, 256),
        deploymentRef: reference(item.deploymentRef, 256),
        siteRef: reference(item.siteRef, 128),
        siteReleaseRef: reference(item.siteReleaseRef, 128),
        webArtifactDigest: digest(item.webArtifactDigest),
        sessionContractRevision: reference(item.sessionContractRevision, 128),
        environment: environment as RuntimeEnvironment,
        region: reference(item.region, 128),
        audience: reference(item.audience, 256),
        allowedOperations: Object.freeze(allowedOperations),
        bindingEpoch,
        siteSecurityEpoch,
        policyEpoch,
        csrfSha256: digest(item.csrfSha256),
      });
      byFingerprint.set(certificateSha256, registration);
    }
    return new ProductWorkloadRegistry(byFingerprint, registryRevision);
  }

  authenticate(request: IncomingMessage, operation: string): ProductWorkloadIdentity {
    if (!ALLOWED_OPERATIONS.has(operation)) {
      throw new SessionAuthorizationError("WORKLOAD_NOT_AUTHORIZED");
    }
    const socket = request.socket;
    if (!(socket instanceof TLSSocket) || !socket.encrypted || !socket.authorized) {
      throw new SessionAuthorizationError("WORKLOAD_NOT_AUTHORIZED");
    }
    const certificate = socket.getPeerCertificate(false);
    if (!certificate || certificate.raw === undefined) {
      throw new SessionAuthorizationError("WORKLOAD_NOT_AUTHORIZED");
    }
    const fingerprint = createHash("sha256").update(certificate.raw).digest("hex");
    const registration = this.#byFingerprint.get(fingerprint);
    if (registration === undefined || !registration.allowedOperations.includes(operation)) {
      throw new SessionAuthorizationError("WORKLOAD_NOT_AUTHORIZED");
    }
    return registration;
  }

  verifyCsrf(workload: ProductWorkloadIdentity, token: string | undefined): boolean {
    return this.verifyCsrfEvidence(workload, token) !== null;
  }

  verifyCsrfEvidence(workload: ProductWorkloadIdentity, token: string | undefined): VerifiedCsrfEvidence | null {
    if (token === undefined || token.length < 32 || token.length > 512) return null;
    const digest = createHash("sha256").update(token, "utf8").digest("hex");
    const actual = Buffer.from(digest, "ascii");
    const expected = Buffer.from(workload.csrfSha256, "ascii");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const evidence = Object.freeze({ workloadIdentityId: workload.workloadIdentityId, digest }) as VerifiedCsrfEvidence;
    issuedCsrfEvidence.add(evidence);
    return evidence;
  }

  verifiedCsrfDigest(workload: ProductWorkloadIdentity, evidence: VerifiedCsrfEvidence): string {
    if (
      !issuedCsrfEvidence.has(evidence) || evidence.workloadIdentityId !== workload.workloadIdentityId ||
      evidence.digest !== workload.csrfSha256
    ) throw new SessionAuthorizationError("WORKLOAD_NOT_AUTHORIZED");
    return evidence.digest;
  }

  async verify(
    context: RequestSecurityContext,
    operation: string,
  ): Promise<VerifiedTrustedCallerClaims> {
    const evidence = context.evidence.find((item) => item.kind === "mtls-certificate-sha256");
    const registration = evidence === undefined ? undefined : this.#byFingerprint.get(evidence.evidenceId);
    if (
      registration === undefined ||
      registration.workloadIdentityId !== context.trustedCaller.workloadIdentityId ||
      registration.siteRef !== context.trustedCaller.siteId ||
      registration.siteReleaseRef !== context.trustedCaller.siteReleaseRef ||
      registration.environment !== context.environment ||
      registration.region !== context.region ||
      registration.audience !== context.audience ||
      registration.bindingEpoch !== context.trustedCaller.bindingEpoch ||
      registration.siteSecurityEpoch !== context.trustedCaller.siteSecurityEpoch ||
      registration.policyEpoch !== context.policyEpoch ||
      !registration.allowedOperations.includes(operation)
    ) throw new SessionAuthorizationError("WORKLOAD_NOT_AUTHORIZED");
    return Object.freeze({
      workloadIdentityId: registration.workloadIdentityId,
      kind: "site_product",
      audience: registration.audience,
      environment: registration.environment,
      region: registration.region,
      allowedOperations: registration.allowedOperations,
      siteId: registration.siteRef,
      siteReleaseRef: registration.siteReleaseRef,
      bindingEpoch: registration.bindingEpoch,
      siteSecurityEpoch: registration.siteSecurityEpoch,
      issuedAt: context.trustedCaller.issuedAt,
      expiresAt: context.trustedCaller.expiresAt,
      issuer: "kokoro-platform-product-workload-registry",
      keyVersion: this.#registryRevision,
    });
  }
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    throw new Error("PRODUCT_WORKLOAD_REGISTRY_UNKNOWN_FIELD");
  }
}

function reference(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    [...value].some((character) => (character.codePointAt(0) ?? 0) < 32)
  ) throw new Error("PRODUCT_WORKLOAD_REGISTRY_VALUE_INVALID");
  return value;
}

function digest(value: unknown): string {
  const parsed = reference(value, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) throw new Error("PRODUCT_WORKLOAD_REGISTRY_DIGEST_INVALID");
  return parsed;
}

function positiveEpoch(value: unknown): string {
  const parsed = reference(value, 20);
  if (!/^[1-9][0-9]{0,19}$/u.test(parsed) || (parsed.length === 20 && parsed > "18446744073709551615")) {
    throw new Error("PRODUCT_WORKLOAD_REGISTRY_EPOCH_INVALID");
  }
  return parsed;
}
