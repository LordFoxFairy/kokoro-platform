import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createPlatformPublicHttpHandler } from "../../src/interfaces/http/platform-public.js";
import { definePlatformPublicOperation } from
  "../../src/interfaces/http/platform-public-operation-registry.js";
import type {
  AuthenticatedUserSession,
  ProductWorkloadIdentity,
} from "../../src/modules/authorization/domain/session-access-grant.js";
import type { ProductWorkloadRegistry } from
  "../../src/modules/authorization/infrastructure/transport/product-workload-registry.js";
import type { GetPublicCommandReceiptResponse } from
  "../../src/generated/contracts/openapi/platform-public/types.gen.js";

describe("Platform Public receipt authentication alternatives", () => {
  it.each([
    ["authenticated session", { authorization: `Bearer ${"s".repeat(43)}` }, true, null],
    ["receipt recovery capability", {
      "x-kokoro-receipt-recovery-capability": "r".repeat(43),
    }, false, "r".repeat(43)],
    ["convergent session and receipt recovery capability", {
      authorization: `Bearer ${"s".repeat(43)}`,
      "x-kokoro-receipt-recovery-capability": "r".repeat(43),
    }, true, "r".repeat(43)],
  ] as const)("passes exactly one %s credential to the receipt owner",
    async (_name, authenticationHeaders, expectsSession, expectedCapability) => {
      const fixture = receiptHandler();
      const response = await invoke(fixture.handler, authenticationHeaders);

      expect(response).toMatchObject({ statusCode: 200 });
      expect(fixture.executions).toHaveLength(1);
      expect(fixture.executions[0]).toMatchObject({
        session: expectsSession ? { identitySessionRef: "session-1" } : null,
        receiptRecoveryCapability: expectedCapability,
      });
    });

  it.each([
    ["malformed recovery capability", {
      "x-kokoro-receipt-recovery-capability": "short",
    }],
    ["invalid session", { authorization: `Bearer ${"x".repeat(43)}` }],
    ["a valid session plus malformed recovery capability", {
      authorization: `Bearer ${"s".repeat(43)}`,
      "x-kokoro-receipt-recovery-capability": "short",
    }],
    ["an invalid session plus well-formed recovery capability", {
      authorization: `Bearer ${"x".repeat(43)}`,
      "x-kokoro-receipt-recovery-capability": "r".repeat(43),
    }],
  ] as const)("maps %s to the same non-disclosing not-found response",
    async (_name, authenticationHeaders) => {
      const fixture = receiptHandler();
      const response = await invoke(fixture.handler, authenticationHeaders);

      expect(response.statusCode).toBe(404);
      expect(response.body).toMatchObject({ code: "NOT_FOUND", retryClass: "never" });
      expect(fixture.executions).toEqual([]);
    });

  it("requires at least one receipt authentication alternative", async () => {
    const fixture = receiptHandler();
    const response = await invoke(fixture.handler, {});

    expect(response.statusCode).toBe(401);
    expect(response.body).toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
      retryClass: "after_user_action",
    });
    expect(fixture.executions).toEqual([]);
  });

  it("preserves an unexpected session-store failure as unavailable", async () => {
    const fixture = receiptHandler({ sessionFailure: new Error("session database unavailable") });
    const response = await invoke(fixture.handler, {
      authorization: `Bearer ${"s".repeat(43)}`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).toMatchObject({
      code: "INTERNAL_UNAVAILABLE",
      retryClass: "after_delay",
    });
    expect(fixture.executions).toEqual([]);
  });

  it.each([
    ["pending", publicReceiptResponse("pending")],
    ["failed", publicReceiptResponse("failed")],
    ["outcome unknown", publicReceiptResponse("outcome_unknown")],
  ] as const)("serves a safe %s state through the capability-only transport",
    async (_state, publicResponse) => {
      const fixture = receiptHandler({ publicResponse });
      const response = await invoke(fixture.handler, {
        "x-kokoro-receipt-recovery-capability": "r".repeat(43),
      });

      expect(response).toEqual({ statusCode: 200, body: publicResponse });
      expect(fixture.executions).toHaveLength(1);
      expect(fixture.executions[0]).toMatchObject({
        session: null,
        receiptRecoveryCapability: "r".repeat(43),
      });
    });
});

function receiptHandler(options: Readonly<{
  sessionFailure?: Error;
  publicResponse?: GetPublicCommandReceiptResponse;
}> = {}) {
  const workload: ProductWorkloadIdentity = Object.freeze({
    certificateSha256: "a".repeat(64),
    workloadIdentityId: "workload-1",
    siteProjectBindingRef: "binding-1",
    deploymentRef: "deployment-1",
    siteRef: "site-1",
    siteReleaseRef: "release-1",
    webArtifactDigest: "b".repeat(64),
    sessionContractRevision: "session-browser-v3",
    environment: "production",
    region: "us-east-1",
    audience: "site-product",
    allowedOperations: Object.freeze(["getPublicCommandReceipt"]),
    bindingEpoch: "2",
    siteSecurityEpoch: "1",
    policyEpoch: "2",
    csrfSha256: "c".repeat(64),
  });
  const session: AuthenticatedUserSession = Object.freeze({
    identitySessionRef: "session-1",
    subjectRef: "subject-1",
    siteRef: "site-1",
    subjectGeneration: "3",
    identitySessionEpoch: "4",
    restrictionEpoch: "5",
    credentialEpoch: "6",
    authenticationMethods: Object.freeze(["password"] as const),
    authenticatedAt: "2026-08-11T00:00:00.000Z",
    expiresAt: "2026-08-12T00:00:00.000Z",
  });
  const workloads = {
    authenticate: () => workload,
    verify: async () => Object.freeze({
      workloadIdentityId: workload.workloadIdentityId,
      kind: "site_product" as const,
      audience: workload.audience,
      environment: workload.environment,
      region: workload.region,
      allowedOperations: workload.allowedOperations,
      siteId: workload.siteRef,
      siteReleaseRef: workload.siteReleaseRef,
      bindingEpoch: workload.bindingEpoch,
      siteSecurityEpoch: workload.siteSecurityEpoch,
      issuedAt: "2026-08-11T00:00:00.000Z",
      expiresAt: "2026-08-11T00:01:00.000Z",
      issuer: "kokoro-platform-product-workload-registry",
      keyVersion: "fixture-1",
    }),
  } as unknown as ProductWorkloadRegistry;
  const executions: unknown[] = [];
  const operation = definePlatformPublicOperation({
    operationId: "getPublicCommandReceipt",
    async execute(input) {
      executions.push(input);
      return options.publicResponse ?? {
        receipt: {
          commandId: input.path.id,
          deliveryState: "not_applicable" as const,
          observedAt: "2026-08-11T00:00:00.000Z",
          requestDigest: "d".repeat(64),
          state: "committed" as const,
        },
        reconciliation: { kind: "terminal" as const, outcome: "committed" as const },
      };
    },
  });
  return {
    executions,
    handler: createPlatformPublicHttpHandler({
      workloads,
      sessions: {
        async authenticateUserSession({ credentialDigest }) {
          if (options.sessionFailure !== undefined) throw options.sessionFailure;
          return credentialDigest === "e".repeat(64) ? null : session;
        },
      },
      operations: [operation],
      requiredOperationIds: ["getPublicCommandReceipt"],
      grantSigner: { jwks: () => ({ keys: [] }) } as never,
      sessionCredentialDigest: (credential) => credential === "x".repeat(43)
        ? "e".repeat(64)
        : "f".repeat(64),
      clock: () => new Date("2026-08-11T00:00:00.000Z"),
    }),
  };
}

function publicReceiptResponse(
  state: "pending" | "failed" | "outcome_unknown",
): GetPublicCommandReceiptResponse {
  const receipt = {
    commandId: "1".repeat(32),
    deliveryState: "not_applicable" as const,
    observedAt: "2026-08-11T00:00:00.000Z",
    requestDigest: "d".repeat(64),
  };
  if (state === "pending") {
    return {
      receipt: { ...receipt, state: "accepted" },
      reconciliation: { kind: "pending", retryAfterSeconds: 2 },
    };
  }
  if (state === "outcome_unknown") {
    return {
      receipt: { ...receipt, state: "outcome_unknown" },
      reconciliation: { kind: "pending", retryAfterSeconds: 2 },
    };
  }
  return {
    receipt: { ...receipt, state: "rejected" },
    reconciliation: { kind: "terminal", outcome: "rejected" },
  };
}

async function invoke(
  handler: ReturnType<typeof createPlatformPublicHttpHandler>,
  authenticationHeaders: Readonly<Record<string, string>>,
): Promise<Readonly<{ statusCode: number; body: Record<string, unknown> }>> {
  const request = Readable.from([]) as unknown as IncomingMessage;
  Object.assign(request, {
    method: "GET",
    url: `/v1/commands/${"1".repeat(32)}/receipt`,
    headers: { "kokoro-contract-version": "1", ...authenticationHeaders },
  });
  let body: Record<string, unknown> = {};
  const response = {
    statusCode: 0,
    setHeader() {},
    end(value: string) {
      body = JSON.parse(value) as Record<string, unknown>;
    },
  } as unknown as ServerResponse;
  await handler.handle(request, response);
  return Object.freeze({ statusCode: response.statusCode, body });
}
