import { timingSafeEqual } from "node:crypto";
import type { ProductWorkloadIdentity, AuthenticatedUserSession } from "../../../authorization/domain/session-access-grant.js";
import type { JsonValue, CommandIdentity, CommandReceipt } from "../../../../shared/outbox-inbox/receipt.js";
import type { OutboxEvent } from "../../../../shared/outbox-inbox/outbox.js";
import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { IdentityRepository, IdentitySessionSafeFact, VerificationRecord } from "../contracts/identity-repository.js";
import type {
  IdentityAuditDigesterPort,
  IdentityPasswordHash,
  IdentityPasswordHasherPort,
  IdentityTotpSecretProtectorPort,
  IdentityTotpVerifierPort,
  OpaqueCredentialPort,
  VerificationEnvelopeSealerPort,
} from "../contracts/identity-security-ports.js";
import { normalizeIdentityEmail } from "../../domain/identity-email.js";
import { IdentitySessionAuthorizationMutation } from "./identity-session-authorization-mutation.js";
import { PersonalBootstrapAuthorizationMutation } from "./personal-bootstrap-authorization-mutation.js";
import { digestIdentityRecoveryCode } from "./identity-recovery-code-digest.js";
import { digestIdentityReceiptRecoveryCapability } from
  "./identity-receipt-recovery-digest.js";

export interface IdentityUnitOfWorkPort {
  execute<Result>(
    fence: Readonly<{ context: VerifiedRequestSecurityContext; operation: string }>,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export interface IdentityCommandReceiptPort {
  begin(transaction: PlatformTransaction, identity: CommandIdentity): Promise<CommandReceipt>;
  recordOutcome(
    transaction: PlatformTransaction,
    identity: CommandIdentity,
    outcome: Readonly<{ state: "succeeded" | "failed" | "outcome_unknown"; result: JsonValue | null; resultDigest: string }>,
  ): Promise<CommandReceipt>;
}

export interface IdentityOutboxPort {
  enqueue(transaction: PlatformTransaction, event: OutboxEvent): Promise<void>;
}

export type IdentityCommandReceipt = Readonly<{
  commandId: string;
  committedAt: string;
  receiptRef: string;
  requestDigest: string;
  state: "committed";
}>;

export class IdentityApplicationError extends Error {
  constructor(readonly code: "AUTHENTICATION_FAILED" | "AUTH_TRANSACTION_INVALID") {
    super(code);
  }
}

export class IdentityApplicationService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: IdentityUnitOfWorkPort;
    repository: IdentityRepository;
    receipts: IdentityCommandReceiptPort;
    outbox: IdentityOutboxPort;
    passwordHasher: IdentityPasswordHasherPort;
    dummyPasswordHash: IdentityPasswordHash;
    verificationCredentials: OpaqueCredentialPort;
    sessionCredentials: OpaqueCredentialPort;
    refreshCredentials: OpaqueCredentialPort;
    totpSecretProtector: IdentityTotpSecretProtectorPort;
    totpVerifier: IdentityTotpVerifierPort;
    dummyTotpSecret: string;
    auditDigest: IdentityAuditDigesterPort;
    deliverySealer: VerificationEnvelopeSealerPort;
    personalBootstrapAuthorization: PersonalBootstrapAuthorizationMutation;
    sessionAuthorization: IdentitySessionAuthorizationMutation;
    clock?: () => Date;
    reference?: () => string;
  }>) {}

  async beginRegistration(input: Readonly<{
    workload: ProductWorkloadIdentity; context: VerifiedRequestSecurityContext;
    commandId: string; idempotencyKey: string; email: string; password: string;
    legalAcceptanceRefs: readonly string[];
  }>) {
    const emailNormalized = normalizeIdentityEmail(input.email);
    const passwordNormalized = normalizePassword(input.password);
    const legalAcceptanceRefs = canonicalLegalRefs(input.legalAcceptanceRefs);
    const requestDigest = this.dependencies.auditDigest({
      operation: "beginRegistration", siteRef: input.workload.siteRef,
      email: emailNormalized, password: passwordNormalized, legalAcceptanceRefs: [...legalAcceptanceRefs],
    });
    const password = await this.dependencies.passwordHasher.hash(passwordNormalized);
    return this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "beginRegistration" },
      async (transaction) => {
        const identity = commandIdentity(input, "beginRegistration", requestDigest);
        const existing = await this.dependencies.receipts.begin(transaction, identity);
        assertSameCommand(existing, input.commandId);
        if (existing.state === "succeeded" && existing.result !== null) {
          const restored = verificationResult(existing.result);
          return { receipt: receipt(input.commandId, requestDigest, restored.committedAt), transaction: restored.transaction };
        }
        const now = this.now();
        const expiresAt = plus(now, 15 * 60_000);
        const accountRef = this.reference();
        const subjectRef = this.reference();
        const transactionRef = this.reference();
        const secret = this.dependencies.verificationCredentials.issue();
        const deliveryRef = this.reference();
        const eventId = this.reference();
        const created = await this.dependencies.repository.createVerification(transaction, {
          siteRef: input.workload.siteRef, accountRef, subjectRef, transactionRef, emailNormalized,
          passwordHash: password.passwordHash, pepperVersion: password.pepperVersion,
          secretDigest: secret.digest, requestDigest, expiresAt, acceptedAt: now,
          legalAcceptances: legalAcceptanceRefs.map((termRef) => ({
            termRef,
            evidenceDigest: this.dependencies.auditDigest({
              siteRef: input.workload.siteRef, workloadIdentityId: input.workload.workloadIdentityId,
              siteReleaseRef: input.workload.siteReleaseRef, termRef, acceptedAt: now,
            }),
            workloadIdentityId: input.workload.workloadIdentityId,
            siteReleaseRef: input.workload.siteReleaseRef,
          })),
        });
        if (created === "created") {
          const sealedEnvelope = this.dependencies.deliverySealer.seal({
            siteRef: input.workload.siteRef, transactionRef, email: emailNormalized,
            verificationSecret: secret.credential, expiresAt,
          });
          const payload = json({
            kind: "sealed_identity_verification_v1", credentialRevision: 0, sealedEnvelope,
          });
          await this.dependencies.outbox.enqueue(transaction, {
            eventId, owner: "identity", eventType: "identity.verification.delivery.requested",
            aggregateId: transactionRef, payload,
            payloadDigest: this.dependencies.auditDigest(payload),
            correlationId: input.context.correlationId, causationId: input.commandId,
          });
          await this.dependencies.repository.recordVerificationDelivery(transaction, {
            siteRef: input.workload.siteRef, transactionRef, deliveryRef, eventId,
            credentialRevision: 0,
          });
        }
        const transactionResult = Object.freeze({ transactionRef, expiresAt, deliveryState: "queued" as const });
        await this.success(transaction, identity, { transaction: transactionResult, committedAt: now });
        return { receipt: receipt(input.commandId, requestDigest, now), transaction: transactionResult };
      },
    );
  }

  async resendEmailVerification(input: Readonly<{
    workload: ProductWorkloadIdentity; context: VerifiedRequestSecurityContext;
    commandId: string; idempotencyKey: string; email: string;
  }>) {
    const emailNormalized = normalizeIdentityEmail(input.email);
    const requestDigest = this.dependencies.auditDigest({
      operation: "resendEmailVerification", siteRef: input.workload.siteRef, email: emailNormalized,
    });
    return this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "resendEmailVerification" },
      async (transaction) => {
        const identity = commandIdentity(input, "resendEmailVerification", requestDigest);
        const existing = await this.dependencies.receipts.begin(transaction, identity);
        assertSameCommand(existing, input.commandId);
        if (existing.state === "succeeded" && existing.result !== null) {
          const restored = verificationResult(existing.result);
          return { receipt: receipt(input.commandId, requestDigest, restored.committedAt), transaction: restored.transaction };
        }
        const now = this.now();
        const pending = await this.dependencies.repository.findPendingVerificationByEmail(transaction, {
          siteRef: input.workload.siteRef, emailNormalized, now,
        });
        if (pending === null) {
          const transactionResult = Object.freeze({
            transactionRef: this.reference(), expiresAt: plus(now, 15 * 60_000), deliveryState: "queued" as const,
          });
          await this.success(transaction, identity, { transaction: transactionResult, committedAt: now });
          return { receipt: receipt(input.commandId, requestDigest, now), transaction: transactionResult };
        }
        const rateLimited = pending.resendCount >= 20 || pending.lastDeliveryAt !== null &&
          Date.parse(now) - Date.parse(pending.lastDeliveryAt) < 60_000;
        if (rateLimited) {
          const transactionResult = Object.freeze({
            transactionRef: pending.transactionRef, expiresAt: pending.expiresAt,
            deliveryState: "rate_limited" as const,
          });
          await this.success(transaction, identity, { transaction: transactionResult, committedAt: now });
          return { receipt: receipt(input.commandId, requestDigest, now), transaction: transactionResult };
        }
        const expiresAt = plus(now, 15 * 60_000);
        const secret = this.dependencies.verificationCredentials.issue();
        await this.dependencies.repository.rotateVerificationSecret(transaction, {
          siteRef: input.workload.siteRef, transactionRef: pending.transactionRef,
          expectedResendCount: pending.resendCount, secretDigest: secret.digest, expiresAt, now,
        });
        const eventId = this.reference();
        const sealedEnvelope = this.dependencies.deliverySealer.seal({
          siteRef: input.workload.siteRef, transactionRef: pending.transactionRef,
          email: emailNormalized, verificationSecret: secret.credential, expiresAt,
        });
        const credentialRevision = pending.resendCount + 1;
        const payload = json({
          kind: "sealed_identity_verification_v1", credentialRevision, sealedEnvelope,
        });
        await this.dependencies.outbox.enqueue(transaction, {
          eventId, owner: "identity", eventType: "identity.verification.delivery.requested",
          aggregateId: pending.transactionRef, payload,
          payloadDigest: this.dependencies.auditDigest(payload),
          correlationId: input.context.correlationId, causationId: input.commandId,
        });
        await this.dependencies.repository.recordVerificationDelivery(transaction, {
          siteRef: input.workload.siteRef, transactionRef: pending.transactionRef,
          deliveryRef: this.reference(), eventId, credentialRevision,
        });
        const transactionResult = Object.freeze({
          transactionRef: pending.transactionRef, expiresAt, deliveryState: "queued" as const,
        });
        await this.success(transaction, identity, { transaction: transactionResult, committedAt: now });
        return { receipt: receipt(input.commandId, requestDigest, now), transaction: transactionResult };
      },
    );
  }

  async completeEmailVerification(input: Readonly<{
    workload: ProductWorkloadIdentity; context: VerifiedRequestSecurityContext;
    commandId: string; idempotencyKey: string; transactionRef: string;
    transactionSecret: string; receiptRecoveryCapability: string;
  }>) {
    const requestDigest = this.dependencies.auditDigest({
      operation: "completeEmailVerification", siteRef: input.workload.siteRef,
      transactionRef: input.transactionRef, transactionSecret: input.transactionSecret,
    });
    const outcome = await this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "completeEmailVerification" },
      async (transaction) => {
        const identity = commandIdentity(input, "completeEmailVerification", requestDigest);
        const existing = await this.dependencies.receipts.begin(transaction, identity);
        assertSameCommand(existing, input.commandId);
        await this.bindRecovery(transaction, input, "completeEmailVerification", input.transactionRef);
        if (existing.state === "succeeded" && existing.result !== null) {
          const restored = activationResult(existing.result);
          return { kind: "ok" as const, value: { ...restored.value, receipt: receipt(input.commandId, requestDigest, restored.committedAt) } };
        }
        if (existing.state === "failed") return { kind: "rejected" as const };
        const now = this.now();
        const verification = await this.dependencies.repository.loadVerificationForUpdate(transaction, {
          siteRef: input.workload.siteRef, transactionRef: input.transactionRef,
        });
        if (!validVerification(verification, now) || !safeDigestEqual(
          verification.secretDigest,
          this.safeVerificationDigest(input.transactionSecret),
        )) {
          if (verification?.state === "pending") {
            await this.dependencies.repository.recordVerificationFailure(transaction, {
              siteRef: input.workload.siteRef, transactionRef: input.transactionRef, now,
            });
          }
          await this.failure(transaction, identity, "AUTH_TRANSACTION_INVALID");
          return { kind: "rejected" as const };
        }
        const accountRef = verification.accountRef;
        const subjectRef = verification.subjectRef;
        const workspaceRef = this.reference();
        const billingAccountRef = this.reference();
        const projectRef = this.reference();
        const executionSpaceRef = this.reference();
        const executionNamespace = this.reference();
        const namespaceIntentRef = this.reference();
        const namespaceEventId = this.reference();
        await this.dependencies.personalBootstrapAuthorization.execute(
          transaction,
          { siteRef: input.workload.siteRef, correlationId: input.context.correlationId },
          async () => {
            const payload = json({
              kind: "identity_namespace_allocation_v1", siteRef: input.workload.siteRef,
              subjectRef, workspaceRef, projectRef, executionSpaceRef, executionNamespace,
              namespaceIntentRef,
            });
            await this.dependencies.outbox.enqueue(transaction, {
              eventId: namespaceEventId, owner: "identity",
              eventType: "identity.namespace.allocation.requested",
              aggregateId: executionSpaceRef, payload,
              payloadDigest: this.dependencies.auditDigest(payload),
              correlationId: input.context.correlationId, causationId: input.commandId,
            });
            return this.dependencies.repository.activateVerification(transaction, {
              siteRef: input.workload.siteRef, transactionRef: input.transactionRef,
              accountRef, subjectRef, now, displayName: "New user", workspaceRef,
              billingAccountRef, projectRef, executionSpaceRef, executionNamespace,
              namespaceIntentRef, namespaceEventId,
            });
          },
        );
        const value = Object.freeze({ accountRef });
        await this.success(transaction, identity, { value, committedAt: now });
        return { kind: "ok" as const, value: { ...value, receipt: receipt(input.commandId, requestDigest, now) } };
      },
    );
    if (outcome.kind === "rejected") throw new IdentityApplicationError("AUTH_TRANSACTION_INVALID");
    return outcome.value;
  }

  async createIdentitySession(input: Readonly<{
    workload: ProductWorkloadIdentity; context: VerifiedRequestSecurityContext;
    commandId: string; idempotencyKey: string;
    receiptRecoveryCapability: string;
  } & (
    | Readonly<{ email: string; password: string; returnIntentRef?: string }>
    | Readonly<{ recoveryAction: "supersede_session_delivery"; priorCommandId: string }>
  )>) {
    const recovery = "recoveryAction" in input;
    const emailNormalized = recovery ? null : normalizeIdentityEmail(input.email);
    const passwordNormalized = recovery ? null : normalizePassword(input.password);
    const requestDigest = this.dependencies.auditDigest(recovery
      ? { operation: "createIdentitySession", siteRef: input.workload.siteRef,
          recoveryAction: input.recoveryAction, priorCommandId: input.priorCommandId }
      : { operation: "createIdentitySession", siteRef: input.workload.siteRef,
          email: emailNormalized, password: passwordNormalized,
          returnIntentRef: input.returnIntentRef ?? null });
    const passwordCandidate = recovery ? null : await this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "createIdentitySession" },
      (transaction) => this.dependencies.repository.findAccountPassword(transaction, {
        siteRef: input.workload.siteRef,
        emailNormalized: emailNormalized ?? "",
      }),
    );
    const passwordValid = recovery ? null : await this.dependencies.passwordHasher.verify(
      passwordNormalized ?? "",
      passwordCandidate === null ? this.dependencies.dummyPasswordHash : {
        passwordHash: passwordCandidate.passwordHash,
        pepperVersion: passwordCandidate.pepperVersion,
      },
    );
    const outcome = await this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "createIdentitySession" },
      async (transaction) => {
        const identity = commandIdentity(input, "createIdentitySession", requestDigest);
        const existing = await this.dependencies.receipts.begin(transaction, identity);
        assertSameCommand(existing, input.commandId);
        if (existing.state === "succeeded") {
          const pending = authenticationPendingResult(existing.result);
          if (pending !== null) {
            return {
              kind: "pending" as const,
              response: Object.freeze({
                receipt: receipt(input.commandId, requestDigest, pending.committedAt),
                pending: pending.pending,
              }),
            };
          }
          return { kind: "retry" as const };
        }
        if (existing.state === "failed") return { kind: "rejected" as const };
        const now = this.now();
        const sessionExpiresAt = plus(now, 12 * 60 * 60_000);
        const refreshExpiresAt = plus(now, 30 * 24 * 60 * 60_000);
        const retainUntil = plus(sessionExpiresAt, 5 * 60_000);
        let account: Readonly<{ accountRef: string; subjectRef: string }>;
        let authenticationMethods: readonly ("password" | "totp" | "recovery_code")[];
        if (recovery) {
          const recoveryResult: {
            value: Awaited<ReturnType<IdentityRepository["consumeIdentitySessionDeliveryRecovery"]>>;
          } = { value: null };
          await this.dependencies.sessionAuthorization.execute(
            transaction,
            { siteRef: input.workload.siteRef, correlationId: input.context.correlationId },
            async () => {
              recoveryResult.value = await this.dependencies.repository.consumeIdentitySessionDeliveryRecovery(transaction, {
                priorCommandId: input.priorCommandId, newCommandId: input.commandId,
                siteRef: input.workload.siteRef,
                siteReleaseRef: input.workload.siteReleaseRef,
                siteProjectBindingRef: input.workload.siteProjectBindingRef,
                workloadIdentityId: input.workload.workloadIdentityId,
                bindingEpoch: input.workload.bindingEpoch, purpose: "createIdentitySession",
                transactionRef: null,
                capabilityDigest: this.recoveryDigest(
                  "createIdentitySession", input.receiptRecoveryCapability, input.workload,
                ),
                now, retainUntil,
              });
              if (recoveryResult.value === null) throw new IdentityApplicationError("AUTHENTICATION_FAILED");
              return recoveryResult.value.revoked;
            },
          );
          const recovered = recoveryResult.value;
          if (recovered === null) throw new IdentityApplicationError("AUTHENTICATION_FAILED");
          account = recovered;
          authenticationMethods = recovered.authenticationMethods;
        } else {
          if (emailNormalized === null || passwordNormalized === null) {
            throw new Error("IDENTITY_LOGIN_INPUT_INVARIANT");
          }
          await this.bindRecovery(transaction, input, "createIdentitySession", null);
          const current = await this.dependencies.repository.findAccountPassword(transaction, {
            siteRef: input.workload.siteRef, emailNormalized,
          });
          if (passwordValid !== true || passwordCandidate === null || current === null ||
              !samePasswordAccount(passwordCandidate, current)) {
            if (passwordValid === false && passwordCandidate !== null && current !== null &&
                samePasswordAccount(passwordCandidate, current)) {
              await this.dependencies.repository.recordIdentityPasswordFailure(transaction, {
                siteRef: input.workload.siteRef, accountRef: current.accountRef,
                subjectRef: current.subjectRef, passwordCredentialEpoch: current.credentialEpoch, now,
              });
            }
            await this.failure(transaction, identity, "AUTHENTICATION_FAILED");
            return { kind: "rejected" as const };
          }
          account = current;
          const authentication = await this.dependencies.repository.beginIdentityAuthentication(transaction, {
            siteRef: input.workload.siteRef, accountRef: current.accountRef, subjectRef: current.subjectRef,
            passwordCredentialEpoch: current.credentialEpoch, transactionRef: this.reference(),
            initiatingCommandId: input.commandId, requestDigest, now, expiresAt: plus(now, 5 * 60_000),
          });
          if (authentication.kind === "locked" || authentication.kind === "capacity_exceeded") {
            await this.failure(transaction, identity, "AUTHENTICATION_FAILED");
            return { kind: "rejected" as const };
          }
          if (authentication.kind === "pending") {
            const pending = Object.freeze({
              transactionRef: authentication.transactionRef,
              challengeKind: authentication.challengeKind,
              expiresAt: authentication.expiresAt,
            });
            await this.success(transaction, identity, {
              kind: "auth_pending", pending, committedAt: now,
            });
            return {
              kind: "pending" as const,
              response: Object.freeze({ receipt: receipt(input.commandId, requestDigest, now), pending }),
            };
          }
          authenticationMethods = Object.freeze(["password"] as const);
        }
        const sessionRef = this.reference();
        const familyRef = this.reference();
        const sessionCredential = this.dependencies.sessionCredentials.issue();
        const refreshCredential = this.dependencies.refreshCredentials.issue();
        await this.dependencies.sessionAuthorization.execute(
          transaction,
          { siteRef: input.workload.siteRef, correlationId: input.context.correlationId },
          () => this.dependencies.repository.createIdentitySession(transaction, {
            commandId: input.commandId, requestDigest, siteRef: input.workload.siteRef,
            accountRef: account.accountRef, subjectRef: account.subjectRef,
            sessionRef, familyRef, sessionCredentialDigest: sessionCredential.digest,
            refreshCredentialDigest: refreshCredential.digest, authenticatedAt: now,
            sessionExpiresAt, refreshExpiresAt, retainUntil, deviceLabel: "Web session",
            authenticationMethods,
          }),
        );
        await this.success(transaction, identity, {
          sessionRef, sessionExpiresAt, refreshExpiresAt, committedAt: now,
        });
        return {
          kind: "fresh" as const,
          credentials: Object.freeze({
            sessionRef, sessionCredential: sessionCredential.credential,
            sessionCredentialExpiresAt: sessionExpiresAt,
            refreshCredential: refreshCredential.credential,
            refreshCredentialExpiresAt: refreshExpiresAt,
          }),
        };
      },
    );
    if (outcome.kind === "rejected") throw new IdentityApplicationError("AUTHENTICATION_FAILED");
    if (outcome.kind === "pending") return outcome.response;
    if (outcome.kind === "retry") {
      return Object.freeze({
        kind: "delivery_unavailable" as const, commandId: input.commandId,
        receiptRef: `command:${input.commandId}`, requestDigest,
      });
    }
    return Object.freeze({ commandId: input.commandId, requestDigest, credentials: outcome.credentials });
  }

  async completeSessionMfa(input: Readonly<{
    workload: ProductWorkloadIdentity; context: VerifiedRequestSecurityContext;
    commandId: string; idempotencyKey: string; receiptRecoveryCapability: string;
    transactionRef: string;
  } & (
    | Readonly<{ code: string }>
    | Readonly<{ recoveryAction: "supersede_session_delivery"; priorCommandId: string }>
  )>) {
    const recovery = "recoveryAction" in input;
    const code = recovery ? null : input.code.normalize("NFC");
    const requestDigest = this.dependencies.auditDigest(recovery
      ? { operation: "completeSessionMfa", siteRef: input.workload.siteRef,
          transactionRef: input.transactionRef, recoveryAction: input.recoveryAction,
          priorCommandId: input.priorCommandId }
      : { operation: "completeSessionMfa", siteRef: input.workload.siteRef,
          transactionRef: input.transactionRef, code });
    let proof: Readonly<
      | { kind: "totp"; timeStep: number }
      | { kind: "recovery_code"; codeDigest: string }
      | { kind: "invalid" }
    > = Object.freeze({ kind: "invalid" as const });
    if (!recovery) {
      const material = await this.dependencies.unitOfWork.execute(
        { context: input.context, operation: "completeSessionMfa" },
        (transaction) => this.dependencies.repository.loadIdentityAuthenticationMaterial(transaction, {
          siteRef: input.workload.siteRef, transactionRef: input.transactionRef, now: this.now(),
        }),
      );
      let secret = this.dependencies.dummyTotpSecret;
      let totpUsable = false;
      if (material?.authenticator !== null && material?.authenticator !== undefined) {
        try {
          secret = this.dependencies.totpSecretProtector.unseal(material.authenticator.envelope, {
            siteRef: input.workload.siteRef, accountRef: material.accountRef,
            subjectRef: material.subjectRef, authenticatorRef: material.authenticator.authenticatorRef,
          });
          totpUsable = true;
        } catch {
          totpUsable = false;
        }
      }
      const totp = await this.dependencies.totpVerifier.verify({
        secret, code: code ?? "", epochSeconds: Math.floor(Date.parse(this.now()) / 1_000),
        afterTimeStep: material?.authenticator?.lastAcceptedTimeStep ?? null,
      });
      const recoveryDigest = digestIdentityRecoveryCode(this.dependencies.auditDigest, {
        siteRef: input.workload.siteRef,
        accountRef: material?.accountRef ?? "unknown-account",
        recoverySetRef: material?.recoverySetRef ?? "unknown-recovery-set",
        code: code ?? "",
      });
      const recoveryMatched = constantTimeRecoveryCodeMatch(
        recoveryDigest,
        material?.recoveryCodeDigests ?? Object.freeze([]),
      ) && material?.recoverySetRef !== null && material?.recoverySetRef !== undefined;
      if (totpUsable && totp.valid) {
        proof = Object.freeze({ kind: "totp" as const, timeStep: totp.timeStep });
      } else if (recoveryMatched) {
        proof = Object.freeze({ kind: "recovery_code" as const, codeDigest: recoveryDigest });
      }
    }

    const outcome = await this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "completeSessionMfa" },
      async (transaction) => {
        const identity = commandIdentity(input, "completeSessionMfa", requestDigest);
        const existing = await this.dependencies.receipts.begin(transaction, identity);
        assertSameCommand(existing, input.commandId);
        if (existing.state === "succeeded") return { kind: "retry" as const };
        if (existing.state === "failed") return { kind: "rejected" as const };
        const now = this.now();
        const sessionExpiresAt = plus(now, 12 * 60 * 60_000);
        const refreshExpiresAt = plus(now, 30 * 24 * 60 * 60_000);
        const retainUntil = plus(sessionExpiresAt, 5 * 60_000);
        let account: Readonly<{ accountRef: string; subjectRef: string }>;
        let authenticationMethods: readonly ("password" | "totp" | "recovery_code")[];
        if (recovery) {
          const recoveryResult: {
            value: Awaited<ReturnType<IdentityRepository["consumeIdentitySessionDeliveryRecovery"]>>;
          } = { value: null };
          await this.dependencies.sessionAuthorization.execute(
            transaction,
            { siteRef: input.workload.siteRef, correlationId: input.context.correlationId },
            async () => {
              recoveryResult.value = await this.dependencies.repository.consumeIdentitySessionDeliveryRecovery(transaction, {
                priorCommandId: input.priorCommandId, newCommandId: input.commandId,
                siteRef: input.workload.siteRef, siteReleaseRef: input.workload.siteReleaseRef,
                siteProjectBindingRef: input.workload.siteProjectBindingRef,
                workloadIdentityId: input.workload.workloadIdentityId, bindingEpoch: input.workload.bindingEpoch,
                purpose: "completeSessionMfa", transactionRef: input.transactionRef,
                capabilityDigest: this.recoveryDigest(
                  "completeSessionMfa", input.receiptRecoveryCapability, input.workload,
                ),
                now, retainUntil,
              });
              if (recoveryResult.value === null) throw new IdentityApplicationError("AUTHENTICATION_FAILED");
              return recoveryResult.value.revoked;
            },
          );
          const recovered = recoveryResult.value;
          if (recovered === null) throw new IdentityApplicationError("AUTHENTICATION_FAILED");
          account = recovered;
          authenticationMethods = recovered.authenticationMethods;
        } else {
          await this.bindRecovery(transaction, input, "completeSessionMfa", input.transactionRef);
          const accepted = await this.dependencies.repository.consumeIdentityAuthentication(transaction, {
            siteRef: input.workload.siteRef, transactionRef: input.transactionRef, now, proof,
          });
          if (accepted.kind === "rejected") {
            await this.failure(transaction, identity, "AUTHENTICATION_FAILED");
            return { kind: "rejected" as const };
          }
          account = accepted;
          authenticationMethods = Object.freeze(["password", accepted.authenticationMethod]);
        }
        const sessionRef = this.reference();
        const familyRef = this.reference();
        const sessionCredential = this.dependencies.sessionCredentials.issue();
        const refreshCredential = this.dependencies.refreshCredentials.issue();
        await this.dependencies.sessionAuthorization.execute(
          transaction,
          { siteRef: input.workload.siteRef, correlationId: input.context.correlationId },
          () => this.dependencies.repository.createIdentitySession(transaction, {
            commandId: input.commandId, requestDigest, siteRef: input.workload.siteRef,
            accountRef: account.accountRef, subjectRef: account.subjectRef, sessionRef, familyRef,
            sessionCredentialDigest: sessionCredential.digest,
            refreshCredentialDigest: refreshCredential.digest, authenticatedAt: now,
            sessionExpiresAt, refreshExpiresAt, retainUntil, deviceLabel: "Web session",
            authenticationMethods,
          }),
        );
        await this.success(transaction, identity, {
          sessionRef, sessionExpiresAt, refreshExpiresAt, committedAt: now,
        });
        return oneTimeCredentials({
          sessionRef, sessionCredential: sessionCredential.credential, sessionExpiresAt,
          refreshCredential: refreshCredential.credential, refreshExpiresAt,
        });
      },
    );
    if (outcome.kind === "rejected") throw new IdentityApplicationError("AUTHENTICATION_FAILED");
    if (outcome.kind === "retry") {
      return Object.freeze({
        kind: "delivery_unavailable" as const, commandId: input.commandId,
        receiptRef: `command:${input.commandId}`, requestDigest,
      });
    }
    return Object.freeze({ commandId: input.commandId, requestDigest, credentials: outcome.credentials });
  }

  async refreshIdentitySession(input: Readonly<{
    workload: ProductWorkloadIdentity; context: VerifiedRequestSecurityContext;
    commandId: string; idempotencyKey: string; receiptRecoveryCapability: string;
  } & (
    | Readonly<{ opaqueCredential: string }>
    | Readonly<{ recoveryAction: "supersede_refresh_delivery"; priorCommandId: string }>
  )>) {
    const recovery = "recoveryAction" in input;
    const requestDigest = this.dependencies.auditDigest(recovery
      ? { operation: "refreshIdentitySession", siteRef: input.workload.siteRef,
          recoveryAction: input.recoveryAction, priorCommandId: input.priorCommandId }
      : { operation: "refreshIdentitySession", siteRef: input.workload.siteRef,
          refreshCredential: input.opaqueCredential });
    const outcome = await this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "refreshIdentitySession" },
      async (transaction) => {
        const identity = commandIdentity(input, "refreshIdentitySession", requestDigest);
        const existing = await this.dependencies.receipts.begin(transaction, identity);
        assertSameCommand(existing, input.commandId);
        if (existing.state === "succeeded") return { kind: "retry" as const };
        if (existing.state === "failed") return { kind: "rejected" as const };
        const now = this.now();
        const proposedSessionExpiresAt = plus(now, 12 * 60 * 60_000);
        if (recovery) {
          const sessionCredential = this.dependencies.sessionCredentials.issue();
          const refreshCredential = this.dependencies.refreshCredentials.issue();
          const recoveryResult: {
            value: Awaited<ReturnType<IdentityRepository["supersedeIdentityRefreshDelivery"]>>;
          } = { value: null };
          await this.dependencies.sessionAuthorization.execute(
            transaction,
            { siteRef: input.workload.siteRef, correlationId: input.context.correlationId },
            async () => {
              recoveryResult.value = await this.dependencies.repository.supersedeIdentityRefreshDelivery(transaction, {
                priorCommandId: input.priorCommandId, newCommandId: input.commandId, requestDigest,
                siteRef: input.workload.siteRef, siteReleaseRef: input.workload.siteReleaseRef,
                siteProjectBindingRef: input.workload.siteProjectBindingRef,
                workloadIdentityId: input.workload.workloadIdentityId, bindingEpoch: input.workload.bindingEpoch,
                purpose: "refreshIdentitySession",
                capabilityDigest: this.recoveryDigest(
                  "refreshIdentitySession", input.receiptRecoveryCapability, input.workload,
                ),
                sessionCredentialDigest: sessionCredential.digest,
                refreshCredentialDigest: refreshCredential.digest, now,
                sessionExpiresAt: proposedSessionExpiresAt,
                retainUntil: plus(proposedSessionExpiresAt, 5 * 60_000),
              });
              if (recoveryResult.value === null) throw new IdentityApplicationError("AUTHENTICATION_FAILED");
              return recoveryResult.value.current;
            },
          );
          const recovered = recoveryResult.value;
          if (recovered === null) throw new IdentityApplicationError("AUTHENTICATION_FAILED");
          await this.success(transaction, identity, {
            sessionRef: recovered.sessionRef, sessionExpiresAt: recovered.current.expiresAt,
            refreshExpiresAt: recovered.refreshExpiresAt, committedAt: now,
          });
          return oneTimeCredentials({
            sessionRef: recovered.sessionRef, sessionCredential: sessionCredential.credential,
            sessionExpiresAt: recovered.current.expiresAt,
            refreshCredential: refreshCredential.credential,
            refreshExpiresAt: recovered.refreshExpiresAt,
          });
        }

        await this.bindRecovery(transaction, input, "refreshIdentitySession", null);
        const credential = await this.dependencies.repository.loadIdentityRefreshCredential(transaction, {
          siteRef: input.workload.siteRef,
          credentialDigest: this.safeRefreshDigest(input.opaqueCredential),
        });
        if (credential === null || credential.familyState !== "active" || credential.sessionState !== "active" ||
            Date.parse(credential.credentialExpiresAt) <= Date.parse(now) ||
            Date.parse(credential.absoluteExpiresAt) <= Date.parse(now)) {
          await this.failure(transaction, identity, "AUTHENTICATION_FAILED");
          return { kind: "rejected" as const };
        }
        const sessionExpiresAt = earlier(proposedSessionExpiresAt, credential.absoluteExpiresAt);
        const retainUntil = plus(sessionExpiresAt, 5 * 60_000);
        if (credential.credentialState !== "active" || credential.generation !== credential.currentGeneration) {
          await this.dependencies.sessionAuthorization.execute(
            transaction,
            { siteRef: input.workload.siteRef, correlationId: input.context.correlationId },
            () => this.dependencies.repository.revokeIdentityRefreshFamilyForReplay(transaction, {
              siteRef: input.workload.siteRef, subjectRef: credential.subjectRef,
              sessionRef: credential.sessionRef, familyRef: credential.familyRef,
              expectedCurrentGeneration: credential.currentGeneration, now, retainUntil,
            }),
          );
          await this.failure(transaction, identity, "AUTHENTICATION_FAILED");
          return { kind: "rejected" as const };
        }
        const sessionCredential = this.dependencies.sessionCredentials.issue();
        const refreshCredential = this.dependencies.refreshCredentials.issue();
        await this.dependencies.sessionAuthorization.execute(
          transaction,
          { siteRef: input.workload.siteRef, correlationId: input.context.correlationId },
          () => this.dependencies.repository.rotateIdentityRefreshCredential(transaction, {
            commandId: input.commandId, requestDigest, siteRef: input.workload.siteRef,
            subjectRef: credential.subjectRef, sessionRef: credential.sessionRef,
            familyRef: credential.familyRef, expectedGeneration: credential.currentGeneration,
            newGeneration: credential.currentGeneration + 1,
            sessionCredentialDigest: sessionCredential.digest,
            refreshCredentialDigest: refreshCredential.digest, now, sessionExpiresAt,
            refreshExpiresAt: credential.absoluteExpiresAt, retainUntil,
          }),
        );
        await this.success(transaction, identity, {
          sessionRef: credential.sessionRef, sessionExpiresAt,
          refreshExpiresAt: credential.absoluteExpiresAt, committedAt: now,
        });
        return oneTimeCredentials({
          sessionRef: credential.sessionRef, sessionCredential: sessionCredential.credential,
          sessionExpiresAt, refreshCredential: refreshCredential.credential,
          refreshExpiresAt: credential.absoluteExpiresAt,
        });
      },
    );
    if (outcome.kind === "rejected") throw new IdentityApplicationError("AUTHENTICATION_FAILED");
    if (outcome.kind === "retry") {
      return Object.freeze({
        kind: "delivery_unavailable" as const, commandId: input.commandId,
        receiptRef: `command:${input.commandId}`, requestDigest,
      });
    }
    return Object.freeze({ commandId: input.commandId, requestDigest, credentials: outcome.credentials });
  }

  async listIdentitySessions(input: Readonly<{
    workload: ProductWorkloadIdentity; context: VerifiedRequestSecurityContext; session: AuthenticatedUserSession;
  }>): Promise<Readonly<{ revision: string; sessions: readonly IdentitySessionSafeFact[] }>> {
    return this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "listIdentitySessions" },
      async (transaction) => {
        const sessions = await this.dependencies.repository.listIdentitySessions(transaction, {
          siteRef: input.workload.siteRef, subjectRef: input.session.subjectRef,
          currentSessionRef: input.session.identitySessionRef, now: this.now(),
        });
        return Object.freeze({
          revision: this.dependencies.auditDigest(json({
            siteRef: input.workload.siteRef, subjectRef: input.session.subjectRef, sessions,
          })),
          sessions,
        });
      },
    );
  }

  async revokeIdentitySessions(input: Readonly<{
    workload: ProductWorkloadIdentity; context: VerifiedRequestSecurityContext; session: AuthenticatedUserSession;
    commandId: string; idempotencyKey: string;
    target: "current" | "single" | "others" | "all"; sessionRef?: string;
  }>) {
    if (input.target === "single" && input.sessionRef === undefined) throw new IdentityApplicationError("AUTH_TRANSACTION_INVALID");
    if (input.target !== "single" && input.sessionRef !== undefined) throw new IdentityApplicationError("AUTH_TRANSACTION_INVALID");
    const requestDigest = this.dependencies.auditDigest({
      operation: "revokeIdentitySessions", siteRef: input.workload.siteRef,
      subjectRef: input.session.subjectRef, target: input.target, sessionRef: input.sessionRef ?? null,
    });
    return this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "revokeIdentitySessions" },
      async (transaction) => {
        const identity = commandIdentity(input, "revokeIdentitySessions", requestDigest);
        const existing = await this.dependencies.receipts.begin(transaction, identity);
        assertSameCommand(existing, input.commandId);
        if (existing.state === "succeeded" && existing.result !== null) {
          const restored = committedResult(existing.result);
          return { receipt: receipt(input.commandId, requestDigest, restored.committedAt) };
        }
        const now = this.now();
        const retainUntil = plus(now, 12 * 60 * 60_000 + 5 * 60_000);
        const targets = await this.dependencies.repository.selectSessionsForRevocation(transaction, {
          siteRef: input.workload.siteRef, subjectRef: input.session.subjectRef,
          currentSessionRef: input.session.identitySessionRef,
          target: input.target, sessionRef: input.sessionRef ?? null,
        });
        for (const sessionRef of targets) {
          await this.dependencies.sessionAuthorization.execute(
            transaction,
            { siteRef: input.workload.siteRef, correlationId: input.context.correlationId },
            () => this.dependencies.repository.revokeExactIdentitySession(transaction, {
              siteRef: input.workload.siteRef, subjectRef: input.session.subjectRef,
              sessionRef, now, retainUntil, reason: `user_${input.target}`,
            }),
          );
        }
        await this.success(transaction, identity, { committedAt: now });
        return { receipt: receipt(input.commandId, requestDigest, now) };
      },
    );
  }

  private now(): string {
    const clock = this.dependencies.clock ?? (() => new Date());
    return new Date(Math.floor(clock().getTime() / 1_000) * 1_000).toISOString();
  }

  private reference(): string {
    const reference = this.dependencies.reference?.();
    if (reference === undefined) throw new Error("IDENTITY_REFERENCE_FACTORY_REQUIRED");
    return reference;
  }

  private async success(transaction: PlatformTransaction, identity: CommandIdentity, result: JsonValue): Promise<void> {
    await this.dependencies.receipts.recordOutcome(transaction, identity, {
      state: "succeeded", result, resultDigest: this.dependencies.auditDigest(result),
    });
  }

  private async failure(transaction: PlatformTransaction, identity: CommandIdentity, code: string): Promise<void> {
    const result = json({ code });
    await this.dependencies.receipts.recordOutcome(transaction, identity, {
      state: "failed", result, resultDigest: this.dependencies.auditDigest(result),
    });
  }

  private async bindRecovery(
    transaction: PlatformTransaction,
    input: Readonly<{ commandId: string; workload: ProductWorkloadIdentity; receiptRecoveryCapability: string }>,
    purpose: string,
    transactionRef: string | null,
  ): Promise<void> {
    assertRecoveryCapability(input.receiptRecoveryCapability);
    const now = this.now();
    await this.dependencies.repository.bindReceiptRecoveryCapability(transaction, {
      commandId: input.commandId, siteRef: input.workload.siteRef,
      siteReleaseRef: input.workload.siteReleaseRef,
      siteProjectBindingRef: input.workload.siteProjectBindingRef,
      workloadIdentityId: input.workload.workloadIdentityId,
      bindingEpoch: input.workload.bindingEpoch, purpose, transactionRef,
      capabilityDigest: this.recoveryDigest(purpose, input.receiptRecoveryCapability, input.workload),
      expiresAt: plus(now, 24 * 60 * 60_000), now,
    });
  }

  private recoveryDigest(
    purpose: string,
    capability: string,
    authority: Pick<ProductWorkloadIdentity,
      "siteRef" | "siteReleaseRef" | "siteProjectBindingRef" | "workloadIdentityId" | "bindingEpoch">,
  ): string {
    return digestIdentityReceiptRecoveryCapability(
      this.dependencies.auditDigest,
      purpose,
      capability,
      authority,
    );
  }

  private safeVerificationDigest(secret: string): string {
    try { return this.dependencies.verificationCredentials.digest(secret); }
    catch { return "0".repeat(64); }
  }

  private safeRefreshDigest(credential: string): string {
    try { return this.dependencies.refreshCredentials.digest(credential); }
    catch { return "0".repeat(64); }
  }
}

function commandIdentity(
  input: Readonly<{ commandId: string; idempotencyKey: string; workload: ProductWorkloadIdentity }>,
  operation: string,
  requestDigest: string,
): CommandIdentity {
  return Object.freeze({
    commandId: input.commandId, environment: input.workload.environment, region: input.workload.region,
    callerIdentity: input.workload.workloadIdentityId, operation,
    idempotencyKey: input.idempotencyKey, requestDigest,
  });
}

function receipt(commandId: string, requestDigest: string, committedAt: string): IdentityCommandReceipt {
  return Object.freeze({ commandId, requestDigest, committedAt, receiptRef: `command:${commandId}`, state: "committed" });
}

function assertSameCommand(existing: CommandReceipt, commandId: string): void {
  if (existing.commandId !== commandId) throw new Error("COMMAND_IDENTITY_CONFLICT");
}

function canonicalLegalRefs(values: readonly string[]): readonly string[] {
  if (values.length < 1 || values.length > 16 || values.some((value) => value.length < 1 || value.length > 128)) {
    throw new IdentityApplicationError("AUTH_TRANSACTION_INVALID");
  }
  const canonical = [...new Set(values)].sort();
  if (canonical.length !== values.length) throw new IdentityApplicationError("AUTH_TRANSACTION_INVALID");
  return Object.freeze(canonical);
}

function normalizePassword(password: string): string {
  const normalized = password.normalize("NFC");
  const codePoints = [...normalized].length;
  if (codePoints < 15 || codePoints > 1024) throw new IdentityApplicationError("AUTH_TRANSACTION_INVALID");
  return normalized;
}

function assertRecoveryCapability(value: string): void {
  if (value.length < 32 || value.length > 2048 || value.trim() !== value || /\s/u.test(value)) {
    throw new IdentityApplicationError("AUTH_TRANSACTION_INVALID");
  }
}

function plus(instant: string, milliseconds: number): string {
  return new Date(Date.parse(instant) + milliseconds).toISOString();
}

function earlier(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function oneTimeCredentials(input: Readonly<{
  sessionRef: string; sessionCredential: string; sessionExpiresAt: string;
  refreshCredential: string; refreshExpiresAt: string;
}>) {
  return Object.freeze({
    kind: "fresh" as const,
    credentials: Object.freeze({
      sessionRef: input.sessionRef, sessionCredential: input.sessionCredential,
      sessionCredentialExpiresAt: input.sessionExpiresAt,
      refreshCredential: input.refreshCredential,
      refreshCredentialExpiresAt: input.refreshExpiresAt,
    }),
  });
}

function validVerification(value: VerificationRecord | null, now: string): value is VerificationRecord {
  return value !== null && value.state === "pending" && value.attemptCount < value.maxAttempts && Date.parse(value.expiresAt) > Date.parse(now);
}

function safeDigestEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "ascii");
  const b = Buffer.from(right, "ascii");
  return a.length === b.length && timingSafeEqual(a, b);
}

function constantTimeRecoveryCodeMatch(candidate: string, stored: readonly string[]): boolean {
  let matched = 0;
  for (let index = 0; index < 10; index += 1) {
    const digest = stored[index] ?? "0".repeat(64);
    matched |= safeDigestEqual(candidate, digest) ? 1 : 0;
  }
  return matched === 1;
}

function samePasswordAccount(left: Readonly<{
  accountRef: string; subjectRef: string; passwordHash: string; pepperVersion: number; credentialEpoch: string;
}>, right: Readonly<{
  accountRef: string; subjectRef: string; passwordHash: string; pepperVersion: number; credentialEpoch: string;
}>): boolean {
  return left.accountRef === right.accountRef && left.subjectRef === right.subjectRef &&
    left.passwordHash === right.passwordHash && left.pepperVersion === right.pepperVersion &&
    left.credentialEpoch === right.credentialEpoch;
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function object(value: JsonValue): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("IDENTITY_RECEIPT_RESULT_INVALID");
  return value;
}

function string(value: JsonValue | undefined): string {
  if (typeof value !== "string") throw new Error("IDENTITY_RECEIPT_RESULT_INVALID");
  return value;
}

function verificationResult(value: JsonValue) {
  const root = object(value);
  const transaction = object(root.transaction!);
  const deliveryState = string(transaction.deliveryState);
  if (!(["queued", "sent", "rate_limited"] as const).includes(deliveryState as never)) {
    throw new Error("IDENTITY_RECEIPT_RESULT_INVALID");
  }
  return Object.freeze({
    committedAt: string(root.committedAt),
    transaction: Object.freeze({
      transactionRef: string(transaction.transactionRef), expiresAt: string(transaction.expiresAt),
      deliveryState: deliveryState as "queued" | "sent" | "rate_limited",
    }),
  });
}

function activationResult(value: JsonValue) {
  const root = object(value);
  const result = object(root.value!);
  return Object.freeze({
    committedAt: string(root.committedAt),
    value: Object.freeze({ accountRef: string(result.accountRef) }),
  });
}

function committedResult(value: JsonValue) {
  const root = object(value);
  return Object.freeze({ committedAt: string(root.committedAt) });
}

function authenticationPendingResult(value: JsonValue | null) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value.kind !== "auth_pending") {
    return null;
  }
  const root = object(value);
  const pending = object(root.pending!);
  const challengeKind = string(pending.challengeKind);
  if (challengeKind !== "totp" && challengeKind !== "recovery") {
    throw new Error("IDENTITY_RECEIPT_RESULT_INVALID");
  }
  return Object.freeze({
    committedAt: string(root.committedAt),
    pending: Object.freeze({
      transactionRef: string(pending.transactionRef),
      challengeKind,
      expiresAt: string(pending.expiresAt),
    }),
  });
}
