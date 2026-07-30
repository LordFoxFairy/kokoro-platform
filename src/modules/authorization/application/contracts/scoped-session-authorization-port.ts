import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";

export type IdentitySessionAuthorizationState = "active" | "revoked" | "expired" | "removed";

export type IdentitySessionCurrentFact = Readonly<{
  siteRef: string;
  subjectRef: string;
  identitySessionRef: string;
  state: IdentitySessionAuthorizationState;
  identitySessionEpoch: string;
  credentialEpoch: string;
  expiresAt: string;
  updatedAt: string;
  retainUntil: string;
}>;

export type ScopedAuthorizationReservation = Readonly<{
  siteRef: string;
  streamSequence: bigint;
  aggregateSequence: bigint;
}>;

export type SiteCurrentFact = Readonly<{
  siteRef: string;
  state: "active" | "suspended" | "decommissioning" | "decommissioned";
  siteSecurityEpoch: string;
  policyEpoch: string;
  revocationEpoch: string;
  updatedAt: string;
  retainUntil: string;
}>;

export type SubjectCurrentFact = Readonly<{
  siteRef: string;
  subjectRef: string;
  state: "active" | "disabled" | "removed";
  subjectGeneration: string;
  restrictionEpoch: string;
  updatedAt: string;
  retainUntil: string;
}>;

export type ProjectMembershipCurrentFact = Readonly<{
  siteRef: string;
  subjectRef: string;
  projectRef: string;
  state: "active" | "revoked" | "removed";
  membershipEpoch: string;
  authorizationEpoch: string;
  updatedAt: string;
  retainUntil: string;
}>;

export interface ScopedSiteAuthorizationMutationPort {
  reserveSiteMutation(
    transaction: PlatformTransaction,
    input: Readonly<{ siteRef: string }>,
  ): Promise<ScopedAuthorizationReservation>;
  publishSiteCurrent(
    transaction: PlatformTransaction,
    input: Readonly<{
      reservation: ScopedAuthorizationReservation;
      current: SiteCurrentFact;
      correlationId: string;
    }>,
  ): Promise<void>;
}

export interface ScopedSubjectAuthorizationMutationPort {
  reserveSubjectMutation(
    transaction: PlatformTransaction,
    input: Readonly<{ siteRef: string }>,
  ): Promise<ScopedAuthorizationReservation>;
  publishSubjectCurrent(
    transaction: PlatformTransaction,
    input: Readonly<{
      reservation: ScopedAuthorizationReservation;
      current: SubjectCurrentFact;
      correlationId: string;
    }>,
  ): Promise<void>;
}

/**
 * Required owner-mutation boundary for the v2 authorization feed.
 *
 * The two-step shape is intentional: reserve acquires global-stream then Site
 * locks, the owner repository mutates next, and publish appends the complete
 * replacement fact before the caller's Unit of Work commits.
 */
export interface ScopedSessionAuthorizationMutationPort {
  reserveIdentitySessionMutation(
    transaction: PlatformTransaction,
    input: Readonly<{ siteRef: string }>,
  ): Promise<ScopedAuthorizationReservation>;

  publishIdentitySessionCurrent(
    transaction: PlatformTransaction,
    input: Readonly<{
      reservation: ScopedAuthorizationReservation;
      current: IdentitySessionCurrentFact;
      correlationId: string;
    }>,
  ): Promise<void>;
}

export interface ScopedProjectMembershipAuthorizationMutationPort {
  reserveProjectMembershipMutation(
    transaction: PlatformTransaction,
    input: Readonly<{ siteRef: string }>,
  ): Promise<ScopedAuthorizationReservation>;
  publishProjectMembershipCurrent(
    transaction: PlatformTransaction,
    input: Readonly<{
      reservation: ScopedAuthorizationReservation;
      current: ProjectMembershipCurrentFact;
      correlationId: string;
    }>,
  ): Promise<void>;
}

export interface ScopedAuthorizationBatchReservationPort {
  reserveOwnerMutations(
    transaction: PlatformTransaction,
    input: Readonly<{ siteRef: string; count: number }>,
  ): Promise<readonly ScopedAuthorizationReservation[]>;
}
