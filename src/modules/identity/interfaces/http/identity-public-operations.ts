import type { RegisteredPlatformPublicOperation } from "../../../../interfaces/http/platform-public-operation-registry.js";
import { definePlatformPublicOperation } from "../../../../interfaces/http/platform-public-operation-registry.js";
import type { IdentityApplicationService } from "../../application/services/identity-application-service.js";
import { IdentityApplicationError } from "../../application/services/identity-application-service.js";
import type { IdentitySecurityManagementService } from "../../application/services/identity-security-management-service.js";

export const IDENTITY_LAUNCH_OPERATION_IDS = Object.freeze([
  "beginRegistration",
  "resendEmailVerification",
  "completeEmailVerification",
  "createIdentitySession",
  "completeSessionMfa",
  "reauthenticateIdentitySession",
  "beginTotpEnrollment",
  "confirmTotpEnrollment",
  "disableTotp",
  "regenerateRecoveryCodes",
  "refreshIdentitySession",
  "listIdentitySessions",
  "revokeIdentitySessions",
] as const);

export function createIdentityPublicOperations(
  service: IdentityApplicationService,
  securityManagement: IdentitySecurityManagementService,
): readonly RegisteredPlatformPublicOperation[] {
  return Object.freeze([
    definePlatformPublicOperation({
      operationId: "beginRegistration",
      async execute(input) {
        return service.beginRegistration({
          workload: input.workload,
          context: input.context,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"],
          email: input.body.email,
          password: input.body.password,
          legalAcceptanceRefs: input.body.legalAcceptanceRefs,
        });
      },
    }),
    definePlatformPublicOperation({
      operationId: "resendEmailVerification",
      async execute(input) {
        return service.resendEmailVerification({
          workload: input.workload,
          context: input.context,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"],
          email: input.body.email,
        });
      },
    }),
    definePlatformPublicOperation({
      operationId: "completeEmailVerification",
      async execute(input) {
        return service.completeEmailVerification({
          workload: input.workload,
          context: input.context,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"],
          transactionRef: input.path.id,
          transactionSecret: input.body.transactionSecret,
          receiptRecoveryCapability: recovery(input.receiptRecoveryCapability),
        });
      },
    }),
    definePlatformPublicOperation({
      operationId: "createIdentitySession",
      async execute(input) {
        const common = {
          workload: input.workload,
          context: input.context,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"],
          receiptRecoveryCapability: recovery(input.receiptRecoveryCapability),
        };
        if ("recoveryAction" in input.body) {
          return service.createIdentitySession({
            ...common,
            recoveryAction: input.body.recoveryAction,
            priorCommandId: input.body.priorCommandId,
          });
        }
        return service.createIdentitySession({
          ...common,
          email: input.body.email,
          password: input.body.password,
          ...(input.body.returnIntentRef === undefined
            ? {}
            : { returnIntentRef: input.body.returnIntentRef }),
        });
      },
    }),
    definePlatformPublicOperation({
      operationId: "completeSessionMfa",
      async execute(input) {
        const common = {
          workload: input.workload,
          context: input.context,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"],
          receiptRecoveryCapability: recovery(input.receiptRecoveryCapability),
          transactionRef: input.path.id,
        };
        if ("recoveryAction" in input.body) {
          return service.completeSessionMfa({
            ...common,
            recoveryAction: input.body.recoveryAction,
            priorCommandId: input.body.priorCommandId,
          });
        }
        return service.completeSessionMfa({ ...common, code: input.body.code });
      },
    }),
    definePlatformPublicOperation({
      operationId: "reauthenticateIdentitySession",
      async execute(input) {
        if (input.session === null) throw new IdentityApplicationError("AUTHENTICATION_FAILED");
        const common = {
          workload: input.workload, context: input.context, session: input.session,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"],
          receiptRecoveryCapability: recovery(input.receiptRecoveryCapability),
        };
        if (input.body.stage === "supersede") {
          return securityManagement.reauthenticateIdentitySession({
            ...common, stage: input.body.stage, priorCommandId: input.body.priorCommandId,
          });
        }
        if (input.body.stage === "mfa") {
          return securityManagement.reauthenticateIdentitySession({
            ...common, stage: input.body.stage, challengeKind: input.body.challengeKind,
            proofCode: input.body.proofCode, transactionRef: input.body.transactionRef,
            target: input.body.target,
          });
        }
        return securityManagement.reauthenticateIdentitySession({
          ...common, stage: input.body.stage, password: input.body.password, target: input.body.target,
        });
      },
    }),
    definePlatformPublicOperation({
      operationId: "beginTotpEnrollment",
      async execute(input) {
        if (input.session === null) throw new IdentityApplicationError("AUTHENTICATION_FAILED");
        const common = {
          workload: input.workload,
          context: input.context,
          session: input.session,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"],
          receiptRecoveryCapability: recovery(input.receiptRecoveryCapability),
        };
        if (input.body.ceremonyAction === "supersede") {
          return securityManagement.beginTotpEnrollment({
            ...common,
            ceremonyAction: input.body.ceremonyAction,
            priorCommandId: input.body.priorCommandId,
            priorTransactionRef: input.body.priorTransactionRef,
          });
        }
        return securityManagement.beginTotpEnrollment({
          ...common,
          ceremonyAction: input.body.ceremonyAction,
          reauthenticationProof: input.body.reauthenticationProof,
        });
      },
    }),
    definePlatformPublicOperation({
      operationId: "confirmTotpEnrollment",
      async execute(input) {
        if (input.session === null) throw new IdentityApplicationError("AUTHENTICATION_FAILED");
        return securityManagement.confirmTotpEnrollment({
          workload: input.workload,
          context: input.context,
          session: input.session,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"],
          receiptRecoveryCapability: recovery(input.receiptRecoveryCapability),
          transactionRef: input.body.transactionRef,
          code: input.body.code,
        });
      },
    }),
    definePlatformPublicOperation({
      operationId: "disableTotp",
      async execute(input) {
        if (input.session === null) throw new IdentityApplicationError("AUTHENTICATION_FAILED");
        return securityManagement.disableTotp({
          workload: input.workload, context: input.context, session: input.session,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"],
          code: input.body.code, reauthenticationProof: input.body.reauthenticationProof,
        });
      },
    }),
    definePlatformPublicOperation({
      operationId: "regenerateRecoveryCodes",
      async execute(input) {
        if (input.session === null) throw new IdentityApplicationError("AUTHENTICATION_FAILED");
        const common = {
          workload: input.workload, context: input.context, session: input.session,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"],
          receiptRecoveryCapability: recovery(input.receiptRecoveryCapability),
        };
        return input.body.recoveryAction === "supersede"
          ? securityManagement.regenerateRecoveryCodes({ ...common,
              recoveryAction: input.body.recoveryAction, priorCommandId: input.body.priorCommandId })
          : securityManagement.regenerateRecoveryCodes({ ...common,
              recoveryAction: input.body.recoveryAction,
              reauthenticationProof: input.body.reauthenticationProof });
      },
    }),
    definePlatformPublicOperation({
      operationId: "refreshIdentitySession",
      async execute(input) {
        const common = {
          workload: input.workload,
          context: input.context,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"],
          receiptRecoveryCapability: recovery(input.receiptRecoveryCapability),
        };
        if ("recoveryAction" in input.body) {
          return service.refreshIdentitySession({
            ...common,
            recoveryAction: input.body.recoveryAction,
            priorCommandId: input.body.priorCommandId,
          });
        }
        return service.refreshIdentitySession({
          ...common,
          opaqueCredential: input.body.opaqueCredential,
        });
      },
    }),
    definePlatformPublicOperation({
      operationId: "listIdentitySessions",
      async execute(input) {
        if (input.session === null) throw new IdentityApplicationError("AUTHENTICATION_FAILED");
        return service.listIdentitySessions({
          workload: input.workload,
          context: input.context,
          session: input.session,
        });
      },
    }),
    definePlatformPublicOperation({
      operationId: "revokeIdentitySessions",
      async execute(input) {
        if (input.session === null) throw new IdentityApplicationError("AUTHENTICATION_FAILED");
        return service.revokeIdentitySessions({
          workload: input.workload,
          context: input.context,
          session: input.session,
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
