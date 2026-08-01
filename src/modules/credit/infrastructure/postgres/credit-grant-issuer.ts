import { createHash, randomUUID } from "node:crypto";
import type {
  CreditGrantAccountIdentity,
  CreditGrantIssue,
  CreditGrantIssueReceipt,
  CreditGrantIssuancePort,
  CreditGrantRef,
  PreparedCreditGrantAccounts,
} from "../../application/contracts/grant-issuance.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import {
  creditAccountAdvisoryKey,
  lockCreditAccountAuthority,
  type LockedCreditAccount,
} from "./credit-account-lock.js";

type PreparedState = {
  transaction: PlatformTransaction;
  accounts: Map<string, Readonly<{
    identity: CreditGrantAccountIdentity;
    account: LockedCreditAccount | null;
  }>>;
  consumed: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,37}$/u;

export class PostgresCreditGrantIssuer implements CreditGrantIssuancePort {
  readonly #prepared = new WeakMap<PreparedCreditGrantAccounts, PreparedState>();
  readonly #reference: () => string;

  constructor(dependencies: Readonly<{ reference?: () => string }> = {}) {
    this.#reference = dependencies.reference ?? randomUUID;
  }

  async prepareAccounts(
    transaction: Parameters<CreditGrantIssuancePort["prepareAccounts"]>[0],
    input: Parameters<CreditGrantIssuancePort["prepareAccounts"]>[1],
  ): ReturnType<CreditGrantIssuancePort["prepareAccounts"]> {
    const identities = new Map<string, CreditGrantAccountIdentity>();
    for (const identity of input.accounts) {
      validateIdentity(identity);
      identities.set(creditAccountAdvisoryKey(identity), Object.freeze({ ...identity }));
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
    const preparation = Object.freeze({ accountCount: accounts.size }) as PreparedCreditGrantAccounts;
    this.#prepared.set(preparation, { transaction, accounts, consumed: false });
    return Object.freeze({ kind: "ready" as const, preparation });
  }

  async issueGrants(
    transaction: Parameters<CreditGrantIssuancePort["issueGrants"]>[0],
    input: Parameters<CreditGrantIssuancePort["issueGrants"]>[1],
  ): ReturnType<CreditGrantIssuancePort["issueGrants"]> {
    const prepared = this.#prepared.get(input.preparation);
    if (prepared === undefined || prepared.transaction !== transaction) {
      throw new Error("CREDIT_GRANT_PREPARATION_INVALID");
    }
    if (prepared.consumed) throw new Error("CREDIT_GRANT_PREPARATION_CONSUMED");
    const grants = input.grants.map(validateGrant);
    const sourceRefs = new Set<string>();
    const operationKeys = new Set<string>();
    for (const grant of grants) {
      if (!prepared.accounts.has(creditAccountAdvisoryKey(grant.account))) {
        throw new Error("CREDIT_GRANT_ACCOUNT_NOT_PREPARED");
      }
      if (sourceRefs.has(`${grant.sourceType}:${grant.sourceRef}`) || operationKeys.has(grant.businessOperationKey)) {
        throw new Error("CREDIT_GRANT_IDEMPOTENCY_KEY_DUPLICATED");
      }
      sourceRefs.add(`${grant.sourceType}:${grant.sourceRef}`);
      operationKeys.add(grant.businessOperationKey);
    }
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
    for (const grant of grants) {
      const account = prepared.accounts.get(creditAccountAdvisoryKey(grant.account))?.account;
      if (account === undefined || account === null || account.state !== "active") {
        throw new Error("CREDIT_GRANT_ACCOUNT_AUTHORITY_MISSING");
      }
      const creditGrantRef = reference(this.#reference, "CREDIT_GRANT_REF_INVALID") as CreditGrantRef;
      const journalTransactionRef = reference(this.#reference, "CREDIT_JOURNAL_REF_INVALID");
      const created = await sql.execute(
        `INSERT INTO platform.credit_grant
         (credit_grant_id,credit_account_ref,site_ref,billing_account_ref,credit_program_revision_ref,
          source_type,source_ref,issuance_journal_transaction_ref,ux_bucket_class,unit,
          liability_merchant_account_ref,original_amount,burn_priority,scope_policy,effective_at,expires_at,issued_at)
         VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::uuid,$9,$10,$11,$12::numeric,$13,$14::jsonb,
                 $15::timestamptz,$16::timestamptz,$15::timestamptz)`,
        [creditGrantRef, account.creditAccountId, grant.account.siteId, grant.account.billingAccountId,
          grant.creditProgramRevisionRef, grant.sourceType, grant.sourceRef, journalTransactionRef, grant.bucketClass,
          grant.account.unit, grant.account.liabilityMerchantAccountId, grant.amount, grant.burnPriority,
          JSON.stringify(grant.scopePolicy), grant.effectiveAt, grant.expiresAt],
      );
      if (created !== 1) throw new Error("CREDIT_GRANT_CREATE_FAILED");
      await recordGrantIssueJournal(sql, {
        journalTransactionRef,
        creditAccountId: account.creditAccountId,
        siteId: grant.account.siteId,
        unit: grant.account.unit,
        businessOperationKey: grant.businessOperationKey,
        commandId: input.commandId,
        creditGrantRef,
        amount: grant.amount,
        occurredAt: grant.effectiveAt,
      });
      receipts.push(Object.freeze({
        outputLineId: grant.outputLineId,
        occurrence: grant.occurrence,
        creditProgramRevisionRef: grant.creditProgramRevisionRef,
        creditGrantRef,
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
  bounded(grant.sourceRef, 256, "CREDIT_GRANT_SOURCE_REF_INVALID");
  bounded(grant.businessOperationKey, 256, "CREDIT_GRANT_OPERATION_KEY_INVALID");
  if (!Number.isSafeInteger(grant.occurrence) || grant.occurrence < 1) throw new Error("CREDIT_GRANT_OCCURRENCE_INVALID");
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
  const effectiveAt = Date.parse(grant.effectiveAt);
  const expiresAt = grant.expiresAt === null ? null : Date.parse(grant.expiresAt);
  if (!Number.isFinite(effectiveAt) || (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= effectiveAt))) {
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
    commandId: string;
    creditGrantRef: CreditGrantRef;
    amount: string;
    occurredAt: string;
  }>,
): Promise<void> {
  const entries = [
    { entryOrdinal: 0, entrySide: "debit", accountType: "grant_issuance_source" },
    { entryOrdinal: 1, entrySide: "credit", accountType: "customer_available" },
  ] as const;
  const entriesDigest = createHash("sha256").update(entries.map((entry) => [
    entry.entryOrdinal,
    input.siteId,
    input.creditAccountId,
    input.unit,
    entry.entrySide,
    entry.accountType,
    input.amount,
    input.creditGrantRef,
    "",
  ].join("|")).join("\n"), "utf8").digest("hex");
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

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
