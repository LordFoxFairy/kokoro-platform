import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { SessionAccessPurpose, SessionGrantResource } from "../../domain/session-access-grant.js";

export interface VerifiedSessionAccessGrantAuthority {
  readonly siteId: string;
  readonly siteReleaseRef: string;
  readonly projectRef: string;
  readonly subjectRef: string;
  readonly subjectGeneration: bigint;
  readonly identitySessionRef: string;
  readonly resource: SessionGrantResource;
}

/** Platform-local verifier for a delivered opaque SessionAccessGrant. */
export interface SessionAccessGrantVerifierPort {
  verify(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteId: string;
      credential: string;
      purpose: SessionAccessPurpose;
      environment: string;
      region: string;
    }>,
  ): Promise<VerifiedSessionAccessGrantAuthority | null>;
}

export function resourceAuthorizesSession(
  resource: SessionGrantResource,
  sessionId: string,
): boolean {
  return resource.kind === "session" && resource.sessionRef === sessionId;
}

export function resourceAuthorizesRun(
  resource: SessionGrantResource,
  sessionId: string,
  runId: string,
): boolean {
  return resource.kind === "project" ||
    (resource.kind === "session" && resource.sessionRef === sessionId) ||
    (resource.kind === "run" && resource.sessionRef === sessionId && resource.runRef === runId);
}
