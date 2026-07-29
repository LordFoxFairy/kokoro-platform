import { randomUUID } from "node:crypto";
import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import { PlatformUnitOfWork } from "../../../../shared/unit-of-work/unit-of-work.js";
import { signedCredentialDigest } from "../contracts/authorization-digest.js";
import type {
  SessionAccessGrantSigner,
  SessionAuthorizationPublisher,
  SessionAuthorizationRepository,
} from "../contracts/session-authorization-ports.js";
import {
  assertSessionGrantResource,
  SessionAuthorizationError,
  type AuthenticatedUserSession,
  type IssuedSessionAccessGrant,
  type ProductWorkloadIdentity,
  type SessionAccessPurpose,
  type SessionGrantResource,
} from "../../domain/session-access-grant.js";

export class IssueSessionAccessGrantService {
  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: SessionAuthorizationRepository,
    private readonly signer: SessionAccessGrantSigner,
    private readonly publisher: SessionAuthorizationPublisher,
    private readonly clock: () => Date = () => new Date(),
    private readonly grantRef: () => string = randomUUID,
  ) {}

  async execute(input: Readonly<{
    workload: ProductWorkloadIdentity;
    session: AuthenticatedUserSession;
    context: VerifiedRequestSecurityContext;
    productContextRef: string;
    projectRef: string;
    purpose: SessionAccessPurpose;
    resource: SessionGrantResource;
  }>): Promise<IssuedSessionAccessGrant> {
    assertSessionGrantResource(input.resource);
    if (
      input.productContextRef.length < 1 || input.productContextRef.length > 256 ||
      input.projectRef.length < 1 || input.projectRef.length > 256
    ) throw new SessionAuthorizationError("AUTHORIZATION_INPUT_INVALID");
    const nowDate = this.clock();
    const issuedAt = instant(nowDate);
    const notBefore = instant(new Date(nowDate.getTime() - 5_000));
    const expiresAt = instant(new Date(nowDate.getTime() + this.signer.maximumTtlSeconds * 1_000));
    const grantRef = this.grantRef();
    const prepared = await this.unitOfWork.execute(
      { context: input.context, operation: "issueSessionAccessGrant" },
      async (transaction) => {
        const result = await this.repository.prepareSessionAccessGrant(transaction, {
          grantRef,
          workload: input.workload,
          session: input.session,
          productContextRef: input.productContextRef,
          projectRef: input.projectRef,
          purpose: input.purpose,
          resource: input.resource,
          issuer: this.signer.issuer,
          keyRevision: this.signer.keyRevision,
          notBefore,
          issuedAt,
          expiresAt,
        });
        return result;
      },
    );

    let credential: string;
    try {
      credential = await this.signer.sign(prepared.claims);
    } catch {
      await this.recordFailure(input.context, grantRef, prepared.claimsDigest, "SIGNING_FAILED");
      throw new SessionAuthorizationError("AUTHORIZATION_DELIVERY_FAILED");
    }
    try {
      await this.unitOfWork.execute(
        { context: input.context, operation: "issueSessionAccessGrant" },
        async (transaction) => {
          await this.repository.markGrantDelivered(transaction, {
            grantRef,
            claimsDigest: prepared.claimsDigest,
            credentialDigest: signedCredentialDigest(credential),
          });
          await this.publisher.publishGrantDelivered(transaction, {
            claims: prepared.claims,
            claimsDigest: prepared.claimsDigest,
            changedAt: instant(this.clock()),
            correlationId: input.context.correlationId,
          });
        },
      );
    } catch {
      await this.recordFailure(input.context, grantRef, prepared.claimsDigest, "DELIVERY_COMMIT_FAILED");
      throw new SessionAuthorizationError("AUTHORIZATION_DELIVERY_FAILED");
    }
    return Object.freeze({ ...prepared.claims, credential });
  }

  private async recordFailure(
    context: VerifiedRequestSecurityContext,
    grantRef: string,
    claimsDigest: string,
    errorCode: string,
  ): Promise<void> {
    await this.unitOfWork.execute(
      { context, operation: "issueSessionAccessGrant" },
      (transaction) => this.repository.markGrantDeliveryFailed(transaction, {
        grantRef,
        claimsDigest,
        errorCode,
      }),
    ).catch(() => undefined);
  }
}

function instant(value: Date): string {
  return new Date(Math.floor(value.getTime() / 1_000) * 1_000).toISOString();
}
