import type { RegisteredPlatformPublicOperation } from "../../../../interfaces/http/platform-public-operation-registry.js";
import { definePlatformPublicOperation } from "../../../../interfaces/http/platform-public-operation-registry.js";
import type { IdentityApplicationService } from "../../application/services/identity-application-service.js";
import { IdentityApplicationError } from "../../application/services/identity-application-service.js";

export const IDENTITY_LAUNCH_OPERATION_IDS = Object.freeze([
  "beginRegistration",
  "resendEmailVerification",
  "completeEmailVerification",
  "createIdentitySession",
  "refreshIdentitySession",
  "listIdentitySessions",
  "revokeIdentitySessions",
] as const);

export function createIdentityPublicOperations(
  service: IdentityApplicationService,
): readonly RegisteredPlatformPublicOperation[] {
  return Object.freeze([
    definePlatformPublicOperation({
      operationId: "beginRegistration",
      async execute(input) {
        return service.beginRegistration({
          workload: input.workload, context: input.context,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"],
          email: input.body.email, password: input.body.password,
          legalAcceptanceRefs: input.body.legalAcceptanceRefs,
        });
      },
    }),
    definePlatformPublicOperation({
      operationId: "resendEmailVerification",
      async execute(input) {
        return service.resendEmailVerification({
          workload: input.workload, context: input.context,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"], email: input.body.email,
        });
      },
    }),
    definePlatformPublicOperation({
      operationId: "completeEmailVerification",
      async execute(input) {
        return service.completeEmailVerification({
          workload: input.workload, context: input.context,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"],
          transactionRef: input.path.id, transactionSecret: input.body.transactionSecret,
          receiptRecoveryCapability: recovery(input.receiptRecoveryCapability),
        });
      },
    }),
    definePlatformPublicOperation({
      operationId: "createIdentitySession",
      async execute(input) {
        const common = {
          workload: input.workload, context: input.context,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"],
          receiptRecoveryCapability: recovery(input.receiptRecoveryCapability),
        };
        if ("recoveryAction" in input.body) {
          return service.createIdentitySession({
            ...common, recoveryAction: input.body.recoveryAction, priorCommandId: input.body.priorCommandId,
          });
        }
        return service.createIdentitySession({
          ...common, email: input.body.email, password: input.body.password,
          ...(input.body.returnIntentRef === undefined ? {} : { returnIntentRef: input.body.returnIntentRef }),
        });
      },
    }),
    definePlatformPublicOperation({
      operationId: "refreshIdentitySession",
      async execute(input) {
        const common = {
          workload: input.workload, context: input.context,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"],
          receiptRecoveryCapability: recovery(input.receiptRecoveryCapability),
        };
        if ("recoveryAction" in input.body) {
          return service.refreshIdentitySession({
            ...common, recoveryAction: input.body.recoveryAction, priorCommandId: input.body.priorCommandId,
          });
        }
        return service.refreshIdentitySession({ ...common, opaqueCredential: input.body.opaqueCredential });
      },
    }),
    definePlatformPublicOperation({
      operationId: "listIdentitySessions",
      async execute(input) {
        if (input.session === null) throw new IdentityApplicationError("AUTHENTICATION_FAILED");
        return service.listIdentitySessions({
          workload: input.workload, context: input.context, session: input.session,
        });
      },
    }),
    definePlatformPublicOperation({
      operationId: "revokeIdentitySessions",
      async execute(input) {
        if (input.session === null) throw new IdentityApplicationError("AUTHENTICATION_FAILED");
        return service.revokeIdentitySessions({
          workload: input.workload, context: input.context, session: input.session,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"],
          target: input.body.target,
          ...(input.body.sessionRef === undefined ? {} : { sessionRef: input.body.sessionRef }),
        });
      },
    }),
  ]);
}

function recovery(value: string | null): string {
  if (value === null) throw new IdentityApplicationError("AUTH_TRANSACTION_INVALID");
  return value;
}
