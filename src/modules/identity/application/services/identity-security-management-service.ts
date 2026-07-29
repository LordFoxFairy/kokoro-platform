import type {
  AuthenticatedUserSession,
  ProductWorkloadIdentity,
} from "../../../authorization/domain/session-access-grant.js";
import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type {
  CommandIdentity,
  CommandReceipt,
  JsonValue,
} from "../../../../shared/outbox-inbox/receipt.js";
import type { OutboxEvent } from "../../../../shared/outbox-inbox/outbox.js";
import type {
  IdentityCommandReceiptPort,
  IdentityOutboxPort,
  IdentityUnitOfWorkPort,
} from "./identity-application-service.js";
import { IdentityApplicationError } from "./identity-application-service.js";
import type { IdentityRepository } from "../contracts/identity-repository.js";
import type {
  IdentitySecurityManagementRepository,
  IdentitySecuritySessionBinding,
} from "../contracts/identity-security-management-repository.js";
import type {
  IdentityAuditDigesterPort,
  IdentityRecoveryCodeIssuerPort,
  IdentityTotpEnrollmentIssuerPort,
  IdentityTotpSecretProtectorPort,
  IdentityTotpVerifierPort,
} from "../contracts/identity-security-ports.js";
import { digestIdentityRecoveryCode } from "./identity-recovery-code-digest.js";

export class IdentitySecurityManagementService {
  constructor(
    private readonly dependencies: Readonly<{
      unitOfWork: IdentityUnitOfWorkPort;
      repository: IdentitySecurityManagementRepository;
      receiptRecovery: Pick<IdentityRepository, "bindReceiptRecoveryCapability">;
      receipts: IdentityCommandReceiptPort;
      outbox: IdentityOutboxPort;
      totpEnrollmentIssuer: IdentityTotpEnrollmentIssuerPort;
      recoveryCodeIssuer: IdentityRecoveryCodeIssuerPort;
      totpSecretProtector: IdentityTotpSecretProtectorPort;
      totpVerifier: IdentityTotpVerifierPort;
      dummyTotpSecret: string;
      auditDigest: IdentityAuditDigesterPort;
      clock?: () => Date;
      reference?: () => string;
    }>,
  ) {}

  async beginTotpEnrollment(
    input: Readonly<
      {
        workload: ProductWorkloadIdentity;
        context: VerifiedRequestSecurityContext;
        session: AuthenticatedUserSession;
        commandId: string;
        idempotencyKey: string;
        receiptRecoveryCapability: string;
      } & (
        | Readonly<{ ceremonyAction: "begin" }>
        | Readonly<{
            ceremonyAction: "supersede";
            priorCommandId: string;
            priorTransactionRef: string;
          }>
      )
    >,
  ) {
    const supersede = input.ceremonyAction === "supersede";
    const requestDigest = this.dependencies.auditDigest(
      supersede
        ? {
            operation: "beginTotpEnrollment",
            siteRef: input.workload.siteRef,
            sessionRef: input.session.identitySessionRef,
            ceremonyAction: input.ceremonyAction,
            priorCommandId: input.priorCommandId,
            priorTransactionRef: input.priorTransactionRef,
          }
        : {
            operation: "beginTotpEnrollment",
            siteRef: input.workload.siteRef,
            sessionRef: input.session.identitySessionRef,
            ceremonyAction: input.ceremonyAction,
          },
    );
    const now = this.now();
    const binding = sessionBinding(input.workload, input.session);
    const material = await this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "beginTotpEnrollment" },
      (transaction) =>
        this.dependencies.repository.loadSecurityOwnerMaterial(transaction, { binding, now }),
    );
    if (material === null) throw new IdentityApplicationError("AUTHENTICATION_FAILED");
    const identityIssuerLabel = canonicalIdentityIssuerLabel(material.identityIssuerLabel);
    const transactionRef = this.reference();
    const authenticatorRef = this.reference();
    const issued = await this.dependencies.totpEnrollmentIssuer.issue({
      issuer: identityIssuerLabel,
      accountLabel: material.emailNormalized,
    });
    const envelope = this.dependencies.totpSecretProtector.seal(issued.secret, {
      siteRef: input.workload.siteRef,
      accountRef: material.accountRef,
      subjectRef: input.session.subjectRef,
      authenticatorRef,
    });
    const expiresAt = plus(now, 10 * 60_000);
    const outcome = await this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "beginTotpEnrollment" },
      async (transaction) => {
        const identity = commandIdentity(input, "beginTotpEnrollment", requestDigest);
        const existing = await this.dependencies.receipts.begin(transaction, identity);
        assertSameCommand(existing, input.commandId);
        if (existing.state === "succeeded") return Object.freeze({ kind: "retry" as const });
        if (existing.state === "failed") return Object.freeze({ kind: "rejected" as const });
        let accepted: boolean;
        if (supersede) {
          accepted = await this.dependencies.repository.supersedeTotpEnrollment(transaction, {
            binding,
            accountRef: material.accountRef,
            expectedAccountSecurityEpoch: material.accountSecurityEpoch,
            priorCommandId: input.priorCommandId,
            priorTransactionRef: input.priorTransactionRef,
            newCommandId: input.commandId,
            requestDigest,
            workloadIdentityId: input.workload.workloadIdentityId,
            capabilityDigest: this.recoveryDigest(
              "beginTotpEnrollment",
              input.receiptRecoveryCapability,
            ),
            transactionRef,
            authenticatorRef,
            envelope,
            now,
            expiresAt,
          });
        } else {
          await this.bindRecovery(transaction, input, "beginTotpEnrollment", transactionRef, now);
          accepted = await this.dependencies.repository.beginTotpEnrollment(transaction, {
            binding,
            accountRef: material.accountRef,
            expectedAccountSecurityEpoch: material.accountSecurityEpoch,
            commandId: input.commandId,
            requestDigest,
            transactionRef,
            authenticatorRef,
            envelope,
            now,
            expiresAt,
          });
        }
        if (!accepted) {
          await this.failure(transaction, identity, "AUTH_TRANSACTION_INVALID");
          return Object.freeze({ kind: "rejected" as const });
        }
        await this.securityEvent(transaction, input, {
          eventType: supersede
            ? "identity.totp.enrollment_superseded"
            : "identity.totp.enrollment_started",
          accountRef: material.accountRef,
          accountSecurityEpoch: material.accountSecurityEpoch,
          occurredAt: now,
          aggregateRef: transactionRef,
        });
        await this.success(transaction, identity, {
          kind: "totp_enrollment",
          transactionRef,
          expiresAt,
          accountRef: material.accountRef,
          accountSecurityEpoch: material.accountSecurityEpoch,
          committedAt: now,
        });
        return Object.freeze({ kind: "fresh" as const });
      },
    );
    if (outcome.kind === "rejected") throw new IdentityApplicationError("AUTH_TRANSACTION_INVALID");
    if (outcome.kind === "retry") return deliveryUnavailable(input.commandId, requestDigest);
    return Object.freeze({
      commandId: input.commandId,
      requestDigest,
      transaction: Object.freeze({
        transactionRef,
        expiresAt,
        otpauthUri: issued.otpauthUri,
        manualEntrySecret: issued.secret,
      }),
    });
  }

  async confirmTotpEnrollment(
    input: Readonly<{
      workload: ProductWorkloadIdentity;
      context: VerifiedRequestSecurityContext;
      session: AuthenticatedUserSession;
      commandId: string;
      idempotencyKey: string;
      receiptRecoveryCapability: string;
      transactionRef: string;
      code: string;
    }>,
  ) {
    const code = input.code.normalize("NFC");
    const requestDigest = this.dependencies.auditDigest({
      operation: "confirmTotpEnrollment",
      siteRef: input.workload.siteRef,
      sessionRef: input.session.identitySessionRef,
      transactionRef: input.transactionRef,
      code,
    });
    const now = this.now();
    const binding = sessionBinding(input.workload, input.session);
    const material = await this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "confirmTotpEnrollment" },
      (transaction) =>
        this.dependencies.repository.loadTotpEnrollmentMaterial(transaction, {
          binding,
          transactionRef: input.transactionRef,
          now,
        }),
    );
    let secret = this.dependencies.dummyTotpSecret;
    let usable = false;
    if (material !== null) {
      try {
        secret = this.dependencies.totpSecretProtector.unseal(material.envelope, {
          siteRef: input.workload.siteRef,
          accountRef: material.accountRef,
          subjectRef: material.subjectRef,
          authenticatorRef: material.authenticatorRef,
        });
        usable = true;
      } catch {
        usable = false;
      }
    }
    const verification = await this.dependencies.totpVerifier.verify({
      secret,
      code,
      epochSeconds: Math.floor(Date.parse(now) / 1_000),
      afterTimeStep: material?.lastAcceptedTimeStep ?? null,
    });
    const setRef = this.reference();
    const recoveryCodes = this.dependencies.recoveryCodeIssuer.issue();
    const recoveryCodeDigests = recoveryCodes.map((recoveryCode) => ({
      codeDigest: digestIdentityRecoveryCode(this.dependencies.auditDigest, {
        siteRef: input.workload.siteRef,
        accountRef: material?.accountRef ?? "unknown-account",
        recoverySetRef: setRef,
        code: recoveryCode,
      }),
    }));
    const outcome = await this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "confirmTotpEnrollment" },
      async (transaction) => {
        const identity = commandIdentity(input, "confirmTotpEnrollment", requestDigest);
        const existing = await this.dependencies.receipts.begin(transaction, identity);
        assertSameCommand(existing, input.commandId);
        if (existing.state === "succeeded") return Object.freeze({ kind: "retry" as const });
        if (existing.state === "failed") return Object.freeze({ kind: "rejected" as const });
        await this.bindRecovery(
          transaction,
          input,
          "confirmTotpEnrollment",
          input.transactionRef,
          now,
        );
        const confirmed = await this.dependencies.repository.confirmTotpEnrollment(transaction, {
          binding,
          transactionRef: input.transactionRef,
          timeStep: usable && verification.valid ? verification.timeStep : null,
          commandId: input.commandId,
          requestDigest,
          setRef,
          recoveryCodeDigests,
          now,
        });
        if (confirmed === null) {
          await this.failure(transaction, identity, "AUTH_TRANSACTION_INVALID");
          return Object.freeze({ kind: "rejected" as const });
        }
        await this.securityEvent(transaction, input, {
          eventType: "identity.totp.enrollment_confirmed",
          accountRef: confirmed.accountRef,
          accountSecurityEpoch: confirmed.accountSecurityEpoch,
          occurredAt: now,
          aggregateRef: setRef,
        });
        await this.success(transaction, identity, {
          kind: "recovery_code_set",
          setRef,
          generatedAt: now,
          accountRef: confirmed.accountRef,
          accountSecurityEpoch: confirmed.accountSecurityEpoch,
          committedAt: now,
        });
        return Object.freeze({ kind: "fresh" as const });
      },
    );
    if (outcome.kind === "rejected") throw new IdentityApplicationError("AUTH_TRANSACTION_INVALID");
    if (outcome.kind === "retry") return deliveryUnavailable(input.commandId, requestDigest);
    return Object.freeze({
      commandId: input.commandId,
      requestDigest,
      recoveryCodes,
      generatedAt: now,
    });
  }

  private now(): string {
    const clock = this.dependencies.clock ?? (() => new Date());
    return new Date(Math.floor(clock().getTime() / 1_000) * 1_000).toISOString();
  }

  private reference(): string {
    const value = this.dependencies.reference?.();
    if (value === undefined) throw new Error("IDENTITY_REFERENCE_FACTORY_REQUIRED");
    return value;
  }

  private recoveryDigest(purpose: string, capability: string): string {
    assertRecoveryCapability(capability);
    return this.dependencies.auditDigest({ purpose, capability });
  }

  private async bindRecovery(
    transaction: PlatformTransaction,
    input: Readonly<{
      commandId: string;
      workload: ProductWorkloadIdentity;
      receiptRecoveryCapability: string;
    }>,
    purpose: string,
    transactionRef: string | null,
    now: string,
  ): Promise<void> {
    await this.dependencies.receiptRecovery.bindReceiptRecoveryCapability(transaction, {
      commandId: input.commandId,
      siteRef: input.workload.siteRef,
      workloadIdentityId: input.workload.workloadIdentityId,
      purpose,
      transactionRef,
      capabilityDigest: this.recoveryDigest(purpose, input.receiptRecoveryCapability),
      expiresAt: plus(now, 24 * 60 * 60_000),
      now,
    });
  }

  private async securityEvent(
    transaction: PlatformTransaction,
    input: Readonly<{
      commandId: string;
      workload: ProductWorkloadIdentity;
      context: VerifiedRequestSecurityContext;
      session: AuthenticatedUserSession;
    }>,
    event: Readonly<{
      eventType: string;
      accountRef: string;
      accountSecurityEpoch: string;
      occurredAt: string;
      aggregateRef: string;
    }>,
  ): Promise<void> {
    const eventId = this.reference();
    const payload = json({
      version: 1,
      eventType: event.eventType,
      siteRef: input.workload.siteRef,
      accountRef: event.accountRef,
      subjectRef: input.session.subjectRef,
      sessionRef: input.session.identitySessionRef,
      accountSecurityEpoch: event.accountSecurityEpoch,
      occurredAt: event.occurredAt,
    });
    const payloadDigest = this.dependencies.auditDigest(payload);
    const outbox: OutboxEvent = Object.freeze({
      eventId,
      owner: "identity",
      eventType: event.eventType,
      aggregateId: event.aggregateRef,
      payload,
      payloadDigest,
      correlationId: input.context.correlationId,
      causationId: input.commandId,
    });
    await this.dependencies.outbox.enqueue(transaction, outbox);
    await this.dependencies.repository.appendSecurityEvent(transaction, {
      eventId,
      siteRef: input.workload.siteRef,
      accountRef: event.accountRef,
      subjectRef: input.session.subjectRef,
      sessionRef: input.session.identitySessionRef,
      eventType: event.eventType,
      accountSecurityEpoch: event.accountSecurityEpoch,
      payloadDigest,
      correlationId: input.context.correlationId,
      causationId: input.commandId,
      occurredAt: event.occurredAt,
    });
  }

  private async success(
    transaction: PlatformTransaction,
    identity: CommandIdentity,
    result: JsonValue,
  ): Promise<void> {
    await this.dependencies.receipts.recordOutcome(transaction, identity, {
      state: "succeeded",
      result,
      resultDigest: this.dependencies.auditDigest(result),
    });
  }

  private async failure(
    transaction: PlatformTransaction,
    identity: CommandIdentity,
    code: string,
  ): Promise<void> {
    const result = json({ code });
    await this.dependencies.receipts.recordOutcome(transaction, identity, {
      state: "failed",
      result,
      resultDigest: this.dependencies.auditDigest(result),
    });
  }
}

function sessionBinding(
  workload: ProductWorkloadIdentity,
  session: AuthenticatedUserSession,
): IdentitySecuritySessionBinding {
  if (session.siteRef !== workload.siteRef)
    throw new IdentityApplicationError("AUTHENTICATION_FAILED");
  return Object.freeze({
    siteRef: workload.siteRef,
    siteReleaseRef: workload.siteReleaseRef,
    subjectRef: session.subjectRef,
    sessionRef: session.identitySessionRef,
    subjectGeneration: session.subjectGeneration,
    sessionEpoch: session.identitySessionEpoch,
    credentialEpoch: session.credentialEpoch,
    authenticatedAt: session.authenticatedAt,
    authenticationMethods: session.authenticationMethods,
  });
}

function commandIdentity(
  input: Readonly<{ commandId: string; idempotencyKey: string; workload: ProductWorkloadIdentity }>,
  operation: string,
  requestDigest: string,
): CommandIdentity {
  return Object.freeze({
    commandId: input.commandId,
    environment: input.workload.environment,
    region: input.workload.region,
    callerIdentity: input.workload.workloadIdentityId,
    operation,
    idempotencyKey: input.idempotencyKey,
    requestDigest,
  });
}

function assertSameCommand(existing: CommandReceipt, commandId: string): void {
  if (existing.commandId !== commandId) throw new Error("COMMAND_IDENTITY_CONFLICT");
}

function assertRecoveryCapability(value: string): void {
  if (value.length < 32 || value.length > 2048 || value.trim() !== value || /\s/u.test(value)) {
    throw new IdentityApplicationError("AUTH_TRANSACTION_INVALID");
  }
}

function canonicalIdentityIssuerLabel(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 64 ||
    value.trim() !== value ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  ) {
    throw new IdentityApplicationError("AUTHENTICATION_FAILED");
  }
  return value;
}

function deliveryUnavailable(commandId: string, requestDigest: string) {
  return Object.freeze({
    kind: "delivery_unavailable" as const,
    commandId,
    receiptRef: `command:${commandId}`,
    requestDigest,
  });
}

function plus(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
