import { createHash } from "node:crypto";
import type { JsonValue } from "../../../../shared/outbox-inbox/receipt.js";
import { CommandReceiptRepository } from "../../../../shared/outbox-inbox/receipt.js";
import type { PlatformTransactionHost } from "../../../../shared/unit-of-work/unit-of-work.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type { AdminOperatorSessionService } from
  "../../interfaces/connect/admin-identity-service.js";
import { digestAdminValue } from "../../../admin-control/application/admin-digest.js";
import {
  OidcProviderOutcomeUnknownError,
  type AdminOidcProviderClaims,
  type AdminOidcRegistration,
} from "../../application/services/admin-oidc-service.js";

interface StepUpRow extends Record<string, unknown> {
  transactionRef: unknown;
  state: unknown;
  completeCommandId: unknown;
  completeIdempotencyKey: unknown;
  completeRequestDigest: unknown;
  operatorSessionRef: unknown;
  operatorRef: unknown;
  operatorGeneration: unknown;
  requestedOperation: unknown;
  resourceRefs: unknown;
  callbackRef: unknown;
  issuer: unknown;
  clientId: unknown;
  oidcAudience: unknown;
  exactCallbackUri: unknown;
  pkceVerifierCiphertext: unknown;
  nonceCiphertext: unknown;
  completeReceipt: unknown;
  expiresAt: unknown;
  stepUpAt: unknown;
}

type StepUpState = "pending" | "redeeming" | "committed" | "provider_outcome_unknown" | "rejected";

export class AdminOperatorSessionApplicationService implements AdminOperatorSessionService {
  private readonly receipts = new CommandReceiptRepository();

  constructor(private readonly dependencies: Readonly<{
    unitOfWork: PlatformTransactionHost;
    provider: Readonly<{
      authorizationUri(input: Readonly<{
        registration: AdminOidcRegistration;
        codeChallenge: string;
        nonce: string;
        state: string;
      }>): string;
      redeem(input: Readonly<{
        registration: AdminOidcRegistration;
        authorizationCode: string;
        pkceVerifier: string;
        expectedNonce: string;
        expectedState: string;
      }>): Promise<AdminOidcProviderClaims>;
    }>;
    registration: Readonly<{ resolve(input: Readonly<{
      workloadIdentityRef: string;
      environment: string;
      region: string;
      managedDeviceRef: string;
      audience: string;
    }>): AdminOidcRegistration }>;
    protector: Readonly<{ seal(value: string): string; open(value: string): string }>;
    secrets(): Readonly<{ verifier: string; challenge: string; nonce: string }>;
    reference(): string;
    clock?: () => Date;
  }>) {}

  async beginStepUp(input: Parameters<AdminOperatorSessionService["beginStepUp"]>[0]) {
    const registration = this.dependencies.registration.resolve(input.axes);
    if (!registration.returnIntentRefs.includes(input.callbackRef)) {
      throw new Error("ADMIN_STEP_UP_CALLBACK_INVALID");
    }
    if (input.resourceRefs.length < 1 || input.resourceRefs.length > 100 ||
        new Set(input.resourceRefs).size !== input.resourceRefs.length) {
      throw new Error("ADMIN_STEP_UP_RESOURCE_INVALID");
    }
    const secret = this.dependencies.secrets();
    const transactionRef = this.dependencies.reference();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    const identity = commandIdentity(input, "admin.identity.step-up.begin");
    const stored = await this.dependencies.unitOfWork.transaction(
      { context: input.verifiedContext, operation: "admin.identity.step-up.begin" },
      async (transaction) => {
        const existing = await this.receipts.begin(transaction, identity);
        if (existing.state === "succeeded") {
          const replay = await findStepUpByBeginCommand(transaction, input.commandId);
          if (replay === null) throw new Error("ADMIN_STEP_UP_RECEIPT_CORRUPT");
          return replay;
        }
        const sql = resolvePlatformTransaction(transaction);
        const changed = await sql.execute(
          `INSERT INTO platform.admin_step_up_transaction(
             transaction_ref,state,begin_command_id,begin_idempotency_key,begin_request_digest,
             operator_session_ref,operator_ref,operator_generation,requested_operation,
             resource_refs,callback_ref,issuer,client_id,oidc_audience,exact_callback_uri,
             pkce_verifier_ciphertext,nonce_ciphertext,expires_at
           ) VALUES($1::uuid,'pending',$2,$3,$4,$5::uuid,$6,$7,$8,$9::text[],$10,$11,$12,
                    $13,$14,$15,$16,$17::timestamptz)
           ON CONFLICT(begin_command_id) DO NOTHING`,
          [transactionRef, input.commandId, input.idempotencyKey, input.requestDigest,
            input.axes.operatorSessionRef, input.axes.actorRef, input.axes.operatorGeneration,
            input.requestedOperation, [...input.resourceRefs], input.callbackRef,
            registration.issuer, registration.clientId, registration.oidcAudience,
            registration.exactCallbackUri, this.dependencies.protector.seal(secret.verifier),
            this.dependencies.protector.seal(secret.nonce), expiresAt],
        );
        if (changed !== 1) throw new Error("ADMIN_STEP_UP_COMMAND_CONFLICT");
        const outcome = result({ transactionRef, expiresAt });
        await this.receipts.recordOutcome(transaction, identity, {
          state: "succeeded",
          result: outcome,
          resultDigest: digestAdminValue(outcome),
        });
        const created = await findStepUpByBeginCommand(transaction, input.commandId);
        if (created === null) throw new Error("ADMIN_STEP_UP_WRITE_FAILED");
        return created;
      },
    );
    return Object.freeze({
      transactionRef: stored.transactionRef,
      authorizationUri: this.dependencies.provider.authorizationUri({
        registration: registrationFromStepUp(stored),
        codeChallenge: pkceChallenge(this.dependencies.protector.open(stored.pkceVerifierCiphertext)),
        nonce: this.dependencies.protector.open(stored.nonceCiphertext), state: stored.transactionRef,
      }),
      expiresAt: stored.expiresAt,
      receipt: receipt(input, "admin.identity.step-up.begin", now.toISOString()),
    });
  }

  async completeStepUp(input: Parameters<AdminOperatorSessionService["completeStepUp"]>[0]) {
    const identity = commandIdentity(input, "admin.identity.step-up.complete");
    const claimed = await this.dependencies.unitOfWork.transaction(
      { context: input.verifiedContext, operation: "admin.identity.step-up.complete" },
      async (transaction) => {
        await this.receipts.begin(transaction, identity);
        const sql = resolvePlatformTransaction(transaction);
        const rows = await sql.query<StepUpRow>(
          `UPDATE platform.admin_step_up_transaction SET state='redeeming',
             complete_command_id=$2,complete_idempotency_key=$3,complete_request_digest=$4,
             claimed_at=now(),updated_at=now()
           WHERE transaction_ref=$1::uuid AND state='pending' AND operator_session_ref=$5::uuid
             AND operator_ref=$6 AND operator_generation=$7 AND expires_at>now()
           ${stepUpReturning()}`,
          [input.transactionRef, input.commandId, input.idempotencyKey, input.requestDigest,
            input.axes.operatorSessionRef, input.axes.actorRef, input.axes.operatorGeneration],
        );
        if (rows[0] !== undefined) return mapStepUp(rows[0]);
        const existing = await findStepUp(transaction, input.transactionRef, input.axes.operatorSessionRef);
        if (existing === null) throw new Error("ADMIN_STEP_UP_NOT_FOUND");
        if (existing.state === "committed" && sameComplete(existing, input)) return existing;
        throw new Error("ADMIN_STEP_UP_RESTART_REQUIRED");
      },
    );
    if (claimed.state === "committed") return committedResult(claimed, input);
    let claims: AdminOidcProviderClaims;
    try {
      claims = await this.dependencies.provider.redeem({
        registration: registrationFromStepUp(claimed), authorizationCode: input.authorizationCode,
        pkceVerifier: this.dependencies.protector.open(claimed.pkceVerifierCiphertext),
        expectedNonce: this.dependencies.protector.open(claimed.nonceCiphertext),
        expectedState: claimed.transactionRef,
      });
    } catch (error) {
      if (error instanceof OidcProviderOutcomeUnknownError) {
        await this.terminalizeUnknown(input, identity);
        throw new Error("ADMIN_STEP_UP_RESTART_REQUIRED");
      }
      await this.terminalizeRejected(input, identity);
      throw new Error("ADMIN_STEP_UP_REJECTED");
    }
    try {
      verifyStepUpClaims(claimed, claims, input.axes.managedDeviceRef,
        this.dependencies.protector.open(claimed.nonceCiphertext));
    } catch {
      await this.terminalizeRejected(input, identity);
      throw new Error("ADMIN_STEP_UP_REJECTED");
    }
    const stepUpAt = this.now().toISOString();
    const completeReceipt = receipt(input, "admin.identity.step-up.complete", stepUpAt);
    await this.dependencies.unitOfWork.transaction(
      { context: input.verifiedContext, operation: "admin.identity.step-up.complete" },
      async (transaction) => {
        const sql = resolvePlatformTransaction(transaction);
        const changed = await sql.execute(
          `UPDATE platform.admin_operator_session session_row
           SET assurance_level='phishing_resistant',factor_classes=$1::text[],
               step_up_at=$2::timestamptz,session_epoch=session_epoch+1,updated_at=now()
           WHERE operator_session_ref=$3::uuid AND operator_ref=$4 AND operator_generation=$5
             AND session_epoch=$6 AND state='active' AND expires_at>now()
             AND EXISTS (
               SELECT 1 FROM platform.admin_operator_identity identity_row
               WHERE identity_row.operator_ref=session_row.operator_ref
                 AND identity_row.operator_generation=session_row.operator_generation
                 AND identity_row.issuer=$7 AND identity_row.subject=$8 AND identity_row.state='active'
             )`,
          [[...claims.factorClasses], stepUpAt, input.axes.operatorSessionRef, input.axes.actorRef,
            input.axes.operatorGeneration, input.context.securityEpochs!.sessionEpoch,
            claims.issuer, claims.subject],
        );
        if (changed !== 1) throw new Error("ADMIN_STEP_UP_SESSION_STALE");
        const committed = await sql.execute(
          `UPDATE platform.admin_step_up_transaction SET state='committed',
             complete_receipt=$2::jsonb,completed_at=$3::timestamptz,updated_at=now()
           WHERE transaction_ref=$1::uuid AND state='redeeming'`,
          [input.transactionRef, JSON.stringify(completeReceipt), stepUpAt],
        );
        if (committed !== 1) throw new Error("ADMIN_STEP_UP_COMMIT_CONFLICT");
        const outcome = result({ operatorSessionRef: input.axes.operatorSessionRef, stepUpAt });
        await this.receipts.recordOutcome(transaction, identity, {
          state: "succeeded", result: outcome, resultDigest: digestAdminValue(outcome),
        });
      },
    );
    return Object.freeze({ operatorSessionRef: input.axes.operatorSessionRef, stepUpAt,
      receipt: completeReceipt });
  }

  async signOut(input: Parameters<AdminOperatorSessionService["signOut"]>[0]) {
    const identity = commandIdentity(input, "admin.identity.sign-out");
    const recordedAt = this.now().toISOString();
    await this.dependencies.unitOfWork.transaction(
      { context: input.verifiedContext, operation: "admin.identity.sign-out" },
      async (transaction) => {
        const existing = await this.receipts.begin(transaction, identity);
        if (existing.state === "succeeded") return;
        const changed = await resolvePlatformTransaction(transaction).execute(
          `UPDATE platform.admin_operator_session
           SET state='revoked',revoked_at=$1::timestamptz,session_epoch=session_epoch+1,updated_at=now()
           WHERE operator_session_ref=$2::uuid AND operator_ref=$3 AND operator_generation=$4
             AND session_epoch=$5 AND state='active'`,
          [recordedAt, input.operatorSessionRef, input.axes.actorRef,
            input.axes.operatorGeneration, input.context.securityEpochs!.sessionEpoch],
        );
        if (changed !== 1) throw new Error("ADMIN_SIGN_OUT_SESSION_STALE");
        const outcome = result({ operatorSessionRef: input.operatorSessionRef });
        await this.receipts.recordOutcome(transaction, identity, {
          state: "succeeded", result: outcome,
          resultDigest: digestAdminValue(outcome),
        });
      },
    );
    return Object.freeze({ receipt: receipt(input, "admin.identity.sign-out", recordedAt) });
  }

  private async terminalizeUnknown(
    input: Parameters<AdminOperatorSessionService["completeStepUp"]>[0],
    identity: ReturnType<typeof commandIdentity>,
  ): Promise<void> {
    await this.dependencies.unitOfWork.transaction(
      { context: input.verifiedContext, operation: "admin.identity.step-up.complete" },
      async (transaction) => {
        await resolvePlatformTransaction(transaction).execute(
          `UPDATE platform.admin_step_up_transaction SET state='provider_outcome_unknown',
             updated_at=now() WHERE transaction_ref=$1::uuid AND state='redeeming'`,
          [input.transactionRef],
        );
        await this.receipts.recordOutcome(transaction, identity, {
          state: "outcome_unknown", result: null, resultDigest: digestAdminValue(null),
        });
      },
    );
  }

  private async terminalizeRejected(
    input: Parameters<AdminOperatorSessionService["completeStepUp"]>[0],
    identity: ReturnType<typeof commandIdentity>,
  ): Promise<void> {
    await this.dependencies.unitOfWork.transaction(
      { context: input.verifiedContext, operation: "admin.identity.step-up.complete" },
      async (transaction) => {
        const changed = await resolvePlatformTransaction(transaction).execute(
          `UPDATE platform.admin_step_up_transaction SET state='rejected',updated_at=now()
           WHERE transaction_ref=$1::uuid AND state='redeeming'`,
          [input.transactionRef],
        );
        if (changed !== 1) throw new Error("ADMIN_STEP_UP_NOT_FOUND");
        const outcome = result({ code: "ADMIN_STEP_UP_REJECTED" });
        await this.receipts.recordOutcome(transaction, identity, {
          state: "failed", result: outcome, resultDigest: digestAdminValue(outcome),
        });
      },
    );
  }

  private now(): Date {
    return (this.dependencies.clock ?? (() => new Date()))();
  }
}

function commandIdentity(
  input: Readonly<{
    commandId: string;
    idempotencyKey: string;
    requestDigest: string;
    axes: VerifiedAxes;
  }>,
  operation: string,
) {
  return Object.freeze({
    commandId: input.commandId, environment: input.axes.environment, region: input.axes.region,
    callerIdentity: `${input.axes.workloadIdentityRef}:${input.axes.actorRef}`,
    operation, idempotencyKey: input.idempotencyKey, requestDigest: input.requestDigest,
  });
}

interface VerifiedAxes {
  readonly environment: string;
  readonly region: string;
  readonly workloadIdentityRef: string;
  readonly actorRef: string;
}

function receipt(
  input: Readonly<{ commandId: string; idempotencyKey: string; requestDigest: string }>,
  operation: string,
  recordedAt: string,
) {
  return Object.freeze({ commandId: input.commandId, idempotencyKey: input.idempotencyKey,
    requestDigest: input.requestDigest, operation, recordedAt });
}

function result(value: Readonly<Record<string, string>>): JsonValue {
  return Object.freeze({ ...value });
}

function stepUpReturning(): string {
  return `RETURNING transaction_ref AS "transactionRef",state,
    complete_command_id AS "completeCommandId",complete_idempotency_key AS "completeIdempotencyKey",
    complete_request_digest AS "completeRequestDigest",operator_session_ref AS "operatorSessionRef",
    operator_ref AS "operatorRef",operator_generation AS "operatorGeneration",
    requested_operation AS "requestedOperation",resource_refs AS "resourceRefs",
    callback_ref AS "callbackRef",issuer,client_id AS "clientId",oidc_audience AS "oidcAudience",
    exact_callback_uri AS "exactCallbackUri",pkce_verifier_ciphertext AS "pkceVerifierCiphertext",
    nonce_ciphertext AS "nonceCiphertext",complete_receipt AS "completeReceipt",
    expires_at AS "expiresAt",NULL::timestamptz AS "stepUpAt"`;
}

async function findStepUp(
  transaction: Parameters<Parameters<PlatformTransactionHost["transaction"]>[1]>[0],
  transactionRef: string,
  sessionRef: string,
): Promise<MappedStepUp | null> {
  const rows = await resolvePlatformTransaction(transaction).query<StepUpRow>(
    `SELECT stepup.transaction_ref AS "transactionRef",stepup.state,
            stepup.complete_command_id AS "completeCommandId",
            stepup.complete_idempotency_key AS "completeIdempotencyKey",
            stepup.complete_request_digest AS "completeRequestDigest",
            stepup.operator_session_ref AS "operatorSessionRef",stepup.operator_ref AS "operatorRef",
            stepup.operator_generation AS "operatorGeneration",
            stepup.requested_operation AS "requestedOperation",stepup.resource_refs AS "resourceRefs",
            stepup.callback_ref AS "callbackRef",stepup.issuer,stepup.client_id AS "clientId",
            stepup.oidc_audience AS "oidcAudience",stepup.exact_callback_uri AS "exactCallbackUri",
            stepup.pkce_verifier_ciphertext AS "pkceVerifierCiphertext",
            stepup.nonce_ciphertext AS "nonceCiphertext",stepup.complete_receipt AS "completeReceipt",
            stepup.expires_at AS "expiresAt",session_row.step_up_at AS "stepUpAt"
     FROM platform.admin_step_up_transaction stepup
     JOIN platform.admin_operator_session session_row
       ON session_row.operator_session_ref=stepup.operator_session_ref
     WHERE stepup.transaction_ref=$1::uuid AND stepup.operator_session_ref=$2::uuid LIMIT 1`,
    [transactionRef, sessionRef],
  );
  return rows[0] === undefined ? null : mapStepUp(rows[0]);
}

interface MappedStepUp {
  readonly transactionRef: string;
  readonly state: StepUpState;
  readonly completeCommandId: string | null;
  readonly completeIdempotencyKey: string | null;
  readonly completeRequestDigest: string | null;
  readonly operatorSessionRef: string;
  readonly operatorRef: string;
  readonly operatorGeneration: bigint;
  readonly requestedOperation: string;
  readonly resourceRefs: readonly string[];
  readonly callbackRef: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly oidcAudience: string;
  readonly exactCallbackUri: string;
  readonly pkceVerifierCiphertext: string;
  readonly nonceCiphertext: string;
  readonly completeReceipt: unknown;
  readonly expiresAt: string;
  readonly stepUpAt: string | null;
}

function mapStepUp(row: StepUpRow): MappedStepUp {
  const state = row.state;
  if (state !== "pending" && state !== "redeeming" && state !== "committed" &&
      state !== "provider_outcome_unknown" && state !== "rejected") {
    throw new Error("ADMIN_STEP_UP_ROW_CORRUPT");
  }
  return Object.freeze({
    transactionRef: text(row.transactionRef), state,
    completeCommandId: nullableText(row.completeCommandId),
    completeIdempotencyKey: nullableText(row.completeIdempotencyKey),
    completeRequestDigest: nullableText(row.completeRequestDigest),
    operatorSessionRef: text(row.operatorSessionRef), operatorRef: text(row.operatorRef),
    operatorGeneration: BigInt(String(row.operatorGeneration)),
    requestedOperation: text(row.requestedOperation), resourceRefs: strings(row.resourceRefs),
    callbackRef: text(row.callbackRef), issuer: text(row.issuer), clientId: text(row.clientId),
    oidcAudience: text(row.oidcAudience), exactCallbackUri: text(row.exactCallbackUri),
    pkceVerifierCiphertext: text(row.pkceVerifierCiphertext),
    nonceCiphertext: text(row.nonceCiphertext), completeReceipt: row.completeReceipt,
    expiresAt: instant(row.expiresAt), stepUpAt: row.stepUpAt === null ? null : instant(row.stepUpAt),
  });
}

function registrationFromStepUp(row: MappedStepUp): AdminOidcRegistration {
  return Object.freeze({ issuer: row.issuer, clientId: row.clientId,
    oidcAudience: row.oidcAudience, exactCallbackUri: row.exactCallbackUri,
    returnIntentRefs: [row.callbackRef], signingKeyRevision: "step-up",
    deliveryKeyRevision: "step-up" });
}

async function findStepUpByBeginCommand(
  transaction: Parameters<Parameters<PlatformTransactionHost["transaction"]>[1]>[0],
  commandId: string,
): Promise<MappedStepUp | null> {
  const rows = await resolvePlatformTransaction(transaction).query<StepUpRow>(
    `SELECT stepup.transaction_ref AS "transactionRef",stepup.state,
            stepup.complete_command_id AS "completeCommandId",
            stepup.complete_idempotency_key AS "completeIdempotencyKey",
            stepup.complete_request_digest AS "completeRequestDigest",
            stepup.operator_session_ref AS "operatorSessionRef",stepup.operator_ref AS "operatorRef",
            stepup.operator_generation AS "operatorGeneration",
            stepup.requested_operation AS "requestedOperation",stepup.resource_refs AS "resourceRefs",
            stepup.callback_ref AS "callbackRef",stepup.issuer,stepup.client_id AS "clientId",
            stepup.oidc_audience AS "oidcAudience",stepup.exact_callback_uri AS "exactCallbackUri",
            stepup.pkce_verifier_ciphertext AS "pkceVerifierCiphertext",
            stepup.nonce_ciphertext AS "nonceCiphertext",stepup.complete_receipt AS "completeReceipt",
            stepup.expires_at AS "expiresAt",session_row.step_up_at AS "stepUpAt"
     FROM platform.admin_step_up_transaction stepup
     JOIN platform.admin_operator_session session_row
       ON session_row.operator_session_ref=stepup.operator_session_ref
     WHERE stepup.begin_command_id=$1 LIMIT 1`,
    [commandId],
  );
  return rows[0] === undefined ? null : mapStepUp(rows[0]);
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function sameComplete(
  row: MappedStepUp,
  input: Readonly<{ commandId: string; idempotencyKey: string; requestDigest: string }>,
): boolean {
  return row.completeCommandId === input.commandId &&
    row.completeIdempotencyKey === input.idempotencyKey && row.completeRequestDigest === input.requestDigest;
}

function committedResult(
  row: MappedStepUp,
  input: Readonly<{ commandId: string; idempotencyKey: string; requestDigest: string }>,
) {
  if (row.stepUpAt === null || row.completeReceipt === null) throw new Error("ADMIN_STEP_UP_ROW_CORRUPT");
  return Object.freeze({ operatorSessionRef: row.operatorSessionRef, stepUpAt: row.stepUpAt,
    receipt: receipt(input, "admin.identity.step-up.complete", row.stepUpAt) });
}

function verifyStepUpClaims(
  row: MappedStepUp,
  claims: AdminOidcProviderClaims,
  managedDeviceRef: string,
  nonce: string,
): void {
  if (claims.issuer !== row.issuer || claims.audience !== row.oidcAudience || claims.nonce !== nonce ||
      claims.managedDeviceRef !== managedDeviceRef || claims.assuranceLevel !== "phishing_resistant" ||
      !claims.factorClasses.includes("webauthn")) throw new Error("ADMIN_STEP_UP_CLAIMS_INVALID");
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length < 1) throw new Error("ADMIN_STEP_UP_ROW_CORRUPT");
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.some((item) => typeof item !== "string")) {
    throw new Error("ADMIN_STEP_UP_ROW_CORRUPT");
  }
  return Object.freeze([...(value as string[])]);
}

function instant(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || !Number.isFinite(date.getTime())) throw new Error("ADMIN_STEP_UP_ROW_CORRUPT");
  return date.toISOString();
}
