import type {
  AdminOidcReceipt,
  AdminOidcStore,
  AdminOidcTransaction,
  AdminOidcTransactionState,
  AdminWorkloadAxes,
} from "../../application/services/admin-oidc-service.js";
import {
  resolvePlatformTransaction,
  type PlatformTransaction,
} from "../../../../shared/unit-of-work/platform-transaction.js";

export type AdminIdentityOperation =
  | "admin.identity.begin"
  | "admin.identity.exchange"
  | "admin.identity.delivery.read";

export interface AdminIdentityTransactionHost {
  adminIdentityTransaction<Result>(
    fence: Readonly<{ operation: AdminIdentityOperation } & AdminWorkloadAxes>,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
}

interface TransactionRow extends Record<string, unknown> {
  transactionRef: unknown;
  state: unknown;
  beginCommandId: unknown;
  beginIdempotencyKey: unknown;
  beginRequestDigest: unknown;
  workloadIdentityRef: unknown;
  environment: unknown;
  region: unknown;
  managedDeviceRef: unknown;
  audience: unknown;
  returnIntentRef: unknown;
  issuer: unknown;
  clientId: unknown;
  oidcAudience: unknown;
  exactCallbackUri: unknown;
  pkceVerifierCiphertext: unknown;
  pkceChallenge: unknown;
  nonceCiphertext: unknown;
  stateDigest: unknown;
  recoveryDigest: unknown;
  signingKeyRevision: unknown;
  deliveryKeyRevision: unknown;
  exchangeCommandId: unknown;
  exchangeIdempotencyKey: unknown;
  exchangeRequestDigest: unknown;
  operatorSessionRef: unknown;
  sessionExpiresAt: unknown;
  deliveryEnvelope: unknown;
  exchangeReceipt: unknown;
  expiresAt: unknown;
  recoveryExpiresAt: unknown;
  deliveryExpiresAt: unknown;
}

const RETURNING = `RETURNING transaction_ref AS "transactionRef",state,
  begin_command_id AS "beginCommandId",begin_idempotency_key AS "beginIdempotencyKey",
  begin_request_digest AS "beginRequestDigest",workload_identity_ref AS "workloadIdentityRef",
  environment,region,managed_device_ref AS "managedDeviceRef",audience,
  return_intent_ref AS "returnIntentRef",issuer,client_id AS "clientId",
  oidc_audience AS "oidcAudience",exact_callback_uri AS "exactCallbackUri",
  pkce_verifier_ciphertext AS "pkceVerifierCiphertext",pkce_challenge AS "pkceChallenge",
  nonce_ciphertext AS "nonceCiphertext",
  state_digest AS "stateDigest",recovery_digest AS "recoveryDigest",
  signing_key_revision AS "signingKeyRevision",delivery_key_revision AS "deliveryKeyRevision",
  exchange_command_id AS "exchangeCommandId",exchange_idempotency_key AS "exchangeIdempotencyKey",
  exchange_request_digest AS "exchangeRequestDigest",operator_session_ref AS "operatorSessionRef",
  session_expires_at AS "sessionExpiresAt",
  delivery_envelope AS "deliveryEnvelope",exchange_receipt AS "exchangeReceipt",
  expires_at AS "expiresAt",recovery_expires_at AS "recoveryExpiresAt",
  delivery_expires_at AS "deliveryExpiresAt"`;

export class PostgresAdminOidcStore implements AdminOidcStore {
  constructor(private readonly host: AdminIdentityTransactionHost) {}

  create(transaction: AdminOidcTransaction): Promise<AdminOidcTransaction> {
    return this.host.adminIdentityTransaction(
      { operation: "admin.identity.begin", ...transaction.axes },
      async (ownerTransaction) => {
        const sql = resolvePlatformTransaction(ownerTransaction);
        const rows = await sql.query<TransactionRow>(
          `INSERT INTO platform.admin_oidc_transaction(
             transaction_ref,state,begin_command_id,begin_idempotency_key,begin_request_digest,
             workload_identity_ref,environment,region,managed_device_ref,audience,return_intent_ref,
             issuer,client_id,oidc_audience,exact_callback_uri,pkce_verifier_ciphertext,
             pkce_challenge,nonce_ciphertext,state_digest,recovery_digest,signing_key_revision,
             delivery_key_revision,expires_at,recovery_expires_at
           ) VALUES(
             $1::uuid,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
             $18,$19,$20,$21,$22::timestamptz,$23::timestamptz
           ) ON CONFLICT(workload_identity_ref,environment,region,begin_idempotency_key)
             DO NOTHING ${RETURNING}`,
          [
            transaction.transactionRef, transaction.beginCommandId,
            transaction.beginIdempotencyKey, transaction.beginRequestDigest,
            transaction.axes.workloadIdentityRef, transaction.axes.environment,
            transaction.axes.region, transaction.axes.managedDeviceRef, transaction.axes.audience,
            transaction.returnIntentRef, transaction.issuer, transaction.clientId,
            transaction.oidcAudience, transaction.exactCallbackUri,
            transaction.pkceVerifierCiphertext, transaction.pkceChallenge,
            transaction.nonceCiphertext, transaction.stateDigest, transaction.recoveryDigest,
            transaction.signingKeyRevision,
            transaction.deliveryKeyRevision, transaction.expiresAt, transaction.recoveryExpiresAt,
          ],
        );
        if (rows[0] !== undefined) return mapTransaction(rows[0]);
        const existing = await sql.query<TransactionRow>(
          `SELECT transaction_ref AS "transactionRef",state,
             begin_command_id AS "beginCommandId",begin_idempotency_key AS "beginIdempotencyKey",
             begin_request_digest AS "beginRequestDigest",workload_identity_ref AS "workloadIdentityRef",
             environment,region,managed_device_ref AS "managedDeviceRef",audience,
             return_intent_ref AS "returnIntentRef",issuer,client_id AS "clientId",
             oidc_audience AS "oidcAudience",exact_callback_uri AS "exactCallbackUri",
             pkce_verifier_ciphertext AS "pkceVerifierCiphertext",pkce_challenge AS "pkceChallenge",
             nonce_ciphertext AS "nonceCiphertext",state_digest AS "stateDigest",
             recovery_digest AS "recoveryDigest",signing_key_revision AS "signingKeyRevision",
             delivery_key_revision AS "deliveryKeyRevision",exchange_command_id AS "exchangeCommandId",
             exchange_idempotency_key AS "exchangeIdempotencyKey",
             exchange_request_digest AS "exchangeRequestDigest",
             operator_session_ref AS "operatorSessionRef",session_expires_at AS "sessionExpiresAt",
             delivery_envelope AS "deliveryEnvelope",exchange_receipt AS "exchangeReceipt",
             expires_at AS "expiresAt",recovery_expires_at AS "recoveryExpiresAt",
             delivery_expires_at AS "deliveryExpiresAt"
           FROM platform.admin_oidc_transaction
           WHERE workload_identity_ref=$1 AND environment=$2 AND region=$3
             AND managed_device_ref=$4 AND audience=$5 AND begin_idempotency_key=$6 LIMIT 1`,
          [transaction.axes.workloadIdentityRef, transaction.axes.environment, transaction.axes.region,
            transaction.axes.managedDeviceRef, transaction.axes.audience,
            transaction.beginIdempotencyKey],
        );
        return requiredTransaction(existing[0]);
      },
    );
  }

  find(transactionRef: string, axes: AdminWorkloadAxes): Promise<AdminOidcTransaction | null> {
    return this.host.adminIdentityTransaction(
      { operation: "admin.identity.delivery.read", ...axes },
      async (ownerTransaction) => {
        const rows = await resolvePlatformTransaction(ownerTransaction).query<TransactionRow>(
          `SELECT transaction_ref AS "transactionRef",state,
             begin_command_id AS "beginCommandId",begin_idempotency_key AS "beginIdempotencyKey",
             begin_request_digest AS "beginRequestDigest",workload_identity_ref AS "workloadIdentityRef",
             environment,region,managed_device_ref AS "managedDeviceRef",audience,
             return_intent_ref AS "returnIntentRef",issuer,client_id AS "clientId",
             oidc_audience AS "oidcAudience",exact_callback_uri AS "exactCallbackUri",
             pkce_verifier_ciphertext AS "pkceVerifierCiphertext",pkce_challenge AS "pkceChallenge",
             nonce_ciphertext AS "nonceCiphertext",
             state_digest AS "stateDigest",recovery_digest AS "recoveryDigest",
             signing_key_revision AS "signingKeyRevision",delivery_key_revision AS "deliveryKeyRevision",
             exchange_command_id AS "exchangeCommandId",exchange_idempotency_key AS "exchangeIdempotencyKey",
             exchange_request_digest AS "exchangeRequestDigest",operator_session_ref AS "operatorSessionRef",
             session_expires_at AS "sessionExpiresAt",
             delivery_envelope AS "deliveryEnvelope",exchange_receipt AS "exchangeReceipt",
             expires_at AS "expiresAt",recovery_expires_at AS "recoveryExpiresAt",
             delivery_expires_at AS "deliveryExpiresAt"
           FROM platform.admin_oidc_transaction
           WHERE transaction_ref=$1::uuid AND workload_identity_ref=$2 AND environment=$3
             AND region=$4 AND managed_device_ref=$5 AND audience=$6
           LIMIT 1`,
          [transactionRef, axes.workloadIdentityRef, axes.environment, axes.region,
            axes.managedDeviceRef, axes.audience],
        );
        return rows[0] === undefined ? null : mapTransaction(rows[0]);
      },
    );
  }

  claimExchange(
    transactionRef: string,
    request: Readonly<{ commandId: string; idempotencyKey: string; requestDigest: string }>,
    axes: AdminWorkloadAxes,
  ): Promise<AdminOidcTransaction | null> {
    return this.host.adminIdentityTransaction(
      { operation: "admin.identity.exchange", ...axes },
      async (ownerTransaction) => {
        const rows = await resolvePlatformTransaction(ownerTransaction).query<TransactionRow>(
          `UPDATE platform.admin_oidc_transaction SET state='redeeming',
             exchange_command_id=$7,exchange_idempotency_key=$8,exchange_request_digest=$9,
             claimed_at=now(),updated_at=now()
           WHERE transaction_ref=$1::uuid AND state='pending' AND workload_identity_ref=$2
             AND environment=$3 AND region=$4 AND managed_device_ref=$5 AND audience=$6
             AND expires_at>now()
           ${RETURNING}`,
          [transactionRef, axes.workloadIdentityRef, axes.environment, axes.region,
            axes.managedDeviceRef, axes.audience, request.commandId, request.idempotencyKey,
            request.requestDigest],
        );
        if (rows[0] !== undefined) return mapTransaction(rows[0]);
        return this.findWithin(ownerTransaction, transactionRef, axes);
      },
    );
  }

  async markProviderOutcomeUnknown(
    transactionRef: string,
    axes: AdminWorkloadAxes,
  ): Promise<void> {
    await this.host.adminIdentityTransaction(
      { operation: "admin.identity.exchange", ...axes },
      async (ownerTransaction) => {
        const changed = await resolvePlatformTransaction(ownerTransaction).execute(
          `UPDATE platform.admin_oidc_transaction
           SET state='provider_outcome_unknown',updated_at=now()
           WHERE transaction_ref=$1::uuid AND state='redeeming' AND workload_identity_ref=$2
             AND environment=$3 AND region=$4 AND managed_device_ref=$5 AND audience=$6`,
          [transactionRef, axes.workloadIdentityRef, axes.environment, axes.region,
            axes.managedDeviceRef, axes.audience],
        );
        if (changed !== 1) throw new Error("ADMIN_OIDC_TRANSACTION_NOT_FOUND");
      },
    );
  }

  async markRejected(
    transactionRef: string,
    axes: AdminWorkloadAxes,
  ): Promise<void> {
    await this.host.adminIdentityTransaction(
      { operation: "admin.identity.exchange", ...axes },
      async (ownerTransaction) => {
        const changed = await resolvePlatformTransaction(ownerTransaction).execute(
          `UPDATE platform.admin_oidc_transaction
           SET state='rejected',updated_at=now()
           WHERE transaction_ref=$1::uuid AND state='redeeming' AND workload_identity_ref=$2
             AND environment=$3 AND region=$4 AND managed_device_ref=$5 AND audience=$6`,
          [transactionRef, axes.workloadIdentityRef, axes.environment, axes.region,
            axes.managedDeviceRef, axes.audience],
        );
        if (changed !== 1) throw new Error("ADMIN_OIDC_TRANSACTION_NOT_FOUND");
      },
    );
  }

  commitExchange(
    transactionRef: string,
    commit: Parameters<AdminOidcStore["commitExchange"]>[1],
    axes: AdminWorkloadAxes,
  ): Promise<AdminOidcTransaction> {
    return this.host.adminIdentityTransaction(
      { operation: "admin.identity.exchange", ...axes },
      async (ownerTransaction) => {
        const sql = resolvePlatformTransaction(ownerTransaction);
        await sql.execute(
          `INSERT INTO platform.admin_operator_session(
             operator_session_ref,credential_digest,operator_ref,operator_generation,
             workload_identity_ref,environment,region,managed_device_ref,audience,
             operator_security_epoch,session_epoch,restriction_epoch,policy_epoch,
             assurance_level,factor_classes,state,authenticated_at,expires_at
           ) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,$13,$14::text[],
                    'active',$15::timestamptz,$16::timestamptz)`,
          [commit.sessionRef, commit.credentialDigest, commit.operatorRef,
            commit.operatorGeneration, axes.workloadIdentityRef, axes.environment, axes.region,
            axes.managedDeviceRef, axes.audience, commit.operatorSecurityEpoch,
            commit.restrictionEpoch, commit.policyEpoch, commit.assuranceLevel,
            [...commit.factorClasses], commit.authenticatedAt, commit.sessionExpiresAt],
        );
        const rows = await sql.query<TransactionRow>(
          `UPDATE platform.admin_oidc_transaction SET state='committed',
             operator_session_ref=$7::uuid,session_expires_at=$8::timestamptz,
             delivery_envelope=$9,exchange_receipt=$10::jsonb,
             delivery_expires_at=$11::timestamptz,committed_at=now(),updated_at=now()
           WHERE transaction_ref=$1::uuid AND state='redeeming' AND workload_identity_ref=$2
             AND environment=$3 AND region=$4 AND managed_device_ref=$5 AND audience=$6
           ${RETURNING}`,
          [transactionRef, axes.workloadIdentityRef, axes.environment, axes.region,
            axes.managedDeviceRef, axes.audience, commit.sessionRef, commit.sessionExpiresAt,
            commit.deliveryEnvelope, JSON.stringify(commit.exchangeReceipt), commit.deliveryExpiresAt],
        );
        return requiredTransaction(rows[0]);
      },
    );
  }

  private async findWithin(
    ownerTransaction: PlatformTransaction,
    transactionRef: string,
    axes: AdminWorkloadAxes,
  ): Promise<AdminOidcTransaction | null> {
    const rows = await resolvePlatformTransaction(ownerTransaction).query<TransactionRow>(
      `SELECT transaction_ref AS "transactionRef",state,
         begin_command_id AS "beginCommandId",begin_idempotency_key AS "beginIdempotencyKey",
         begin_request_digest AS "beginRequestDigest",workload_identity_ref AS "workloadIdentityRef",
         environment,region,managed_device_ref AS "managedDeviceRef",audience,
         return_intent_ref AS "returnIntentRef",issuer,client_id AS "clientId",
         oidc_audience AS "oidcAudience",exact_callback_uri AS "exactCallbackUri",
         pkce_verifier_ciphertext AS "pkceVerifierCiphertext",pkce_challenge AS "pkceChallenge",
         nonce_ciphertext AS "nonceCiphertext",
         state_digest AS "stateDigest",recovery_digest AS "recoveryDigest",
         signing_key_revision AS "signingKeyRevision",delivery_key_revision AS "deliveryKeyRevision",
         exchange_command_id AS "exchangeCommandId",exchange_idempotency_key AS "exchangeIdempotencyKey",
         exchange_request_digest AS "exchangeRequestDigest",operator_session_ref AS "operatorSessionRef",
         session_expires_at AS "sessionExpiresAt",
         delivery_envelope AS "deliveryEnvelope",exchange_receipt AS "exchangeReceipt",
         expires_at AS "expiresAt",recovery_expires_at AS "recoveryExpiresAt",
         delivery_expires_at AS "deliveryExpiresAt"
       FROM platform.admin_oidc_transaction
       WHERE transaction_ref=$1::uuid AND workload_identity_ref=$2 AND environment=$3
         AND region=$4 AND managed_device_ref=$5 AND audience=$6 LIMIT 1`,
      [transactionRef, axes.workloadIdentityRef, axes.environment, axes.region,
        axes.managedDeviceRef, axes.audience],
    );
    return rows[0] === undefined ? null : mapTransaction(rows[0]);
  }
}

function requiredTransaction(row: TransactionRow | undefined): AdminOidcTransaction {
  if (row === undefined) throw new Error("ADMIN_OIDC_TRANSACTION_WRITE_CONFLICT");
  return mapTransaction(row);
}

function mapTransaction(row: TransactionRow): AdminOidcTransaction {
  const state = requiredState(row.state);
  const transaction: AdminOidcTransaction = {
    transactionRef: requiredString(row.transactionRef),
    state,
    beginCommandId: requiredString(row.beginCommandId),
    beginIdempotencyKey: requiredString(row.beginIdempotencyKey),
    beginRequestDigest: requiredDigest(row.beginRequestDigest),
    axes: Object.freeze({
      workloadIdentityRef: requiredString(row.workloadIdentityRef),
      environment: requiredString(row.environment),
      region: requiredString(row.region),
      managedDeviceRef: requiredString(row.managedDeviceRef),
      audience: requiredString(row.audience),
    }),
    returnIntentRef: requiredString(row.returnIntentRef),
    issuer: requiredString(row.issuer),
    clientId: requiredString(row.clientId),
    oidcAudience: requiredString(row.oidcAudience),
    exactCallbackUri: requiredString(row.exactCallbackUri),
    pkceVerifierCiphertext: requiredString(row.pkceVerifierCiphertext),
    pkceChallenge: requiredString(row.pkceChallenge),
    nonceCiphertext: requiredString(row.nonceCiphertext),
    stateDigest: requiredDigest(row.stateDigest),
    recoveryDigest: requiredDigest(row.recoveryDigest),
    signingKeyRevision: requiredString(row.signingKeyRevision),
    deliveryKeyRevision: requiredString(row.deliveryKeyRevision),
    expiresAt: requiredDate(row.expiresAt),
    recoveryExpiresAt: requiredDate(row.recoveryExpiresAt),
  };
  optionalString(row.exchangeCommandId, (value) => { transaction.exchangeCommandId = value; });
  optionalString(row.exchangeIdempotencyKey, (value) => {
    transaction.exchangeIdempotencyKey = value;
  });
  optionalDigest(row.exchangeRequestDigest, (value) => {
    transaction.exchangeRequestDigest = value;
  });
  optionalString(row.operatorSessionRef, (value) => { transaction.sessionRef = value; });
  optionalString(row.deliveryEnvelope, (value) => { transaction.deliveryEnvelope = value; });
  optionalDate(row.deliveryExpiresAt, (value) => { transaction.deliveryExpiresAt = value; });
  if (row.exchangeReceipt !== null && row.exchangeReceipt !== undefined) {
    transaction.exchangeReceipt = receipt(row.exchangeReceipt);
  }
  if (state === "committed") {
    transaction.sessionExpiresAt = requiredDate(row.sessionExpiresAt);
  }
  return Object.freeze(transaction);
}

function receipt(value: unknown): AdminOidcReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("ADMIN_OIDC_ROW_CORRUPT");
  }
  const record = value as Record<string, unknown>;
  if (record.operation !== "admin.identity.begin" && record.operation !== "admin.identity.exchange") {
    throw new Error("ADMIN_OIDC_ROW_CORRUPT");
  }
  if (record.state !== "committed") throw new Error("ADMIN_OIDC_ROW_CORRUPT");
  return Object.freeze({
    commandId: requiredString(record.commandId),
    idempotencyKey: requiredString(record.idempotencyKey),
    requestDigest: requiredDigest(record.requestDigest),
    operation: record.operation,
    state: record.state,
    recordedAt: requiredDate(record.recordedAt),
  });
}

function requiredState(value: unknown): AdminOidcTransactionState {
  if (value === "pending" || value === "redeeming" || value === "committed" ||
      value === "provider_outcome_unknown" || value === "rejected") return value;
  throw new Error("ADMIN_OIDC_ROW_CORRUPT");
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length < 1) throw new Error("ADMIN_OIDC_ROW_CORRUPT");
  return value;
}

function requiredDigest(value: unknown): string {
  const digest = requiredString(value);
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("ADMIN_OIDC_ROW_CORRUPT");
  return digest;
}

function requiredDate(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || !Number.isFinite(date.getTime())) throw new Error("ADMIN_OIDC_ROW_CORRUPT");
  return date.toISOString();
}

function optionalString(value: unknown, assign: (value: string) => void): void {
  if (value === null || value === undefined) return;
  assign(requiredString(value));
}

function optionalDigest(value: unknown, assign: (value: string) => void): void {
  if (value === null || value === undefined) return;
  assign(requiredDigest(value));
}

function optionalDate(value: unknown, assign: (value: string) => void): void {
  if (value === null || value === undefined) return;
  assign(requiredDate(value));
}
