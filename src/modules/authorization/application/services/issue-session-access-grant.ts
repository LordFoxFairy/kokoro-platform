import { randomUUID } from "node:crypto";
import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import { PlatformUnitOfWork } from "../../../../shared/unit-of-work/unit-of-work.js";
import { signedCredentialDigest } from "../contracts/authorization-digest.js";
import type {
  SessionAccessGrantSigner,
  SessionGrantDeliveryPublisher,
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
    private readonly publisher: SessionGrantDeliveryPublisher,
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
    try {
      return await this.unitOfWork.execute(
        { context: input.context, operation: "issueSessionAccessGrant" },
        async (transaction) => {
          let reservation: Awaited<ReturnType<SessionGrantDeliveryPublisher["reserveGrantDelivery"]>>;
          try {
            reservation = await this.publisher.reserveGrantDelivery(transaction, {
              siteRef: input.workload.siteRef,
            });
            if (reservation.siteRef !== input.workload.siteRef || reservation.streamSequence < 1n) {
              throw new GrantDeliveryFailure();
            }
          } catch {
            throw new GrantDeliveryFailure();
          }
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
            authorizationStreamSequence: reservation.streamSequence.toString(),
            notBefore,
            issuedAt,
            expiresAt,
          });
          let credential: string;
          try {
            credential = await this.signer.sign(result.claims);
          } catch {
            throw new GrantDeliveryFailure();
          }
          try {
            await this.repository.markGrantDelivered(transaction, {
              grantRef,
              claimsDigest: result.claimsDigest,
              credentialDigest: signedCredentialDigest(credential),
            });
            await this.publisher.publishGrantDelivered(transaction, {
              claims: result.claims,
              claimsDigest: result.claimsDigest,
              reservation,
              changedAt: instant(this.clock()),
              correlationId: input.context.correlationId,
            });
          } catch {
            throw new GrantDeliveryFailure();
          }
          return Object.freeze({ ...result.claims, credential });
        },
      );
    } catch (error) {
      if (!(error instanceof GrantDeliveryFailure)) throw error;
      throw new SessionAuthorizationError("AUTHORIZATION_DELIVERY_FAILED");
    }
  }
}

class GrantDeliveryFailure extends Error {}

function instant(value: Date): string {
  return new Date(Math.floor(value.getTime() / 1_000) * 1_000).toISOString();
}
