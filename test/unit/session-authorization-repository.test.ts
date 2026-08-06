import { describe, expect, it } from "vitest";
import { PostgresSessionAuthorizationRepository } from
  "../../src/modules/authorization/infrastructure/postgres/session-authorization-repository.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

const workload = Object.freeze({
  certificateSha256: "a".repeat(64),
  workloadIdentityId: "spiffe://kokoro/site/site-a",
  siteProjectBindingRef: "binding-a",
  deploymentRef: "deployment-a",
  siteRef: "site-a",
  siteReleaseRef: "release-a",
  webArtifactDigest: "b".repeat(64),
  sessionContractRevision: "session-v1",
  environment: "development" as const,
  region: "local",
  audience: "kokoro-session",
  allowedOperations: Object.freeze([]),
  bindingEpoch: "1",
  siteSecurityEpoch: "1",
  policyEpoch: "1",
  csrfSha256: "c".repeat(64),
});

const session = Object.freeze({
  identitySessionRef: "identity-session-a",
  subjectRef: "subject-a",
  siteRef: "site-a",
  subjectGeneration: "1",
  identitySessionEpoch: "1",
  restrictionEpoch: "1",
  credentialEpoch: "1",
  authenticationMethods: Object.freeze(["password"] as const),
  authenticatedAt: "2026-08-05T12:00:00.000Z",
  expiresAt: "2026-08-05T13:00:00.000Z",
});

describe("PostgresSessionAuthorizationRepository", () => {
  it("resolves ProductContext using only SELECT authority", async () => {
    const statement = await captureRejectedQuery((repository, transaction) =>
      repository.resolveProductContext(transaction, {
        workload,
        now: "2026-08-05T12:00:00.000Z",
        expiresAt: "2026-08-05T12:05:00.000Z",
        cacheMaxAgeSeconds: 60,
        modelOptionCatalogRef: "model-catalog-a",
        modelOptionCatalogs: Object.freeze([{
          surfaceId: "chat",
          catalogRevisionRef: "chat-catalog-a",
          defaultModelOptionRevisionRef: "model-option-a",
          options: Object.freeze([{
            modelOptionRevisionRef: "model-option-a",
            optionKey: "chat.default",
            label: "Default",
            inputModalities: Object.freeze(["text"]),
            outputModalities: Object.freeze(["text"]),
            supportedEfforts: Object.freeze([]),
            badges: Object.freeze([]),
            availability: "available" as const,
          }]),
          publishedAt: "2026-08-05T12:00:00.000Z",
        }]),
      }), "WORKLOAD_NOT_AUTHORIZED");

    expect(statement).toContain("platform.authorization_product_binding");
    expect(statement).not.toMatch(/FOR\s+(?:NO\s+KEY\s+)?UPDATE|FOR\s+(?:KEY\s+)?SHARE/iu);
  });

  it("loads PersonalContext using only SELECT authority", async () => {
    const statement = await captureRejectedQuery((repository, transaction) =>
      repository.loadPersonalContext(transaction, {
        workload,
        session,
        now: "2026-08-05T12:00:00.000Z",
        expiresAt: "2026-08-05T12:05:00.000Z",
      }), "PROJECT_NOT_AUTHORIZED");

    expect(statement).toContain("platform.authorization_identity_session");
    expect(statement).not.toMatch(/FOR\s+(?:NO\s+KEY\s+)?UPDATE|FOR\s+(?:KEY\s+)?SHARE/iu);
  });

  it("never lets PersonalContext outlive the exact selected ProductContext", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({
      query: async <Row extends Record<string, unknown>>(statement: string) => {
        statements.push(statement);
        return [{
          subjectRef: "subject-a",
          subjectGeneration: 1n,
          displayName: "Subject A",
          avatarUrl: null,
          projectRef: "project-a",
          workspaceRef: "workspace-a",
          executionSpaceRef: "execution-space-a",
          projectDisplayName: "Project A",
          membershipEpoch: 1n,
          authorizationEpoch: 1n,
          isDefault: true,
          productContextRef: "product-context-a",
          contextExpiresAt: new Date("2026-08-05T12:00:45.000Z"),
        } as unknown as Row];
      },
      execute: async () => 0,
    });
    try {
      const context = await new PostgresSessionAuthorizationRepository().loadPersonalContext(
        lease.transaction,
        {
          workload,
          session,
          now: "2026-08-05T12:00:00.000Z",
          expiresAt: "2026-08-05T12:05:00.000Z",
        },
      );

      expect(context.productContextRef).toBe("product-context-a");
      expect(context.expiresAt).toBe("2026-08-05T12:00:45.000Z");
      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain('context.expires_at AS "contextExpiresAt"');
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("prepares a SessionAccessGrant using only SELECT authority", async () => {
    const statement = await captureRejectedQuery((repository, transaction) =>
      repository.prepareSessionAccessGrant(transaction, {
        grantRef: "00000000-0000-4000-8000-000000000001",
        workload,
        session,
        productContextRef: "product-context-a",
        projectRef: "project-a",
        purpose: "write",
        resource: Object.freeze({ kind: "session", sessionRef: "session-a" }),
        issuer: "kokoro-platform",
        keyRevision: "key-a",
        authorizationStreamSequence: "1",
        notBefore: "2026-08-05T11:59:55.000Z",
        issuedAt: "2026-08-05T12:00:00.000Z",
        expiresAt: "2026-08-05T12:05:00.000Z",
      }), "PROJECT_NOT_AUTHORIZED");

    expect(statement).toContain("platform.authorization_product_context");
    expect(statement).not.toMatch(/FOR\s+(?:NO\s+KEY\s+)?UPDATE|FOR\s+(?:KEY\s+)?SHARE/iu);
  });
});

async function captureRejectedQuery(
  invoke: (
    repository: PostgresSessionAuthorizationRepository,
    transaction: ReturnType<typeof issuePlatformTransaction>["transaction"],
  ) => Promise<unknown>,
  errorCode: string,
): Promise<string> {
  const statements: string[] = [];
  const lease = issuePlatformTransaction({
    query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> => {
      statements.push(statement);
      return [];
    },
    execute: async () => 0,
  });
  try {
    await expect(invoke(new PostgresSessionAuthorizationRepository(), lease.transaction))
      .rejects.toThrow(errorCode);
    expect(statements).toHaveLength(1);
    return statements[0]!;
  } finally {
    revokePlatformTransaction(lease);
  }
}
