import type { SiteAggregate, SiteRelease } from "./site-lifecycle.js";

export interface SiteAuthorityDefinition extends SiteAggregate {
  readonly siteKey: string;
}

export interface SiteProjectBinding {
  readonly bindingRef: string;
  readonly siteRef: string;
  readonly repositoryRef: string;
  readonly providerProjectRef: string;
  readonly environment: "development" | "preview" | "production";
  readonly workloadIdentityId: string;
  readonly bindingEpoch: bigint;
  readonly state: "active" | "revoked";
}

export interface PublishedSiteRelease extends SiteRelease {
  readonly launchProfileRef: string;
  readonly siteConfigRevisionRef: string;
  readonly legalRevisionRef: string;
  readonly featurePolicyRevision: string;
  readonly modelOptionCatalogRef: string;
  readonly agentCatalogRef: string;
  readonly identityIssuerLabel: string;
  readonly identityAuthStrengthPolicyRevision: string;
  readonly enabledSurfaceIds: readonly string[];
  readonly localePolicy: Readonly<{
    defaultLocale: string;
    allowedLocales: readonly string[];
  }>;
}

export function createPreviewReadySite(input: Readonly<{
  siteRef: string;
  siteKey: string;
}>): SiteAuthorityDefinition {
  identifier(input.siteRef, "SITE_REF_INVALID");
  if (!/^[a-z][a-z0-9-]{2,62}$/u.test(input.siteKey)) throw new Error("SITE_KEY_INVALID");
  return Object.freeze({
    siteRef: input.siteRef,
    siteKey: input.siteKey,
    state: "preview_ready",
    activeReleaseRef: null,
    securityEpoch: 1n,
    policyEpoch: 1n,
    revocationEpoch: 1n,
  });
}

export function createSiteProjectBinding(input: Readonly<{
  bindingRef: string;
  siteRef: string;
  repositoryRef: string;
  providerProjectRef: string;
  environment: "development" | "preview" | "production";
  workloadIdentityId: string;
}>): SiteProjectBinding {
  identifier(input.bindingRef, "SITE_PROJECT_BINDING_REF_INVALID");
  identifier(input.siteRef, "SITE_REF_INVALID");
  bounded(input.repositoryRef, "SITE_REPOSITORY_REF_INVALID");
  bounded(input.providerProjectRef, "SITE_PROVIDER_PROJECT_REF_INVALID");
  bounded(input.workloadIdentityId, "SITE_WORKLOAD_IDENTITY_INVALID");
  return Object.freeze({ ...input, bindingEpoch: 1n, state: "active" });
}

export function publishCertifiedSiteRelease(
  input: Omit<PublishedSiteRelease, "state">,
): PublishedSiteRelease {
  for (const [value, code] of [
    [input.releaseRef, "SITE_RELEASE_REF_INVALID"],
    [input.siteRef, "SITE_REF_INVALID"],
    [input.launchProfileRef, "SITE_LAUNCH_PROFILE_REF_INVALID"],
    [input.siteConfigRevisionRef, "SITE_CONFIG_REVISION_REF_INVALID"],
    [input.legalRevisionRef, "SITE_LEGAL_REVISION_REF_INVALID"],
    [input.featurePolicyRevision, "SITE_FEATURE_POLICY_REVISION_INVALID"],
    [input.modelOptionCatalogRef, "SITE_MODEL_CATALOG_REF_INVALID"],
    [input.agentCatalogRef, "SITE_AGENT_CATALOG_REF_INVALID"],
    [input.identityAuthStrengthPolicyRevision, "SITE_AUTH_POLICY_REVISION_INVALID"],
  ] as const) identifier(value, code);
  digest(input.webArtifactDigest);
  digest(input.releaseManifestDigest);
  digest(input.certificationDigest);
  if (input.identityIssuerLabel.length < 1 || input.identityIssuerLabel.length > 64 ||
      input.identityIssuerLabel.includes(":") || control(input.identityIssuerLabel)) {
    throw new Error("SITE_IDENTITY_ISSUER_LABEL_INVALID");
  }
  const surfaces = canonicalStrings(input.enabledSurfaceIds, "SITE_RELEASE_SURFACES_INVALID", 1, 64);
  const locales = canonicalStrings(input.localePolicy.allowedLocales, "SITE_RELEASE_LOCALES_INVALID", 1, 32);
  if (!locales.includes(input.localePolicy.defaultLocale)) throw new Error("SITE_DEFAULT_LOCALE_INVALID");
  return Object.freeze({
    ...input,
    state: "ready",
    enabledSurfaceIds: surfaces,
    localePolicy: Object.freeze({
      defaultLocale: input.localePolicy.defaultLocale,
      allowedLocales: locales,
    }),
  });
}

function identifier(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,255}$/u.test(value) || control(value)) throw new Error(code);
}
function bounded(value: string, code: string): void {
  if (value.length < 3 || value.length > 512 || control(value)) throw new Error(code);
}
function digest(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("SITE_RELEASE_DIGEST_INVALID");
}
function canonicalStrings(values: readonly string[], code: string, minimum: number, maximum: number): readonly string[] {
  if (values.length < minimum || values.length > maximum || values.some((value) =>
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) || new Set(values).size !== values.length) {
    throw new Error(code);
  }
  return Object.freeze([...values].sort());
}
function control(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  });
}
