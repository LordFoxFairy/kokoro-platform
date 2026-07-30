import { AdmissionRetryClass } from "../../../../interfaces/connect/generated/kokoro/platform/admission/v1/admission_pb.js";
import {
  resourceAuthorizesRun,
  type SessionAccessGrantVerifierPort,
} from "../../../authorization/application/contracts/session-access-grant-verifier.js";
import { PostgresSessionAccessGrantVerifier } from
  "../../../authorization/infrastructure/postgres/session-access-grant-verifier.js";
import type {
  AdmissionOwnerResolution,
  AdmissionSessionGrantOwnerPort,
} from "../../application/platform-admission-owner-authority.js";

/**
 * Verifies possession of the exact delivered SessionAccessGrant against
 * Platform's current authorization owners. No identity or project claim is
 * accepted from Session's RPC response.
 */
export class PostgresAdmissionSessionGrantOwner implements AdmissionSessionGrantOwnerPort {
  constructor(
    private readonly verifier: SessionAccessGrantVerifierPort = new PostgresSessionAccessGrantVerifier(),
  ) {}

  async resolve(
    transaction: Parameters<AdmissionSessionGrantOwnerPort["resolve"]>[0],
    input: Parameters<AdmissionSessionGrantOwnerPort["resolve"]>[1],
  ): ReturnType<AdmissionSessionGrantOwnerPort["resolve"]> {
    const authority = await this.verifier.verify(transaction, {
      siteId: input.siteId,
      credential: input.credential,
      purpose: "write",
      environment: input.environment,
      region: input.region,
    });
    if (
      authority === null || authority.projectRef !== input.projectRef ||
      authority.siteReleaseRef !== input.configurationRevisionId ||
      !resourceAuthorizesRun(authority.resource, input.sessionId, input.runId)
    ) return denied("ADMISSION_SESSION_ACCESS_GRANT_NOT_AUTHORIZED");
    return Object.freeze({
      kind: "resolved",
      value: Object.freeze({
        subjectRef: authority.subjectRef,
        subjectGeneration: authority.subjectGeneration,
      }),
    });
  }
}

function denied(code: string): AdmissionOwnerResolution<never> {
  return Object.freeze({ kind: "denied", denial: Object.freeze({
    code,
    retryClass: AdmissionRetryClass.NEVER,
  }) });
}
