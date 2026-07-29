export const SESSION_ACCESS_AUDIENCES = Object.freeze({
  read: "session.read",
  write: "session.write",
  control: "session.control",
  stream: "session.stream",
} as const);

export type SessionAccessPurpose = keyof typeof SESSION_ACCESS_AUDIENCES;
export type SessionAccessAudience = (typeof SESSION_ACCESS_AUDIENCES)[SessionAccessPurpose];
export type RuntimeEnvironment = "development" | "preview" | "production";

export type SessionGrantResource =
  | Readonly<{ kind: "project" }>
  | Readonly<{ kind: "session"; sessionRef: string }>
  | Readonly<{ kind: "run"; sessionRef: string; runRef: string }>;

export interface ProductWorkloadIdentity {
  readonly certificateSha256: string;
  readonly workloadIdentityId: string;
  readonly siteProjectBindingRef: string;
  readonly deploymentRef: string;
  readonly siteRef: string;
  readonly siteReleaseRef: string;
  readonly webArtifactDigest: string;
  readonly sessionContractRevision: string;
  readonly environment: RuntimeEnvironment;
  readonly region: string;
  readonly audience: string;
  readonly allowedOperations: readonly string[];
  readonly bindingEpoch: string;
  readonly policyEpoch: string;
  readonly csrfSha256: string;
}

export interface AuthenticatedUserSession {
  readonly identitySessionRef: string;
  readonly subjectRef: string;
  readonly siteRef: string;
  readonly subjectGeneration: string;
  readonly identitySessionEpoch: string;
  readonly restrictionEpoch: string;
  readonly credentialEpoch: string;
  readonly authenticationMethods: readonly ("password" | "totp" | "recovery_code")[];
  readonly authenticatedAt: string;
  readonly expiresAt: string;
}

export interface LocalePolicy {
  readonly defaultLocale: string;
  readonly allowedLocales: readonly string[];
}

export interface PublishedModelOption {
  readonly modelOptionRevisionRef: string;
  readonly optionKey: string;
  readonly label: string;
  readonly description?: string;
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly supportedEfforts: readonly string[];
  readonly badges: readonly string[];
  readonly availability: "available" | "temporarily_unavailable";
}

export interface SurfaceModelOptionCatalog {
  readonly surfaceId: string;
  readonly catalogRevisionRef: string;
  readonly defaultModelOptionRevisionRef: string;
  readonly options: readonly PublishedModelOption[];
  readonly publishedAt: string;
}

export interface ProductContextSnapshot {
  readonly productContextRef: string;
  readonly siteProjectBindingRef: string;
  readonly deploymentRef: string;
  readonly siteRef: string;
  readonly siteReleaseRef: string;
  readonly webArtifactDigest: string;
  readonly runtimeEnvironment: RuntimeEnvironment;
  readonly region: string;
  readonly audience: string;
  readonly sessionContractRevision: string;
  readonly policyEpoch: string;
  readonly revocationEpoch: string;
  readonly enabledSurfaceIds: readonly string[];
  readonly featurePolicyRevision: string;
  readonly modelOptionCatalogRef: string;
  readonly modelOptionCatalogs: readonly SurfaceModelOptionCatalog[];
  readonly agentCatalogRef: string;
  readonly localePolicy: LocalePolicy;
  readonly cacheMaxAgeSeconds: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly snapshotDigest: string;
}

export type PublicProductContext = Omit<ProductContextSnapshot, "snapshotDigest">;

export function parsePublicProductContext(input: unknown): PublicProductContext {
  const value = strictRecord(input, [
    "productContextRef", "siteProjectBindingRef", "deploymentRef", "siteRef", "siteReleaseRef",
    "webArtifactDigest", "runtimeEnvironment", "region", "audience", "sessionContractRevision",
    "policyEpoch", "revocationEpoch", "enabledSurfaceIds", "featurePolicyRevision",
    "modelOptionCatalogRef", "modelOptionCatalogs", "agentCatalogRef", "localePolicy",
    "cacheMaxAgeSeconds", "issuedAt", "expiresAt",
  ]);
  const environment = bounded(value.runtimeEnvironment, 32);
  if (!["development", "preview", "production"].includes(environment)) throw corruptContext();
  const locale = strictRecord(value.localePolicy, ["defaultLocale", "allowedLocales"]);
  const modelOptionCatalogs = array(value.modelOptionCatalogs).map((raw) => {
    const catalog = strictRecord(raw, [
      "surfaceId", "catalogRevisionRef", "defaultModelOptionRevisionRef", "options", "publishedAt",
    ]);
    const options = array(catalog.options).map((optionRaw) => {
      const option = strictRecord(optionRaw, [
        "modelOptionRevisionRef", "optionKey", "label", "description", "inputModalities",
        "outputModalities", "supportedEfforts", "badges", "availability",
      ]);
      const availability = bounded(option.availability, 32);
      if (!["available", "temporarily_unavailable"].includes(availability)) throw corruptContext();
      return Object.freeze({
        modelOptionRevisionRef: bounded(option.modelOptionRevisionRef, 256),
        optionKey: bounded(option.optionKey, 128),
        label: bounded(option.label, 128),
        ...(option.description === undefined ? {} : { description: bounded(option.description, 512, true) }),
        inputModalities: strings(option.inputModalities, 16, 1),
        outputModalities: strings(option.outputModalities, 16, 1),
        supportedEfforts: strings(option.supportedEfforts, 16),
        badges: strings(option.badges, 16),
        availability: availability as PublishedModelOption["availability"],
      });
    });
    if (options.length < 1 || !options.some((option) => option.modelOptionRevisionRef === catalog.defaultModelOptionRevisionRef)) {
      throw corruptContext();
    }
    return Object.freeze({
      surfaceId: bounded(catalog.surfaceId, 128),
      catalogRevisionRef: bounded(catalog.catalogRevisionRef, 256),
      defaultModelOptionRevisionRef: bounded(catalog.defaultModelOptionRevisionRef, 256),
      options: Object.freeze(options),
      publishedAt: timestamp(catalog.publishedAt),
    });
  });
  if (modelOptionCatalogs.length < 1 || modelOptionCatalogs.length > 64) throw corruptContext();
  const issuedAt = timestamp(value.issuedAt);
  const expiresAt = timestamp(value.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) throw corruptContext();
  const cacheMaxAgeSeconds = value.cacheMaxAgeSeconds;
  if (!Number.isInteger(cacheMaxAgeSeconds) || (cacheMaxAgeSeconds as number) < 0 || (cacheMaxAgeSeconds as number) > 300) {
    throw corruptContext();
  }
  return Object.freeze({
    productContextRef: bounded(value.productContextRef, 256),
    siteProjectBindingRef: bounded(value.siteProjectBindingRef, 256),
    deploymentRef: bounded(value.deploymentRef, 256),
    siteRef: bounded(value.siteRef, 128),
    siteReleaseRef: bounded(value.siteReleaseRef, 128),
    webArtifactDigest: hexDigest(value.webArtifactDigest),
    runtimeEnvironment: environment as RuntimeEnvironment,
    region: bounded(value.region, 128),
    audience: bounded(value.audience, 256),
    sessionContractRevision: bounded(value.sessionContractRevision, 128),
    policyEpoch: parsedEpoch(value.policyEpoch),
    revocationEpoch: parsedEpoch(value.revocationEpoch),
    enabledSurfaceIds: strings(value.enabledSurfaceIds, 256),
    featurePolicyRevision: bounded(value.featurePolicyRevision, 128),
    modelOptionCatalogRef: bounded(value.modelOptionCatalogRef, 256),
    modelOptionCatalogs: Object.freeze(modelOptionCatalogs),
    agentCatalogRef: bounded(value.agentCatalogRef, 256),
    localePolicy: Object.freeze({
      defaultLocale: bounded(locale.defaultLocale, 35),
      allowedLocales: strings(locale.allowedLocales, 64),
    }),
    cacheMaxAgeSeconds: cacheMaxAgeSeconds as number,
    issuedAt,
    expiresAt,
  });
}

export interface PersonalProjectSnapshot {
  readonly projectRef: string;
  readonly workspaceRef: string;
  readonly executionSpaceRef: string;
  readonly displayName: string;
  readonly membershipRevision: string;
}

export interface PersonalContextSnapshot {
  readonly personalContextRef: string;
  readonly productContextRef: string;
  readonly contextRevision: string;
  readonly actor: Readonly<{
    subjectRef: string;
    subjectGeneration: string;
    displayName: string;
    avatarUrl: string | null;
    state: "active";
  }>;
  readonly defaultProjectRef: string;
  readonly projects: readonly PersonalProjectSnapshot[];
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface SessionAccessGrantBinding {
  readonly productContextRef: string;
  readonly siteProjectBindingRef: string;
  readonly deploymentRef: string;
  readonly siteRef: string;
  readonly siteReleaseRef: string;
  readonly webArtifactDigest: string;
  readonly runtimeEnvironment: RuntimeEnvironment;
  readonly region: string;
  readonly sessionContractRevision: string;
  readonly projectRef: string;
  readonly subjectRef: string;
  readonly subjectGeneration: string;
  readonly identitySessionRef: string;
  readonly issuer: string;
  readonly keyRevision: string;
  readonly notBefore: string;
  readonly siteSecurityEpoch: string;
  readonly identitySessionEpoch: string;
  readonly membershipEpoch: string;
  readonly authorizationEpoch: string;
  readonly restrictionEpoch: string;
  readonly credentialEpoch: string;
  readonly policyEpoch: string;
  readonly revocationEpoch: string;
  readonly resource: SessionGrantResource;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface SessionAccessGrantClaims {
  readonly grantRef: string;
  readonly binding: SessionAccessGrantBinding;
  readonly authorization: Readonly<{
    purpose: SessionAccessPurpose;
    audience: SessionAccessAudience;
  }>;
}

export interface IssuedSessionAccessGrant extends SessionAccessGrantClaims {
  readonly credential: string;
}

export class SessionAuthorizationError extends Error {
  constructor(
    readonly code:
      | "WORKLOAD_NOT_AUTHORIZED"
      | "USER_SESSION_REQUIRED"
      | "PRODUCT_CONTEXT_STALE"
      | "PROJECT_NOT_AUTHORIZED"
      | "AUTHORIZATION_STALE"
      | "AUTHORIZATION_DELIVERY_FAILED"
      | "AUTHORIZATION_INPUT_INVALID",
  ) {
    super(`Session authorization rejected: ${code}`);
    this.name = "SessionAuthorizationError";
  }
}

export function assertPositiveUint64(value: string, code = "AUTHORIZATION_INPUT_INVALID"): void {
  if (
    !/^[1-9][0-9]{0,19}$/u.test(value) ||
    (value.length === 20 && value > "18446744073709551615")
  ) {
    throw new SessionAuthorizationError(code as "AUTHORIZATION_INPUT_INVALID");
  }
}

export function assertSessionGrantResource(value: SessionGrantResource): void {
  const reference = (candidate: string): boolean =>
    candidate.length >= 1 && candidate.length <= 256 && candidate.trim() === candidate;
  if (
    value.kind === "project" ||
    (value.kind === "session" && reference(value.sessionRef)) ||
    (value.kind === "run" && reference(value.sessionRef) && reference(value.runRef))
  ) return;
  throw new SessionAuthorizationError("AUTHORIZATION_INPUT_INVALID");
}

function strictRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw corruptContext();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw corruptContext();
  return record;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw corruptContext();
  return value;
}

function bounded(value: unknown, maximum: number, empty = false): string {
  if (
    typeof value !== "string" || value.length > maximum || (!empty && value.length < 1) ||
    value.trim() !== value || [...value].some((character) => (character.codePointAt(0) ?? 0) < 32)
  ) throw corruptContext();
  return value;
}

function strings(value: unknown, maximumItems: number, minimumItems = 0): readonly string[] {
  const values = array(value).map((item) => bounded(item, 128));
  if (
    values.length < minimumItems || values.length > maximumItems ||
    new Set(values).size !== values.length
  ) throw corruptContext();
  return Object.freeze(values);
}

function timestamp(value: unknown): string {
  const parsed = bounded(value, 64);
  if (!Number.isFinite(Date.parse(parsed))) throw corruptContext();
  return parsed;
}

function parsedEpoch(value: unknown): string {
  const parsed = bounded(value, 20);
  if (!/^[1-9][0-9]{0,19}$/u.test(parsed) || (parsed.length === 20 && parsed > "18446744073709551615")) {
    throw corruptContext();
  }
  return parsed;
}

function hexDigest(value: unknown): string {
  const parsed = bounded(value, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) throw corruptContext();
  return parsed;
}

function corruptContext(): Error {
  return new Error("PRODUCT_CONTEXT_RECEIPT_CORRUPT");
}
