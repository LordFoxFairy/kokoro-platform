import { timingSafeEqual } from "node:crypto";
import type {
  IdentitySecurityManagementRepository,
  IdentityReauthenticationChallengeMaterial,
  IdentityReauthenticationMaterial,
  IdentityReauthenticationProofBinding,
  IdentityReauthenticationTarget,
  IdentitySecurityOwnerMaterial,
  IdentitySecuritySessionBinding,
  RecoveryCodeDigest,
  TotpEnrollmentMaterial,
} from "../../application/contracts/identity-security-management-repository.js";
import { IdentitySecurityAtomicRejection } from "../../application/contracts/identity-security-management-repository.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import {
  resolvePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../../../shared/unit-of-work/platform-transaction.js";

export class PostgresIdentitySecurityManagementRepository implements IdentitySecurityManagementRepository {
  async loadReauthenticationMaterial(
    transaction: PlatformTransaction,
    input: Parameters<IdentitySecurityManagementRepository["loadReauthenticationMaterial"]>[1],
  ): Promise<IdentityReauthenticationMaterial | null> {
    const rows = await resolvePlatformTransaction(transaction).query<ReauthenticationOwnerRow>(
      `${reauthenticationOwnerSelect}
       FOR SHARE OF site,release,product_binding,account,subject,session,credential`,
      securityAuthorityValues(input.binding, input.now),
    );
    return reauthenticationMaterial(rows[0], input.binding);
  }

  async recordReauthenticationFailure(
    transaction: PlatformTransaction,
    input: Parameters<IdentitySecurityManagementRepository["recordReauthenticationFailure"]>[1],
  ): Promise<void> {
    const sql = resolvePlatformTransaction(transaction);
    await lockAccount(sql, input.binding.siteRef, input.accountRef);
    const rows = await sql.query<ReauthenticationOwnerRow>(
      `${reauthenticationOwnerSelect}
       FOR SHARE OF site,release,product_binding,account,subject,session,credential`,
      securityAuthorityValues(input.binding, input.now),
    );
    const owner = rows[0];
    if (owner === undefined || !bindingMatches(owner, input.binding) || owner.accountRef !== input.accountRef ||
        owner.passwordCredentialEpoch.toString() !== input.passwordCredentialEpoch) return;
    const rate = (await sql.query<AuthRateRow>(
      `SELECT failed_attempt_count AS "failedAttemptCount",window_started_at AS "windowStartedAt",
              locked_until AS "lockedUntil"
       FROM platform.identity_auth_rate_limit
       WHERE site_ref=$1 AND account_ref=$2 AND purpose='reauthentication' FOR UPDATE`,
      [input.binding.siteRef, input.accountRef],
    ))[0];
    if (rate?.lockedUntil !== null && rate?.lockedUntil !== undefined &&
        Date.parse(instant(rate.lockedUntil)) > Date.parse(input.now)) return;
    await recordReauthenticationRateFailure(sql, input.binding.siteRef, input.accountRef, input.now, rate);
  }

  async issueReauthenticationProof(
    transaction: PlatformTransaction,
    input: Parameters<IdentitySecurityManagementRepository["issueReauthenticationProof"]>[1],
  ): Promise<boolean> {
    const sql = resolvePlatformTransaction(transaction);
    await lockAccount(sql, input.binding.siteRef, input.accountRef);
    const rows = await sql.query<ReauthenticationOwnerRow>(
      `${reauthenticationOwnerSelect}
       FOR UPDATE OF account,subject,session,credential
       FOR SHARE OF site,release,product_binding`,
      securityAuthorityValues(input.binding, input.now),
    );
    const owner = rows[0];
    if (owner === undefined || !bindingMatches(owner, input.binding) || owner.accountRef !== input.accountRef ||
        input.workloadIdentityId !== input.binding.workloadIdentityId ||
        owner.accountSecurityEpoch.toString() !== input.expectedAccountSecurityEpoch ||
        owner.passwordCredentialEpoch.toString() !== input.passwordCredentialEpoch ||
        owner.authStrengthPolicyRevision !== input.authStrengthPolicyRevision) return false;
    if (await reauthenticationLocked(sql, input.binding.siteRef, input.accountRef, input.now)) return false;
    await insertReauthenticationProof(sql, input, owner);
    await resetReauthenticationRate(sql, input.binding.siteRef, input.accountRef, input.now);
    return true;
  }

  async beginReauthenticationChallenge(
    transaction: PlatformTransaction,
    input: Parameters<IdentitySecurityManagementRepository["beginReauthenticationChallenge"]>[1],
  ): Promise<boolean> {
    const sql = resolvePlatformTransaction(transaction);
    await lockAccount(sql, input.binding.siteRef, input.accountRef);
    const rows = await sql.query<ReauthenticationOwnerRow>(
      `${reauthenticationOwnerSelect}
       FOR UPDATE OF account,subject,session,credential
       FOR SHARE OF site,release,product_binding`,
      securityAuthorityValues(input.binding, input.now),
    );
    const owner = rows[0];
    if (owner === undefined || !bindingMatches(owner, input.binding) || owner.accountRef !== input.accountRef ||
        input.workloadIdentityId !== input.binding.workloadIdentityId ||
        owner.accountSecurityEpoch.toString() !== input.expectedAccountSecurityEpoch ||
        owner.passwordCredentialEpoch.toString() !== input.passwordCredentialEpoch ||
        owner.authStrengthPolicyRevision !== input.authStrengthPolicyRevision ||
        owner.authenticatorRef !== input.authenticatorRef || owner.recoverySetRef !== input.recoverySetRef) return false;
    if (await reauthenticationLocked(sql, input.binding.siteRef, input.accountRef, input.now)) return false;
    await sql.execute(
      `UPDATE platform.identity_reauthentication_challenge
       SET state='expired',updated_at=$4::timestamptz
       WHERE site_ref=$1 AND account_ref=$2 AND session_ref=$3 AND state='pending'
         AND expires_at<=$4::timestamptz`,
      [input.binding.siteRef, input.accountRef, input.binding.sessionRef, input.now],
    );
    const pending = await sql.query<Record<string, unknown>>(
      `SELECT 1 FROM platform.identity_reauthentication_challenge
       WHERE site_ref=$1 AND account_ref=$2 AND session_ref=$3 AND operation_id=$4 AND state='pending'
       LIMIT 1`,
      [input.binding.siteRef, input.accountRef, input.binding.sessionRef, input.target.operationId],
    );
    if (pending.length > 0) return false;
    const inserted = await sql.execute(
      `INSERT INTO platform.identity_reauthentication_challenge
       (site_ref,transaction_ref,initiating_command_id,site_release_ref,site_project_binding_ref,
        workload_identity_id,binding_epoch,
        account_ref,subject_ref,session_ref,audience,operation_id,resource_kind,resource_ref,
        account_security_epoch,subject_generation,session_epoch,credential_epoch,password_credential_epoch,
        auth_strength_policy_revision,authenticator_ref,recovery_set_ref,state,attempt_count,max_attempts,
        expires_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$22,$5,$23::bigint,$6,$7,$8,$9,$10,$11,$6,$12::bigint,$13::bigint,$14::bigint,
               $15::bigint,$16::bigint,$17,$18,$19,'pending',0,5,$20::timestamptz,$21::timestamptz,$21::timestamptz)`,
      [input.binding.siteRef, input.transactionRef, input.commandId, input.binding.siteReleaseRef,
        input.workloadIdentityId, input.accountRef, input.binding.subjectRef, input.binding.sessionRef,
        input.target.audience, input.target.operationId, input.target.resourceKind,
        owner.accountSecurityEpoch.toString(), input.binding.subjectGeneration, input.binding.sessionEpoch,
        input.binding.credentialEpoch, input.passwordCredentialEpoch, input.authStrengthPolicyRevision,
        input.authenticatorRef, input.recoverySetRef, input.expiresAt, input.now,
        input.binding.siteProjectBindingRef, input.binding.bindingEpoch],
    );
    if (inserted !== 1) throw new Error("IDENTITY_REAUTHENTICATION_CHALLENGE_CREATE_FAILED");
    await resetReauthenticationRate(sql, input.binding.siteRef, input.accountRef, input.now);
    return true;
  }

  async loadReauthenticationChallengeMaterial(
    transaction: PlatformTransaction,
    input: Parameters<IdentitySecurityManagementRepository["loadReauthenticationChallengeMaterial"]>[1],
  ): Promise<IdentityReauthenticationChallengeMaterial | null> {
    const sql = resolvePlatformTransaction(transaction);
    const rows = await sql.query<ReauthenticationChallengeRow>(
      `${reauthenticationChallengeSelect}
       WHERE challenge.site_ref=$1 AND challenge.transaction_ref=$2 AND challenge.state='pending'
         AND challenge.expires_at>$3::timestamptz`,
      [input.binding.siteRef, input.transactionRef, input.now,
        input.binding.siteProjectBindingRef, input.binding.workloadIdentityId,
        input.binding.bindingEpoch],
    );
    const row = rows[0];
    if (row === undefined || !challengeMatches(row, input)) return null;
    const recoveryCodeDigests = row.recoverySetRef === null ? [] : await sql.query<RecoveryCodeDigestRow>(
      `SELECT code_digest AS "codeDigest" FROM platform.identity_recovery_code
       WHERE site_ref=$1 AND set_ref=$2 AND state='active' ORDER BY code_digest LIMIT 10`,
      [input.binding.siteRef, row.recoverySetRef],
    );
    return reauthenticationChallengeMaterial(row, recoveryCodeDigests);
  }

  async completeReauthenticationChallenge(
    transaction: PlatformTransaction,
    input: Parameters<IdentitySecurityManagementRepository["completeReauthenticationChallenge"]>[1],
  ) {
    const sql = resolvePlatformTransaction(transaction);
    const accountRows = await sql.query<{ accountRef: string } & Record<string, unknown>>(
      `SELECT account_ref AS "accountRef" FROM platform.identity_reauthentication_challenge
       WHERE site_ref=$1 AND transaction_ref=$2`,
      [input.binding.siteRef, input.transactionRef],
    );
    const accountRef = accountRows[0]?.accountRef;
    if (accountRef === undefined) return null;
    await lockAccount(sql, input.binding.siteRef, accountRef);
    const challengeRows = await sql.query<ReauthenticationChallengeRow>(
      `${reauthenticationChallengeSelect}
       WHERE challenge.site_ref=$1 AND challenge.transaction_ref=$2
       FOR UPDATE OF challenge,account,subject,session,credential,authenticator
       FOR SHARE OF site,release,product_binding`,
      [input.binding.siteRef, input.transactionRef, input.now,
        input.binding.siteProjectBindingRef, input.binding.workloadIdentityId,
        input.binding.bindingEpoch],
    );
    const challenge = challengeRows[0];
    if (challenge === undefined || challenge.state !== "pending" ||
        Date.parse(instant(challenge.expiresAt)) <= Date.parse(input.now) || !challengeMatches(challenge, input)) {
      return null;
    }
    let accepted = false;
    if (input.proof.kind === "totp" && challenge.authenticatorRef !== null) {
      accepted = await sql.execute(
        `UPDATE platform.identity_totp_authenticator
         SET last_accepted_timestep=$4::bigint,updated_at=$5::timestamptz
         WHERE site_ref=$1 AND authenticator_ref=$2 AND account_ref=$3 AND state='active'
           AND (last_accepted_timestep IS NULL OR last_accepted_timestep<$4::bigint)`,
        [input.binding.siteRef, challenge.authenticatorRef, challenge.accountRef,
          input.proof.timeStep, input.now],
      ) === 1;
    } else if (input.proof.kind === "recovery_code" && challenge.recoverySetRef !== null) {
      accepted = await sql.execute(
        `UPDATE platform.identity_recovery_code SET state='used',used_at=$4::timestamptz
         WHERE site_ref=$1 AND set_ref=$2 AND code_digest=$3 AND state='active'`,
        [input.binding.siteRef, challenge.recoverySetRef, input.proof.codeDigest, input.now],
      ) === 1;
    }
    if (!accepted) {
      await rejectReauthenticationChallenge(sql, challenge, input.now);
      return null;
    }
    const consumed = await sql.execute(
      `UPDATE platform.identity_reauthentication_challenge
       SET state='consumed',consumed_at=$4::timestamptz,consuming_command_id=$3,updated_at=$4::timestamptz
       WHERE site_ref=$1 AND transaction_ref=$2 AND state='pending'`,
      [input.binding.siteRef, input.transactionRef, input.commandId, input.now],
    );
    if (consumed !== 1) throw new Error("IDENTITY_REAUTHENTICATION_CHALLENGE_CONSUME_STALE");
    await insertReauthenticationProof(sql, {
      binding: input.binding, accountRef: challenge.accountRef,
      workloadIdentityId: input.workloadIdentityId, commandId: input.commandId,
      requestDigest: input.requestDigest, proofDigest: input.proofDigest,
      target: input.target, authStrengthPolicyRevision: challenge.authStrengthPolicyRevision,
      now: input.now, expiresAt: input.expiresAt,
    }, challenge);
    await resetReauthenticationRate(sql, input.binding.siteRef, challenge.accountRef, input.now);
    return Object.freeze({
      accountRef: challenge.accountRef,
      accountSecurityEpoch: challenge.accountSecurityEpoch.toString(),
      target: input.target,
      authStrengthPolicyRevision: challenge.authStrengthPolicyRevision,
    });
  }

  async supersedeReauthenticationProof(
    transaction: PlatformTransaction,
    input: Parameters<IdentitySecurityManagementRepository["supersedeReauthenticationProof"]>[1],
  ) {
    const sql = resolvePlatformTransaction(transaction);
    await lockAccount(sql, input.binding.siteRef, input.accountRef);
    const ownerRows = await sql.query<ReauthenticationOwnerRow>(
      `${reauthenticationOwnerSelect}
       FOR UPDATE OF account,subject,session,credential
       FOR SHARE OF site,release,product_binding`,
      securityAuthorityValues(input.binding, input.now),
    );
    const owner = ownerRows[0];
    if (owner === undefined || !bindingMatches(owner, input.binding) || owner.accountRef !== input.accountRef ||
        input.workloadIdentityId !== input.binding.workloadIdentityId ||
        owner.accountSecurityEpoch.toString() !== input.expectedAccountSecurityEpoch ||
        owner.authStrengthPolicyRevision !== input.expectedAuthStrengthPolicyRevision) return null;
    const priorRows = await sql.query<ReauthenticationRecoveryRow>(
      `SELECT proof.proof_digest AS "proofDigest",proof.state AS "proofState",proof.expires_at AS "proofExpiresAt",
              proof.site_release_ref AS "proofSiteReleaseRef",
              proof.site_project_binding_ref AS "proofSiteProjectBindingRef",
              proof.workload_identity_id AS "proofWorkloadIdentityId",proof.binding_epoch AS "proofBindingEpoch",
              proof.audience,proof.operation_id AS "operationId",proof.resource_kind AS "resourceKind",
              proof.auth_strength_policy_revision AS "authStrengthPolicyRevision",
              claim.state AS "claimState",claim.request_digest AS "claimRequestDigest",
              receipt.request_digest AS "receiptRequestDigest",receipt.operation,receipt.state AS "receiptState",
              receipt.caller_identity AS "callerIdentity",recovery.site_ref AS "recoverySiteRef",
              recovery.site_release_ref AS "recoverySiteReleaseRef",
              recovery.site_project_binding_ref AS "recoverySiteProjectBindingRef",
              recovery.workload_identity_id AS "recoveryWorkloadIdentityId",
              recovery.binding_epoch AS "recoveryBindingEpoch",recovery.purpose AS "recoveryPurpose",
              recovery.capability_digest AS "capabilityDigest",recovery.state AS "recoveryState",
              recovery.expires_at AS "recoveryExpiresAt"
       FROM platform.identity_reauthentication_proof proof
       JOIN platform.identity_reauthentication_delivery_claim claim ON claim.proof_digest=proof.proof_digest
       JOIN platform.command_receipt receipt ON receipt.command_id=claim.command_id
       JOIN platform.identity_receipt_recovery_capability recovery ON recovery.command_id=claim.command_id
       WHERE proof.site_ref=$1 AND proof.account_ref=$2 AND proof.issuing_command_id=$3
       FOR UPDATE OF proof,claim,receipt,recovery`,
      [input.binding.siteRef, input.accountRef, input.priorCommandId],
    );
    const prior = priorRows[0];
    if (prior === undefined || prior.proofState !== "active" || prior.claimState !== "first_claim_consumed" ||
        Date.parse(instant(prior.proofExpiresAt)) <= Date.parse(input.now) || prior.receiptState !== "succeeded" ||
        prior.operation !== "reauthenticateIdentitySession" || prior.callerIdentity !== input.workloadIdentityId ||
        prior.claimRequestDigest !== prior.receiptRequestDigest ||
        prior.proofSiteReleaseRef !== input.binding.siteReleaseRef ||
        prior.proofSiteProjectBindingRef !== input.binding.siteProjectBindingRef ||
        prior.proofWorkloadIdentityId !== input.workloadIdentityId ||
        prior.proofBindingEpoch.toString() !== input.binding.bindingEpoch ||
        !recoveryAuthorityMatches(prior, input.binding, input.workloadIdentityId) ||
        prior.recoveryPurpose !== "reauthenticateIdentitySession" || prior.recoveryState !== "active" ||
        Date.parse(instant(prior.recoveryExpiresAt)) <= Date.parse(input.now) ||
        !digestEqual(prior.capabilityDigest, input.capabilityDigest) || prior.audience !== "platform-public" ||
        !sensitiveOperation(prior.operationId) || prior.resourceKind !== "identity_account" ||
        prior.authStrengthPolicyRevision !== owner.authStrengthPolicyRevision) return null;
    const proofChanged = await sql.execute(
      `UPDATE platform.identity_reauthentication_proof
       SET state='superseded',superseded_at=$2::timestamptz,updated_at=$2::timestamptz
       WHERE proof_digest=$1 AND state='active'`,
      [prior.proofDigest, input.now],
    );
    const claimChanged = await sql.execute(
      `UPDATE platform.identity_reauthentication_delivery_claim
       SET state='superseded',superseded_at=$2::timestamptz WHERE command_id=$1 AND state='first_claim_consumed'`,
      [input.priorCommandId, input.now],
    );
    const recoveryChanged = await sql.execute(
      `UPDATE platform.identity_receipt_recovery_capability SET command_id=$2
       WHERE command_id=$1 AND state='active'`,
      [input.priorCommandId, input.newCommandId],
    );
    if (proofChanged !== 1 || claimChanged !== 1 || recoveryChanged !== 1) {
      throw new IdentitySecurityAtomicRejection();
    }
    const target = Object.freeze({
      audience: "platform-public" as const, operationId: prior.operationId,
      resourceKind: "identity_account" as const,
    });
    await insertReauthenticationProof(sql, {
      ...input, target, authStrengthPolicyRevision: prior.authStrengthPolicyRevision,
    }, owner);
    return Object.freeze({ target, authStrengthPolicyRevision: prior.authStrengthPolicyRevision });
  }

  async consumeReauthenticationProof(
    transaction: PlatformTransaction,
    input: Parameters<IdentitySecurityManagementRepository["consumeReauthenticationProof"]>[1],
  ): Promise<boolean> {
    const sql = resolvePlatformTransaction(transaction);
    await lockAccount(sql, input.binding.siteRef, input.accountRef);
    const owner = await lockSecurityOwner(sql, input.binding, input.now);
    if (owner === null || owner.accountRef !== input.accountRef) return false;
    if (!await lockReauthenticationProof(sql, {
      binding: input.binding, accountRef: input.accountRef, proof: input.proof, now: input.now,
    })) return false;
    return consumeReauthenticationProof(sql, input);
  }
  async loadSecurityOwnerMaterial(
    transaction: PlatformTransaction,
    input: Parameters<IdentitySecurityManagementRepository["loadSecurityOwnerMaterial"]>[1],
  ): Promise<IdentitySecurityOwnerMaterial | null> {
    const sql = resolvePlatformTransaction(transaction);
    const rows = await sql.query<SecurityOwnerRow>(
      `${securityOwnerSelect}
       FOR SHARE OF site,release,product_binding,account,subject,session`,
      securityAuthorityValues(input.binding, input.now),
    );
    const owner = rows[0];
    if (
      owner === undefined ||
      !bindingMatches(owner, input.binding) ||
      !validIdentityIssuerLabel(owner.identityIssuerLabel) ||
      !validRevision(owner.authStrengthPolicyRevision)
    )
      return null;
    return Object.freeze({
      accountRef: owner.accountRef,
      subjectRef: owner.subjectRef,
      sessionRef: owner.sessionRef,
      emailNormalized: owner.emailNormalized,
      identityIssuerLabel: owner.identityIssuerLabel,
      authStrengthPolicyRevision: owner.authStrengthPolicyRevision,
      accountSecurityEpoch: owner.accountSecurityEpoch.toString(),
      subjectGeneration: owner.subjectGeneration.toString(),
      sessionEpoch: owner.sessionEpoch.toString(),
      credentialEpoch: owner.credentialEpoch.toString(),
      authenticatedAt: instant(owner.authenticatedAt),
      authenticationMethods: authenticationMethods(owner.authenticationMethods),
    });
  }

  async beginTotpEnrollment(
    transaction: PlatformTransaction,
    input: Parameters<IdentitySecurityManagementRepository["beginTotpEnrollment"]>[1],
  ): Promise<boolean> {
    const sql = resolvePlatformTransaction(transaction);
    await lockAccount(sql, input.binding.siteRef, input.accountRef);
    const owner = await lockSecurityOwner(sql, input.binding, input.now);
    if (!expectedOwner(owner, input.accountRef, input.expectedAccountSecurityEpoch)) return false;
    if (!await lockReauthenticationProof(sql, {
      binding: input.binding, accountRef: input.accountRef, proof: input.proof, now: input.now,
    })) return false;
    await expireTotpEnrollments(sql, input.binding.siteRef, input.accountRef, input.now);
    if (
      (await activeTotpExists(sql, input.binding.siteRef, input.accountRef)) ||
      (await pendingTotpEnrollmentExists(sql, input.binding.siteRef, input.accountRef))
    )
      return false;
    await insertTotpEnrollment(sql, input);
    if (!await consumeReauthenticationProof(sql, {
      binding: input.binding, accountRef: input.accountRef, commandId: input.commandId,
      proof: input.proof, now: input.now,
    })) throw new IdentitySecurityAtomicRejection();
    return true;
  }

  async supersedeTotpEnrollment(
    transaction: PlatformTransaction,
    input: Parameters<IdentitySecurityManagementRepository["supersedeTotpEnrollment"]>[1],
  ): Promise<boolean> {
    const sql = resolvePlatformTransaction(transaction);
    await lockAccount(sql, input.binding.siteRef, input.accountRef);
    const owner = await lockSecurityOwner(sql, input.binding, input.now);
    if (
      owner === null ||
      !expectedOwner(owner, input.accountRef, input.expectedAccountSecurityEpoch) ||
      input.workloadIdentityId !== input.binding.workloadIdentityId ||
      owner.authStrengthPolicyRevision !== input.expectedAuthStrengthPolicyRevision ||
      (await activeTotpExists(sql, input.binding.siteRef, input.accountRef))
    )
      return false;
    const rows = await sql.query<EnrollmentRecoveryRow>(
      `SELECT enrollment.authenticator_ref AS "authenticatorRef",enrollment.state AS "enrollmentState",
              enrollment.expires_at AS "enrollmentExpiresAt",claim.request_digest AS "claimRequestDigest",
              claim.state AS "claimState",receipt.request_digest AS "receiptRequestDigest",
              receipt.operation,receipt.state AS "receiptState",receipt.caller_identity AS "callerIdentity",
              recovery.site_ref AS "recoverySiteRef",recovery.site_release_ref AS "recoverySiteReleaseRef",
              recovery.site_project_binding_ref AS "recoverySiteProjectBindingRef",
              recovery.workload_identity_id AS "recoveryWorkloadIdentityId",
              recovery.binding_epoch AS "recoveryBindingEpoch",
              recovery.purpose AS "recoveryPurpose",recovery.transaction_ref AS "recoveryTransactionRef",
              recovery.capability_digest AS "capabilityDigest",recovery.state AS "recoveryState",
              recovery.expires_at AS "recoveryExpiresAt"
       FROM platform.identity_totp_enrollment_transaction enrollment
       JOIN platform.identity_totp_enrollment_delivery_claim claim
         ON claim.site_ref=enrollment.site_ref AND claim.transaction_ref=enrollment.transaction_ref
       JOIN platform.command_receipt receipt ON receipt.command_id=claim.command_id
       JOIN platform.identity_receipt_recovery_capability recovery ON recovery.command_id=claim.command_id
       WHERE enrollment.site_ref=$1 AND enrollment.transaction_ref=$2 AND enrollment.account_ref=$3
         AND claim.command_id=$4
       FOR UPDATE OF enrollment,claim,receipt,recovery`,
      [input.binding.siteRef, input.priorTransactionRef, input.accountRef, input.priorCommandId],
    );
    const prior = rows[0];
    if (
      prior === undefined ||
      prior.enrollmentState !== "pending" ||
      prior.claimState !== "first_claim_consumed" ||
      Date.parse(instant(prior.enrollmentExpiresAt)) <= Date.parse(input.now) ||
      prior.receiptState !== "succeeded" ||
      prior.operation !== "beginTotpEnrollment" ||
      prior.callerIdentity !== input.workloadIdentityId ||
      prior.claimRequestDigest !== prior.receiptRequestDigest ||
      !recoveryAuthorityMatches(prior, input.binding, input.workloadIdentityId) ||
      prior.recoveryPurpose !== "beginTotpEnrollment" ||
      prior.recoveryTransactionRef !== input.priorTransactionRef ||
      prior.recoveryState !== "active" ||
      Date.parse(instant(prior.recoveryExpiresAt)) <= Date.parse(input.now) ||
      !digestEqual(prior.capabilityDigest, input.capabilityDigest)
    )
      return false;
    const transferred = await sql.execute(
      `UPDATE platform.identity_receipt_recovery_capability
       SET command_id=$2,transaction_ref=$3
       WHERE command_id=$1 AND state='active'`,
      [input.priorCommandId, input.newCommandId, input.transactionRef],
    );
    const claim = await sql.execute(
      `UPDATE platform.identity_totp_enrollment_delivery_claim
       SET state='superseded',superseded_at=$2::timestamptz
       WHERE command_id=$1 AND state='first_claim_consumed'`,
      [input.priorCommandId, input.now],
    );
    const enrollment = await sql.execute(
      `UPDATE platform.identity_totp_enrollment_transaction SET state='superseded',updated_at=$3::timestamptz
       WHERE site_ref=$1 AND transaction_ref=$2 AND state='pending'`,
      [input.binding.siteRef, input.priorTransactionRef, input.now],
    );
    const factor = await sql.execute(
      `UPDATE platform.identity_totp_authenticator SET state='revoked',revoked_at=$3::timestamptz,updated_at=$3::timestamptz
       WHERE site_ref=$1 AND authenticator_ref=$2 AND state='pending'`,
      [input.binding.siteRef, prior.authenticatorRef, input.now],
    );
    if (transferred !== 1 || claim !== 1 || enrollment !== 1 || factor !== 1) {
      throw new IdentitySecurityAtomicRejection();
    }
    await insertTotpEnrollment(sql, {
      binding: input.binding,
      accountRef: input.accountRef,
      expectedAccountSecurityEpoch: input.expectedAccountSecurityEpoch,
      commandId: input.newCommandId,
      requestDigest: input.requestDigest,
      transactionRef: input.transactionRef,
      authenticatorRef: input.authenticatorRef,
      envelope: input.envelope,
      now: input.now,
      expiresAt: input.expiresAt,
    });
    return true;
  }

  async loadTotpEnrollmentMaterial(
    transaction: PlatformTransaction,
    input: Parameters<IdentitySecurityManagementRepository["loadTotpEnrollmentMaterial"]>[1],
  ): Promise<TotpEnrollmentMaterial | null> {
    const rows = await resolvePlatformTransaction(transaction).query<TotpEnrollmentRow>(
      `SELECT enrollment.account_ref AS "accountRef",enrollment.subject_ref AS "subjectRef",
              enrollment.session_ref AS "sessionRef",enrollment.transaction_ref AS "transactionRef",
              enrollment.expires_at AS "expiresAt",enrollment.authenticator_ref AS "authenticatorRef",
              enrollment.account_security_epoch AS "accountSecurityEpoch",
              authenticator.secret_algorithm AS "secretAlgorithm",
              authenticator.secret_key_revision AS "secretKeyRevision",authenticator.secret_nonce AS "secretNonce",
              authenticator.secret_ciphertext AS "secretCiphertext",
              authenticator.secret_authentication_tag AS "secretAuthenticationTag",
              authenticator.last_accepted_timestep AS "lastAcceptedTimeStep"
       FROM platform.identity_totp_enrollment_transaction enrollment
       JOIN platform.identity_totp_authenticator authenticator
         ON authenticator.site_ref=enrollment.site_ref AND authenticator.authenticator_ref=enrollment.authenticator_ref
           AND authenticator.account_ref=enrollment.account_ref AND authenticator.subject_ref=enrollment.subject_ref
       JOIN platform.identity_account account
         ON account.site_ref=enrollment.site_ref AND account.account_ref=enrollment.account_ref
           AND account.subject_ref=enrollment.subject_ref
       JOIN platform.authorization_identity_session session
         ON session.session_ref=enrollment.session_ref AND session.subject_ref=enrollment.subject_ref
           AND session.site_ref=enrollment.site_ref
       JOIN platform.authorization_subject subject
         ON subject.subject_ref=enrollment.subject_ref AND subject.site_ref=enrollment.site_ref
       WHERE enrollment.site_ref=$1 AND enrollment.transaction_ref=$2 AND enrollment.state='pending'
         AND enrollment.expires_at>$3::timestamptz AND authenticator.state='pending'
         AND session.state='active' AND session.expires_at>$3::timestamptz AND subject.state='active'
         AND account.state='active' AND account.security_epoch=enrollment.account_security_epoch
         AND subject.subject_generation=$4::bigint AND subject.subject_generation=enrollment.subject_generation
         AND session.session_epoch=$5::bigint AND session.session_epoch=enrollment.session_epoch
         AND session.credential_epoch=$6::bigint AND session.credential_epoch=enrollment.credential_epoch`,
      [
        input.binding.siteRef,
        input.transactionRef,
        input.now,
        input.binding.subjectGeneration,
        input.binding.sessionEpoch,
        input.binding.credentialEpoch,
      ],
    );
    const row = rows[0];
    if (
      row === undefined ||
      row.secretAlgorithm !== "A256GCM" ||
      row.subjectRef !== input.binding.subjectRef ||
      row.sessionRef !== input.binding.sessionRef
    )
      return null;
    return Object.freeze({
      accountRef: row.accountRef,
      subjectRef: row.subjectRef,
      sessionRef: row.sessionRef,
      transactionRef: row.transactionRef,
      expiresAt: instant(row.expiresAt),
      authenticatorRef: row.authenticatorRef,
      accountSecurityEpoch: row.accountSecurityEpoch.toString(),
      envelope: Object.freeze({
        algorithm: "A256GCM" as const,
        keyRevision: row.secretKeyRevision,
        nonce: row.secretNonce,
        ciphertext: row.secretCiphertext,
        authenticationTag: row.secretAuthenticationTag,
      }),
      lastAcceptedTimeStep:
        row.lastAcceptedTimeStep === null ? null : Number(row.lastAcceptedTimeStep),
    });
  }

  async confirmTotpEnrollment(
    transaction: PlatformTransaction,
    input: Parameters<IdentitySecurityManagementRepository["confirmTotpEnrollment"]>[1],
  ) {
    const sql = resolvePlatformTransaction(transaction);
    const ownerRows = await sql.query<{ accountRef: string } & Record<string, unknown>>(
      `SELECT account_ref AS "accountRef" FROM platform.identity_totp_enrollment_transaction
       WHERE site_ref=$1 AND transaction_ref=$2`,
      [input.binding.siteRef, input.transactionRef],
    );
    const ownerRef = ownerRows[0]?.accountRef;
    if (ownerRef === undefined) return null;
    await lockAccount(sql, input.binding.siteRef, ownerRef);
    const owner = await lockSecurityOwner(sql, input.binding, input.now);
    if (!expectedOwner(owner, ownerRef, owner?.accountSecurityEpoch.toString() ?? "")) return null;
    const rows = await sql.query<TotpEnrollmentLockRow>(
      `SELECT enrollment.account_ref AS "accountRef",enrollment.authenticator_ref AS "authenticatorRef",
              enrollment.state,enrollment.attempt_count AS "attemptCount",enrollment.max_attempts AS "maxAttempts",
              enrollment.expires_at AS "expiresAt",enrollment.account_security_epoch AS "accountSecurityEpoch",
              enrollment.subject_generation AS "subjectGeneration",enrollment.session_epoch AS "sessionEpoch",
              enrollment.credential_epoch AS "credentialEpoch",
              authenticator.last_accepted_timestep AS "lastAcceptedTimeStep"
       FROM platform.identity_totp_enrollment_transaction enrollment
       JOIN platform.identity_totp_authenticator authenticator
         ON authenticator.site_ref=enrollment.site_ref AND authenticator.authenticator_ref=enrollment.authenticator_ref
           AND authenticator.account_ref=enrollment.account_ref AND authenticator.subject_ref=enrollment.subject_ref
       WHERE enrollment.site_ref=$1 AND enrollment.transaction_ref=$2 AND enrollment.subject_ref=$3
         AND enrollment.session_ref=$4 AND authenticator.state='pending'
       FOR UPDATE OF enrollment,authenticator`,
      [
        input.binding.siteRef,
        input.transactionRef,
        input.binding.subjectRef,
        input.binding.sessionRef,
      ],
    );
    const enrollment = rows[0];
    if (
      enrollment === undefined ||
      enrollment.state !== "pending" ||
      enrollment.attemptCount >= enrollment.maxAttempts ||
      owner === null ||
      enrollment.accountSecurityEpoch.toString() !== owner.accountSecurityEpoch.toString() ||
      enrollment.subjectGeneration.toString() !== input.binding.subjectGeneration ||
      enrollment.sessionEpoch.toString() !== input.binding.sessionEpoch ||
      enrollment.credentialEpoch.toString() !== input.binding.credentialEpoch ||
      Date.parse(instant(enrollment.expiresAt)) <= Date.parse(input.now)
    )
      return null;
    if (
      input.timeStep === null ||
      (enrollment.lastAcceptedTimeStep !== null &&
        input.timeStep <= Number(enrollment.lastAcceptedTimeStep))
    ) {
      await recordCeremonyFailure(
        sql,
        "identity_totp_enrollment_transaction",
        input.binding.siteRef,
        input.transactionRef,
        input.now,
      );
      return null;
    }
    const activated = await sql.execute(
      `UPDATE platform.identity_totp_authenticator
       SET state='active',last_accepted_timestep=$4::bigint,confirmed_at=$5::timestamptz,updated_at=$5::timestamptz
       WHERE site_ref=$1 AND authenticator_ref=$2 AND account_ref=$3 AND state='pending'
         AND (last_accepted_timestep IS NULL OR last_accepted_timestep<$4::bigint)`,
      [
        input.binding.siteRef,
        enrollment.authenticatorRef,
        enrollment.accountRef,
        input.timeStep,
        input.now,
      ],
    );
    if (activated !== 1) return null;
    const confirmed = await sql.execute(
      `UPDATE platform.identity_totp_enrollment_transaction
       SET state='confirmed',confirmed_at=$3::timestamptz,updated_at=$3::timestamptz
       WHERE site_ref=$1 AND transaction_ref=$2 AND state='pending'`,
      [input.binding.siteRef, input.transactionRef, input.now],
    );
    if (confirmed !== 1) throw new Error("IDENTITY_TOTP_ENROLLMENT_CONFIRM_STALE");
    await replaceRecoveryCodeSet(sql, {
      siteRef: input.binding.siteRef,
      accountRef: enrollment.accountRef,
      subjectRef: input.binding.subjectRef,
      setRef: input.setRef,
      recoveryCodeDigests: input.recoveryCodeDigests,
      now: input.now,
    });
    const epoch = await incrementSecurityEpoch(
      sql,
      input.binding.siteRef,
      enrollment.accountRef,
      input.now,
    );
    await insertRecoveryCodeDeliveryClaim(sql, {
      commandId: input.commandId,
      siteRef: input.binding.siteRef,
      accountRef: enrollment.accountRef,
      subjectRef: input.binding.subjectRef,
      sessionRef: input.binding.sessionRef,
      setRef: input.setRef,
      purpose: "confirmTotpEnrollment",
      requestDigest: input.requestDigest,
      now: input.now,
    });
    return Object.freeze({ accountRef: enrollment.accountRef, accountSecurityEpoch: epoch });
  }

  async loadActiveTotpMaterial(
    transaction: PlatformTransaction,
    input: Parameters<IdentitySecurityManagementRepository["loadActiveTotpMaterial"]>[1],
  ): Promise<IdentityReauthenticationMaterial | null> {
    return this.loadReauthenticationMaterial(transaction, input);
  }

  async disableTotp(
    transaction: PlatformTransaction,
    input: Parameters<IdentitySecurityManagementRepository["disableTotp"]>[1],
  ) {
    const sql = resolvePlatformTransaction(transaction);
    await lockAccount(sql, input.binding.siteRef, input.accountRef);
    const ownerRows = await sql.query<ReauthenticationOwnerRow>(
      `${reauthenticationOwnerSelect}
       FOR UPDATE OF account,subject,session,credential
       FOR SHARE OF site,release,product_binding`,
      securityAuthorityValues(input.binding, input.now),
    );
    const owner = ownerRows[0];
    if (owner === undefined || !bindingMatches(owner, input.binding) || owner.accountRef !== input.accountRef ||
        owner.authenticatorRef !== input.authenticatorRef || input.timeStep === null ||
        (owner.lastAcceptedTimeStep !== null && input.timeStep <= Number(owner.lastAcceptedTimeStep))) return null;
    if (!await lockReauthenticationProof(sql, {
      binding: input.binding, accountRef: input.accountRef, proof: input.proof, now: input.now,
    })) return null;
    const factor = await sql.execute(
      `UPDATE platform.identity_totp_authenticator
       SET state='revoked',last_accepted_timestep=$4::bigint,revoked_at=$5::timestamptz,updated_at=$5::timestamptz
       WHERE site_ref=$1 AND authenticator_ref=$2 AND account_ref=$3 AND state='active'
         AND (last_accepted_timestep IS NULL OR last_accepted_timestep<$4::bigint)`,
      [input.binding.siteRef, input.authenticatorRef, input.accountRef, input.timeStep, input.now],
    );
    if (factor !== 1) return null;
    await revokeRecoveryCodeSets(sql, input.binding.siteRef, input.accountRef, input.now);
    if (!await consumeReauthenticationProof(sql, {
      binding: input.binding, accountRef: input.accountRef, commandId: input.commandId,
      proof: input.proof, now: input.now,
    })) throw new IdentitySecurityAtomicRejection();
    const epoch = await incrementSecurityEpoch(sql, input.binding.siteRef, input.accountRef, input.now);
    return Object.freeze({ accountRef: input.accountRef, accountSecurityEpoch: epoch });
  }

  async regenerateRecoveryCodes(
    transaction: PlatformTransaction,
    input: Parameters<IdentitySecurityManagementRepository["regenerateRecoveryCodes"]>[1],
  ) {
    const sql = resolvePlatformTransaction(transaction);
    await lockAccount(sql, input.binding.siteRef, input.accountRef);
    const owner = await lockSecurityOwner(sql, input.binding, input.now);
    if (owner === null || owner.accountRef !== input.accountRef) return null;
    if (!await lockReauthenticationProof(sql, {
      binding: input.binding, accountRef: input.accountRef, proof: input.proof, now: input.now,
    })) return null;
    await replaceRecoveryCodeSet(sql, {
      siteRef: input.binding.siteRef, accountRef: input.accountRef, subjectRef: input.binding.subjectRef,
      setRef: input.setRef, recoveryCodeDigests: input.recoveryCodeDigests, now: input.now,
    });
    if (!await consumeReauthenticationProof(sql, {
      binding: input.binding, accountRef: input.accountRef, commandId: input.commandId,
      proof: input.proof, now: input.now,
    })) throw new IdentitySecurityAtomicRejection();
    const epoch = await incrementSecurityEpoch(sql, input.binding.siteRef, input.accountRef, input.now);
    await insertRecoveryCodeDeliveryClaim(sql, {
      commandId: input.commandId, siteRef: input.binding.siteRef, accountRef: input.accountRef,
      subjectRef: input.binding.subjectRef, sessionRef: input.binding.sessionRef, setRef: input.setRef,
      purpose: "regenerateRecoveryCodes", requestDigest: input.requestDigest, now: input.now,
    });
    return Object.freeze({ accountRef: input.accountRef, accountSecurityEpoch: epoch });
  }

  async supersedeRecoveryCodes(
    transaction: PlatformTransaction,
    input: Parameters<IdentitySecurityManagementRepository["supersedeRecoveryCodes"]>[1],
  ) {
    const sql = resolvePlatformTransaction(transaction);
    await lockAccount(sql, input.binding.siteRef, input.accountRef);
    const owner = await lockSecurityOwner(sql, input.binding, input.now);
    if (owner === null || owner.accountRef !== input.accountRef ||
        input.workloadIdentityId !== input.binding.workloadIdentityId ||
        owner.authStrengthPolicyRevision !== input.expectedAuthStrengthPolicyRevision) return null;
    const rows = await sql.query<RecoveryCodeRecoveryRow>(
      `SELECT claim.set_ref AS "setRef",claim.state AS "claimState",claim.request_digest AS "claimRequestDigest",
              receipt.request_digest AS "receiptRequestDigest",receipt.operation,receipt.state AS "receiptState",
              receipt.caller_identity AS "callerIdentity",recovery.site_ref AS "recoverySiteRef",
              recovery.site_release_ref AS "recoverySiteReleaseRef",
              recovery.site_project_binding_ref AS "recoverySiteProjectBindingRef",
              recovery.workload_identity_id AS "recoveryWorkloadIdentityId",
              recovery.binding_epoch AS "recoveryBindingEpoch",recovery.purpose AS "recoveryPurpose",
              recovery.transaction_ref AS "recoveryTransactionRef",recovery.capability_digest AS "capabilityDigest",
              recovery.state AS "recoveryState",recovery.expires_at AS "recoveryExpiresAt",
              code_set.state AS "setState"
       FROM platform.identity_recovery_code_delivery_claim claim
       JOIN platform.command_receipt receipt ON receipt.command_id=claim.command_id
       JOIN platform.identity_receipt_recovery_capability recovery ON recovery.command_id=claim.command_id
       JOIN platform.identity_recovery_code_set code_set
         ON code_set.site_ref=claim.site_ref AND code_set.set_ref=claim.set_ref
       WHERE claim.command_id=$1 AND claim.site_ref=$2 AND claim.account_ref=$3
         AND claim.purpose='regenerateRecoveryCodes'
       FOR UPDATE OF claim,receipt,recovery,code_set`,
      [input.priorCommandId, input.binding.siteRef, input.accountRef],
    );
    const prior = rows[0];
    if (prior === undefined || prior.claimState !== "first_claim_consumed" || prior.setState !== "active" ||
        prior.receiptState !== "succeeded" || prior.operation !== "regenerateRecoveryCodes" ||
        prior.callerIdentity !== input.workloadIdentityId || prior.claimRequestDigest !== prior.receiptRequestDigest ||
        !recoveryAuthorityMatches(prior, input.binding, input.workloadIdentityId) ||
        prior.recoveryPurpose !== "regenerateRecoveryCodes" || prior.recoveryTransactionRef !== prior.setRef ||
        prior.recoveryState !== "active" || Date.parse(instant(prior.recoveryExpiresAt)) <= Date.parse(input.now) ||
        !digestEqual(prior.capabilityDigest, input.capabilityDigest)) return null;
    const claim = await sql.execute(
      `UPDATE platform.identity_recovery_code_delivery_claim
       SET state='superseded',superseded_at=$2::timestamptz
       WHERE command_id=$1 AND state='first_claim_consumed'`,
      [input.priorCommandId, input.now],
    );
    const recovery = await sql.execute(
      `UPDATE platform.identity_receipt_recovery_capability SET command_id=$2,transaction_ref=$3
       WHERE command_id=$1 AND state='active'`,
      [input.priorCommandId, input.newCommandId, input.setRef],
    );
    if (claim !== 1 || recovery !== 1) throw new IdentitySecurityAtomicRejection();
    await replaceRecoveryCodeSet(sql, {
      siteRef: input.binding.siteRef, accountRef: input.accountRef, subjectRef: input.binding.subjectRef,
      setRef: input.setRef, recoveryCodeDigests: input.recoveryCodeDigests, now: input.now,
    });
    const epoch = await incrementSecurityEpoch(sql, input.binding.siteRef, input.accountRef, input.now);
    await insertRecoveryCodeDeliveryClaim(sql, {
      commandId: input.newCommandId, siteRef: input.binding.siteRef, accountRef: input.accountRef,
      subjectRef: input.binding.subjectRef, sessionRef: input.binding.sessionRef, setRef: input.setRef,
      purpose: "regenerateRecoveryCodes", requestDigest: input.requestDigest, now: input.now,
    });
    return Object.freeze({ accountRef: input.accountRef, accountSecurityEpoch: epoch });
  }

  async appendSecurityEvent(
    transaction: PlatformTransaction,
    input: Parameters<IdentitySecurityManagementRepository["appendSecurityEvent"]>[1],
  ): Promise<void> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.identity_security_event
       (event_id,site_ref,account_ref,subject_ref,session_ref,event_type,account_security_epoch,
        payload_digest,correlation_id,causation_id,occurred_at)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::bigint,$8,$9,$10,$11::timestamptz)`,
      [
        input.eventId,
        input.siteRef,
        input.accountRef,
        input.subjectRef,
        input.sessionRef,
        input.eventType,
        input.accountSecurityEpoch,
        input.payloadDigest,
        input.correlationId,
        input.causationId,
        input.occurredAt,
      ],
    );
    if (changed !== 1) throw new Error("IDENTITY_SECURITY_EVENT_APPEND_FAILED");
  }
}

const securityOwnerSelect = `SELECT account.site_ref AS "siteRef",
  site.state AS "siteState",release.release_ref AS "siteReleaseRef",release.state AS "releaseState",
  product_binding.binding_ref AS "siteProjectBindingRef",
  product_binding.workload_identity_id AS "workloadIdentityId",
  product_binding.binding_epoch AS "bindingEpoch",product_binding.state AS "bindingState",
  account.account_ref AS "accountRef",account.subject_ref AS "subjectRef",
  account.security_epoch AS "accountSecurityEpoch",subject.subject_generation AS "subjectGeneration",
  session.session_ref AS "sessionRef",session.session_epoch AS "sessionEpoch",
  session.credential_epoch AS "credentialEpoch",session.authenticated_at AS "authenticatedAt",
  session.authentication_methods AS "authenticationMethods",
  identifier.normalized_value AS "emailNormalized",release.identity_issuer_label AS "identityIssuerLabel",
  release.identity_auth_strength_policy_revision AS "authStrengthPolicyRevision"
  FROM platform.identity_account account
  JOIN platform.authorization_site site
    ON site.site_ref=account.site_ref AND site.state='active'
  JOIN platform.authorization_subject subject
    ON subject.subject_ref=account.subject_ref AND subject.site_ref=account.site_ref
  JOIN platform.authorization_identity_session session
    ON session.subject_ref=account.subject_ref AND session.site_ref=account.site_ref
  JOIN platform.authorization_site_release release
    ON release.site_ref=account.site_ref AND release.release_ref=$5 AND release.state='active'
  JOIN platform.authorization_product_binding product_binding
    ON product_binding.binding_ref=$6 AND product_binding.workload_identity_id=$7
      AND product_binding.site_ref=account.site_ref AND product_binding.release_ref=release.release_ref
      AND product_binding.binding_epoch=$8::bigint AND product_binding.state='active'
  JOIN platform.identity_login_identifier identifier
    ON identifier.site_ref=account.site_ref AND identifier.account_ref=account.account_ref
      AND identifier.subject_ref=account.subject_ref AND identifier.kind='email' AND identifier.status='active'
  WHERE account.site_ref=$1 AND account.subject_ref=$2 AND session.session_ref=$3
    AND account.state='active' AND subject.state='active' AND session.state='active'
    AND session.expires_at>$4::timestamptz`;

const reauthenticationOwnerSelect = `SELECT account.site_ref AS "siteRef",
  site.state AS "siteState",release.release_ref AS "siteReleaseRef",release.state AS "releaseState",
  product_binding.binding_ref AS "siteProjectBindingRef",
  product_binding.workload_identity_id AS "workloadIdentityId",
  product_binding.binding_epoch AS "bindingEpoch",product_binding.state AS "bindingState",
  account.account_ref AS "accountRef",account.subject_ref AS "subjectRef",
  account.security_epoch AS "accountSecurityEpoch",subject.subject_generation AS "subjectGeneration",
  session.session_ref AS "sessionRef",session.session_epoch AS "sessionEpoch",
  session.credential_epoch AS "credentialEpoch",session.authenticated_at AS "authenticatedAt",
  session.authentication_methods AS "authenticationMethods",identifier.normalized_value AS "emailNormalized",
  release.identity_issuer_label AS "identityIssuerLabel",
  release.identity_auth_strength_policy_revision AS "authStrengthPolicyRevision",
  credential.password_hash AS "passwordHash",credential.pepper_version AS "pepperVersion",
  credential.credential_epoch AS "passwordCredentialEpoch",authenticator.authenticator_ref AS "authenticatorRef",
  authenticator.secret_algorithm AS "secretAlgorithm",authenticator.secret_key_revision AS "secretKeyRevision",
  authenticator.secret_nonce AS "secretNonce",authenticator.secret_ciphertext AS "secretCiphertext",
  authenticator.secret_authentication_tag AS "secretAuthenticationTag",
  authenticator.last_accepted_timestep AS "lastAcceptedTimeStep",
  recovery_set.set_ref AS "recoverySetRef"
  FROM platform.identity_account account
  JOIN platform.authorization_site site
    ON site.site_ref=account.site_ref AND site.state='active'
  JOIN platform.authorization_subject subject
    ON subject.subject_ref=account.subject_ref AND subject.site_ref=account.site_ref
  JOIN platform.authorization_identity_session session
    ON session.subject_ref=account.subject_ref AND session.site_ref=account.site_ref
  JOIN platform.authorization_site_release release
    ON release.site_ref=account.site_ref AND release.release_ref=$5 AND release.state='active'
  JOIN platform.authorization_product_binding product_binding
    ON product_binding.binding_ref=$6 AND product_binding.workload_identity_id=$7
      AND product_binding.site_ref=account.site_ref AND product_binding.release_ref=release.release_ref
      AND product_binding.binding_epoch=$8::bigint AND product_binding.state='active'
  JOIN platform.identity_password_credential credential
    ON credential.site_ref=account.site_ref AND credential.account_ref=account.account_ref
  JOIN platform.identity_login_identifier identifier
    ON identifier.site_ref=account.site_ref AND identifier.account_ref=account.account_ref
      AND identifier.subject_ref=account.subject_ref AND identifier.kind='email' AND identifier.status='active'
  LEFT JOIN platform.identity_totp_authenticator authenticator
    ON authenticator.site_ref=account.site_ref AND authenticator.account_ref=account.account_ref
      AND authenticator.subject_ref=account.subject_ref AND authenticator.state='active'
  LEFT JOIN platform.identity_recovery_code_set recovery_set
    ON recovery_set.site_ref=account.site_ref AND recovery_set.account_ref=account.account_ref
      AND recovery_set.subject_ref=account.subject_ref AND recovery_set.state='active'
  WHERE account.site_ref=$1 AND account.subject_ref=$2 AND session.session_ref=$3
    AND account.state='active' AND subject.state='active' AND session.state='active'
    AND session.expires_at>$4::timestamptz`;

const reauthenticationChallengeSelect = `SELECT challenge.site_ref AS "siteRef",
  challenge.transaction_ref AS "transactionRef",challenge.site_release_ref AS "siteReleaseRef",
  challenge.site_project_binding_ref AS "siteProjectBindingRef",challenge.binding_epoch AS "bindingEpoch",
  challenge.workload_identity_id AS "workloadIdentityId",challenge.account_ref AS "accountRef",
  challenge.subject_ref AS "subjectRef",challenge.session_ref AS "sessionRef",
  challenge.audience,challenge.operation_id AS "operationId",challenge.resource_kind AS "resourceKind",
  challenge.resource_ref AS "resourceRef",challenge.account_security_epoch AS "accountSecurityEpoch",
  challenge.subject_generation AS "subjectGeneration",challenge.session_epoch AS "sessionEpoch",
  challenge.credential_epoch AS "credentialEpoch",
  challenge.password_credential_epoch AS "passwordCredentialEpoch",
  challenge.auth_strength_policy_revision AS "authStrengthPolicyRevision",
  challenge.authenticator_ref AS "authenticatorRef",challenge.recovery_set_ref AS "recoverySetRef",
  challenge.state,challenge.attempt_count AS "attemptCount",challenge.max_attempts AS "maxAttempts",
  challenge.expires_at AS "expiresAt",account.security_epoch AS "currentAccountSecurityEpoch",
  subject.subject_generation AS "currentSubjectGeneration",session.session_epoch AS "currentSessionEpoch",
  session.credential_epoch AS "currentCredentialEpoch",session.authenticated_at AS "authenticatedAt",
  session.authentication_methods AS "authenticationMethods",
  credential.credential_epoch AS "currentPasswordCredentialEpoch",
  release.identity_auth_strength_policy_revision AS "currentAuthStrengthPolicyRevision",
  authenticator.secret_algorithm AS "secretAlgorithm",authenticator.secret_key_revision AS "secretKeyRevision",
  authenticator.secret_nonce AS "secretNonce",authenticator.secret_ciphertext AS "secretCiphertext",
  authenticator.secret_authentication_tag AS "secretAuthenticationTag",
  authenticator.last_accepted_timestep AS "lastAcceptedTimeStep",
  active_recovery_set.set_ref AS "currentRecoverySetRef"
  FROM platform.identity_reauthentication_challenge challenge
  JOIN platform.authorization_site site
    ON site.site_ref=challenge.site_ref AND site.state='active'
  JOIN platform.identity_account account
    ON account.site_ref=challenge.site_ref AND account.account_ref=challenge.account_ref
      AND account.subject_ref=challenge.subject_ref AND account.state='active'
  JOIN platform.authorization_subject subject
    ON subject.site_ref=challenge.site_ref AND subject.subject_ref=challenge.subject_ref AND subject.state='active'
  JOIN platform.authorization_identity_session session
    ON session.site_ref=challenge.site_ref AND session.subject_ref=challenge.subject_ref
      AND session.session_ref=challenge.session_ref AND session.state='active'
  JOIN platform.identity_password_credential credential
    ON credential.site_ref=challenge.site_ref AND credential.account_ref=challenge.account_ref
  JOIN platform.authorization_site_release release
    ON release.site_ref=challenge.site_ref AND release.release_ref=challenge.site_release_ref
      AND release.state='active'
  JOIN platform.authorization_product_binding product_binding
    ON product_binding.binding_ref=$4 AND product_binding.workload_identity_id=$5
      AND product_binding.site_ref=challenge.site_ref
      AND product_binding.release_ref=challenge.site_release_ref
      AND product_binding.binding_epoch=$6::bigint AND product_binding.state='active'
      AND challenge.site_project_binding_ref=product_binding.binding_ref
      AND challenge.binding_epoch=product_binding.binding_epoch
  JOIN platform.identity_totp_authenticator authenticator
    ON authenticator.site_ref=challenge.site_ref AND authenticator.authenticator_ref=challenge.authenticator_ref
      AND authenticator.account_ref=challenge.account_ref AND authenticator.subject_ref=challenge.subject_ref
      AND authenticator.state='active'
  LEFT JOIN platform.identity_recovery_code_set active_recovery_set
    ON active_recovery_set.site_ref=challenge.site_ref
      AND active_recovery_set.set_ref=challenge.recovery_set_ref
      AND active_recovery_set.account_ref=challenge.account_ref
      AND active_recovery_set.subject_ref=challenge.subject_ref AND active_recovery_set.state='active'`;

function reauthenticationMaterial(
  owner: ReauthenticationOwnerRow | undefined,
  binding: IdentitySecuritySessionBinding,
): IdentityReauthenticationMaterial | null {
  if (owner === undefined || !bindingMatches(owner, binding) || !validIdentityIssuerLabel(owner.identityIssuerLabel) ||
      !validRevision(owner.authStrengthPolicyRevision)) return null;
  const authenticator = reauthenticationFactor(owner);
  if (owner.authenticatorRef !== null && authenticator === null) return null;
  return Object.freeze({
    accountRef: owner.accountRef, subjectRef: owner.subjectRef, sessionRef: owner.sessionRef,
    emailNormalized: owner.emailNormalized, identityIssuerLabel: owner.identityIssuerLabel,
    accountSecurityEpoch: owner.accountSecurityEpoch.toString(),
    subjectGeneration: owner.subjectGeneration.toString(), sessionEpoch: owner.sessionEpoch.toString(),
    credentialEpoch: owner.credentialEpoch.toString(), authenticatedAt: instant(owner.authenticatedAt),
    authenticationMethods: authenticationMethods(owner.authenticationMethods), passwordHash: owner.passwordHash,
    pepperVersion: owner.pepperVersion, passwordCredentialEpoch: owner.passwordCredentialEpoch.toString(),
    authStrengthPolicyRevision: owner.authStrengthPolicyRevision,
    recoverySetRef: owner.recoverySetRef,
    authenticator,
  });
}

function reauthenticationFactor(owner: ReauthenticationOwnerRow): IdentityReauthenticationMaterial["authenticator"] {
  if (owner.authenticatorRef === null) return null;
  if (owner.secretAlgorithm !== "A256GCM" || owner.secretKeyRevision === null || owner.secretNonce === null ||
      owner.secretCiphertext === null || owner.secretAuthenticationTag === null) return null;
  return Object.freeze({
    authenticatorRef: owner.authenticatorRef,
    envelope: Object.freeze({
      algorithm: "A256GCM" as const, keyRevision: owner.secretKeyRevision, nonce: owner.secretNonce,
      ciphertext: owner.secretCiphertext, authenticationTag: owner.secretAuthenticationTag,
    }),
    lastAcceptedTimeStep: owner.lastAcceptedTimeStep === null ? null : Number(owner.lastAcceptedTimeStep),
  });
}

function challengeMatches(
  row: ReauthenticationChallengeRow,
  input: Readonly<{
    binding: IdentitySecuritySessionBinding;
    workloadIdentityId: string;
    target: IdentityReauthenticationTarget;
  }>,
): boolean {
  const methods = authenticationMethods(row.authenticationMethods);
  return row.siteRef === input.binding.siteRef && row.siteReleaseRef === input.binding.siteReleaseRef &&
    row.siteProjectBindingRef === input.binding.siteProjectBindingRef &&
    row.bindingEpoch.toString() === input.binding.bindingEpoch &&
    input.workloadIdentityId === input.binding.workloadIdentityId &&
    row.workloadIdentityId === input.binding.workloadIdentityId && row.subjectRef === input.binding.subjectRef &&
    row.sessionRef === input.binding.sessionRef && row.audience === input.target.audience &&
    row.operationId === input.target.operationId && row.resourceKind === input.target.resourceKind &&
    row.resourceRef === row.accountRef && row.accountSecurityEpoch === row.currentAccountSecurityEpoch &&
    row.subjectGeneration === row.currentSubjectGeneration &&
    row.subjectGeneration.toString() === input.binding.subjectGeneration &&
    row.sessionEpoch === row.currentSessionEpoch && row.sessionEpoch.toString() === input.binding.sessionEpoch &&
    row.credentialEpoch === row.currentCredentialEpoch &&
    row.credentialEpoch.toString() === input.binding.credentialEpoch &&
    row.passwordCredentialEpoch === row.currentPasswordCredentialEpoch &&
    row.authStrengthPolicyRevision === row.currentAuthStrengthPolicyRevision &&
    instant(row.authenticatedAt) === input.binding.authenticatedAt &&
    methods.length === input.binding.authenticationMethods.length &&
    methods.every((method, index) => method === input.binding.authenticationMethods[index]) &&
    (row.recoverySetRef === null || row.currentRecoverySetRef === row.recoverySetRef);
}

function reauthenticationChallengeMaterial(
  row: ReauthenticationChallengeRow,
  recoveryCodes: readonly RecoveryCodeDigestRow[],
): IdentityReauthenticationChallengeMaterial | null {
  if (row.secretAlgorithm !== "A256GCM" || row.secretKeyRevision === null || row.secretNonce === null ||
      row.secretCiphertext === null || row.secretAuthenticationTag === null ||
      !sensitiveOperation(row.operationId) || !validRevision(row.authStrengthPolicyRevision)) return null;
  return Object.freeze({
    accountRef: row.accountRef, subjectRef: row.subjectRef, sessionRef: row.sessionRef,
    transactionRef: row.transactionRef,
    target: Object.freeze({ audience: "platform-public" as const, operationId: row.operationId,
      resourceKind: "identity_account" as const }),
    authStrengthPolicyRevision: row.authStrengthPolicyRevision, expiresAt: instant(row.expiresAt),
    authenticator: Object.freeze({
      authenticatorRef: row.authenticatorRef,
      envelope: Object.freeze({ algorithm: "A256GCM" as const, keyRevision: row.secretKeyRevision,
        nonce: row.secretNonce, ciphertext: row.secretCiphertext,
        authenticationTag: row.secretAuthenticationTag }),
      lastAcceptedTimeStep: row.lastAcceptedTimeStep === null ? null : Number(row.lastAcceptedTimeStep),
    }),
    recoverySetRef: row.recoverySetRef,
    recoveryCodeDigests: Object.freeze(recoveryCodes.map((item) => item.codeDigest)),
  });
}

async function rejectReauthenticationChallenge(
  sql: PlatformSqlTransaction,
  challenge: ReauthenticationChallengeRow,
  now: string,
): Promise<void> {
  const changed = await sql.execute(
    `UPDATE platform.identity_reauthentication_challenge
     SET attempt_count=LEAST(max_attempts,attempt_count+1),
         state=CASE WHEN attempt_count+1>=max_attempts THEN 'locked' ELSE 'pending' END,
         updated_at=$3::timestamptz
     WHERE site_ref=$1 AND transaction_ref=$2 AND state='pending'`,
    [challenge.siteRef, challenge.transactionRef, now],
  );
  if (changed !== 1) throw new Error("IDENTITY_REAUTHENTICATION_CHALLENGE_FAILURE_STALE");
  const rate = (await sql.query<AuthRateRow>(
    `SELECT failed_attempt_count AS "failedAttemptCount",window_started_at AS "windowStartedAt",
            locked_until AS "lockedUntil" FROM platform.identity_auth_rate_limit
     WHERE site_ref=$1 AND account_ref=$2 AND purpose='reauthentication' FOR UPDATE`,
    [challenge.siteRef, challenge.accountRef],
  ))[0];
  await recordReauthenticationRateFailure(sql, challenge.siteRef, challenge.accountRef, now, rate);
}

async function reauthenticationLocked(
  sql: PlatformSqlTransaction,
  siteRef: string,
  accountRef: string,
  now: string,
): Promise<boolean> {
  const rate = (await sql.query<AuthRateRow>(
    `SELECT failed_attempt_count AS "failedAttemptCount",window_started_at AS "windowStartedAt",
            locked_until AS "lockedUntil"
     FROM platform.identity_auth_rate_limit
     WHERE site_ref=$1 AND account_ref=$2 AND purpose='reauthentication' FOR UPDATE`,
    [siteRef, accountRef],
  ))[0];
  return rate?.lockedUntil !== null && rate?.lockedUntil !== undefined &&
    Date.parse(instant(rate.lockedUntil)) > Date.parse(now);
}

async function recordReauthenticationRateFailure(
  sql: PlatformSqlTransaction,
  siteRef: string,
  accountRef: string,
  now: string,
  current: AuthRateRow | undefined,
): Promise<void> {
  const windowMilliseconds = 15 * 60_000;
  const currentWindow = current !== undefined &&
    Date.parse(instant(current.windowStartedAt)) + windowMilliseconds > Date.parse(now);
  const failedAttemptCount = Math.min(10, currentWindow ? current.failedAttemptCount + 1 : 1);
  const windowStartedAt = currentWindow ? instant(current.windowStartedAt) : now;
  const lockedUntil = failedAttemptCount >= 10 ? new Date(Date.parse(now) + windowMilliseconds).toISOString() : null;
  const changed = await sql.execute(
    `INSERT INTO platform.identity_auth_rate_limit
     (site_ref,account_ref,purpose,window_started_at,failed_attempt_count,locked_until,updated_at)
     VALUES ($1,$2,'reauthentication',$3::timestamptz,$4,$5::timestamptz,$6::timestamptz)
     ON CONFLICT(site_ref,account_ref,purpose) DO UPDATE SET
       window_started_at=EXCLUDED.window_started_at,failed_attempt_count=EXCLUDED.failed_attempt_count,
       locked_until=EXCLUDED.locked_until,updated_at=EXCLUDED.updated_at`,
    [siteRef, accountRef, windowStartedAt, failedAttemptCount, lockedUntil, now],
  );
  if (changed !== 1) throw new Error("IDENTITY_REAUTHENTICATION_RATE_UPDATE_FAILED");
}

async function resetReauthenticationRate(
  sql: PlatformSqlTransaction,
  siteRef: string,
  accountRef: string,
  now: string,
): Promise<void> {
  await sql.execute(
    `INSERT INTO platform.identity_auth_rate_limit
     (site_ref,account_ref,purpose,window_started_at,failed_attempt_count,locked_until,updated_at)
     VALUES ($1,$2,'reauthentication',$3::timestamptz,0,NULL,$3::timestamptz)
     ON CONFLICT(site_ref,account_ref,purpose) DO UPDATE SET
       window_started_at=EXCLUDED.window_started_at,failed_attempt_count=0,locked_until=NULL,updated_at=EXCLUDED.updated_at`,
    [siteRef, accountRef, now],
  );
}

async function insertReauthenticationProof(
  sql: PlatformSqlTransaction,
  input: Readonly<{
    binding: IdentitySecuritySessionBinding; accountRef: string; workloadIdentityId: string;
    commandId?: string; newCommandId?: string; requestDigest: string; proofDigest: string;
    target: IdentityReauthenticationTarget; authStrengthPolicyRevision: string; now: string; expiresAt: string;
  }>,
  owner: Readonly<{ accountSecurityEpoch: bigint }>,
): Promise<void> {
  const commandId = input.commandId ?? input.newCommandId;
  if (commandId === undefined) throw new Error("IDENTITY_REAUTHENTICATION_COMMAND_REQUIRED");
  const proof = await sql.execute(
    `INSERT INTO platform.identity_reauthentication_proof
     (proof_digest,issuing_command_id,site_ref,site_release_ref,site_project_binding_ref,
      workload_identity_id,binding_epoch,account_ref,subject_ref,
      session_ref,audience,operation_id,resource_kind,resource_ref,account_security_epoch,subject_generation,
      session_epoch,credential_epoch,auth_strength_policy_revision,state,issued_at,expires_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$19,$5,$20::bigint,$6,$7,$8,$9,$10,$11,$6,$12::bigint,$13::bigint,$14::bigint,$15::bigint,
             $16,'active',$17::timestamptz,$18::timestamptz,$17::timestamptz,$17::timestamptz)`,
    [input.proofDigest, commandId, input.binding.siteRef, input.binding.siteReleaseRef,
      input.workloadIdentityId, input.accountRef, input.binding.subjectRef, input.binding.sessionRef,
      input.target.audience, input.target.operationId, input.target.resourceKind,
      owner.accountSecurityEpoch.toString(), input.binding.subjectGeneration, input.binding.sessionEpoch,
      input.binding.credentialEpoch, input.authStrengthPolicyRevision, input.now, input.expiresAt,
      input.binding.siteProjectBindingRef, input.binding.bindingEpoch],
  );
  const claim = await sql.execute(
    `INSERT INTO platform.identity_reauthentication_delivery_claim
     (command_id,proof_digest,site_ref,account_ref,subject_ref,session_ref,request_digest,state,claimed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'first_claim_consumed',$8::timestamptz)`,
    [commandId, input.proofDigest, input.binding.siteRef, input.accountRef, input.binding.subjectRef,
      input.binding.sessionRef, input.requestDigest, input.now],
  );
  if (proof !== 1 || claim !== 1) throw new Error("IDENTITY_REAUTHENTICATION_PROOF_CREATE_FAILED");
}

async function consumeReauthenticationProof(
  sql: PlatformSqlTransaction,
  input: Readonly<{
    binding: IdentitySecuritySessionBinding; accountRef: string; commandId: string;
    proof: IdentityReauthenticationProofBinding; now: string;
  }>,
): Promise<boolean> {
  const changed = await sql.execute(
    `UPDATE platform.identity_reauthentication_proof proof
     SET state='consumed',consumed_at=$14::timestamptz,consuming_command_id=$13,updated_at=$14::timestamptz
     FROM platform.authorization_site site,
          platform.authorization_site_release release,
          platform.authorization_product_binding binding
     WHERE proof.proof_digest=$1 AND proof.site_ref=$2 AND proof.site_release_ref=$3
       AND proof.workload_identity_id=$4 AND proof.account_ref=$5 AND proof.subject_ref=$6
       AND proof.session_ref=$7 AND proof.audience=$8 AND proof.operation_id=$9
       AND proof.resource_kind=$10 AND proof.resource_ref=$5 AND proof.account_security_epoch=(
         SELECT security_epoch FROM platform.identity_account WHERE site_ref=$2 AND account_ref=$5
       )
       AND proof.subject_generation=$11::bigint AND proof.session_epoch=$12::bigint
       AND proof.credential_epoch=$15::bigint AND proof.auth_strength_policy_revision=$16
       AND proof.state='active' AND proof.expires_at>$14::timestamptz
       AND site.site_ref=proof.site_ref AND site.state='active'
       AND release.site_ref=proof.site_ref AND release.release_ref=proof.site_release_ref
       AND release.state='active' AND release.identity_auth_strength_policy_revision=$16
       AND binding.binding_ref=$17 AND binding.workload_identity_id=$18
       AND binding.workload_identity_id=proof.workload_identity_id
       AND binding.site_ref=proof.site_ref AND binding.release_ref=proof.site_release_ref
       AND proof.site_project_binding_ref=binding.binding_ref
       AND proof.binding_epoch=binding.binding_epoch
       AND binding.binding_epoch=$19::bigint AND binding.state='active'`,
    [input.proof.proofDigest, input.binding.siteRef, input.binding.siteReleaseRef,
      input.proof.workloadIdentityId, input.accountRef, input.binding.subjectRef, input.binding.sessionRef,
      input.proof.target.audience, input.proof.target.operationId, input.proof.target.resourceKind,
      input.binding.subjectGeneration, input.binding.sessionEpoch, input.commandId, input.now,
      input.binding.credentialEpoch, input.proof.expectedAuthStrengthPolicyRevision,
      input.binding.siteProjectBindingRef, input.binding.workloadIdentityId, input.binding.bindingEpoch],
  );
  return changed === 1;
}

async function lockReauthenticationProof(
  sql: PlatformSqlTransaction,
  input: Readonly<{
    binding: IdentitySecuritySessionBinding;
    accountRef: string;
    proof: IdentityReauthenticationProofBinding;
    now: string;
  }>,
): Promise<boolean> {
  const rows = await sql.query<Record<string, unknown>>(
    `SELECT 1
     FROM platform.identity_reauthentication_proof proof
     JOIN platform.authorization_site site
       ON site.site_ref=proof.site_ref
     JOIN platform.authorization_site_release release
       ON release.site_ref=proof.site_ref AND release.release_ref=proof.site_release_ref
     JOIN platform.authorization_product_binding binding
       ON binding.workload_identity_id=proof.workload_identity_id
         AND binding.site_ref=proof.site_ref AND binding.release_ref=proof.site_release_ref
         AND proof.site_project_binding_ref=binding.binding_ref
         AND proof.binding_epoch=binding.binding_epoch
     JOIN platform.identity_account account
       ON account.site_ref=proof.site_ref AND account.account_ref=proof.account_ref
     WHERE proof.proof_digest=$1 AND proof.site_ref=$2 AND proof.site_release_ref=$3
       AND proof.workload_identity_id=$4 AND proof.account_ref=$5 AND proof.subject_ref=$6
       AND proof.session_ref=$7 AND proof.audience=$8 AND proof.operation_id=$9
       AND proof.resource_kind=$10 AND proof.resource_ref=$5
       AND proof.account_security_epoch=account.security_epoch
       AND proof.subject_generation=$11::bigint AND proof.session_epoch=$12::bigint
       AND proof.credential_epoch=$13::bigint AND proof.auth_strength_policy_revision=$15
       AND proof.state='active' AND proof.expires_at>$14::timestamptz
       AND site.state='active'
       AND release.state='active' AND release.identity_auth_strength_policy_revision=$15
       AND binding.binding_ref=$16 AND binding.workload_identity_id=$17
       AND binding.binding_epoch=$18::bigint AND binding.state='active'
     FOR UPDATE OF proof FOR SHARE OF site,release,binding`,
    [input.proof.proofDigest, input.binding.siteRef, input.binding.siteReleaseRef,
      input.proof.workloadIdentityId, input.accountRef, input.binding.subjectRef, input.binding.sessionRef,
      input.proof.target.audience, input.proof.target.operationId, input.proof.target.resourceKind,
      input.binding.subjectGeneration, input.binding.sessionEpoch, input.binding.credentialEpoch,
      input.now, input.proof.expectedAuthStrengthPolicyRevision,
      input.binding.siteProjectBindingRef, input.binding.workloadIdentityId, input.binding.bindingEpoch],
  );
  return rows.length === 1;
}

function sensitiveOperation(value: string): value is IdentityReauthenticationTarget["operationId"] {
  return value === "beginTotpEnrollment" || value === "disableTotp" || value === "regenerateRecoveryCodes";
}

function validRevision(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/u.test(value);
}

async function lockAccount(
  sql: PlatformSqlTransaction,
  siteRef: string,
  accountRef: string,
): Promise<void> {
  await sql.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
    `identity-security\0${siteRef}\0${accountRef}`,
  ]);
}

async function lockSecurityOwner(
  sql: PlatformSqlTransaction,
  binding: IdentitySecuritySessionBinding,
  now: string,
): Promise<SecurityOwnerRow | null> {
  const rows = await sql.query<SecurityOwnerRow>(
    `${securityOwnerSelect}
     FOR UPDATE OF account,subject,session
     FOR SHARE OF site,release,product_binding`,
    securityAuthorityValues(binding, now),
  );
  const owner = rows[0];
  return owner !== undefined && bindingMatches(owner, binding) ? owner : null;
}

function expectedOwner(
  owner: SecurityOwnerRow | null,
  accountRef: string,
  securityEpoch: string,
): boolean {
  return (
    owner !== null &&
    owner.accountRef === accountRef &&
    owner.accountSecurityEpoch.toString() === securityEpoch
  );
}

function bindingMatches(owner: SecurityOwnerRow, binding: IdentitySecuritySessionBinding): boolean {
  const methods = authenticationMethods(owner.authenticationMethods);
  return (
    owner.siteRef === binding.siteRef &&
    owner.siteState === "active" &&
    owner.siteReleaseRef === binding.siteReleaseRef &&
    owner.releaseState === "active" &&
    owner.siteProjectBindingRef === binding.siteProjectBindingRef &&
    owner.workloadIdentityId === binding.workloadIdentityId &&
    owner.bindingEpoch.toString() === binding.bindingEpoch &&
    owner.bindingState === "active" &&
    owner.subjectRef === binding.subjectRef &&
    owner.sessionRef === binding.sessionRef &&
    owner.subjectGeneration.toString() === binding.subjectGeneration &&
    owner.sessionEpoch.toString() === binding.sessionEpoch &&
    owner.credentialEpoch.toString() === binding.credentialEpoch &&
    instant(owner.authenticatedAt) === binding.authenticatedAt &&
    methods.length === binding.authenticationMethods.length &&
    methods.every((method, index) => method === binding.authenticationMethods[index])
  );
}

function recoveryAuthorityMatches(
  recovery: FrozenRecoveryAuthorityRow,
  binding: IdentitySecuritySessionBinding,
  workloadIdentityId: string,
): boolean {
  return recovery.recoverySiteRef === binding.siteRef &&
    recovery.recoverySiteReleaseRef === binding.siteReleaseRef &&
    recovery.recoverySiteProjectBindingRef === binding.siteProjectBindingRef &&
    recovery.recoveryWorkloadIdentityId === workloadIdentityId &&
    workloadIdentityId === binding.workloadIdentityId &&
    recovery.recoveryBindingEpoch.toString() === binding.bindingEpoch;
}

function securityAuthorityValues(
  binding: IdentitySecuritySessionBinding,
  now: string,
): readonly unknown[] {
  return [
    binding.siteRef,
    binding.subjectRef,
    binding.sessionRef,
    now,
    binding.siteReleaseRef,
    binding.siteProjectBindingRef,
    binding.workloadIdentityId,
    binding.bindingEpoch,
  ];
}

async function expireTotpEnrollments(
  sql: PlatformSqlTransaction,
  siteRef: string,
  accountRef: string,
  now: string,
): Promise<void> {
  await sql.execute(
    `WITH expired AS (
       UPDATE platform.identity_totp_enrollment_transaction
       SET state='expired',updated_at=$3::timestamptz
       WHERE site_ref=$1 AND account_ref=$2 AND state='pending' AND expires_at<=$3::timestamptz
       RETURNING authenticator_ref
     )
     UPDATE platform.identity_totp_authenticator authenticator
     SET state='revoked',revoked_at=$3::timestamptz,updated_at=$3::timestamptz
     FROM expired
     WHERE authenticator.site_ref=$1 AND authenticator.authenticator_ref=expired.authenticator_ref
       AND authenticator.state='pending'`,
    [siteRef, accountRef, now],
  );
}

async function activeTotpExists(
  sql: PlatformSqlTransaction,
  siteRef: string,
  accountRef: string,
): Promise<boolean> {
  return (
    (
      await sql.query<Record<string, unknown>>(
        `SELECT 1 FROM platform.identity_totp_authenticator
     WHERE site_ref=$1 AND account_ref=$2 AND state='active' LIMIT 1`,
        [siteRef, accountRef],
      )
    ).length > 0
  );
}

async function pendingTotpEnrollmentExists(
  sql: PlatformSqlTransaction,
  siteRef: string,
  accountRef: string,
): Promise<boolean> {
  return (
    (
      await sql.query<Record<string, unknown>>(
        `SELECT 1 FROM platform.identity_totp_enrollment_transaction
     WHERE site_ref=$1 AND account_ref=$2 AND state='pending' LIMIT 1`,
        [siteRef, accountRef],
      )
    ).length > 0
  );
}

async function insertTotpEnrollment(
  sql: PlatformSqlTransaction,
  input: Readonly<{
    binding: IdentitySecuritySessionBinding;
    accountRef: string;
    commandId: string;
    requestDigest: string;
    transactionRef: string;
    authenticatorRef: string;
    envelope: Readonly<{
      algorithm: "A256GCM";
      keyRevision: string;
      nonce: string;
      ciphertext: string;
      authenticationTag: string;
    }>;
    expectedAccountSecurityEpoch: string;
    now: string;
    expiresAt: string;
  }>,
): Promise<void> {
  const factor = await sql.execute(
    `INSERT INTO platform.identity_totp_authenticator
     (site_ref,authenticator_ref,account_ref,subject_ref,state,secret_algorithm,secret_key_revision,
      secret_nonce,secret_ciphertext,secret_authentication_tag,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'pending','A256GCM',$5,$6,$7,$8,$9::timestamptz,$9::timestamptz)`,
    [
      input.binding.siteRef,
      input.authenticatorRef,
      input.accountRef,
      input.binding.subjectRef,
      input.envelope.keyRevision,
      input.envelope.nonce,
      input.envelope.ciphertext,
      input.envelope.authenticationTag,
      input.now,
    ],
  );
  const enrollment = await sql.execute(
    `INSERT INTO platform.identity_totp_enrollment_transaction
     (site_ref,transaction_ref,account_ref,subject_ref,session_ref,authenticator_ref,
      account_security_epoch,subject_generation,session_epoch,credential_epoch,
      initiating_command_id,request_digest,expires_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::bigint,$8::bigint,$9::bigint,$10::bigint,
             $11,$12,$13::timestamptz,$14::timestamptz,$14::timestamptz)`,
    [
      input.binding.siteRef,
      input.transactionRef,
      input.accountRef,
      input.binding.subjectRef,
      input.binding.sessionRef,
      input.authenticatorRef,
      input.expectedAccountSecurityEpoch,
      input.binding.subjectGeneration,
      input.binding.sessionEpoch,
      input.binding.credentialEpoch,
      input.commandId,
      input.requestDigest,
      input.expiresAt,
      input.now,
    ],
  );
  const claim = await sql.execute(
    `INSERT INTO platform.identity_totp_enrollment_delivery_claim
     (command_id,site_ref,account_ref,subject_ref,session_ref,transaction_ref,request_digest,state,claimed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'first_claim_consumed',$8::timestamptz)`,
    [
      input.commandId,
      input.binding.siteRef,
      input.accountRef,
      input.binding.subjectRef,
      input.binding.sessionRef,
      input.transactionRef,
      input.requestDigest,
      input.now,
    ],
  );
  if (factor !== 1 || enrollment !== 1 || claim !== 1)
    throw new Error("IDENTITY_TOTP_ENROLLMENT_CREATE_FAILED");
}

async function recordCeremonyFailure(
  sql: PlatformSqlTransaction,
  table: "identity_totp_enrollment_transaction",
  siteRef: string,
  transactionRef: string,
  now: string,
): Promise<void> {
  const rows = await sql.query<
    { authenticatorRef: string; state: "pending" | "locked" } & Record<string, unknown>
  >(
    `UPDATE platform.${table}
     SET attempt_count=LEAST(max_attempts,attempt_count+1),
         state=CASE WHEN attempt_count+1>=max_attempts THEN 'locked' ELSE 'pending' END,
         updated_at=$3::timestamptz
     WHERE site_ref=$1 AND transaction_ref=$2 AND state='pending'
     RETURNING authenticator_ref AS "authenticatorRef",state`,
    [siteRef, transactionRef, now],
  );
  const changed = rows[0];
  if (changed === undefined) throw new Error("IDENTITY_SECURITY_CEREMONY_FAILURE_STALE");
  if (changed.state === "locked") {
    const revoked = await sql.execute(
      `UPDATE platform.identity_totp_authenticator
       SET state='revoked',revoked_at=$3::timestamptz,updated_at=$3::timestamptz
       WHERE site_ref=$1 AND authenticator_ref=$2 AND state='pending'`,
      [siteRef, changed.authenticatorRef, now],
    );
    if (revoked !== 1) throw new Error("IDENTITY_TOTP_ENROLLMENT_LOCK_STALE");
  }
}

async function replaceRecoveryCodeSet(
  sql: PlatformSqlTransaction,
  input: Readonly<{
    siteRef: string;
    accountRef: string;
    subjectRef: string;
    setRef: string;
    recoveryCodeDigests: readonly RecoveryCodeDigest[];
    now: string;
  }>,
): Promise<void> {
  if (
    input.recoveryCodeDigests.length !== 10 ||
    new Set(input.recoveryCodeDigests.map((item) => item.codeDigest)).size !== 10 ||
    input.recoveryCodeDigests.some((item) => !/^[a-f0-9]{64}$/u.test(item.codeDigest))
  ) {
    throw new Error("IDENTITY_RECOVERY_CODE_SET_INVALID");
  }
  await sql.execute(
    `UPDATE platform.identity_recovery_code code SET state='revoked'
     FROM platform.identity_recovery_code_set code_set
     WHERE code_set.site_ref=$1 AND code_set.account_ref=$2 AND code_set.state='active'
       AND code.site_ref=code_set.site_ref AND code.set_ref=code_set.set_ref AND code.state='active'`,
    [input.siteRef, input.accountRef],
  );
  await sql.execute(
    `UPDATE platform.identity_recovery_code_set
     SET state='replaced',replaced_at=$3::timestamptz,updated_at=$3::timestamptz
     WHERE site_ref=$1 AND account_ref=$2 AND state='active'`,
    [input.siteRef, input.accountRef, input.now],
  );
  const set = await sql.execute(
    `INSERT INTO platform.identity_recovery_code_set
     (site_ref,set_ref,account_ref,subject_ref,generation,state,created_at,updated_at)
     SELECT $1,$2,$3,$4,COALESCE(MAX(generation),0)+1,'active',$5::timestamptz,$5::timestamptz
     FROM platform.identity_recovery_code_set WHERE site_ref=$1 AND account_ref=$3`,
    [input.siteRef, input.setRef, input.accountRef, input.subjectRef, input.now],
  );
  if (set !== 1) throw new Error("IDENTITY_RECOVERY_CODE_SET_CREATE_FAILED");
  for (const item of input.recoveryCodeDigests) {
    const code = await sql.execute(
      `INSERT INTO platform.identity_recovery_code(site_ref,set_ref,code_digest,state,created_at)
       VALUES ($1,$2,$3,'active',$4::timestamptz)`,
      [input.siteRef, input.setRef, item.codeDigest, input.now],
    );
    if (code !== 1) throw new Error("IDENTITY_RECOVERY_CODE_CREATE_FAILED");
  }
}

async function revokeRecoveryCodeSets(
  sql: PlatformSqlTransaction,
  siteRef: string,
  accountRef: string,
  now: string,
): Promise<void> {
  await sql.execute(
    `UPDATE platform.identity_recovery_code code SET state='revoked'
     FROM platform.identity_recovery_code_set code_set
     WHERE code_set.site_ref=$1 AND code_set.account_ref=$2 AND code_set.state='active'
       AND code.site_ref=code_set.site_ref AND code.set_ref=code_set.set_ref AND code.state='active'`,
    [siteRef, accountRef],
  );
  await sql.execute(
    `UPDATE platform.identity_recovery_code_set
     SET state='revoked',revoked_at=$3::timestamptz,updated_at=$3::timestamptz
     WHERE site_ref=$1 AND account_ref=$2 AND state='active'`,
    [siteRef, accountRef, now],
  );
}

async function incrementSecurityEpoch(
  sql: PlatformSqlTransaction,
  siteRef: string,
  accountRef: string,
  now: string,
): Promise<string> {
  const rows = await sql.query<{ securityEpoch: bigint } & Record<string, unknown>>(
    `UPDATE platform.identity_account SET security_epoch=security_epoch+1,updated_at=$3::timestamptz
     WHERE site_ref=$1 AND account_ref=$2 AND state='active'
     RETURNING security_epoch AS "securityEpoch"`,
    [siteRef, accountRef, now],
  );
  const epoch = rows[0]?.securityEpoch;
  if (epoch === undefined) throw new Error("IDENTITY_SECURITY_EPOCH_INCREMENT_FAILED");
  return epoch.toString();
}

async function insertRecoveryCodeDeliveryClaim(
  sql: PlatformSqlTransaction,
  input: Readonly<{
    commandId: string;
    siteRef: string;
    accountRef: string;
    subjectRef: string;
    sessionRef: string;
    setRef: string;
    purpose: "confirmTotpEnrollment" | "regenerateRecoveryCodes";
    requestDigest: string;
    now: string;
  }>,
): Promise<void> {
  const changed = await sql.execute(
    `INSERT INTO platform.identity_recovery_code_delivery_claim
     (command_id,site_ref,account_ref,subject_ref,session_ref,set_ref,purpose,request_digest,state,claimed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'first_claim_consumed',$9::timestamptz)`,
    [
      input.commandId,
      input.siteRef,
      input.accountRef,
      input.subjectRef,
      input.sessionRef,
      input.setRef,
      input.purpose,
      input.requestDigest,
      input.now,
    ],
  );
  if (changed !== 1) throw new Error("IDENTITY_RECOVERY_CODE_DELIVERY_CREATE_FAILED");
}

function authenticationMethods(value: unknown): readonly ("password" | "totp" | "recovery_code")[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 3 ||
    value.some((item) => item !== "password" && item !== "totp" && item !== "recovery_code")
  ) {
    throw new Error("IDENTITY_AUTHENTICATION_METHODS_INVALID");
  }
  return Object.freeze([...value]) as readonly ("password" | "totp" | "recovery_code")[];
}

function validIdentityIssuerLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 64 &&
    value.trim() === value &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

function digestEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "ascii");
  const b = Buffer.from(right, "ascii");
  return a.length === b.length && timingSafeEqual(a, b);
}

function instant(value: string | Date): string {
  return new Date(value).toISOString();
}

interface SecurityOwnerRow extends Record<string, unknown> {
  siteRef: string;
  siteState: string;
  siteReleaseRef: string;
  releaseState: string;
  siteProjectBindingRef: string;
  workloadIdentityId: string;
  bindingEpoch: bigint;
  bindingState: string;
  accountRef: string;
  subjectRef: string;
  sessionRef: string;
  emailNormalized: string;
  identityIssuerLabel: string;
  authStrengthPolicyRevision: string;
  accountSecurityEpoch: bigint;
  subjectGeneration: bigint;
  sessionEpoch: bigint;
  credentialEpoch: bigint;
  authenticatedAt: string | Date;
  authenticationMethods: unknown;
}

interface ReauthenticationOwnerRow extends SecurityOwnerRow {
  passwordHash: string;
  pepperVersion: number;
  passwordCredentialEpoch: bigint;
  authStrengthPolicyRevision: string;
  authenticatorRef: string | null;
  secretAlgorithm: string | null;
  secretKeyRevision: string | null;
  secretNonce: string | null;
  secretCiphertext: string | null;
  secretAuthenticationTag: string | null;
  lastAcceptedTimeStep: bigint | null;
  recoverySetRef: string | null;
}

interface AuthRateRow extends Record<string, unknown> {
  failedAttemptCount: number;
  windowStartedAt: string | Date;
  lockedUntil: string | Date | null;
}

interface RecoveryCodeDigestRow extends Record<string, unknown> {
  codeDigest: string;
}

interface ReauthenticationChallengeRow extends Record<string, unknown> {
  siteRef: string;
  transactionRef: string;
  siteReleaseRef: string;
  siteProjectBindingRef: string;
  workloadIdentityId: string;
  bindingEpoch: bigint;
  accountRef: string;
  subjectRef: string;
  sessionRef: string;
  audience: string;
  operationId: string;
  resourceKind: string;
  resourceRef: string;
  accountSecurityEpoch: bigint;
  subjectGeneration: bigint;
  sessionEpoch: bigint;
  credentialEpoch: bigint;
  passwordCredentialEpoch: bigint;
  authStrengthPolicyRevision: string;
  authenticatorRef: string;
  recoverySetRef: string | null;
  state: "pending" | "consumed" | "expired" | "locked";
  attemptCount: number;
  maxAttempts: number;
  expiresAt: string | Date;
  currentAccountSecurityEpoch: bigint;
  currentSubjectGeneration: bigint;
  currentSessionEpoch: bigint;
  currentCredentialEpoch: bigint;
  authenticatedAt: string | Date;
  authenticationMethods: unknown;
  currentPasswordCredentialEpoch: bigint;
  currentAuthStrengthPolicyRevision: string;
  secretAlgorithm: string | null;
  secretKeyRevision: string | null;
  secretNonce: string | null;
  secretCiphertext: string | null;
  secretAuthenticationTag: string | null;
  lastAcceptedTimeStep: bigint | null;
  currentRecoverySetRef: string | null;
}

interface FrozenRecoveryAuthorityRow extends Record<string, unknown> {
  recoverySiteRef: string;
  recoverySiteReleaseRef: string;
  recoverySiteProjectBindingRef: string;
  recoveryWorkloadIdentityId: string;
  recoveryBindingEpoch: bigint;
}

interface ReauthenticationRecoveryRow extends FrozenRecoveryAuthorityRow {
  proofDigest: string;
  proofState: string;
  proofExpiresAt: string | Date;
  proofSiteReleaseRef: string;
  proofSiteProjectBindingRef: string;
  proofWorkloadIdentityId: string;
  proofBindingEpoch: bigint;
  audience: string;
  operationId: string;
  resourceKind: string;
  authStrengthPolicyRevision: string;
  claimState: string;
  claimRequestDigest: string;
  receiptRequestDigest: string;
  operation: string;
  receiptState: string;
  callerIdentity: string;
  recoveryPurpose: string;
  capabilityDigest: string;
  recoveryState: string;
  recoveryExpiresAt: string | Date;
}

interface RecoveryCodeRecoveryRow extends FrozenRecoveryAuthorityRow {
  setRef: string;
  setState: string;
  claimState: string;
  claimRequestDigest: string;
  receiptRequestDigest: string;
  operation: string;
  receiptState: string;
  callerIdentity: string;
  recoveryPurpose: string;
  recoveryTransactionRef: string | null;
  capabilityDigest: string;
  recoveryState: string;
  recoveryExpiresAt: string | Date;
}

interface TotpEnrollmentRow extends Record<string, unknown> {
  accountRef: string;
  subjectRef: string;
  sessionRef: string;
  transactionRef: string;
  expiresAt: string | Date;
  authenticatorRef: string;
  accountSecurityEpoch: bigint;
  secretAlgorithm: string;
  secretKeyRevision: string;
  secretNonce: string;
  secretCiphertext: string;
  secretAuthenticationTag: string;
  lastAcceptedTimeStep: bigint | null;
}

interface TotpEnrollmentLockRow extends Record<string, unknown> {
  accountRef: string;
  authenticatorRef: string;
  state: "pending" | "confirmed" | "expired" | "locked" | "superseded";
  attemptCount: number;
  maxAttempts: number;
  expiresAt: string | Date;
  accountSecurityEpoch: bigint;
  subjectGeneration: bigint;
  sessionEpoch: bigint;
  credentialEpoch: bigint;
  lastAcceptedTimeStep: bigint | null;
}

interface EnrollmentRecoveryRow extends FrozenRecoveryAuthorityRow {
  authenticatorRef: string;
  enrollmentState: string;
  enrollmentExpiresAt: string | Date;
  claimRequestDigest: string;
  claimState: string;
  receiptRequestDigest: string;
  operation: string;
  receiptState: string;
  callerIdentity: string;
  recoveryPurpose: string;
  recoveryTransactionRef: string | null;
  capabilityDigest: string;
  recoveryState: string;
  recoveryExpiresAt: string | Date;
}
