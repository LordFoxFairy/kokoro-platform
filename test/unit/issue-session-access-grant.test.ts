import { describe, expect, it, vi } from "vitest";

import { IssueSessionAccessGrantService } from
  "../../src/modules/authorization/application/services/issue-session-access-grant.js";
import type {
  SessionAccessGrantSigner,
  SessionAuthorizationRepository,
  SessionGrantDeliveryPublisher,
} from "../../src/modules/authorization/application/contracts/session-authorization-ports.js";
import type { SessionAccessGrantClaims } from
  "../../src/modules/authorization/domain/session-access-grant.js";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import type { PlatformUnitOfWork } from "../../src/shared/unit-of-work/unit-of-work.js";

describe("IssueSessionAccessGrantService projection watermark", () => {
  it("signs and returns the committed GrantDelivered stream sequence in one transaction", async () => {
    const transaction = Object.freeze({}) as PlatformTransaction;
    const execute = vi.fn(async (_fence: unknown, work: (value: PlatformTransaction) => Promise<unknown>) =>
      work(transaction));
    const unitOfWork = { execute } as unknown as PlatformUnitOfWork;
    const reserveGrantDelivery = vi.fn(async () => ({
      siteRef: "site-1",
      streamSequence: 37n,
      aggregateSequence: 11n,
    }));
    let preparedClaims: SessionAccessGrantClaims | undefined;
    const repository = {
      async prepareSessionAccessGrant(_transaction: PlatformTransaction, input: {
        authorizationStreamSequence: string;
      }) {
        preparedClaims = {
          grantRef: "grant-1",
          binding: {
            productContextRef: "context-1",
            siteProjectBindingRef: "binding-1",
            deploymentRef: "deployment-1",
            siteRef: "site-1",
            siteReleaseRef: "release-1",
            webArtifactDigest: "a".repeat(64),
            runtimeEnvironment: "production",
            region: "us-east-1",
            sessionContractRevision: "session-browser-v3",
            projectRef: "project-1",
            subjectRef: "subject-1",
            subjectGeneration: "1",
            identitySessionRef: "identity-session-1",
            issuer: "https://platform.example.test/authorization",
            keyRevision: "grant-key-1",
            notBefore: "2026-08-06T12:00:00.000Z",
            siteSecurityEpoch: "1",
            identitySessionEpoch: "1",
            membershipEpoch: "1",
            authorizationEpoch: "1",
            restrictionEpoch: "1",
            credentialEpoch: "1",
            policyEpoch: "1",
            revocationEpoch: "1",
            authorizationStreamSequence: input.authorizationStreamSequence,
            resource: { kind: "project" },
            issuedAt: "2026-08-06T12:00:05.000Z",
            expiresAt: "2026-08-06T12:05:05.000Z",
          },
          authorization: { purpose: "write", audience: "session.write" },
        };
        return { claims: preparedClaims, claimsDigest: "b".repeat(64) };
      },
      markGrantDelivered: vi.fn(async () => undefined),
      markGrantDeliveryFailed: vi.fn(async () => undefined),
    } as unknown as SessionAuthorizationRepository;
    const sign = vi.fn(async (claims: SessionAccessGrantClaims) => {
      expect(claims.binding.authorizationStreamSequence).toBe("37");
      return "signed-session-access-grant";
    });
    const signer = {
      issuer: "https://platform.example.test/authorization",
      keyRevision: "grant-key-1",
      maximumTtlSeconds: 300,
      sign,
      jwks: () => ({ keys: [] }),
    } satisfies SessionAccessGrantSigner;
    const publishGrantDelivered = vi.fn(async (_transaction, input) => {
      expect(input.reservation.streamSequence).toBe(37n);
      expect(input.claims.binding.authorizationStreamSequence).toBe("37");
    });
    const publisher = {
      reserveGrantDelivery,
      publishGrantDelivered,
    } satisfies SessionGrantDeliveryPublisher;
    const service = new IssueSessionAccessGrantService(
      unitOfWork,
      repository,
      signer,
      publisher,
      () => new Date("2026-08-06T12:00:05.000Z"),
      () => "grant-1",
    );

    const result = await service.execute({
      workload: {
        certificateSha256: "c".repeat(64), workloadIdentityId: "workload-1",
        siteProjectBindingRef: "binding-1", deploymentRef: "deployment-1",
        siteRef: "site-1", siteReleaseRef: "release-1", webArtifactDigest: "a".repeat(64),
        sessionContractRevision: "session-browser-v3", environment: "production",
        region: "us-east-1", audience: "site-product",
        allowedOperations: ["issueSessionAccessGrant"], bindingEpoch: "1",
        siteSecurityEpoch: "1", policyEpoch: "1", csrfSha256: "d".repeat(64),
      },
      session: {
        identitySessionRef: "identity-session-1", subjectRef: "subject-1", siteRef: "site-1",
        subjectGeneration: "1", identitySessionEpoch: "1", restrictionEpoch: "1",
        credentialEpoch: "1", authenticationMethods: ["password"],
        authenticatedAt: "2026-08-06T11:59:00.000Z", expiresAt: "2026-08-06T13:00:00.000Z",
      },
      context: Object.freeze({}) as never,
      productContextRef: "context-1",
      projectRef: "project-1",
      purpose: "write",
      resource: { kind: "project" },
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(reserveGrantDelivery).toHaveBeenCalledWith(transaction, { siteRef: "site-1" });
    expect(sign).toHaveBeenCalledWith(preparedClaims);
    expect(publishGrantDelivered).toHaveBeenCalledOnce();
    expect(result.binding.authorizationStreamSequence).toBe("37");
    expect(result.credential).toBe("signed-session-access-grant");
  });
});
