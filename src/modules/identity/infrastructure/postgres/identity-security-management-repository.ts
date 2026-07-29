import { timingSafeEqual } from "node:crypto";
import type {
  IdentitySecurityManagementRepository,
  IdentitySecurityOwnerMaterial,
  IdentitySecuritySessionBinding,
  RecoveryCodeDigest,
  TotpEnrollmentMaterial,
} from "../../application/contracts/identity-security-management-repository.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import {
  resolvePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../../../shared/unit-of-work/platform-transaction.js";

export class PostgresIdentitySecurityManagementRepository implements IdentitySecurityManagementRepository {
  async loadSecurityOwnerMaterial(
    transaction: PlatformTransaction,
    input: Parameters<IdentitySecurityManagementRepository["loadSecurityOwnerMaterial"]>[1],
  ): Promise<IdentitySecurityOwnerMaterial | null> {
    const sql = resolvePlatformTransaction(transaction);
    const rows = await sql.query<SecurityOwnerRow>(
      `${securityOwnerSelect} FOR SHARE OF account,subject,session`,
      [
        input.binding.siteRef,
        input.binding.subjectRef,
        input.binding.sessionRef,
        input.now,
        input.binding.siteReleaseRef,
      ],
    );
    const owner = rows[0];
    if (
      owner === undefined ||
      !bindingMatches(owner, input.binding) ||
      !validIdentityIssuerLabel(owner.identityIssuerLabel)
    )
      return null;
    return Object.freeze({
      accountRef: owner.accountRef,
      subjectRef: owner.subjectRef,
      sessionRef: owner.sessionRef,
      emailNormalized: owner.emailNormalized,
      identityIssuerLabel: owner.identityIssuerLabel,
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
    await expireTotpEnrollments(sql, input.binding.siteRef, input.accountRef, input.now);
    if (
      (await activeTotpExists(sql, input.binding.siteRef, input.accountRef)) ||
      (await pendingTotpEnrollmentExists(sql, input.binding.siteRef, input.accountRef))
    )
      return false;
    await insertTotpEnrollment(sql, input);
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
      !expectedOwner(owner, input.accountRef, input.expectedAccountSecurityEpoch) ||
      (await activeTotpExists(sql, input.binding.siteRef, input.accountRef))
    )
      return false;
    const rows = await sql.query<EnrollmentRecoveryRow>(
      `SELECT enrollment.authenticator_ref AS "authenticatorRef",enrollment.state AS "enrollmentState",
              enrollment.expires_at AS "enrollmentExpiresAt",claim.request_digest AS "claimRequestDigest",
              claim.state AS "claimState",receipt.request_digest AS "receiptRequestDigest",
              receipt.operation,receipt.state AS "receiptState",receipt.caller_identity AS "callerIdentity",
              recovery.site_ref AS "recoverySiteRef",recovery.workload_identity_id AS "recoveryWorkloadIdentityId",
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
      prior.recoverySiteRef !== input.binding.siteRef ||
      prior.recoveryWorkloadIdentityId !== input.workloadIdentityId ||
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
      throw new Error("IDENTITY_TOTP_ENROLLMENT_SUPERSEDE_STALE");
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

const securityOwnerSelect = `SELECT account.account_ref AS "accountRef",account.subject_ref AS "subjectRef",
  account.security_epoch AS "accountSecurityEpoch",subject.subject_generation AS "subjectGeneration",
  session.session_ref AS "sessionRef",session.session_epoch AS "sessionEpoch",
  session.credential_epoch AS "credentialEpoch",session.authenticated_at AS "authenticatedAt",
  session.authentication_methods AS "authenticationMethods",
  identifier.normalized_value AS "emailNormalized",release.identity_issuer_label AS "identityIssuerLabel"
  FROM platform.identity_account account
  JOIN platform.authorization_subject subject
    ON subject.subject_ref=account.subject_ref AND subject.site_ref=account.site_ref
  JOIN platform.authorization_identity_session session
    ON session.subject_ref=account.subject_ref AND session.site_ref=account.site_ref
  JOIN platform.authorization_site_release release
    ON release.site_ref=account.site_ref AND release.release_ref=$5 AND release.state='active'
  JOIN platform.identity_login_identifier identifier
    ON identifier.site_ref=account.site_ref AND identifier.account_ref=account.account_ref
      AND identifier.subject_ref=account.subject_ref AND identifier.kind='email' AND identifier.status='active'
  WHERE account.site_ref=$1 AND account.subject_ref=$2 AND session.session_ref=$3
    AND account.state='active' AND subject.state='active' AND session.state='active'
    AND session.expires_at>$4::timestamptz`;

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
    `${securityOwnerSelect} FOR UPDATE OF account,subject,session`,
    [binding.siteRef, binding.subjectRef, binding.sessionRef, now, binding.siteReleaseRef],
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
    purpose: "confirmTotpEnrollment";
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
  accountRef: string;
  subjectRef: string;
  sessionRef: string;
  emailNormalized: string;
  identityIssuerLabel: string;
  accountSecurityEpoch: bigint;
  subjectGeneration: bigint;
  sessionEpoch: bigint;
  credentialEpoch: bigint;
  authenticatedAt: string | Date;
  authenticationMethods: unknown;
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

interface EnrollmentRecoveryRow extends Record<string, unknown> {
  authenticatorRef: string;
  enrollmentState: string;
  enrollmentExpiresAt: string | Date;
  claimRequestDigest: string;
  claimState: string;
  receiptRequestDigest: string;
  operation: string;
  receiptState: string;
  callerIdentity: string;
  recoverySiteRef: string;
  recoveryWorkloadIdentityId: string;
  recoveryPurpose: string;
  recoveryTransactionRef: string | null;
  capabilityDigest: string;
  recoveryState: string;
  recoveryExpiresAt: string | Date;
}
