import { timingSafeEqual } from "node:crypto";
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
  IdentityReauthenticationChallengeMaterial,
  IdentityReauthenticationTarget,
  IdentitySecurityManagementRepository,
  IdentitySecuritySessionBinding,
} from "../contracts/identity-security-management-repository.js";
import { IdentitySecurityAtomicRejection } from "../contracts/identity-security-management-repository.js";
import type {
  IdentityAuditDigesterPort,
  IdentityPasswordHash,
  IdentityPasswordHasherPort,
  IdentityRecoveryCodeIssuerPort,
  IdentityTotpEnrollmentIssuerPort,
  IdentityTotpSecretProtectorPort,
  IdentityTotpVerifierPort,
  OpaqueCredentialPort,
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
      passwordHasher: IdentityPasswordHasherPort;
      dummyPasswordHash: IdentityPasswordHash;
      reauthenticationCredentials: OpaqueCredentialPort;
      dummyTotpSecret: string;
      auditDigest: IdentityAuditDigesterPort;
      clock?: () => Date;
      reference?: () => string;
    }>,
  ) {}

  async reauthenticateIdentitySession(
    input: Readonly<{
      workload: ProductWorkloadIdentity;
      context: VerifiedRequestSecurityContext;
      session: AuthenticatedUserSession;
      commandId: string;
      idempotencyKey: string;
      receiptRecoveryCapability: string;
    } & (
      | Readonly<{
          stage: "password";
          password: string;
          target: Readonly<{
            audience: "platform-public";
            operationId: IdentityReauthenticationTarget["operationId"];
            resource: Readonly<{ kind: "identity_account" }>;
          }>;
        }>
      | Readonly<{
          stage: "mfa";
          challengeKind: "totp" | "recovery";
          proofCode: string;
          transactionRef: string;
          target: Readonly<{
            audience: "platform-public";
            operationId: IdentityReauthenticationTarget["operationId"];
            resource: Readonly<{ kind: "identity_account" }>;
          }>;
        }>
      | Readonly<{ stage: "supersede"; priorCommandId: string }>
    )>,
  ) {
    const supersede = input.stage === "supersede";
    const passwordStage = input.stage === "password";
    const mfaStage = input.stage === "mfa";
    const target = supersede ? null : canonicalTarget(input.target);
    const password = passwordStage ? normalizePassword(input.password) : null;
    const proofCode = mfaStage ? normalizeProofCode(input.proofCode) : null;
    const requestDigest = this.dependencies.auditDigest(
      supersede
        ? { operation: "reauthenticateIdentitySession", siteRef: input.workload.siteRef,
            sessionRef: input.session.identitySessionRef, stage: input.stage,
            priorCommandId: input.priorCommandId }
        : passwordStage
          ? { operation: "reauthenticateIdentitySession", siteRef: input.workload.siteRef,
              sessionRef: input.session.identitySessionRef, stage: input.stage, target, password }
          : { operation: "reauthenticateIdentitySession", siteRef: input.workload.siteRef,
              sessionRef: input.session.identitySessionRef, stage: input.stage, target,
              challengeKind: input.challengeKind, transactionRef: input.transactionRef, proofCode },
    );
    const now = this.now();
    const binding = sessionBinding(input.workload, input.session);
    const material = mfaStage ? null : await this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "reauthenticateIdentitySession" },
      (transaction) => this.dependencies.repository.loadReauthenticationMaterial(transaction, { binding, now }),
    );
    const passwordValid = passwordStage ? await this.dependencies.passwordHasher.verify(
      password ?? "", material === null ? this.dependencies.dummyPasswordHash : {
        passwordHash: material.passwordHash, pepperVersion: material.pepperVersion,
      }) : null;
    const challenge = mfaStage && target !== null ? await this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "reauthenticateIdentitySession" },
      (transaction) => this.dependencies.repository.loadReauthenticationChallengeMaterial(transaction, {
        binding, workloadIdentityId: input.workload.workloadIdentityId,
        transactionRef: input.transactionRef, target, now,
      }),
    ) : null;
    const challengeProof = await this.verifyReauthenticationChallenge(input, challenge, proofCode, now);
    const issued = this.dependencies.reauthenticationCredentials.issue();
    const expiresAt = plus(now, 5 * 60_000);
    const challengeRef = passwordStage ? this.reference() : null;
    let resolvedTarget = target;
    let policyRevision = material?.authStrengthPolicyRevision ?? challenge?.authStrengthPolicyRevision ?? "unknown";
    let accountRef = material?.accountRef ?? challenge?.accountRef ?? null;
    let accountSecurityEpoch = material?.accountSecurityEpoch ?? null;
    const outcome = await this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "reauthenticateIdentitySession" },
      async (transaction) => {
        const identity = commandIdentity(input, "reauthenticateIdentitySession", requestDigest);
        const existing = await this.dependencies.receipts.begin(transaction, identity);
        assertSameCommand(existing, input.commandId);
        if (existing.state === "succeeded") {
          const pending = reauthenticationPendingResult(existing.result);
          return pending === null
            ? Object.freeze({ kind: "retry" as const })
            : Object.freeze({ kind: "pending" as const, pending });
        }
        if (existing.state === "failed") return Object.freeze({ kind: "rejected" as const });
        if (!mfaStage && material === null) {
          await this.failure(transaction, identity, "AUTHENTICATION_FAILED");
          return Object.freeze({ kind: "rejected" as const });
        }
        let completed: Readonly<{
          accountRef: string;
          accountSecurityEpoch: string;
          target: IdentityReauthenticationTarget;
          authStrengthPolicyRevision: string;
        }> | null = null;
        if (supersede) {
          if (material === null) throw new Error("IDENTITY_REAUTHENTICATION_MATERIAL_INVARIANT");
          const recovered = await this.dependencies.repository.supersedeReauthenticationProof(transaction, {
            binding, accountRef: material.accountRef, expectedAccountSecurityEpoch: material.accountSecurityEpoch,
            priorCommandId: input.priorCommandId, newCommandId: input.commandId, requestDigest,
            workloadIdentityId: input.workload.workloadIdentityId,
            capabilityDigest: this.recoveryDigest("reauthenticateIdentitySession", input.receiptRecoveryCapability),
            proofDigest: issued.digest, now, expiresAt,
          });
          if (recovered !== null) {
            resolvedTarget = recovered.target;
            policyRevision = recovered.authStrengthPolicyRevision;
            completed = Object.freeze({ accountRef: material.accountRef,
              accountSecurityEpoch: material.accountSecurityEpoch,
              target: recovered.target, authStrengthPolicyRevision: recovered.authStrengthPolicyRevision });
          }
        } else if (passwordStage && passwordValid === true && target !== null && material !== null) {
          if (material.authenticator !== null && challengeRef !== null) {
            const pendingExpiresAt = expiresAt;
            const accepted = await this.dependencies.repository.beginReauthenticationChallenge(transaction, {
              binding, accountRef: material.accountRef,
              expectedAccountSecurityEpoch: material.accountSecurityEpoch,
              passwordCredentialEpoch: material.passwordCredentialEpoch,
              workloadIdentityId: input.workload.workloadIdentityId, commandId: input.commandId,
              requestDigest, transactionRef: challengeRef, target,
              authStrengthPolicyRevision: material.authStrengthPolicyRevision,
              authenticatorRef: material.authenticator.authenticatorRef,
              recoverySetRef: material.recoverySetRef, now, expiresAt: pendingExpiresAt,
            });
            if (!accepted) {
              await this.failure(transaction, identity, "AUTHENTICATION_FAILED");
              return Object.freeze({ kind: "rejected" as const });
            }
            const pending = Object.freeze({ transactionRef: challengeRef,
              challengeKind: "totp" as const, expiresAt: pendingExpiresAt });
            await this.securityEvent(transaction, input, {
              eventType: "identity.reauthentication.challenge_started", accountRef: material.accountRef,
              accountSecurityEpoch: material.accountSecurityEpoch, occurredAt: now, aggregateRef: challengeRef,
            });
            await this.success(transaction, identity, {
              kind: "reauthentication_pending", pending, committedAt: now,
            });
            return Object.freeze({ kind: "pending" as const,
              pending: Object.freeze({ ...pending, committedAt: now }) });
          }
          const accepted = await this.dependencies.repository.issueReauthenticationProof(transaction, {
            binding, accountRef: material.accountRef, expectedAccountSecurityEpoch: material.accountSecurityEpoch,
            passwordCredentialEpoch: material.passwordCredentialEpoch,
            workloadIdentityId: input.workload.workloadIdentityId, commandId: input.commandId, requestDigest,
            proofDigest: issued.digest, target, authStrengthPolicyRevision: material.authStrengthPolicyRevision,
            now, expiresAt,
          });
          if (accepted) {
            await this.bindRecovery(transaction, input, "reauthenticateIdentitySession", null, now);
            completed = Object.freeze({ accountRef: material.accountRef,
              accountSecurityEpoch: material.accountSecurityEpoch, target,
              authStrengthPolicyRevision: material.authStrengthPolicyRevision });
          }
        } else if (mfaStage && target !== null && challenge !== null) {
          completed = await this.dependencies.repository.completeReauthenticationChallenge(transaction, {
            binding, workloadIdentityId: input.workload.workloadIdentityId, commandId: input.commandId,
            requestDigest, transactionRef: input.transactionRef, target, proofDigest: issued.digest,
            proof: challengeProof, now, expiresAt,
          });
          if (completed !== null) {
            await this.bindRecovery(transaction, input, "reauthenticateIdentitySession", null, now);
          }
        } else if (material !== null) {
          await this.dependencies.repository.recordReauthenticationFailure(transaction, {
            binding, accountRef: material.accountRef,
            passwordCredentialEpoch: material.passwordCredentialEpoch, now,
          });
        }
        if (completed === null || resolvedTarget === null) {
          await this.failure(transaction, identity, "AUTHENTICATION_FAILED");
          return Object.freeze({ kind: "rejected" as const });
        }
        accountRef = completed.accountRef;
        accountSecurityEpoch = completed.accountSecurityEpoch;
        resolvedTarget = completed.target;
        policyRevision = completed.authStrengthPolicyRevision;
        await this.securityEvent(transaction, input, {
          eventType: supersede ? "identity.reauthentication.proof_superseded" :
            "identity.reauthentication.proof_issued",
          accountRef: completed.accountRef, accountSecurityEpoch: completed.accountSecurityEpoch,
          occurredAt: now, aggregateRef: input.commandId,
        });
        await this.success(transaction, identity, {
          kind: "reauthentication_proof", audience: resolvedTarget.audience,
          operationId: resolvedTarget.operationId, resourceKind: resolvedTarget.resourceKind,
          accountRef: completed.accountRef, accountSecurityEpoch: completed.accountSecurityEpoch,
          sessionEpoch: binding.sessionEpoch, authStrengthPolicyRevision: policyRevision,
          issuedAt: now, expiresAt, committedAt: now,
        });
        return Object.freeze({ kind: "fresh" as const });
      },
    );
    if (outcome.kind === "rejected") throw new IdentityApplicationError("AUTHENTICATION_FAILED");
    if (outcome.kind === "retry") return deliveryUnavailable(input.commandId, requestDigest);
    if (outcome.kind === "pending") return Object.freeze({
      receipt: committedReceipt(input.commandId, requestDigest, outcome.pending.committedAt),
      pending: Object.freeze({ transactionRef: outcome.pending.transactionRef,
        challengeKind: outcome.pending.challengeKind, expiresAt: outcome.pending.expiresAt }),
    });
    if (resolvedTarget === null || accountRef === null || accountSecurityEpoch === null) {
      throw new Error("IDENTITY_REAUTHENTICATION_RESULT_INVARIANT");
    }
    return Object.freeze({
      commandId: input.commandId, requestDigest,
      proof: Object.freeze({
        audience: resolvedTarget.audience, operationId: resolvedTarget.operationId,
        resourceKind: resolvedTarget.resourceKind, reauthenticationProof: issued.credential,
        authStrengthPolicyRevision: policyRevision, issuedAt: now, expiresAt,
        sessionRef: binding.sessionRef, sessionEpoch: binding.sessionEpoch,
        userSecurityEpoch: accountSecurityEpoch,
      }),
    });
  }

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
        | Readonly<{ ceremonyAction: "begin"; reauthenticationProof: string }>
        | Readonly<{
            ceremonyAction: "supersede";
            priorCommandId: string;
            priorTransactionRef: string;
          }>
      )
    >,
  ) {
    const supersede = input.ceremonyAction === "supersede";
    const reauthenticationProofDigest = supersede
      ? null
      : this.dependencies.reauthenticationCredentials.digest(input.reauthenticationProof);
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
            reauthenticationProofDigest,
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
        if (!supersede) {
          if (reauthenticationProofDigest === null) {
            throw new Error("IDENTITY_REAUTHENTICATION_PROOF_DIGEST_INVARIANT");
          }
          const proofConsumed = await this.dependencies.repository.consumeReauthenticationProof(transaction, {
            binding, accountRef: material.accountRef, commandId: input.commandId, now,
            proof: {
              proofDigest: reauthenticationProofDigest,
              workloadIdentityId: input.workload.workloadIdentityId,
              expectedAuthStrengthPolicyRevision: material.authStrengthPolicyRevision,
              target: sensitiveTarget("beginTotpEnrollment"),
            },
          });
          if (!proofConsumed) throw new IdentityApplicationError("AUTHENTICATION_FAILED");
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

  async disableTotp(input: Readonly<{
    workload: ProductWorkloadIdentity;
    context: VerifiedRequestSecurityContext;
    session: AuthenticatedUserSession;
    commandId: string;
    idempotencyKey: string;
    code: string;
    reauthenticationProof: string;
  }>) {
    const code = normalizeProofCode(input.code);
    const proofDigest = this.dependencies.reauthenticationCredentials.digest(input.reauthenticationProof);
    const requestDigest = this.dependencies.auditDigest({
      operation: "disableTotp", siteRef: input.workload.siteRef,
      sessionRef: input.session.identitySessionRef, code, reauthenticationProofDigest: proofDigest,
    });
    const now = this.now();
    const binding = sessionBinding(input.workload, input.session);
    const material = await this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "disableTotp" },
      (transaction) => this.dependencies.repository.loadActiveTotpMaterial(transaction, { binding, now }),
    );
    let secret = this.dependencies.dummyTotpSecret;
    let usable = false;
    if (material?.authenticator !== null && material?.authenticator !== undefined) {
      try {
        secret = this.dependencies.totpSecretProtector.unseal(material.authenticator.envelope, {
          siteRef: input.workload.siteRef, accountRef: material.accountRef,
          subjectRef: material.subjectRef, authenticatorRef: material.authenticator.authenticatorRef,
        });
        usable = true;
      } catch {
        usable = false;
      }
    }
    const verification = await this.dependencies.totpVerifier.verify({
      secret, code, epochSeconds: Math.floor(Date.parse(now) / 1_000),
      afterTimeStep: material?.authenticator?.lastAcceptedTimeStep ?? null,
    });
    const outcome = await rejectAtomicSecurityMutation(
      this.dependencies.unitOfWork.execute(
        { context: input.context, operation: "disableTotp" },
        async (transaction) => {
        const identity = commandIdentity(input, "disableTotp", requestDigest);
        const existing = await this.dependencies.receipts.begin(transaction, identity);
        assertSameCommand(existing, input.commandId);
        if (existing.state === "succeeded") {
          return Object.freeze({ kind: "committed" as const,
            committedAt: committedAtResult(existing.result) });
        }
        if (existing.state === "failed" || material?.authenticator === null || material === null) {
          if (existing.state === "pending") await this.failure(transaction, identity, "AUTHENTICATION_FAILED");
          return Object.freeze({ kind: "rejected" as const });
        }
        const changed = await this.dependencies.repository.disableTotp(transaction, {
          binding, accountRef: material.accountRef,
          authenticatorRef: material.authenticator.authenticatorRef,
          timeStep: usable && verification.valid ? verification.timeStep : null,
          commandId: input.commandId,
          proof: { proofDigest, workloadIdentityId: input.workload.workloadIdentityId,
            expectedAuthStrengthPolicyRevision: material.authStrengthPolicyRevision,
            target: sensitiveTarget("disableTotp") },
          now,
        });
        if (changed === null) {
          await this.failure(transaction, identity, "AUTHENTICATION_FAILED");
          return Object.freeze({ kind: "rejected" as const });
        }
        await this.securityEvent(transaction, input, {
          eventType: "identity.totp.disabled", accountRef: changed.accountRef,
          accountSecurityEpoch: changed.accountSecurityEpoch, occurredAt: now,
          aggregateRef: input.commandId,
        });
        await this.success(transaction, identity, { kind: "totp_disabled", accountRef: changed.accountRef,
          accountSecurityEpoch: changed.accountSecurityEpoch, committedAt: now });
        return Object.freeze({ kind: "committed" as const, committedAt: now });
        },
      ),
    );
    if (outcome.kind === "rejected") throw new IdentityApplicationError("AUTHENTICATION_FAILED");
    return Object.freeze({ receipt: committedReceipt(input.commandId, requestDigest, outcome.committedAt) });
  }

  async regenerateRecoveryCodes(
    input: Readonly<{
      workload: ProductWorkloadIdentity;
      context: VerifiedRequestSecurityContext;
      session: AuthenticatedUserSession;
      commandId: string;
      idempotencyKey: string;
      receiptRecoveryCapability: string;
    } & (
      | Readonly<{ recoveryAction: "regenerate"; reauthenticationProof: string }>
      | Readonly<{ recoveryAction: "supersede"; priorCommandId: string }>
    )>,
  ) {
    const supersede = input.recoveryAction === "supersede";
    const proofDigest = supersede
      ? null
      : this.dependencies.reauthenticationCredentials.digest(input.reauthenticationProof);
    const requestDigest = this.dependencies.auditDigest(supersede
      ? { operation: "regenerateRecoveryCodes", siteRef: input.workload.siteRef,
          sessionRef: input.session.identitySessionRef, recoveryAction: input.recoveryAction,
          priorCommandId: input.priorCommandId }
      : { operation: "regenerateRecoveryCodes", siteRef: input.workload.siteRef,
          sessionRef: input.session.identitySessionRef, recoveryAction: input.recoveryAction,
          reauthenticationProofDigest: proofDigest });
    const now = this.now();
    const binding = sessionBinding(input.workload, input.session);
    const material = await this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "regenerateRecoveryCodes" },
      (transaction) => this.dependencies.repository.loadActiveTotpMaterial(transaction, { binding, now }),
    );
    if (material?.authenticator === null || material === null) {
      throw new IdentityApplicationError("AUTHENTICATION_FAILED");
    }
    const setRef = this.reference();
    const recoveryCodes = this.dependencies.recoveryCodeIssuer.issue();
    const recoveryCodeDigests = recoveryCodes.map((recoveryCode) => ({
      codeDigest: digestIdentityRecoveryCode(this.dependencies.auditDigest, {
        siteRef: input.workload.siteRef, accountRef: material.accountRef,
        recoverySetRef: setRef, code: recoveryCode,
      }),
    }));
    const outcome = await rejectAtomicSecurityMutation(
      this.dependencies.unitOfWork.execute(
        { context: input.context, operation: "regenerateRecoveryCodes" },
        async (transaction) => {
        const identity = commandIdentity(input, "regenerateRecoveryCodes", requestDigest);
        const existing = await this.dependencies.receipts.begin(transaction, identity);
        assertSameCommand(existing, input.commandId);
        if (existing.state === "succeeded") return Object.freeze({ kind: "retry" as const });
        if (existing.state === "failed") return Object.freeze({ kind: "rejected" as const });
        let changed: Readonly<{ accountRef: string; accountSecurityEpoch: string }> | null;
        if (supersede) {
          changed = await this.dependencies.repository.supersedeRecoveryCodes(transaction, {
            binding, accountRef: material.accountRef, priorCommandId: input.priorCommandId,
            newCommandId: input.commandId, requestDigest,
            workloadIdentityId: input.workload.workloadIdentityId,
            capabilityDigest: this.recoveryDigest("regenerateRecoveryCodes",
              input.receiptRecoveryCapability),
            setRef, recoveryCodeDigests, now,
          });
        } else {
          if (proofDigest === null) throw new Error("IDENTITY_REAUTHENTICATION_PROOF_DIGEST_INVARIANT");
          const proof = Object.freeze({ proofDigest,
            workloadIdentityId: input.workload.workloadIdentityId,
            expectedAuthStrengthPolicyRevision: material.authStrengthPolicyRevision,
            target: sensitiveTarget("regenerateRecoveryCodes") });
          changed = await this.dependencies.repository.regenerateRecoveryCodes(transaction, {
            binding, accountRef: material.accountRef, commandId: input.commandId, requestDigest,
            setRef, recoveryCodeDigests, proof, now,
          });
          if (changed !== null) {
            await this.bindRecovery(transaction, input, "regenerateRecoveryCodes", setRef, now);
          }
        }
        if (changed === null) {
          await this.failure(transaction, identity, "AUTHENTICATION_FAILED");
          return Object.freeze({ kind: "rejected" as const });
        }
        await this.securityEvent(transaction, input, {
          eventType: supersede ? "identity.recovery_codes.delivery_superseded" :
            "identity.recovery_codes.regenerated",
          accountRef: changed.accountRef, accountSecurityEpoch: changed.accountSecurityEpoch,
          occurredAt: now, aggregateRef: setRef,
        });
        await this.success(transaction, identity, { kind: "recovery_code_set", setRef,
          accountRef: changed.accountRef, accountSecurityEpoch: changed.accountSecurityEpoch,
          generatedAt: now, committedAt: now });
        return Object.freeze({ kind: "fresh" as const });
        },
      ),
    );
    if (outcome.kind === "rejected") throw new IdentityApplicationError("AUTHENTICATION_FAILED");
    if (outcome.kind === "retry") return deliveryUnavailable(input.commandId, requestDigest);
    return Object.freeze({ commandId: input.commandId, requestDigest, recoveryCodes, generatedAt: now });
  }

  private async verifyReauthenticationChallenge(
    input: Readonly<{
      workload: ProductWorkloadIdentity;
    } & (
      | { stage: "password" | "supersede" }
      | { stage: "mfa"; challengeKind: "totp" | "recovery" }
    )>,
    challenge: IdentityReauthenticationChallengeMaterial | null,
    proofCode: string | null,
    now: string,
  ): Promise<Readonly<
    | { kind: "totp"; timeStep: number }
    | { kind: "recovery_code"; codeDigest: string }
    | { kind: "invalid" }
  >> {
    if (input.stage !== "mfa") return Object.freeze({ kind: "invalid" as const });
    let secret = this.dependencies.dummyTotpSecret;
    let usable = false;
    if (challenge?.authenticator !== null && challenge?.authenticator !== undefined) {
      try {
        secret = this.dependencies.totpSecretProtector.unseal(challenge.authenticator.envelope, {
          siteRef: input.workload.siteRef,
          accountRef: challenge.accountRef,
          subjectRef: challenge.subjectRef,
          authenticatorRef: challenge.authenticator.authenticatorRef,
        });
        usable = true;
      } catch {
        usable = false;
      }
    }
    const totp = await this.dependencies.totpVerifier.verify({
      secret,
      code: proofCode ?? "",
      epochSeconds: Math.floor(Date.parse(now) / 1_000),
      afterTimeStep: challenge?.authenticator?.lastAcceptedTimeStep ?? null,
    });
    const recoveryDigest = digestIdentityRecoveryCode(this.dependencies.auditDigest, {
      siteRef: input.workload.siteRef,
      accountRef: challenge?.accountRef ?? "unknown-account",
      recoverySetRef: challenge?.recoverySetRef ?? "unknown-recovery-set",
      code: proofCode ?? "",
    });
    if (input.challengeKind === "totp" && usable && totp.valid) {
      return Object.freeze({ kind: "totp" as const, timeStep: totp.timeStep });
    }
    if (input.challengeKind === "recovery" && challenge?.recoverySetRef !== null &&
        challenge?.recoverySetRef !== undefined &&
        constantTimeDigestMatch(recoveryDigest, challenge.recoveryCodeDigests)) {
      return Object.freeze({ kind: "recovery_code" as const, codeDigest: recoveryDigest });
    }
    return Object.freeze({ kind: "invalid" as const });
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

function normalizePassword(password: string): string {
  const normalized = password.normalize("NFC");
  const codePoints = [...normalized].length;
  if (codePoints < 15 || codePoints > 1024) {
    throw new IdentityApplicationError("AUTH_TRANSACTION_INVALID");
  }
  return normalized;
}

function normalizeProofCode(value: string): string {
  const normalized = value.normalize("NFC");
  if (normalized.length < 6 || normalized.length > 128 || normalized.trim() !== normalized ||
      /[\p{Cc}\p{Cf}]/u.test(normalized)) {
    throw new IdentityApplicationError("AUTH_TRANSACTION_INVALID");
  }
  return normalized;
}

function canonicalTarget(value: Readonly<{
  audience: "platform-public";
  operationId: IdentityReauthenticationTarget["operationId"];
  resource: Readonly<{ kind: "identity_account" }>;
}>): IdentityReauthenticationTarget {
  if (value.audience !== "platform-public" || value.resource.kind !== "identity_account") {
    throw new IdentityApplicationError("AUTH_TRANSACTION_INVALID");
  }
  return sensitiveTarget(value.operationId);
}

function sensitiveTarget(
  operationId: IdentityReauthenticationTarget["operationId"],
): IdentityReauthenticationTarget {
  if (operationId !== "beginTotpEnrollment" && operationId !== "disableTotp" &&
      operationId !== "regenerateRecoveryCodes") {
    throw new IdentityApplicationError("AUTH_TRANSACTION_INVALID");
  }
  return Object.freeze({ audience: "platform-public", operationId, resourceKind: "identity_account" });
}

function committedReceipt(commandId: string, requestDigest: string, committedAt: string) {
  return Object.freeze({ commandId, requestDigest, committedAt,
    receiptRef: `command:${commandId}`, state: "committed" as const });
}

function reauthenticationPendingResult(value: JsonValue | null) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      value.kind !== "reauthentication_pending") return null;
  const pending = value.pending;
  if (pending === null || typeof pending !== "object" || Array.isArray(pending) ||
      typeof pending.transactionRef !== "string" || pending.challengeKind !== "totp" ||
      typeof pending.expiresAt !== "string" || typeof value.committedAt !== "string") {
    throw new Error("IDENTITY_RECEIPT_RESULT_INVALID");
  }
  return Object.freeze({ transactionRef: pending.transactionRef, challengeKind: "totp" as const,
    expiresAt: pending.expiresAt, committedAt: value.committedAt });
}

function committedAtResult(value: JsonValue | null): string {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      typeof value.committedAt !== "string") {
    throw new Error("IDENTITY_RECEIPT_RESULT_INVALID");
  }
  return value.committedAt;
}

function constantTimeDigestMatch(candidate: string, stored: readonly string[]): boolean {
  let matched = 0;
  for (let index = 0; index < 10; index += 1) {
    const digest = stored[index] ?? "0".repeat(64);
    const left = Buffer.from(candidate, "ascii");
    const right = Buffer.from(digest, "ascii");
    matched |= left.length === right.length && timingSafeEqual(left, right) ? 1 : 0;
  }
  return matched === 1;
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

async function rejectAtomicSecurityMutation<Result>(work: Promise<Result>): Promise<Result> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof IdentitySecurityAtomicRejection) {
      throw new IdentityApplicationError("AUTHENTICATION_FAILED");
    }
    throw error;
  }
}

function plus(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
