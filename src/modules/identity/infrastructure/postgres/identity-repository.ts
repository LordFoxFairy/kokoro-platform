import { timingSafeEqual } from "node:crypto";
import type {
  AccountPasswordRecord,
  IdentityRepository,
  IdentitySessionSafeFact,
  PersonalBootstrapAuthorizationFacts,
  VerificationRecord,
} from "../../application/contracts/identity-repository.js";
import type { IdentitySessionCurrentFact } from "../../../authorization/application/contracts/scoped-session-authorization-port.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import {
  resolvePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../../../shared/unit-of-work/platform-transaction.js";

export class PostgresIdentityRepository implements IdentityRepository {
  async createVerification(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["createVerification"]>[1],
  ): Promise<"created" | "undisclosed"> {
    const sql = resolvePlatformTransaction(transaction);
    await sql.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1 || chr(31) || $2,0)) AS locked`,
      [input.siteRef, input.emailNormalized],
    );
    const existing = await sql.query<{ accountRef: string; subjectRef: string; accountState: string }>(
      `SELECT identifier.account_ref AS "accountRef",identifier.subject_ref AS "subjectRef",
              account.state AS "accountState"
       FROM platform.identity_login_identifier identifier
       JOIN platform.identity_account account
         ON account.site_ref=identifier.site_ref AND account.account_ref=identifier.account_ref
       WHERE identifier.site_ref=$1 AND identifier.kind='email' AND identifier.normalized_value=$2
         AND identifier.status IN ('pending_verification','active')
       LIMIT 1 FOR UPDATE`,
      [input.siteRef, input.emailNormalized],
    );
    const prior = existing[0];
    if (prior !== undefined && prior.accountState !== "verification_pending") return "undisclosed";
    const accountRef = prior?.accountRef ?? input.accountRef;
    const subjectRef = prior?.subjectRef ?? input.subjectRef;
    if (prior === undefined) {
      await sql.execute(
        `INSERT INTO platform.identity_account
         (site_ref,account_ref,subject_ref,state,created_at,updated_at)
         VALUES ($1,$2,$3,'verification_pending',$4::timestamptz,$4::timestamptz)`,
        [input.siteRef, accountRef, subjectRef, input.acceptedAt],
      );
      await sql.execute(
        `INSERT INTO platform.identity_password_credential
         (site_ref,account_ref,password_hash,pepper_version,changed_at)
         VALUES ($1,$2,$3,$4,$5::timestamptz)`,
        [input.siteRef, accountRef, input.passwordHash, input.pepperVersion, input.acceptedAt],
      );
      await sql.execute(
        `INSERT INTO platform.identity_login_identifier
         (site_ref,account_ref,subject_ref,kind,normalized_value,status,created_at,updated_at)
         VALUES ($1,$2,$3,'email',$4,'pending_verification',$5::timestamptz,$5::timestamptz)`,
        [input.siteRef, accountRef, subjectRef, input.emailNormalized, input.acceptedAt],
      );
    } else {
      await sql.execute(
        `UPDATE platform.identity_password_credential
         SET password_hash=$3,pepper_version=$4,credential_epoch=credential_epoch+1,changed_at=$5::timestamptz
         WHERE site_ref=$1 AND account_ref=$2`,
        [input.siteRef, accountRef, input.passwordHash, input.pepperVersion, input.acceptedAt],
      );
      await sql.execute(
        `UPDATE platform.identity_verification_transaction
         SET state='superseded',updated_at=$3::timestamptz
         WHERE site_ref=$1 AND account_ref=$2 AND purpose='registration' AND state='pending'`,
        [input.siteRef, accountRef, input.acceptedAt],
      );
    }
    const changed = await sql.execute(
      `INSERT INTO platform.identity_verification_transaction
       (site_ref,transaction_ref,account_ref,subject_ref,purpose,email_normalized,
        secret_digest,request_digest,max_attempts,expires_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'registration',$5,$6,$7,8,$8::timestamptz,$9::timestamptz,$9::timestamptz)`,
      [input.siteRef, input.transactionRef, accountRef, subjectRef, input.emailNormalized,
        input.secretDigest, input.requestDigest, input.expiresAt, input.acceptedAt],
    );
    if (changed !== 1) throw new Error("IDENTITY_VERIFICATION_CREATE_FAILED");
    for (const evidence of input.legalAcceptances) {
      await sql.execute(
        `INSERT INTO platform.identity_verification_legal_acceptance
         (site_ref,transaction_ref,term_ref,accepted_at,evidence_digest,workload_identity_id,site_release_ref)
         VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7)`,
        [input.siteRef, input.transactionRef, evidence.termRef, input.acceptedAt,
          evidence.evidenceDigest, evidence.workloadIdentityId, evidence.siteReleaseRef],
      );
    }
    return "created";
  }

  async recordVerificationDelivery(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["recordVerificationDelivery"]>[1],
  ): Promise<void> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.identity_verification_delivery
       (site_ref,transaction_ref,delivery_ref,event_id) VALUES ($1,$2,$3::uuid,$4::uuid)`,
      [input.siteRef, input.transactionRef, input.deliveryRef, input.eventId],
    );
    if (changed !== 1) throw new Error("IDENTITY_VERIFICATION_DELIVERY_CREATE_FAILED");
  }

  async findPendingVerificationByEmail(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["findPendingVerificationByEmail"]>[1],
  ): Promise<VerificationRecord | null> {
    const rows = await resolvePlatformTransaction(transaction).query<VerificationRow>(
      `${verificationSelect}
       LEFT JOIN LATERAL (
         SELECT created_at FROM platform.identity_verification_delivery delivery
         WHERE delivery.site_ref=verification.site_ref
           AND delivery.transaction_ref=verification.transaction_ref
         ORDER BY created_at DESC LIMIT 1
       ) latest_delivery ON TRUE
       WHERE verification.site_ref=$1 AND verification.email_normalized=$2
         AND verification.purpose='registration' AND verification.state='pending'
         AND verification.expires_at>$3::timestamptz
       ORDER BY verification.created_at DESC LIMIT 1 FOR UPDATE OF verification`,
      [input.siteRef, input.emailNormalized, input.now],
    );
    return rows[0] === undefined ? null : verification(rows[0]);
  }

  async rotateVerificationSecret(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["rotateVerificationSecret"]>[1],
  ): Promise<void> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.identity_verification_transaction
       SET secret_digest=$4,resend_count=resend_count+1,expires_at=$5::timestamptz,updated_at=$6::timestamptz
       WHERE site_ref=$1 AND transaction_ref=$2 AND state='pending' AND resend_count=$3`,
      [input.siteRef, input.transactionRef, input.expectedResendCount,
        input.secretDigest, input.expiresAt, input.now],
    );
    if (changed !== 1) throw new Error("IDENTITY_VERIFICATION_STALE");
  }

  async loadVerificationForUpdate(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["loadVerificationForUpdate"]>[1],
  ): Promise<VerificationRecord | null> {
    const rows = await resolvePlatformTransaction(transaction).query<VerificationRow>(
      `${verificationSelect}
       LEFT JOIN LATERAL (
         SELECT created_at FROM platform.identity_verification_delivery delivery
         WHERE delivery.site_ref=verification.site_ref
           AND delivery.transaction_ref=verification.transaction_ref
         ORDER BY created_at DESC LIMIT 1
       ) latest_delivery ON TRUE
       WHERE verification.site_ref=$1 AND verification.transaction_ref=$2
       FOR UPDATE OF verification`,
      [input.siteRef, input.transactionRef],
    );
    return rows[0] === undefined ? null : verification(rows[0]);
  }

  async recordVerificationFailure(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["recordVerificationFailure"]>[1],
  ): Promise<void> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.identity_verification_transaction
       SET attempt_count=attempt_count+1,
           state=CASE WHEN attempt_count+1>=max_attempts THEN 'locked' ELSE state END,
           updated_at=$3::timestamptz
       WHERE site_ref=$1 AND transaction_ref=$2 AND state='pending'`,
      [input.siteRef, input.transactionRef, input.now],
    );
    if (changed !== 1) throw new Error("IDENTITY_VERIFICATION_NOT_PENDING");
  }

  async activateVerification(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["activateVerification"]>[1],
  ): Promise<PersonalBootstrapAuthorizationFacts> {
    const sql = resolvePlatformTransaction(transaction);
    const verificationRows = await sql.query<{ accountRef: string; subjectRef: string }>(
      `SELECT verification.account_ref AS "accountRef",verification.subject_ref AS "subjectRef"
       FROM platform.identity_verification_transaction verification
       JOIN platform.identity_account account
         ON account.site_ref=verification.site_ref AND account.account_ref=verification.account_ref
       JOIN platform.identity_login_identifier identifier
         ON identifier.site_ref=verification.site_ref AND identifier.account_ref=verification.account_ref
           AND identifier.subject_ref=verification.subject_ref AND identifier.kind='email'
       JOIN platform.identity_password_credential credential
         ON credential.site_ref=verification.site_ref AND credential.account_ref=verification.account_ref
       WHERE verification.site_ref=$1 AND verification.transaction_ref=$2
         AND verification.purpose='registration' AND verification.state='pending'
         AND account.state='verification_pending' AND identifier.status='pending_verification'
       FOR UPDATE OF verification,account,identifier,credential`,
      [input.siteRef, input.transactionRef],
    );
    const pending = verificationRows[0];
    if (pending === undefined || pending.accountRef !== input.accountRef || pending.subjectRef !== input.subjectRef) {
      throw new Error("IDENTITY_VERIFICATION_NOT_PENDING");
    }
    await sql.execute(
      `INSERT INTO platform.authorization_subject
       (subject_ref,site_ref,display_name,state,subject_generation,restriction_epoch,created_at,updated_at)
       VALUES ($1,$2,$3,'active',1,1,$4::timestamptz,$4::timestamptz)`,
      [input.subjectRef, input.siteRef, input.displayName, input.now],
    );
    await sql.execute(
      `UPDATE platform.identity_account
       SET state='active',updated_at=$4::timestamptz
       WHERE site_ref=$1 AND account_ref=$2 AND subject_ref=$3 AND state='verification_pending'`,
      [input.siteRef, input.accountRef, input.subjectRef, input.now],
    );
    await sql.execute(
      `UPDATE platform.identity_login_identifier
       SET status='active',verified_at=$4::timestamptz,updated_at=$4::timestamptz
       WHERE site_ref=$1 AND account_ref=$2 AND subject_ref=$3
         AND kind='email' AND status='pending_verification'`,
      [input.siteRef, input.accountRef, input.subjectRef, input.now],
    );
    await sql.execute(
      `INSERT INTO platform.identity_personal_workspace
       (site_ref,workspace_ref,personal_owner_subject_ref,display_name,kind,state,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'personal','active',$5::timestamptz,$5::timestamptz)`,
      [input.siteRef, input.workspaceRef, input.subjectRef, "Personal workspace", input.now],
    );
    await sql.execute(
      `INSERT INTO platform.identity_workspace_membership
       (site_ref,workspace_ref,subject_ref,role,state,membership_epoch,authorization_epoch,created_at,updated_at)
       VALUES ($1,$2,$3,'owner','active',1,1,$4::timestamptz,$4::timestamptz)`,
      [input.siteRef, input.workspaceRef, input.subjectRef, input.now],
    );
    await sql.execute(
      `INSERT INTO platform.commerce_billing_account
       (billing_account_ref,site_ref,state,aggregate_version,created_at,updated_at)
       VALUES ($1,$2,'active',1,$3::timestamptz,$3::timestamptz)`,
      [input.billingAccountRef, input.siteRef, input.now],
    );
    await sql.execute(
      `INSERT INTO platform.commerce_billing_account_membership
       (billing_account_ref,site_ref,subject_ref,subject_generation,state,membership_epoch,is_default,created_at,updated_at)
       VALUES ($1,$2,$3,1,'active',1,TRUE,$4::timestamptz,$4::timestamptz)`,
      [input.billingAccountRef, input.siteRef, input.subjectRef, input.now],
    );
    await sql.execute(
      `INSERT INTO platform.authorization_project
       (project_ref,site_ref,workspace_ref,execution_space_ref,display_name,state,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'Default project','active',$5::timestamptz,$5::timestamptz)`,
      [input.projectRef, input.siteRef, input.workspaceRef, input.executionSpaceRef, input.now],
    );
    await sql.execute(
      `INSERT INTO platform.authorization_project_membership
       (project_ref,subject_ref,state,membership_epoch,authorization_epoch,is_default,created_at,updated_at)
       VALUES ($1,$2,'active',1,1,TRUE,$3::timestamptz,$3::timestamptz)`,
      [input.projectRef, input.subjectRef, input.now],
    );
    await sql.execute(
      `INSERT INTO platform.identity_execution_space
       (site_ref,execution_space_ref,project_ref,execution_namespace,state,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'allocation_pending',$5::timestamptz,$5::timestamptz)`,
      [input.siteRef, input.executionSpaceRef, input.projectRef, input.executionNamespace, input.now],
    );
    await sql.execute(
      `INSERT INTO platform.identity_namespace_allocation_intent
       (intent_ref,event_id,site_ref,execution_space_ref,execution_namespace,created_at,updated_at)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::timestamptz,$6::timestamptz)`,
      [input.namespaceIntentRef, input.namespaceEventId, input.siteRef,
        input.executionSpaceRef, input.executionNamespace, input.now],
    );
    await sql.execute(
      `INSERT INTO platform.identity_personal_bootstrap
       (site_ref,subject_ref,subject_generation,bootstrap_kind,workspace_ref,billing_account_ref,
        project_ref,execution_space_ref,execution_namespace,namespace_intent_ref,created_at)
       VALUES ($1,$2,1,'personal_v1',$3,$4,$5,$6,$7,$8::uuid,$9::timestamptz)`,
      [input.siteRef, input.subjectRef, input.workspaceRef, input.billingAccountRef,
        input.projectRef, input.executionSpaceRef, input.executionNamespace, input.namespaceIntentRef, input.now],
    );
    const changed = await sql.execute(
      `UPDATE platform.identity_verification_transaction
       SET state='consumed',consumed_at=$3::timestamptz,updated_at=$3::timestamptz
       WHERE site_ref=$1 AND transaction_ref=$2 AND state='pending'`,
      [input.siteRef, input.transactionRef, input.now],
    );
    if (changed !== 1) throw new Error("IDENTITY_VERIFICATION_STALE");
    const retainUntil = new Date(Date.parse(input.now) + 300_000).toISOString();
    return Object.freeze({
      subject: Object.freeze({
        siteRef: input.siteRef, subjectRef: input.subjectRef, state: "active" as const,
        subjectGeneration: "1", restrictionEpoch: "1", updatedAt: input.now, retainUntil,
      }),
      membership: Object.freeze({
        siteRef: input.siteRef, subjectRef: input.subjectRef, projectRef: input.projectRef,
        state: "active" as const, membershipEpoch: "1", authorizationEpoch: "1",
        updatedAt: input.now, retainUntil,
      }),
    });
  }

  async bindReceiptRecoveryCapability(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["bindReceiptRecoveryCapability"]>[1],
  ): Promise<void> {
    const sql = resolvePlatformTransaction(transaction);
    const authority = await sql.query<Record<string, unknown>>(
      `SELECT 1
       FROM platform.authorization_site site
       JOIN platform.authorization_site_release release
         ON release.site_ref=site.site_ref AND release.release_ref=$2 AND release.state='active'
       JOIN platform.authorization_product_binding binding
         ON binding.site_ref=site.site_ref AND binding.release_ref=release.release_ref
           AND binding.binding_ref=$3 AND binding.workload_identity_id=$4
           AND binding.binding_epoch=$5::bigint AND binding.state='active'
       WHERE site.site_ref=$1 AND site.state='active'
       FOR SHARE OF site,release,binding`,
      [input.siteRef, input.siteReleaseRef, input.siteProjectBindingRef,
        input.workloadIdentityId, input.bindingEpoch],
    );
    if (authority.length !== 1) throw new Error("IDENTITY_RECEIPT_RECOVERY_AUTHORITY_MISMATCH");
    await sql.execute(
      `INSERT INTO platform.identity_receipt_recovery_capability
       (command_id,site_ref,site_release_ref,site_project_binding_ref,workload_identity_id,binding_epoch,
        purpose,transaction_ref,capability_digest,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6::bigint,$7,$8,$9,$10::timestamptz)
       ON CONFLICT (command_id) DO NOTHING`,
      [input.commandId, input.siteRef, input.siteReleaseRef, input.siteProjectBindingRef,
        input.workloadIdentityId, input.bindingEpoch, input.purpose,
        input.transactionRef, input.capabilityDigest, input.expiresAt],
    );
    const rows = await sql.query<{
      siteRef: string; siteReleaseRef: string; siteProjectBindingRef: string;
      workloadIdentityId: string; bindingEpoch: bigint; purpose: string; transactionRef: string | null;
      capabilityDigest: string; state: string; expiresAt: string | Date;
    }>(
      `SELECT site_ref AS "siteRef",site_release_ref AS "siteReleaseRef",
              site_project_binding_ref AS "siteProjectBindingRef",
              workload_identity_id AS "workloadIdentityId",binding_epoch AS "bindingEpoch",purpose,
              transaction_ref AS "transactionRef",capability_digest AS "capabilityDigest",state,
              expires_at AS "expiresAt"
       FROM platform.identity_receipt_recovery_capability WHERE command_id=$1 FOR UPDATE`,
      [input.commandId],
    );
    const found = rows[0];
    if (
      found === undefined || found.siteRef !== input.siteRef ||
      found.siteReleaseRef !== input.siteReleaseRef ||
      found.siteProjectBindingRef !== input.siteProjectBindingRef ||
      found.workloadIdentityId !== input.workloadIdentityId ||
      found.bindingEpoch.toString() !== input.bindingEpoch || found.purpose !== input.purpose ||
      found.transactionRef !== input.transactionRef ||
      !constantTimeDigestEqual(found.capabilityDigest, input.capabilityDigest) ||
      found.state !== "active" || Date.parse(instant(found.expiresAt)) <= Date.parse(input.now)
    ) throw new Error("IDENTITY_RECEIPT_RECOVERY_MISMATCH");
  }

  async findAccountPassword(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["findAccountPassword"]>[1],
  ): Promise<AccountPasswordRecord | null> {
    const rows = await resolvePlatformTransaction(transaction).query<AccountRow>(
      `SELECT account.account_ref AS "accountRef",account.subject_ref AS "subjectRef",
              credential.password_hash AS "passwordHash",credential.pepper_version AS "pepperVersion",
              credential.credential_epoch AS "credentialEpoch"
       FROM platform.identity_account account
       JOIN platform.identity_login_identifier identifier
         ON identifier.site_ref=account.site_ref AND identifier.account_ref=account.account_ref
           AND identifier.subject_ref=account.subject_ref AND identifier.kind='email'
       JOIN platform.identity_password_credential credential
         ON credential.site_ref=account.site_ref AND credential.account_ref=account.account_ref
       JOIN platform.authorization_subject subject
         ON subject.site_ref=account.site_ref AND subject.subject_ref=account.subject_ref
       WHERE account.site_ref=$1 AND identifier.normalized_value=$2 AND identifier.status='active'
         AND account.state='active' AND subject.state='active'
       FOR SHARE OF account,identifier,credential,subject`,
      [input.siteRef, input.emailNormalized],
    );
    const row = rows[0];
    return row === undefined ? null : Object.freeze({ ...row, credentialEpoch: row.credentialEpoch.toString() });
  }

  async beginIdentityAuthentication(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["beginIdentityAuthentication"]>[1],
  ) {
    const sql = resolvePlatformTransaction(transaction);
    await sql.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      [`identity-auth\0${input.siteRef}\0${input.accountRef}`],
    );
    const accounts = await sql.query<{ credentialEpoch: bigint } & Record<string, unknown>>(
      `SELECT credential.credential_epoch AS "credentialEpoch"
       FROM platform.identity_account account
       JOIN platform.identity_password_credential credential
         ON credential.site_ref=account.site_ref AND credential.account_ref=account.account_ref
       JOIN platform.authorization_subject subject
         ON subject.site_ref=account.site_ref AND subject.subject_ref=account.subject_ref
       WHERE account.site_ref=$1 AND account.account_ref=$2 AND account.subject_ref=$3
         AND account.state='active' AND subject.state='active'
       FOR SHARE OF account,credential,subject`,
      [input.siteRef, input.accountRef, input.subjectRef],
    );
    if (accounts[0]?.credentialEpoch.toString() !== input.passwordCredentialEpoch) {
      return Object.freeze({ kind: "locked" as const });
    }
    const rateRows = await sql.query<AuthRateLimitRow>(
      `SELECT failed_attempt_count AS "failedAttemptCount",locked_until AS "lockedUntil",
              window_started_at AS "windowStartedAt"
       FROM platform.identity_auth_rate_limit
       WHERE site_ref=$1 AND account_ref=$2 AND purpose='session_login'
       FOR UPDATE`,
      [input.siteRef, input.accountRef],
    );
    const rate = rateRows[0];
    if (rate?.lockedUntil !== null && rate?.lockedUntil !== undefined &&
        Date.parse(instant(rate.lockedUntil)) > Date.parse(input.now)) {
      return Object.freeze({ kind: "locked" as const });
    }
    const authenticators = await sql.query<{ authenticatorRef: string } & Record<string, unknown>>(
      `SELECT authenticator_ref AS "authenticatorRef"
       FROM platform.identity_totp_authenticator
       WHERE site_ref=$1 AND account_ref=$2 AND subject_ref=$3 AND state='active'
       FOR SHARE`,
      [input.siteRef, input.accountRef, input.subjectRef],
    );
    const recoverySets = await sql.query<{ setRef: string } & Record<string, unknown>>(
      `SELECT set_ref AS "setRef"
       FROM platform.identity_recovery_code_set
       WHERE site_ref=$1 AND account_ref=$2 AND subject_ref=$3 AND state='active'
       FOR SHARE`,
      [input.siteRef, input.accountRef, input.subjectRef],
    );
    const authenticatorRef = authenticators[0]?.authenticatorRef ?? null;
    const recoverySetRef = recoverySets[0]?.setRef ?? null;
    if (authenticatorRef === null && recoverySetRef === null) {
      await resetAuthenticationRateLimit(sql, {
        siteRef: input.siteRef, accountRef: input.accountRef, now: input.now,
      });
      return Object.freeze({ kind: "password_only" as const });
    }
    await sql.execute(
      `UPDATE platform.identity_auth_transaction
       SET state='expired',updated_at=$3::timestamptz
       WHERE site_ref=$1 AND account_ref=$2 AND purpose='session_login'
         AND state='pending' AND expires_at<=$3::timestamptz`,
      [input.siteRef, input.accountRef, input.now],
    );
    const pendingRows = await sql.query<{ pendingCount: number } & Record<string, unknown>>(
      `SELECT count(*)::integer AS "pendingCount"
       FROM platform.identity_auth_transaction
       WHERE site_ref=$1 AND account_ref=$2 AND purpose='session_login' AND state='pending'`,
      [input.siteRef, input.accountRef],
    );
    if ((pendingRows[0]?.pendingCount ?? 0) >= 5) {
      return Object.freeze({ kind: "capacity_exceeded" as const });
    }
    const challengeKind = authenticatorRef === null ? "recovery" as const : "totp" as const;
    const inserted = await sql.execute(
      `INSERT INTO platform.identity_auth_transaction
       (site_ref,transaction_ref,account_ref,subject_ref,purpose,challenge_kind,
        authenticator_ref,recovery_set_ref,password_credential_epoch,initiating_command_id,request_digest,
        state,attempt_count,max_attempts,expires_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'session_login',$5,$6,$7,$8::bigint,$9,$10,
               'pending',0,5,$11::timestamptz,$12::timestamptz,$12::timestamptz)`,
      [input.siteRef, input.transactionRef, input.accountRef, input.subjectRef, challengeKind,
        authenticatorRef, recoverySetRef, input.passwordCredentialEpoch, input.initiatingCommandId,
        input.requestDigest, input.expiresAt, input.now],
    );
    if (inserted !== 1) throw new Error("IDENTITY_AUTH_TRANSACTION_CREATE_FAILED");
    return Object.freeze({
      kind: "pending" as const,
      transactionRef: input.transactionRef,
      challengeKind,
      expiresAt: input.expiresAt,
    });
  }

  async recordIdentityPasswordFailure(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["recordIdentityPasswordFailure"]>[1],
  ): Promise<void> {
    const sql = resolvePlatformTransaction(transaction);
    await sql.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      [`identity-auth\0${input.siteRef}\0${input.accountRef}`],
    );
    const accounts = await sql.query<{ credentialEpoch: bigint } & Record<string, unknown>>(
      `SELECT credential.credential_epoch AS "credentialEpoch"
       FROM platform.identity_account account
       JOIN platform.identity_password_credential credential
         ON credential.site_ref=account.site_ref AND credential.account_ref=account.account_ref
       WHERE account.site_ref=$1 AND account.account_ref=$2 AND account.subject_ref=$3
         AND account.state='active'
       FOR SHARE OF account,credential`,
      [input.siteRef, input.accountRef, input.subjectRef],
    );
    if (accounts[0]?.credentialEpoch.toString() !== input.passwordCredentialEpoch) return;
    const rateRows = await sql.query<AuthRateLimitRow>(
      `SELECT failed_attempt_count AS "failedAttemptCount",locked_until AS "lockedUntil",
              window_started_at AS "windowStartedAt"
       FROM platform.identity_auth_rate_limit
       WHERE site_ref=$1 AND account_ref=$2 AND purpose='session_login'
       FOR UPDATE`,
      [input.siteRef, input.accountRef],
    );
    const rate = rateRows[0];
    if (rate?.lockedUntil !== null && rate?.lockedUntil !== undefined &&
        Date.parse(instant(rate.lockedUntil)) > Date.parse(input.now)) return;
    await recordAuthenticationRateFailure(sql, {
      siteRef: input.siteRef, accountRef: input.accountRef, now: input.now,
    }, rate);
  }

  async loadIdentityAuthenticationMaterial(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["loadIdentityAuthenticationMaterial"]>[1],
  ) {
    const sql = resolvePlatformTransaction(transaction);
    const rows = await sql.query<AuthMaterialRow>(
      `SELECT auth.account_ref AS "accountRef",auth.subject_ref AS "subjectRef",
              auth.transaction_ref AS "transactionRef",auth.challenge_kind AS "challengeKind",
              auth.expires_at AS "expiresAt",auth.authenticator_ref AS "authenticatorRef",
              auth.recovery_set_ref AS "recoverySetRef",
              authenticator.secret_algorithm AS "secretAlgorithm",
              authenticator.secret_key_revision AS "secretKeyRevision",
              authenticator.secret_nonce AS "secretNonce",
              authenticator.secret_ciphertext AS "secretCiphertext",
              authenticator.secret_authentication_tag AS "secretAuthenticationTag",
              authenticator.last_accepted_timestep AS "lastAcceptedTimeStep"
       FROM platform.identity_auth_transaction auth
       JOIN platform.identity_account account
         ON account.site_ref=auth.site_ref AND account.account_ref=auth.account_ref
           AND account.subject_ref=auth.subject_ref
       JOIN platform.identity_password_credential credential
         ON credential.site_ref=auth.site_ref AND credential.account_ref=auth.account_ref
           AND credential.credential_epoch=auth.password_credential_epoch
       LEFT JOIN platform.identity_totp_authenticator authenticator
         ON authenticator.site_ref=auth.site_ref AND authenticator.authenticator_ref=auth.authenticator_ref
           AND authenticator.account_ref=auth.account_ref AND authenticator.subject_ref=auth.subject_ref
           AND authenticator.state='active'
       WHERE auth.site_ref=$1 AND auth.transaction_ref=$2 AND auth.state='pending'
         AND auth.expires_at>$3::timestamptz AND account.state='active'`,
      [input.siteRef, input.transactionRef, input.now],
    );
    const found = rows[0];
    if (found === undefined) return null;
    const recoveryCodeRows = found.recoverySetRef === null ? [] : await sql.query<RecoveryDigestRow>(
      `SELECT code.code_digest AS "codeDigest"
       FROM platform.identity_recovery_code code
       JOIN platform.identity_recovery_code_set code_set
         ON code_set.site_ref=code.site_ref AND code_set.set_ref=code.set_ref
       WHERE code.site_ref=$1 AND code.set_ref=$2 AND code.state='active' AND code_set.state='active'
       ORDER BY code.code_digest
       LIMIT 10`,
      [input.siteRef, found.recoverySetRef],
    );
    const authenticator = found.authenticatorRef === null || found.secretAlgorithm !== "A256GCM" ||
      found.secretKeyRevision === null || found.secretNonce === null || found.secretCiphertext === null ||
      found.secretAuthenticationTag === null
      ? null
      : Object.freeze({
        authenticatorRef: found.authenticatorRef,
        envelope: Object.freeze({
          algorithm: "A256GCM" as const,
          keyRevision: found.secretKeyRevision,
          nonce: found.secretNonce,
          ciphertext: found.secretCiphertext,
          authenticationTag: found.secretAuthenticationTag,
        }),
        lastAcceptedTimeStep: found.lastAcceptedTimeStep === null
          ? null
          : Number(found.lastAcceptedTimeStep),
      });
    return Object.freeze({
      accountRef: found.accountRef,
      subjectRef: found.subjectRef,
      transactionRef: found.transactionRef,
      challengeKind: found.challengeKind,
      expiresAt: instant(found.expiresAt),
      recoverySetRef: found.recoverySetRef,
      authenticator,
      recoveryCodeDigests: Object.freeze(recoveryCodeRows.map((row) => row.codeDigest)),
    });
  }

  async consumeIdentityAuthentication(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["consumeIdentityAuthentication"]>[1],
  ) {
    const sql = resolvePlatformTransaction(transaction);
    const ownerRows = await sql.query<{ accountRef: string } & Record<string, unknown>>(
      `SELECT account_ref AS "accountRef"
       FROM platform.identity_auth_transaction
       WHERE site_ref=$1 AND transaction_ref=$2`,
      [input.siteRef, input.transactionRef],
    );
    const owner = ownerRows[0];
    if (owner === undefined) return Object.freeze({ kind: "rejected" as const });
    await sql.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      [`identity-auth\0${input.siteRef}\0${owner.accountRef}`],
    );
    const rows = await sql.query<AuthTransactionRow>(
      `SELECT account_ref AS "accountRef",subject_ref AS "subjectRef",
              authenticator_ref AS "authenticatorRef",recovery_set_ref AS "recoverySetRef",
              password_credential_epoch AS "passwordCredentialEpoch",state,attempt_count AS "attemptCount",
              max_attempts AS "maxAttempts",expires_at AS "expiresAt"
       FROM platform.identity_auth_transaction
       WHERE site_ref=$1 AND transaction_ref=$2
       FOR UPDATE`,
      [input.siteRef, input.transactionRef],
    );
    const auth = rows[0];
    if (auth === undefined) return Object.freeze({ kind: "rejected" as const });
    const validState = auth.state === "pending" && auth.attemptCount < auth.maxAttempts &&
      Date.parse(instant(auth.expiresAt)) > Date.parse(input.now);
    if (!validState) {
      if (auth.state === "pending" && Date.parse(instant(auth.expiresAt)) <= Date.parse(input.now)) {
        await sql.execute(
          `UPDATE platform.identity_auth_transaction SET state='expired',updated_at=$3::timestamptz
           WHERE site_ref=$1 AND transaction_ref=$2 AND state='pending'`,
          [input.siteRef, input.transactionRef, input.now],
        );
      }
      return Object.freeze({ kind: "rejected" as const });
    }
    const accounts = await sql.query<{ credentialEpoch: bigint } & Record<string, unknown>>(
      `SELECT credential.credential_epoch AS "credentialEpoch"
       FROM platform.identity_account account
       JOIN platform.identity_password_credential credential
         ON credential.site_ref=account.site_ref AND credential.account_ref=account.account_ref
       JOIN platform.authorization_subject subject
         ON subject.site_ref=account.site_ref AND subject.subject_ref=account.subject_ref
       WHERE account.site_ref=$1 AND account.account_ref=$2 AND account.subject_ref=$3
         AND account.state='active' AND subject.state='active'
       FOR SHARE OF account,credential,subject`,
      [input.siteRef, auth.accountRef, auth.subjectRef],
    );
    const rateRows = await sql.query<AuthRateLimitRow>(
      `SELECT failed_attempt_count AS "failedAttemptCount",locked_until AS "lockedUntil",
              window_started_at AS "windowStartedAt"
       FROM platform.identity_auth_rate_limit
       WHERE site_ref=$1 AND account_ref=$2 AND purpose='session_login'
       FOR UPDATE`,
      [input.siteRef, auth.accountRef],
    );
    const rate = rateRows[0];
    const rateLocked = rate?.lockedUntil !== null && rate?.lockedUntil !== undefined &&
      Date.parse(instant(rate.lockedUntil)) > Date.parse(input.now);
    if (rateLocked) {
      await sql.execute(
        `UPDATE platform.identity_auth_transaction SET state='locked',updated_at=$3::timestamptz
         WHERE site_ref=$1 AND transaction_ref=$2 AND state='pending'`,
        [input.siteRef, input.transactionRef, input.now],
      );
      return Object.freeze({ kind: "rejected" as const });
    }
    if (accounts[0]?.credentialEpoch.toString() !== auth.passwordCredentialEpoch.toString()) {
      await recordAuthenticationFailure(sql, input, auth, rate);
      return Object.freeze({ kind: "rejected" as const });
    }

    let authenticationMethod: "totp" | "recovery_code" | null = null;
    if (input.proof.kind === "totp" && auth.authenticatorRef !== null) {
      const accepted = await sql.execute(
        `UPDATE platform.identity_totp_authenticator
         SET last_accepted_timestep=$4::bigint,updated_at=$5::timestamptz
         WHERE site_ref=$1 AND authenticator_ref=$2 AND account_ref=$3 AND state='active'
           AND (last_accepted_timestep IS NULL OR last_accepted_timestep<$4::bigint)`,
        [input.siteRef, auth.authenticatorRef, auth.accountRef, input.proof.timeStep, input.now],
      );
      if (accepted === 1) authenticationMethod = "totp";
    } else if (input.proof.kind === "recovery_code" && auth.recoverySetRef !== null) {
      const accepted = await sql.execute(
        `UPDATE platform.identity_recovery_code code
         SET state='used',used_at=$4::timestamptz
         FROM platform.identity_recovery_code_set code_set
         WHERE code.site_ref=$1 AND code.set_ref=$2 AND code.code_digest=$3 AND code.state='active'
           AND code_set.site_ref=code.site_ref AND code_set.set_ref=code.set_ref AND code_set.state='active'`,
        [input.siteRef, auth.recoverySetRef, input.proof.codeDigest, input.now],
      );
      if (accepted === 1) authenticationMethod = "recovery_code";
    }
    if (authenticationMethod === null) {
      await recordAuthenticationFailure(sql, input, auth, rate);
      return Object.freeze({ kind: "rejected" as const });
    }
    const consumed = await sql.execute(
      `UPDATE platform.identity_auth_transaction
       SET state='consumed',consumed_at=$3::timestamptz,updated_at=$3::timestamptz
       WHERE site_ref=$1 AND transaction_ref=$2 AND state='pending'`,
      [input.siteRef, input.transactionRef, input.now],
    );
    if (consumed !== 1) throw new Error("IDENTITY_AUTH_TRANSACTION_CONSUME_STALE");
    await resetAuthenticationRateLimit(sql, {
      siteRef: input.siteRef, accountRef: auth.accountRef, now: input.now,
    });
    return Object.freeze({
      kind: "accepted" as const,
      accountRef: auth.accountRef,
      subjectRef: auth.subjectRef,
      authenticationMethod,
    });
  }

  async createIdentitySession(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["createIdentitySession"]>[1],
  ): Promise<IdentitySessionCurrentFact> {
    const sql = resolvePlatformTransaction(transaction);
    await sql.execute(
      `INSERT INTO platform.authorization_identity_session
       (session_ref,subject_ref,site_ref,credential_digest,authentication_methods,state,
        session_epoch,credential_epoch,authenticated_at,expires_at,device_label,last_seen_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5::TEXT[],'active',1,1,$6::timestamptz,$7::timestamptz,
               $8,$6::timestamptz,$6::timestamptz,$6::timestamptz)`,
      [input.sessionRef, input.subjectRef, input.siteRef, input.sessionCredentialDigest,
        [...input.authenticationMethods], input.authenticatedAt, input.sessionExpiresAt, input.deviceLabel],
    );
    await sql.execute(
      `INSERT INTO platform.identity_refresh_family
       (site_ref,family_ref,account_ref,subject_ref,session_ref,absolute_expires_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$7::timestamptz)`,
      [input.siteRef, input.familyRef, input.accountRef, input.subjectRef,
        input.sessionRef, input.refreshExpiresAt, input.authenticatedAt],
    );
    await sql.execute(
      `INSERT INTO platform.identity_refresh_credential
       (site_ref,family_ref,generation,credential_digest,expires_at,created_at)
       VALUES ($1,$2,1,$3,$4::timestamptz,$5::timestamptz)`,
      [input.siteRef, input.familyRef, input.refreshCredentialDigest,
        input.refreshExpiresAt, input.authenticatedAt],
    );
    await sql.execute(
      `INSERT INTO platform.identity_session_delivery_claim
       (command_id,site_ref,subject_ref,session_ref,request_digest,state,claimed_at)
       VALUES ($1,$2,$3,$4,$5,'first_claim_consumed',$6::timestamptz)`,
      [input.commandId, input.siteRef, input.subjectRef, input.sessionRef,
        input.requestDigest, input.authenticatedAt],
    );
    return Object.freeze({
      siteRef: input.siteRef, subjectRef: input.subjectRef, identitySessionRef: input.sessionRef,
      state: "active", identitySessionEpoch: "1", credentialEpoch: "1",
      expiresAt: input.sessionExpiresAt, updatedAt: input.authenticatedAt, retainUntil: input.retainUntil,
    });
  }

  async consumeIdentitySessionDeliveryRecovery(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["consumeIdentitySessionDeliveryRecovery"]>[1],
  ) {
    const sql = resolvePlatformTransaction(transaction);
    const rows = await sql.query<SessionDeliveryRecoveryRow>(
      `SELECT family.account_ref AS "accountRef",claim.subject_ref AS "subjectRef",
              claim.session_ref AS "sessionRef",claim.request_digest AS "claimRequestDigest",
              receipt.request_digest AS "receiptRequestDigest",receipt.caller_identity AS "callerIdentity",
              receipt.operation,receipt.state AS "receiptState",
              recovery.site_ref AS "recoverySiteRef",recovery.site_release_ref AS "recoverySiteReleaseRef",
              recovery.site_project_binding_ref AS "recoverySiteProjectBindingRef",
              recovery.workload_identity_id AS "recoveryWorkloadIdentityId",
              recovery.binding_epoch AS "recoveryBindingEpoch",
              recovery.purpose AS "recoveryPurpose",recovery.transaction_ref AS "recoveryTransactionRef",
              recovery.capability_digest AS "capabilityDigest",recovery.state AS "recoveryState",
              recovery.expires_at AS "recoveryExpiresAt",
              identity_session.session_epoch AS "sessionEpoch",
              identity_session.credential_epoch AS "credentialEpoch",
              identity_session.expires_at AS "sessionExpiresAt",
              identity_session.authentication_methods AS "authenticationMethods",
              identity_session.state AS "sessionState"
       FROM platform.identity_session_delivery_claim claim
       JOIN platform.identity_receipt_recovery_capability recovery
         ON recovery.command_id=claim.command_id
       JOIN platform.authorization_site site
         ON site.site_ref=recovery.site_ref AND site.site_ref=$2 AND site.state='active'
       JOIN platform.authorization_site_release release
         ON release.site_ref=recovery.site_ref AND release.release_ref=recovery.site_release_ref
           AND release.release_ref=$3 AND release.state='active'
       JOIN platform.authorization_product_binding product_binding
         ON product_binding.site_ref=recovery.site_ref
           AND product_binding.release_ref=recovery.site_release_ref
           AND product_binding.binding_ref=recovery.site_project_binding_ref
           AND product_binding.binding_ref=$4
           AND product_binding.workload_identity_id=recovery.workload_identity_id
           AND product_binding.workload_identity_id=$5
           AND product_binding.binding_epoch=recovery.binding_epoch
           AND product_binding.binding_epoch=$6::bigint AND product_binding.state='active'
       JOIN platform.command_receipt receipt ON receipt.command_id=claim.command_id
       JOIN platform.authorization_identity_session identity_session
         ON identity_session.session_ref=claim.session_ref
           AND identity_session.subject_ref=claim.subject_ref
           AND identity_session.site_ref=claim.site_ref
       JOIN platform.identity_refresh_family family
         ON family.site_ref=claim.site_ref AND family.session_ref=claim.session_ref
       WHERE claim.command_id=$1 AND claim.site_ref=$2 AND claim.state='first_claim_consumed'
         AND family.state='active'
       FOR UPDATE OF claim,recovery,receipt,identity_session,family
       FOR SHARE OF site,release,product_binding`,
      [input.priorCommandId, input.siteRef, input.siteReleaseRef, input.siteProjectBindingRef,
        input.workloadIdentityId, input.bindingEpoch],
    );
    const found = rows[0];
    if (
      found === undefined || found.recoverySiteRef !== input.siteRef ||
      found.recoverySiteReleaseRef !== input.siteReleaseRef ||
      found.recoverySiteProjectBindingRef !== input.siteProjectBindingRef ||
      found.recoveryWorkloadIdentityId !== input.workloadIdentityId ||
      found.recoveryBindingEpoch.toString() !== input.bindingEpoch ||
      found.recoveryPurpose !== input.purpose || found.recoveryTransactionRef !== input.transactionRef ||
      found.recoveryState !== "active" || Date.parse(instant(found.recoveryExpiresAt)) <= Date.parse(input.now) ||
      found.callerIdentity !== input.workloadIdentityId || found.operation !== input.purpose ||
      found.receiptState !== "succeeded" || found.sessionState !== "active" ||
      found.claimRequestDigest !== found.receiptRequestDigest ||
      !constantTimeDigestEqual(found.capabilityDigest, input.capabilityDigest)
    ) return null;

    const transferred = await sql.execute(
      `UPDATE platform.identity_receipt_recovery_capability
       SET command_id=$2
       WHERE command_id=$1 AND state='active'`,
      [input.priorCommandId, input.newCommandId],
    );
    const superseded = await sql.execute(
      `UPDATE platform.identity_session_delivery_claim
       SET state='superseded',superseded_at=$2::timestamptz
       WHERE command_id=$1 AND state='first_claim_consumed'`,
      [input.priorCommandId, input.now],
    );
    const revoked = await sql.query<RevokedSessionRow>(
      `UPDATE platform.authorization_identity_session
       SET state='revoked',session_epoch=session_epoch+1,credential_epoch=credential_epoch+1,
           updated_at=$3::timestamptz
       WHERE site_ref=$1 AND session_ref=$2 AND state='active'
       RETURNING session_epoch AS "identitySessionEpoch",credential_epoch AS "credentialEpoch",
                 expires_at AS "expiresAt"`,
      [input.siteRef, found.sessionRef, input.now],
    );
    if (transferred !== 1 || superseded !== 1 || revoked[0] === undefined) {
      throw new Error("IDENTITY_SESSION_DELIVERY_RECOVERY_STALE");
    }
    await sql.execute(
      `UPDATE platform.identity_refresh_credential credential SET state='revoked'
       FROM platform.identity_refresh_family family
       WHERE family.site_ref=$1 AND family.session_ref=$2 AND family.state='active'
         AND credential.site_ref=family.site_ref AND credential.family_ref=family.family_ref
         AND credential.state='active'`,
      [input.siteRef, found.sessionRef],
    );
    await sql.execute(
      `UPDATE platform.identity_refresh_family
       SET state='revoked',revoked_at=$3::timestamptz,revoke_reason='delivery_superseded',updated_at=$3::timestamptz
       WHERE site_ref=$1 AND session_ref=$2 AND state='active'`,
      [input.siteRef, found.sessionRef, input.now],
    );
    const prior = revoked[0];
    return Object.freeze({
      accountRef: found.accountRef,
      subjectRef: found.subjectRef,
      authenticationMethods: identityAuthenticationMethods(found.authenticationMethods),
      revoked: Object.freeze({
        siteRef: input.siteRef, subjectRef: found.subjectRef, identitySessionRef: found.sessionRef,
        state: "revoked" as const, identitySessionEpoch: prior.identitySessionEpoch.toString(),
        credentialEpoch: prior.credentialEpoch.toString(), expiresAt: instant(prior.expiresAt),
        updatedAt: input.now, retainUntil: input.retainUntil,
      }),
    });
  }

  async loadIdentityRefreshCredential(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["loadIdentityRefreshCredential"]>[1],
  ) {
    const rows = await resolvePlatformTransaction(transaction).query<RefreshCredentialRow>(
      `SELECT family.account_ref AS "accountRef",family.subject_ref AS "subjectRef",
              family.session_ref AS "sessionRef",family.family_ref AS "familyRef",
              credential.generation, family.current_generation AS "currentGeneration",
              credential.state AS "credentialState",family.state AS "familyState",
              identity_session.state AS "sessionState",credential.expires_at AS "credentialExpiresAt",
              family.absolute_expires_at AS "absoluteExpiresAt"
       FROM platform.identity_refresh_credential credential
       JOIN platform.identity_refresh_family family
         ON family.site_ref=credential.site_ref AND family.family_ref=credential.family_ref
       JOIN platform.authorization_identity_session identity_session
         ON identity_session.site_ref=family.site_ref AND identity_session.session_ref=family.session_ref
           AND identity_session.subject_ref=family.subject_ref
       WHERE credential.site_ref=$1 AND credential.credential_digest=$2
       FOR UPDATE OF credential,family,identity_session`,
      [input.siteRef, input.credentialDigest],
    );
    const found = rows[0];
    return found === undefined ? null : Object.freeze({
      ...found,
      generation: Number(found.generation), currentGeneration: Number(found.currentGeneration),
      credentialExpiresAt: instant(found.credentialExpiresAt),
      absoluteExpiresAt: instant(found.absoluteExpiresAt),
    });
  }

  async rotateIdentityRefreshCredential(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["rotateIdentityRefreshCredential"]>[1],
  ): Promise<IdentitySessionCurrentFact> {
    const sql = resolvePlatformTransaction(transaction);
    const consumed = await sql.execute(
      `UPDATE platform.identity_refresh_credential
       SET state='consumed',consumed_at=$5::timestamptz
       WHERE site_ref=$1 AND family_ref=$2 AND generation=$3 AND state='active'
         AND expires_at>$4::timestamptz`,
      [input.siteRef, input.familyRef, input.expectedGeneration, input.now, input.now],
    );
    const family = await sql.execute(
      `UPDATE platform.identity_refresh_family
       SET current_generation=$4,updated_at=$5::timestamptz
       WHERE site_ref=$1 AND family_ref=$2 AND current_generation=$3 AND state='active'
         AND absolute_expires_at>$5::timestamptz`,
      [input.siteRef, input.familyRef, input.expectedGeneration, input.newGeneration, input.now],
    );
    if (consumed !== 1 || family !== 1) throw new Error("IDENTITY_REFRESH_ROTATION_STALE");
    await sql.execute(
      `INSERT INTO platform.identity_refresh_credential
       (site_ref,family_ref,generation,credential_digest,state,expires_at,created_at)
       VALUES ($1,$2,$3,$4,'active',$5::timestamptz,$6::timestamptz)`,
      [input.siteRef, input.familyRef, input.newGeneration, input.refreshCredentialDigest,
        input.refreshExpiresAt, input.now],
    );
    const currentRows = await sql.query<ActiveSessionRow>(
      `UPDATE platform.authorization_identity_session
       SET credential_digest=$4,credential_epoch=credential_epoch+1,
           expires_at=$5::timestamptz,last_seen_at=$6::timestamptz,updated_at=$6::timestamptz
       WHERE site_ref=$1 AND subject_ref=$2 AND session_ref=$3 AND state='active'
       RETURNING session_epoch AS "identitySessionEpoch",credential_epoch AS "credentialEpoch"`,
      [input.siteRef, input.subjectRef, input.sessionRef, input.sessionCredentialDigest,
        input.sessionExpiresAt, input.now],
    );
    const current = currentRows[0];
    if (current === undefined) throw new Error("IDENTITY_REFRESH_SESSION_STALE");
    await insertSessionDeliveryClaim(sql, {
      commandId: input.commandId, siteRef: input.siteRef, subjectRef: input.subjectRef,
      sessionRef: input.sessionRef, requestDigest: input.requestDigest, claimedAt: input.now,
    });
    return activeSessionFact(input, current);
  }

  async revokeIdentityRefreshFamilyForReplay(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["revokeIdentityRefreshFamilyForReplay"]>[1],
  ): Promise<IdentitySessionCurrentFact> {
    const sql = resolvePlatformTransaction(transaction);
    const family = await sql.execute(
      `UPDATE platform.identity_refresh_family
       SET state='revoked',revoked_at=$5::timestamptz,revoke_reason='refresh_replay',updated_at=$5::timestamptz
       WHERE site_ref=$1 AND family_ref=$2 AND session_ref=$3
         AND current_generation=$4 AND state='active'`,
      [input.siteRef, input.familyRef, input.sessionRef, input.expectedCurrentGeneration, input.now],
    );
    if (family !== 1) throw new Error("IDENTITY_REFRESH_REPLAY_STALE");
    await sql.execute(
      `UPDATE platform.identity_refresh_credential SET state='revoked'
       WHERE site_ref=$1 AND family_ref=$2 AND state='active'`,
      [input.siteRef, input.familyRef],
    );
    const rows = await sql.query<RevokedSessionRow>(
      `UPDATE platform.authorization_identity_session
       SET state='revoked',session_epoch=session_epoch+1,credential_epoch=credential_epoch+1,
           updated_at=$4::timestamptz
       WHERE site_ref=$1 AND subject_ref=$2 AND session_ref=$3 AND state='active'
       RETURNING session_epoch AS "identitySessionEpoch",credential_epoch AS "credentialEpoch",
                 expires_at AS "expiresAt"`,
      [input.siteRef, input.subjectRef, input.sessionRef, input.now],
    );
    const revoked = rows[0];
    if (revoked === undefined) throw new Error("IDENTITY_REFRESH_REPLAY_SESSION_STALE");
    return Object.freeze({
      siteRef: input.siteRef, subjectRef: input.subjectRef, identitySessionRef: input.sessionRef,
      state: "revoked", identitySessionEpoch: revoked.identitySessionEpoch.toString(),
      credentialEpoch: revoked.credentialEpoch.toString(), expiresAt: instant(revoked.expiresAt),
      updatedAt: input.now, retainUntil: input.retainUntil,
    });
  }

  async supersedeIdentityRefreshDelivery(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["supersedeIdentityRefreshDelivery"]>[1],
  ) {
    const sql = resolvePlatformTransaction(transaction);
    const rows = await sql.query<RefreshDeliveryRecoveryRow>(
      `SELECT claim.subject_ref AS "subjectRef",claim.session_ref AS "sessionRef",
              claim.request_digest AS "claimRequestDigest",receipt.request_digest AS "receiptRequestDigest",
              receipt.caller_identity AS "callerIdentity",receipt.operation,receipt.state AS "receiptState",
              recovery.site_ref AS "recoverySiteRef",recovery.site_release_ref AS "recoverySiteReleaseRef",
              recovery.site_project_binding_ref AS "recoverySiteProjectBindingRef",
              recovery.workload_identity_id AS "recoveryWorkloadIdentityId",
              recovery.binding_epoch AS "recoveryBindingEpoch",
              recovery.purpose AS "recoveryPurpose",recovery.transaction_ref AS "recoveryTransactionRef",
              recovery.capability_digest AS "capabilityDigest",recovery.state AS "recoveryState",
              recovery.expires_at AS "recoveryExpiresAt",family.family_ref AS "familyRef",
              family.current_generation AS "currentGeneration",family.absolute_expires_at AS "absoluteExpiresAt",
              identity_session.state AS "sessionState"
       FROM platform.identity_session_delivery_claim claim
       JOIN platform.identity_receipt_recovery_capability recovery ON recovery.command_id=claim.command_id
       JOIN platform.authorization_site site
         ON site.site_ref=recovery.site_ref AND site.site_ref=$2 AND site.state='active'
       JOIN platform.authorization_site_release release
         ON release.site_ref=recovery.site_ref AND release.release_ref=recovery.site_release_ref
           AND release.release_ref=$3 AND release.state='active'
       JOIN platform.authorization_product_binding product_binding
         ON product_binding.site_ref=recovery.site_ref
           AND product_binding.release_ref=recovery.site_release_ref
           AND product_binding.binding_ref=recovery.site_project_binding_ref
           AND product_binding.binding_ref=$4
           AND product_binding.workload_identity_id=recovery.workload_identity_id
           AND product_binding.workload_identity_id=$5
           AND product_binding.binding_epoch=recovery.binding_epoch
           AND product_binding.binding_epoch=$6::bigint AND product_binding.state='active'
       JOIN platform.command_receipt receipt ON receipt.command_id=claim.command_id
       JOIN platform.authorization_identity_session identity_session
         ON identity_session.site_ref=claim.site_ref AND identity_session.session_ref=claim.session_ref
           AND identity_session.subject_ref=claim.subject_ref
       JOIN platform.identity_refresh_family family
         ON family.site_ref=claim.site_ref AND family.session_ref=claim.session_ref AND family.state='active'
       JOIN platform.identity_refresh_credential credential
         ON credential.site_ref=family.site_ref AND credential.family_ref=family.family_ref
           AND credential.generation=family.current_generation AND credential.state='active'
       WHERE claim.command_id=$1 AND claim.site_ref=$2 AND claim.state='first_claim_consumed'
       FOR UPDATE OF claim,recovery,receipt,identity_session,family,credential
       FOR SHARE OF site,release,product_binding`,
      [input.priorCommandId, input.siteRef, input.siteReleaseRef, input.siteProjectBindingRef,
        input.workloadIdentityId, input.bindingEpoch],
    );
    const found = rows[0];
    if (
      found === undefined || found.recoverySiteRef !== input.siteRef ||
      found.recoverySiteReleaseRef !== input.siteReleaseRef ||
      found.recoverySiteProjectBindingRef !== input.siteProjectBindingRef ||
      found.recoveryWorkloadIdentityId !== input.workloadIdentityId ||
      found.recoveryBindingEpoch.toString() !== input.bindingEpoch ||
      found.recoveryPurpose !== input.purpose || found.recoveryTransactionRef !== null ||
      found.recoveryState !== "active" || Date.parse(instant(found.recoveryExpiresAt)) <= Date.parse(input.now) ||
      found.callerIdentity !== input.workloadIdentityId || found.operation !== input.purpose ||
      found.receiptState !== "succeeded" || found.sessionState !== "active" ||
      Date.parse(instant(found.absoluteExpiresAt)) <= Date.parse(input.now) ||
      found.claimRequestDigest !== found.receiptRequestDigest ||
      !constantTimeDigestEqual(found.capabilityDigest, input.capabilityDigest)
    ) return null;
    const newGeneration = Number(found.currentGeneration) + 1;
    const transferred = await sql.execute(
      `UPDATE platform.identity_receipt_recovery_capability SET command_id=$2
       WHERE command_id=$1 AND state='active'`,
      [input.priorCommandId, input.newCommandId],
    );
    const superseded = await sql.execute(
      `UPDATE platform.identity_session_delivery_claim SET state='superseded',superseded_at=$2::timestamptz
       WHERE command_id=$1 AND state='first_claim_consumed'`,
      [input.priorCommandId, input.now],
    );
    const priorCredential = await sql.execute(
      `UPDATE platform.identity_refresh_credential SET state='revoked'
       WHERE site_ref=$1 AND family_ref=$2 AND generation=$3 AND state='active'`,
      [input.siteRef, found.familyRef, Number(found.currentGeneration)],
    );
    const family = await sql.execute(
      `UPDATE platform.identity_refresh_family SET current_generation=$3,updated_at=$5::timestamptz
       WHERE site_ref=$1 AND family_ref=$2 AND current_generation=$4 AND state='active'`,
      [input.siteRef, found.familyRef, newGeneration, Number(found.currentGeneration), input.now],
    );
    if (transferred !== 1 || superseded !== 1 || priorCredential !== 1 || family !== 1) {
      throw new Error("IDENTITY_REFRESH_DELIVERY_RECOVERY_STALE");
    }
    const refreshExpiresAt = instant(found.absoluteExpiresAt);
    const sessionExpiresAt = Date.parse(input.sessionExpiresAt) <= Date.parse(refreshExpiresAt)
      ? input.sessionExpiresAt
      : refreshExpiresAt;
    await sql.execute(
      `INSERT INTO platform.identity_refresh_credential
       (site_ref,family_ref,generation,credential_digest,state,expires_at,created_at)
       VALUES ($1,$2,$3,$4,'active',$5::timestamptz,$6::timestamptz)`,
      [input.siteRef, found.familyRef, newGeneration, input.refreshCredentialDigest, refreshExpiresAt, input.now],
    );
    const currentRows = await sql.query<ActiveSessionRow>(
      `UPDATE platform.authorization_identity_session
       SET credential_digest=$4,credential_epoch=credential_epoch+1,
           expires_at=$5::timestamptz,last_seen_at=$6::timestamptz,updated_at=$6::timestamptz
       WHERE site_ref=$1 AND subject_ref=$2 AND session_ref=$3 AND state='active'
       RETURNING session_epoch AS "identitySessionEpoch",credential_epoch AS "credentialEpoch"`,
      [input.siteRef, found.subjectRef, found.sessionRef, input.sessionCredentialDigest,
        sessionExpiresAt, input.now],
    );
    const current = currentRows[0];
    if (current === undefined) throw new Error("IDENTITY_REFRESH_DELIVERY_SESSION_STALE");
    await insertSessionDeliveryClaim(sql, {
      commandId: input.newCommandId, siteRef: input.siteRef, subjectRef: found.subjectRef,
      sessionRef: found.sessionRef, requestDigest: input.requestDigest, claimedAt: input.now,
    });
    return Object.freeze({
      current: activeSessionFact({
        ...input, subjectRef: found.subjectRef, sessionRef: found.sessionRef, sessionExpiresAt,
      }, current),
      sessionRef: found.sessionRef,
      refreshExpiresAt,
    });
  }

  async listIdentitySessions(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["listIdentitySessions"]>[1],
  ): Promise<readonly IdentitySessionSafeFact[]> {
    const rows = await resolvePlatformTransaction(transaction).query<SessionSafeRow>(
      `SELECT session_ref AS "sessionRef",
              CASE WHEN state='active' AND expires_at<=$4::timestamptz THEN 'expired' ELSE state END AS status,
              session_ref=$3 AS current,device_label AS "deviceLabel",created_at AS "createdAt",
              last_seen_at AS "lastSeenAt",expires_at AS "expiresAt"
       FROM platform.authorization_identity_session
       WHERE site_ref=$1 AND subject_ref=$2
       ORDER BY created_at DESC,session_ref LIMIT 200`,
      [input.siteRef, input.subjectRef, input.currentSessionRef, input.now],
    );
    return Object.freeze(rows.map((row) => Object.freeze({
      ...row, createdAt: instant(row.createdAt), lastSeenAt: instant(row.lastSeenAt), expiresAt: instant(row.expiresAt),
    })));
  }

  async selectSessionsForRevocation(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["selectSessionsForRevocation"]>[1],
  ): Promise<readonly string[]> {
    const rows = await resolvePlatformTransaction(transaction).query<{ sessionRef: string }>(
      `SELECT session_ref AS "sessionRef" FROM platform.authorization_identity_session
       WHERE site_ref=$1 AND subject_ref=$2 AND state='active' AND (
         ($4='current' AND session_ref=$3) OR
         ($4='single' AND session_ref=$5) OR
         ($4='others' AND session_ref<>$3) OR
         $4='all'
       ) ORDER BY session_ref`,
      [input.siteRef, input.subjectRef, input.currentSessionRef, input.target, input.sessionRef],
    );
    return Object.freeze(rows.map((row) => row.sessionRef));
  }

  async revokeExactIdentitySession(
    transaction: PlatformTransaction,
    input: Parameters<IdentityRepository["revokeExactIdentitySession"]>[1],
  ): Promise<IdentitySessionCurrentFact> {
    const sql = resolvePlatformTransaction(transaction);
    const rows = await sql.query<RevokedSessionRow>(
      `UPDATE platform.authorization_identity_session
       SET state='revoked',session_epoch=session_epoch+1,credential_epoch=credential_epoch+1,
           updated_at=$4::timestamptz
       WHERE site_ref=$1 AND subject_ref=$2 AND session_ref=$3 AND state='active'
       RETURNING session_epoch AS "identitySessionEpoch",credential_epoch AS "credentialEpoch",
                 expires_at AS "expiresAt"`,
      [input.siteRef, input.subjectRef, input.sessionRef, input.now],
    );
    const revoked = rows[0];
    if (revoked === undefined) throw new Error("IDENTITY_SESSION_STALE");
    await sql.execute(
      `UPDATE platform.identity_refresh_credential credential SET state='revoked'
       FROM platform.identity_refresh_family family
       WHERE family.site_ref=$1 AND family.session_ref=$2 AND family.state='active'
         AND credential.site_ref=family.site_ref AND credential.family_ref=family.family_ref
         AND credential.state='active'`,
      [input.siteRef, input.sessionRef],
    );
    await sql.execute(
      `UPDATE platform.identity_refresh_family
       SET state='revoked',revoked_at=$3::timestamptz,revoke_reason=$4,updated_at=$3::timestamptz
       WHERE site_ref=$1 AND session_ref=$2 AND state='active'`,
      [input.siteRef, input.sessionRef, input.now, input.reason],
    );
    return Object.freeze({
      siteRef: input.siteRef, subjectRef: input.subjectRef, identitySessionRef: input.sessionRef,
      state: "revoked", identitySessionEpoch: revoked.identitySessionEpoch.toString(),
      credentialEpoch: revoked.credentialEpoch.toString(), expiresAt: instant(revoked.expiresAt),
      updatedAt: input.now, retainUntil: input.retainUntil,
    });
  }
}

const verificationSelect = `SELECT verification.transaction_ref AS "transactionRef",
  verification.account_ref AS "accountRef",verification.subject_ref AS "subjectRef",
  verification.email_normalized AS "emailNormalized",
  verification.secret_digest AS "secretDigest",verification.state,
  verification.attempt_count AS "attemptCount",verification.max_attempts AS "maxAttempts",
  verification.resend_count AS "resendCount",verification.expires_at AS "expiresAt",
  latest_delivery.created_at AS "lastDeliveryAt"
  FROM platform.identity_verification_transaction verification`;

interface VerificationRow extends Record<string, unknown>, Omit<VerificationRecord, "expiresAt" | "lastDeliveryAt"> {
  expiresAt: string | Date;
  lastDeliveryAt: string | Date | null;
}

interface AccountRow extends Record<string, unknown>, Omit<AccountPasswordRecord, "credentialEpoch"> {
  credentialEpoch: bigint;
}

interface AuthRateLimitRow extends Record<string, unknown> {
  failedAttemptCount: number;
  lockedUntil: string | Date | null;
  windowStartedAt: string | Date;
}

interface AuthMaterialRow extends Record<string, unknown> {
  accountRef: string;
  subjectRef: string;
  transactionRef: string;
  challengeKind: "totp" | "recovery";
  expiresAt: string | Date;
  authenticatorRef: string | null;
  recoverySetRef: string | null;
  secretAlgorithm: string | null;
  secretKeyRevision: string | null;
  secretNonce: string | null;
  secretCiphertext: string | null;
  secretAuthenticationTag: string | null;
  lastAcceptedTimeStep: bigint | null;
}

interface RecoveryDigestRow extends Record<string, unknown> {
  codeDigest: string;
}

interface AuthTransactionRow extends Record<string, unknown> {
  accountRef: string;
  subjectRef: string;
  authenticatorRef: string | null;
  recoverySetRef: string | null;
  passwordCredentialEpoch: bigint;
  state: "pending" | "consumed" | "expired" | "locked";
  attemptCount: number;
  maxAttempts: number;
  expiresAt: string | Date;
}

interface SessionSafeRow extends Record<string, unknown>, Omit<IdentitySessionSafeFact, "createdAt" | "lastSeenAt" | "expiresAt"> {
  createdAt: string | Date; lastSeenAt: string | Date; expiresAt: string | Date;
}

interface RevokedSessionRow extends Record<string, unknown> {
  identitySessionEpoch: bigint; credentialEpoch: bigint; expiresAt: string | Date;
}

interface ActiveSessionRow extends Record<string, unknown> {
  identitySessionEpoch: bigint; credentialEpoch: bigint;
}

interface RefreshCredentialRow extends Record<string, unknown> {
  accountRef: string; subjectRef: string; sessionRef: string; familyRef: string;
  generation: bigint | number; currentGeneration: bigint | number;
  credentialState: "active" | "consumed" | "revoked";
  familyState: "active" | "revoked" | "expired";
  sessionState: "active" | "revoked" | "expired";
  credentialExpiresAt: string | Date;
  absoluteExpiresAt: string | Date;
}

interface RefreshDeliveryRecoveryRow extends Record<string, unknown> {
  subjectRef: string; sessionRef: string; claimRequestDigest: string; receiptRequestDigest: string;
  callerIdentity: string; operation: string; receiptState: string;
  recoverySiteRef: string; recoverySiteReleaseRef: string; recoverySiteProjectBindingRef: string;
  recoveryWorkloadIdentityId: string; recoveryBindingEpoch: bigint; recoveryPurpose: string;
  recoveryTransactionRef: string | null; capabilityDigest: string; recoveryState: string;
  recoveryExpiresAt: string | Date; familyRef: string; currentGeneration: bigint | number;
  absoluteExpiresAt: string | Date; sessionState: string;
}

interface SessionDeliveryRecoveryRow extends Record<string, unknown> {
  accountRef: string; subjectRef: string; sessionRef: string;
  claimRequestDigest: string; receiptRequestDigest: string;
  callerIdentity: string; operation: string; receiptState: string;
  recoverySiteRef: string; recoverySiteReleaseRef: string; recoverySiteProjectBindingRef: string;
  recoveryWorkloadIdentityId: string; recoveryBindingEpoch: bigint; recoveryPurpose: string;
  recoveryTransactionRef: string | null; capabilityDigest: string; recoveryState: string;
  recoveryExpiresAt: string | Date; sessionEpoch: bigint; credentialEpoch: bigint;
  sessionExpiresAt: string | Date; sessionState: string; authenticationMethods: unknown;
}

function verification(row: VerificationRow): VerificationRecord {
  return Object.freeze({
    ...row,
    expiresAt: instant(row.expiresAt),
    lastDeliveryAt: row.lastDeliveryAt === null ? null : instant(row.lastDeliveryAt),
  });
}

function instant(value: string | Date): string {
  return new Date(value).toISOString();
}

function constantTimeDigestEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "ascii");
  const b = Buffer.from(right, "ascii");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function recordAuthenticationFailure(
  sql: PlatformSqlTransaction,
  input: Readonly<{ siteRef: string; transactionRef: string; now: string }>,
  auth: AuthTransactionRow,
  rate: AuthRateLimitRow | undefined,
): Promise<void> {
  const nextAttempt = Math.min(auth.maxAttempts, auth.attemptCount + 1);
  await sql.execute(
    `UPDATE platform.identity_auth_transaction
     SET attempt_count=$3,state=CASE WHEN $3>=max_attempts THEN 'locked' ELSE 'pending' END,
         updated_at=$4::timestamptz
     WHERE site_ref=$1 AND transaction_ref=$2 AND state='pending'`,
    [input.siteRef, input.transactionRef, nextAttempt, input.now],
  );
  await recordAuthenticationRateFailure(sql, {
    siteRef: input.siteRef, accountRef: auth.accountRef, now: input.now,
  }, rate);
}

async function recordAuthenticationRateFailure(
  sql: PlatformSqlTransaction,
  input: Readonly<{ siteRef: string; accountRef: string; now: string }>,
  rate: AuthRateLimitRow | undefined,
): Promise<void> {
  const windowExpired = rate === undefined ||
    Date.parse(input.now) - Date.parse(instant(rate.windowStartedAt)) >= 15 * 60_000;
  const failureCount = windowExpired ? 1 : Math.min(10, rate.failedAttemptCount + 1);
  const windowStartedAt = windowExpired ? input.now : instant(rate.windowStartedAt);
  const lockedUntil = failureCount >= 10
    ? new Date(Date.parse(input.now) + 15 * 60_000).toISOString()
    : null;
  await sql.execute(
    `INSERT INTO platform.identity_auth_rate_limit
     (site_ref,account_ref,purpose,window_started_at,failed_attempt_count,locked_until,updated_at)
     VALUES ($1,$2,'session_login',$3::timestamptz,$4,$5::timestamptz,$6::timestamptz)
     ON CONFLICT(site_ref,account_ref,purpose) DO UPDATE
     SET window_started_at=EXCLUDED.window_started_at,
         failed_attempt_count=EXCLUDED.failed_attempt_count,
         locked_until=EXCLUDED.locked_until,
         updated_at=EXCLUDED.updated_at`,
    [input.siteRef, input.accountRef, windowStartedAt, failureCount, lockedUntil, input.now],
  );
}

async function resetAuthenticationRateLimit(
  sql: PlatformSqlTransaction,
  input: Readonly<{ siteRef: string; accountRef: string; now: string }>,
): Promise<void> {
  await sql.execute(
    `INSERT INTO platform.identity_auth_rate_limit
     (site_ref,account_ref,purpose,window_started_at,failed_attempt_count,locked_until,updated_at)
     VALUES ($1,$2,'session_login',$3::timestamptz,0,NULL,$3::timestamptz)
     ON CONFLICT(site_ref,account_ref,purpose) DO UPDATE
     SET window_started_at=EXCLUDED.window_started_at,failed_attempt_count=0,locked_until=NULL,
         updated_at=EXCLUDED.updated_at`,
    [input.siteRef, input.accountRef, input.now],
  );
}

function identityAuthenticationMethods(
  value: unknown,
): readonly ("password" | "totp" | "recovery_code")[] {
  if (!Array.isArray(value) || value.length < 1 ||
      value.some((method) => method !== "password" && method !== "totp" && method !== "recovery_code")) {
    throw new Error("IDENTITY_SESSION_AUTHENTICATION_METHODS_INVALID");
  }
  return Object.freeze([...value]) as readonly ("password" | "totp" | "recovery_code")[];
}

async function insertSessionDeliveryClaim(
  sql: PlatformSqlTransaction,
  input: Readonly<{
    commandId: string; siteRef: string; subjectRef: string; sessionRef: string;
    requestDigest: string; claimedAt: string;
  }>,
): Promise<void> {
  const changed = await sql.execute(
    `INSERT INTO platform.identity_session_delivery_claim
     (command_id,site_ref,subject_ref,session_ref,request_digest,state,claimed_at)
     VALUES ($1,$2,$3,$4,$5,'first_claim_consumed',$6::timestamptz)`,
    [input.commandId, input.siteRef, input.subjectRef, input.sessionRef, input.requestDigest, input.claimedAt],
  );
  if (changed !== 1) throw new Error("IDENTITY_SESSION_DELIVERY_CREATE_FAILED");
}

function activeSessionFact(
  input: Readonly<{
    siteRef: string; subjectRef: string; sessionRef: string; now: string;
    sessionExpiresAt: string; retainUntil: string;
  }>,
  current: ActiveSessionRow,
): IdentitySessionCurrentFact {
  return Object.freeze({
    siteRef: input.siteRef, subjectRef: input.subjectRef, identitySessionRef: input.sessionRef,
    state: "active", identitySessionEpoch: current.identitySessionEpoch.toString(),
    credentialEpoch: current.credentialEpoch.toString(), expiresAt: input.sessionExpiresAt,
    updatedAt: input.now, retainUntil: input.retainUntil,
  });
}
