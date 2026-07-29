import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type {
  AuthenticatedUserSession,
  IssuedSessionAccessGrant,
  PersonalContextSnapshot,
  ProductContextSnapshot,
  ProductWorkloadIdentity,
  SessionAccessGrantClaims,
  SessionAccessPurpose,
  SessionGrantResource,
  SurfaceModelOptionCatalog,
} from "../../domain/session-access-grant.js";

export interface SessionAuthenticationPort {
  authenticateUserSession(input: Readonly<{
    credentialDigest: string;
    siteRef: string;
    now: string;
  }>): Promise<AuthenticatedUserSession | null>;
}

/**
 * Local Platform application boundary owned by ModelOption/SiteRelease. Authorization never reads
 * model-control tables or invents a browser default. A production composition without this port is
 * unavailable by design.
 */
export interface ModelOptionCatalogReadPort {
  readForProductContext(
    input: Readonly<{
      siteId: string;
      siteReleaseRef: string;
    }>,
    context: VerifiedRequestSecurityContext,
    transaction: PlatformTransaction,
  ): Promise<Readonly<{
    modelOptionCatalogRef: string;
    modelOptionCatalogs: readonly SurfaceModelOptionCatalog[];
  }>>;
}

export interface SessionAuthorizationRepository {
  resolveProductContext(
    transaction: PlatformTransaction,
    input: Readonly<{
      workload: ProductWorkloadIdentity;
      now: string;
      expiresAt: string;
      cacheMaxAgeSeconds: number;
      modelOptionCatalogRef: string;
      modelOptionCatalogs: readonly SurfaceModelOptionCatalog[];
    }>,
  ): Promise<ProductContextSnapshot>;

  loadPersonalContext(
    transaction: PlatformTransaction,
    input: Readonly<{
      workload: ProductWorkloadIdentity;
      session: AuthenticatedUserSession;
      now: string;
      expiresAt: string;
    }>,
  ): Promise<PersonalContextSnapshot>;

  prepareSessionAccessGrant(
    transaction: PlatformTransaction,
    input: Readonly<{
      grantRef: string;
      workload: ProductWorkloadIdentity;
      session: AuthenticatedUserSession;
      productContextRef: string;
      projectRef: string;
      purpose: SessionAccessPurpose;
      resource: SessionGrantResource;
      issuer: string;
      keyRevision: string;
      notBefore: string;
      issuedAt: string;
      expiresAt: string;
    }>,
  ): Promise<Readonly<{ claims: SessionAccessGrantClaims; claimsDigest: string }>>;

  markGrantDelivered(
    transaction: PlatformTransaction,
    input: Readonly<{ grantRef: string; claimsDigest: string; credentialDigest: string }>,
  ): Promise<void>;

  markGrantDeliveryFailed(
    transaction: PlatformTransaction,
    input: Readonly<{ grantRef: string; claimsDigest: string; errorCode: string }>,
  ): Promise<void>;

}

export interface SessionAccessGrantSigner {
  readonly issuer: string;
  readonly keyRevision: string;
  readonly maximumTtlSeconds: number;
  sign(claims: SessionAccessGrantClaims): Promise<string>;
  jwks(): Readonly<{ keys: readonly Readonly<Record<string, unknown>>[] }>;
}

export interface SessionAuthorizationPublisher {
  publishGrantDelivered(
    transaction: PlatformTransaction,
    input: Readonly<{
      claims: SessionAccessGrantClaims;
      claimsDigest: string;
      changedAt: string;
      correlationId: string;
    }>,
  ): Promise<void>;
  bumpAndPublishRevocationEpochChanged(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteRef: string;
      expectedRevocationEpoch: string;
      reason: string;
      changedAt: string;
      correlationId: string;
    }>,
  ): Promise<string>;
}

export interface SessionAuthorizationEventSigner {
  readonly keyRevision: string;
  sign(payload: Uint8Array): Promise<Uint8Array>;
}

export interface SessionAuthorizationVerificationKeySet {
  readonly keySetRevision: string;
  verificationKeys(): readonly Readonly<{
    purpose: "event_signing" | "session_access_grant";
    keyRevision: string;
    current: boolean;
    canonicalPublicJwkJson: string;
    notBefore: string;
    notAfter: string;
  }>[];
}

export type SignedSessionAccessGrant = IssuedSessionAccessGrant;
