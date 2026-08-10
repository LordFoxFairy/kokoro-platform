import { createHash, randomUUID } from "node:crypto";
import type {
  CreditGrantAccountIdentity,
  CreditGrantIssue,
  CreditGrantIssueReceipt,
  CreditGrantIssuancePort,
  CreditGrantRef,
  PreparedCreditGrantIssuance,
} from "../../application/contracts/grant-issuance.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import {
  creditAccountAdvisoryKey,
  lockCreditAccountAuthority,
  type LockedCreditAccount,
} from "./credit-account-lock.js";
import { creditJournalEntriesDigest } from "../../domain/journal-digest.js";

type PreparedState = {
  transaction: PlatformTransaction;
  accounts: Map<string, Readonly<{
    identity: CreditGrantAccountIdentity;
    account: LockedCreditAccount | null;
  }>>;
  commandId: string | null;
  grants: readonly CreditGrantIssue[];
  intentDigest: string;
  consumed: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,37}$/u;

export class PostgresCreditGrantIssuer implements CreditGrantIssuancePort {
  readonly #prepared = new WeakMap<PreparedCreditGrantIssuance, PreparedState>();
  readonly #reference: () => string;

  constructor(dependencies: Readonly<{ reference?: () => string }> = {}) {
    this.#reference = dependencies.reference ?? randomUUID;
  }

  async prepareIssuance(
    transaction: Parameters<CreditGrantIssuancePort["prepareIssuance"]>[0],
    input: Parameters<CreditGrantIssuancePort["prepareIssuance"]>[1],
  ): ReturnType<CreditGrantIssuancePort["prepareIssuance"]> {
    if (input.commandId !== null) bounded(input.commandId, 128, "CREDIT_GRANT_COMMAND_INVALID");
    if (input.grants.length < 1 || input.grants.length > 32) throw new Error("CREDIT_GRANT_INTENT_SIZE_INVALID");
    const grants = Object.freeze(input.grants.map(validateGrant).sort(compareGrantIdentity));
    const identities = new Map<string, CreditGrantAccountIdentity>();
    const sourceRefs = new Set<string>();
    const operationKeys = new Set<string>();
    const outputIdentities = new Set<string>();
    const lineToOrdinal = new Map<string, number>();
    const ordinalToLine = new Map<number, string>();
    const occurrences = new Map<string, number[]>();
    for (const grant of grants) {
      const identity = grant.account;
      identities.set(creditAccountAdvisoryKey(identity), identity);
      const outputIdentity = `${grant.outputLineId}\u0000${grant.outputOrdinal}\u0000${grant.occurrence}`;
      if (sourceRefs.has(`${grant.sourceType}:${grant.sourceRef}`) || operationKeys.has(grant.businessOperationKey) ||
          outputIdentities.has(outputIdentity)) throw new Error("CREDIT_GRANT_IDEMPOTENCY_KEY_DUPLICATED");
      sourceRefs.add(`${grant.sourceType}:${grant.sourceRef}`);
      operationKeys.add(grant.businessOperationKey);
      outputIdentities.add(outputIdentity);
      const knownOrdinal = lineToOrdinal.get(grant.outputLineId);
      const knownLine = ordinalToLine.get(grant.outputOrdinal);
      if ((knownOrdinal !== undefined && knownOrdinal !== grant.outputOrdinal) ||
          (knownLine !== undefined && knownLine !== grant.outputLineId)) {
        throw new Error("CREDIT_GRANT_OUTPUT_TOPOLOGY_INVALID");
      }
      lineToOrdinal.set(grant.outputLineId, grant.outputOrdinal);
      ordinalToLine.set(grant.outputOrdinal, grant.outputLineId);
      occurrences.set(grant.outputLineId, [...(occurrences.get(grant.outputLineId) ?? []), grant.occurrence]);
    }
    for (const values of occurrences.values()) {
      if (values.some((value, index) => value !== index + 1)) throw new Error("CREDIT_GRANT_OUTPUT_TOPOLOGY_INVALID");
    }
    const accounts = new Map<string, PreparedState["accounts"] extends Map<string, infer Value> ? Value : never>();
    for (const key of [...identities.keys()].sort(compareCanonical)) {
      const identity = identities.get(key)!;
      const account = await lockCreditAccountAuthority(transaction, identity);
      if (account?.state === "suspended" || account?.state === "closed") {
        return Object.freeze({ kind: "unavailable" as const, reason: `credit_account_${account.state}` as const });
      }
      accounts.set(key, Object.freeze({ identity, account }));
    }
    const intentDigest = issuanceIntentDigest(input.commandId, grants);
    const preparation = Object.freeze({ accountCount: accounts.size, grantCount: grants.length,
      intentDigest }) as PreparedCreditGrantIssuance;
    this.#prepared.set(preparation, { transaction, accounts, commandId: input.commandId, grants, intentDigest, consumed: false });
    return Object.freeze({ kind: "ready" as const, preparation });
  }

  async issuePrepared(
    transaction: Parameters<CreditGrantIssuancePort["issuePrepared"]>[0],
    input: Parameters<CreditGrantIssuancePort["issuePrepared"]>[1],
  ): ReturnType<CreditGrantIssuancePort["issuePrepared"]> {
    const prepared = this.#prepared.get(input.preparation);
    if (prepared === undefined || prepared.transaction !== transaction) {
      throw new Error("CREDIT_GRANT_PREPARATION_INVALID");
    }
    if (prepared.consumed) throw new Error("CREDIT_GRANT_PREPARATION_CONSUMED");
    if (input.preparation.intentDigest !== prepared.intentDigest || input.preparation.grantCount !== prepared.grants.length ||
        input.preparation.accountCount !== prepared.accounts.size) throw new Error("CREDIT_GRANT_PREPARATION_INVALID");
    prepared.consumed = true;

    const sql = resolvePlatformTransaction(transaction);
    for (const [key, preparedAccount] of [...prepared.accounts.entries()].sort(([left], [right]) =>
      compareCanonical(left, right))) {
      if (preparedAccount.account !== null) continue;
      const creditAccountId = reference(this.#reference, "CREDIT_ACCOUNT_REF_INVALID");
      const created = await sql.execute(
        `INSERT INTO platform.credit_account
         (credit_account_ref,site_ref,billing_account_ref,unit,liability_merchant_account_ref,state)
         VALUES ($1::uuid,$2,$3,$4,$5,'active')`,
        [creditAccountId, preparedAccount.identity.siteId, preparedAccount.identity.billingAccountId,
          preparedAccount.identity.unit, preparedAccount.identity.liabilityMerchantAccountId],
      );
      if (created !== 1) throw new Error("CREDIT_ACCOUNT_CREATE_FAILED");
      prepared.accounts.set(key, Object.freeze({
        identity: preparedAccount.identity,
        account: Object.freeze({ creditAccountId, state: "active" as const, aggregateVersion: 1n }),
      }));
    }

    const receipts: CreditGrantIssueReceipt[] = [];
    for (const grant of prepared.grants) {
      const account = prepared.accounts.get(creditAccountAdvisoryKey(grant.account))?.account;
      if (account === undefined || account === null || account.state !== "active") {
        throw new Error("CREDIT_GRANT_ACCOUNT_AUTHORITY_MISSING");
      }
      const creditGrantRef = reference(this.#reference, "CREDIT_GRANT_REF_INVALID") as CreditGrantRef;
      const journalTransactionRef = reference(this.#reference, "CREDIT_JOURNAL_REF_INVALID");
      const created = await sql.execute(
        `INSERT INTO platform.credit_grant
         (credit_grant_id,credit_account_ref,site_ref,billing_account_ref,credit_program_revision_ref,
          credit_program_revision,credit_program_revision_digest,
          source_type,source_ref,source_window_key,issuance_journal_transaction_ref,ux_bucket_class,unit,
          liability_merchant_account_ref,original_amount,burn_priority,scope_policy,effective_at,expires_at,
          acquired_at,issued_at)
         VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::bigint,$7,$8,$9,$10,$11::uuid,$12,$13,$14,$15::numeric,$16,$17::jsonb,
                 $18::timestamptz,$19::timestamptz,$20::timestamptz,$20::timestamptz)`,
        [creditGrantRef, account.creditAccountId, grant.account.siteId, grant.account.billingAccountId,
          grant.creditProgramRevisionRef, grant.creditProgramRevision, grant.creditProgramRevisionDigest,
          grant.sourceType, grant.sourceRef, grant.sourceWindowKey, journalTransactionRef, grant.bucketClass,
          grant.account.unit, grant.account.liabilityMerchantAccountId, grant.amount, grant.burnPriority,
          JSON.stringify(grant.scopePolicy), grant.effectiveAt, grant.expiresAt, grant.acquiredAt],
      );
      if (created !== 1) throw new Error("CREDIT_GRANT_CREATE_FAILED");
      await recordGrantIssueJournal(sql, {
        journalTransactionRef,
        creditAccountId: account.creditAccountId,
        siteId: grant.account.siteId,
        unit: grant.account.unit,
        businessOperationKey: grant.businessOperationKey,
        commandId: prepared.commandId,
        creditGrantRef,
        amount: grant.amount,
        occurredAt: grant.effectiveAt,
      });
      receipts.push(Object.freeze({
        outputLineId: grant.outputLineId,
        outputOrdinal: grant.outputOrdinal,
        occurrence: grant.occurrence,
        creditProgramRevisionRef: grant.creditProgramRevisionRef,
        creditGrantRef,
        outputVersion: 1 as const,
        outputDigest: creditGrantOutputDigest({ creditGrantRef, grant }),
      }));
    }
    return Object.freeze(receipts);
  }
}

function validateIdentity(identity: CreditGrantAccountIdentity): void {
  bounded(identity.siteId, 256, "CREDIT_GRANT_SITE_INVALID");
  bounded(identity.billingAccountId, 256, "CREDIT_GRANT_BILLING_ACCOUNT_INVALID");
  bounded(identity.unit, 64, "CREDIT_GRANT_UNIT_INVALID");
  bounded(identity.liabilityMerchantAccountId, 256, "CREDIT_GRANT_MERCHANT_INVALID");
}

function validateGrant(grant: CreditGrantIssue): CreditGrantIssue {
  validateIdentity(grant.account);
  bounded(grant.outputLineId, 128, "CREDIT_GRANT_OUTPUT_LINE_INVALID");
  bounded(grant.creditProgramRevisionRef, 256, "CREDIT_GRANT_PROGRAM_INVALID");
  if (grant.creditProgramRevision < 1n || grant.creditProgramRevision > 18_446_744_073_709_551_615n ||
      !/^[a-f0-9]{64}$/u.test(grant.creditProgramRevisionDigest)) throw new Error("CREDIT_GRANT_PROGRAM_INVALID");
  bounded(grant.sourceRef, 256, "CREDIT_GRANT_SOURCE_REF_INVALID");
  bounded(grant.businessOperationKey, 256, "CREDIT_GRANT_OPERATION_KEY_INVALID");
  if (!Number.isSafeInteger(grant.occurrence) || grant.occurrence < 1) throw new Error("CREDIT_GRANT_OCCURRENCE_INVALID");
  if (!Number.isSafeInteger(grant.outputOrdinal) || grant.outputOrdinal < 1 || grant.outputOrdinal > 32) {
    throw new Error("CREDIT_GRANT_OUTPUT_ORDINAL_INVALID");
  }
  if (!Number.isInteger(grant.burnPriority) || grant.burnPriority < -2_147_483_648 ||
      grant.burnPriority > 2_147_483_647) {
    throw new Error("CREDIT_GRANT_BURN_PRIORITY_INVALID");
  }
  if (!POSITIVE_DECIMAL.test(grant.amount)) throw new Error("CREDIT_GRANT_AMOUNT_INVALID");
  if (!(["redemption", "payment", "admin_grant", "program_window"] as const).includes(grant.sourceType)) {
    throw new Error("CREDIT_GRANT_SOURCE_TYPE_INVALID");
  }
  if (!(["daily", "period", "permanent"] as const).includes(grant.bucketClass)) {
    throw new Error("CREDIT_GRANT_BUCKET_INVALID");
  }
  if (grant.sourceWindowKey.length > 256 || (grant.bucketClass === "permanent" ? grant.sourceWindowKey !== "" :
    grant.sourceWindowKey.length < 1)) throw new Error("CREDIT_GRANT_WINDOW_KEY_INVALID");
  const effectiveAt = Date.parse(grant.effectiveAt);
  const acquiredAt = Date.parse(grant.acquiredAt);
  const expiresAt = grant.expiresAt === null ? null : Date.parse(grant.expiresAt);
  if (!Number.isFinite(effectiveAt) || !Number.isFinite(acquiredAt) || acquiredAt < effectiveAt ||
      (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= effectiveAt || acquiredAt >= expiresAt))) {
    throw new Error("CREDIT_GRANT_EFFECTIVE_WINDOW_INVALID");
  }
  if ((grant.bucketClass === "permanent") !== (grant.expiresAt === null)) {
    throw new Error("CREDIT_GRANT_BUCKET_WINDOW_INVALID");
  }
  const scopePolicy = validateScopePolicy(grant.scopePolicy);
  return Object.freeze({ ...grant, account: Object.freeze({ ...grant.account }), scopePolicy });
}

function validateScopePolicy(policy: CreditGrantIssue["scopePolicy"]): CreditGrantIssue["scopePolicy"] {
  if (typeof policy !== "object" || policy === null || Object.keys(policy).sort().join(",") !==
      "agentRefs,allowUnattributedAgent,capabilityKeys,surfaceRefs,version" || policy.version !== 1 ||
      typeof policy.allowUnattributedAgent !== "boolean") {
    throw new Error("CREDIT_GRANT_SCOPE_POLICY_INVALID");
  }
  const surfaceRefs = policyRefs(policy.surfaceRefs, true, /^[a-z0-9][a-z0-9._:-]{0,255}$/u);
  const capabilityKeys = policyRefs(policy.capabilityKeys, true, /^[a-z0-9][a-z0-9._:-]{0,255}$/u);
  const agentRefs = policyRefs(policy.agentRefs, false, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u);
  if (!policy.allowUnattributedAgent && agentRefs.length === 0) {
    throw new Error("CREDIT_GRANT_SCOPE_POLICY_INVALID");
  }
  return Object.freeze({ version: 1, surfaceRefs, capabilityKeys, agentRefs,
    allowUnattributedAgent: policy.allowUnattributedAgent });
}

function policyRefs(values: readonly string[], required: boolean, pattern: RegExp): readonly string[] {
  if (!Array.isArray(values) || (required && values.length < 1) || values.length > 256 ||
      values.some((value) => typeof value !== "string" || !pattern.test(value)) ||
      new Set(values).size !== values.length) {
    throw new Error("CREDIT_GRANT_SCOPE_POLICY_INVALID");
  }
  return Object.freeze([...values]);
}

function bounded(value: string, maximum: number, code: string): void {
  if (value.length < 1 || value.length > maximum || [...value].some((character) => character.codePointAt(0)! < 32)) {
    throw new Error(code);
  }
}

function reference(factory: () => string, code: string): string {
  const value = factory();
  if (!UUID.test(value)) throw new Error(code);
  return value;
}

async function recordGrantIssueJournal(
  sql: ReturnType<typeof resolvePlatformTransaction>,
  input: Readonly<{
    journalTransactionRef: string;
    creditAccountId: string;
    siteId: string;
    unit: string;
    businessOperationKey: string;
    commandId: string | null;
    creditGrantRef: CreditGrantRef;
    amount: string;
    occurredAt: string;
  }>,
): Promise<void> {
  const entries = [
    { entryOrdinal: 0, entrySide: "debit", accountType: "grant_issuance_source" },
    { entryOrdinal: 1, entrySide: "credit", accountType: "customer_available" },
  ] as const;
  const entriesDigest = creditJournalEntriesDigest(entries.map((entry) => ({
    ordinal: entry.entryOrdinal,
    siteId: input.siteId,
    creditAccountId: input.creditAccountId,
    unit: input.unit,
    side: entry.entrySide,
    accountType: entry.accountType,
    amount: input.amount,
    creditGrantId: input.creditGrantRef,
    creditHoldRef: null,
  })));
  const requestDigest = sha256(canonicalJson({
    version: 1,
    operationKind: "grant_issue",
    businessOperationKey: input.businessOperationKey,
    creditAccountId: input.creditAccountId,
    creditGrantId: input.creditGrantRef,
    amount: input.amount,
    unit: input.unit,
  }));
  const transactionCreated = await sql.execute(
    `INSERT INTO platform.credit_journal_transaction
     (journal_transaction_ref,credit_account_ref,site_ref,unit,business_operation_key,request_digest,
      operation_kind,expected_entry_count,entries_digest,command_id,occurred_at)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,'grant_issue',2,$7,$8,$9::timestamptz)`,
    [input.journalTransactionRef, input.creditAccountId, input.siteId, input.unit, input.businessOperationKey,
      requestDigest, entriesDigest, input.commandId, input.occurredAt],
  );
  if (transactionCreated !== 1) throw new Error("CREDIT_GRANT_JOURNAL_CREATE_FAILED");
  for (const entry of entries) {
    const shape = entry.entryOrdinal === 0
      ? "'debit','grant_issuance_source'"
      : "'credit','customer_available'";
    const entryCreated = await sql.execute(
      `INSERT INTO platform.credit_journal_entry
       (journal_transaction_ref,entry_ordinal,site_ref,credit_account_ref,unit,entry_side,account_type,
        amount,credit_grant_id,credit_hold_ref)
       VALUES ($1::uuid,$2,$3,$4::uuid,$5,${shape},$6::numeric,$7::uuid,NULL)`,
      [input.journalTransactionRef, entry.entryOrdinal, input.siteId, input.creditAccountId, input.unit,
        input.amount, input.creditGrantRef],
    );
    if (entryCreated !== 1) throw new Error("CREDIT_GRANT_JOURNAL_ENTRY_CREATE_FAILED");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("CREDIT_GRANT_CANONICAL_JSON_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareCanonical(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error("CREDIT_GRANT_CANONICAL_JSON_INVALID");
}

function issuanceIntentDigest(commandId: string | null, grants: readonly CreditGrantIssue[]): string {
  return sha256(canonicalJson({ version: 1, commandId, grants: grants.map((grant) => ({
    ...grant,
    creditProgramRevision: grant.creditProgramRevision.toString(),
  })) }));
}

function creditGrantOutputDigest(input: Readonly<{ creditGrantRef: CreditGrantRef; grant: CreditGrantIssue }>): string {
  return sha256(canonicalJson({ version: 1, kind: "credit_grant", outputLineId: input.grant.outputLineId,
    outputOrdinal: input.grant.outputOrdinal, occurrence: input.grant.occurrence,
    resourceRef: input.creditGrantRef, templateRevisionRef: input.grant.creditProgramRevisionRef,
    outputVersion: 1 }));
}

function compareGrantIdentity(left: CreditGrantIssue, right: CreditGrantIssue): number {
  return left.outputOrdinal - right.outputOrdinal || left.occurrence - right.occurrence ||
    compareCanonical(left.outputLineId, right.outputLineId);
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
