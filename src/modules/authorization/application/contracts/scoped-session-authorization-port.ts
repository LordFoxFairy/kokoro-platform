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

export type SubjectCurrentFact = Readonly<{
  siteRef: string;
  subjectRef: string;
  state: "active" | "disabled" | "removed";
  subjectGeneration: string;
  restrictionEpoch: string;
  updatedAt: string;
  retainUntil: string;
}>;

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
