import type { ExchangeProductContextService } from "../../application/services/exchange-product-context.js";
import type { GetPersonalContextService } from "../../application/services/get-personal-context.js";
import type { IssueSessionAccessGrantService } from "../../application/services/issue-session-access-grant.js";
import type { SessionAccessPurpose, SessionGrantResource } from "../../domain/session-access-grant.js";
import type { RegisteredPlatformPublicOperation } from "../../../../interfaces/http/platform-public-operation-registry.js";
import { definePlatformPublicOperation } from "../../../../interfaces/http/platform-public-operation-registry.js";
import { SessionAuthorizationError } from "../../domain/session-access-grant.js";

export const AUTHORIZATION_PUBLIC_OPERATION_IDS = Object.freeze([
  "exchangeProductContext", "getPersonalContext", "issueSessionAccessGrant",
] as const);

export function createAuthorizationPublicOperations(input: Readonly<{
  exchangeProductContext: ExchangeProductContextService;
  getPersonalContext: GetPersonalContextService;
  issueSessionAccessGrant: IssueSessionAccessGrantService;
}>): readonly RegisteredPlatformPublicOperation[] {
  return Object.freeze([
    definePlatformPublicOperation({
      operationId: "exchangeProductContext",
      async execute(operation) {
        const result = await input.exchangeProductContext.execute({
          workload: operation.workload, context: operation.context,
          commandId: operation.headers["X-Kokoro-Command-Id"],
          idempotencyKey: operation.headers["Idempotency-Key"],
          commandRef: operation.body.commandRef,
        });
        return { receipt: result.receipt, context: result.context };
      },
    }),
    definePlatformPublicOperation({
      operationId: "getPersonalContext",
      async execute(operation) {
        if (operation.session === null) throw new SessionAuthorizationError("USER_SESSION_REQUIRED");
        return input.getPersonalContext.execute({
          workload: operation.workload, session: operation.session, context: operation.context,
        });
      },
    }),
    definePlatformPublicOperation({
      operationId: "issueSessionAccessGrant",
      targetProjectRef: ({ body }) => body.projectRef,
      async execute(operation) {
        if (operation.session === null) throw new SessionAuthorizationError("USER_SESSION_REQUIRED");
        const grant = await input.issueSessionAccessGrant.execute({
          workload: operation.workload, session: operation.session, context: operation.context,
          productContextRef: operation.body.productContextRef,
          projectRef: operation.body.projectRef,
          purpose: operation.body.purpose as SessionAccessPurpose,
          resource: operation.body.resource as SessionGrantResource,
        });
        return { grant };
      },
    }),
  ]);
}
