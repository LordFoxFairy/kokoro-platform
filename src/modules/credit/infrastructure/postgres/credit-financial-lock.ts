import { resolvePlatformTransaction, type PlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";

export type CreditFinancialAuthorityLock = Readonly<{
  creditHoldRef: string;
}>;

/**
 * Canonical Credit financial lock order used by allocation and settlement paths:
 * allocation rows by UUID, then the exact execution root, then its exact hold.
 * Callers must fresh-load mutable heads only after this function returns.
 */
export async function lockCreditFinancialAuthority(
  transaction: PlatformTransaction,
  input: Readonly<{
    siteId: string;
    executionBudgetRootRef: string;
    allocationRefs: readonly string[];
    expectedCreditHoldRef?: string;
  }>,
): Promise<CreditFinancialAuthorityLock | null> {
  const sql = resolvePlatformTransaction(transaction);
  const expectedAllocationRefs = [...new Set(input.allocationRefs)].sort(codePointCompare);
  if (expectedAllocationRefs.length === 0) throw new Error("CREDIT_FINANCIAL_LOCK_ALLOCATION_REQUIRED");

  const allocations = await sql.query<Record<string, unknown>>(
    `/* credit-financial-allocation-lock */
     SELECT allocation.budget_allocation_ref::text AS "allocationRef"
     FROM platform.credit_budget_allocation AS allocation
     WHERE allocation.site_ref=$1
       AND allocation.execution_budget_root_ref=$2::uuid
       AND allocation.budget_allocation_ref=ANY($3::uuid[])
     ORDER BY allocation.budget_allocation_ref
     FOR UPDATE OF allocation`,
    [input.siteId, input.executionBudgetRootRef, expectedAllocationRefs],
  );
  const lockedAllocationRefs = allocations.map((row) => exactString(row, "allocationRef"));
  if (lockedAllocationRefs.length !== expectedAllocationRefs.length ||
      lockedAllocationRefs.some((value, index) => value !== expectedAllocationRefs[index])) return null;

  const roots = await sql.query<Record<string, unknown>>(
    `/* credit-financial-root-lock */
     SELECT root.credit_hold_ref::text AS "creditHoldRef"
     FROM platform.credit_execution_budget_root AS root
     WHERE root.site_ref=$1 AND root.execution_budget_root_ref=$2::uuid
     FOR UPDATE OF root`,
    [input.siteId, input.executionBudgetRootRef],
  );
  if (roots.length === 0) return null;
  if (roots.length !== 1) throw new Error("CREDIT_FINANCIAL_ROOT_AMBIGUOUS");
  const creditHoldRef = exactString(roots[0], "creditHoldRef");
  if (input.expectedCreditHoldRef !== undefined && creditHoldRef !== input.expectedCreditHoldRef) return null;

  const holds = await sql.query<Record<string, unknown>>(
    `/* credit-financial-hold-lock */
     SELECT hold.credit_hold_ref::text AS "creditHoldRef"
     FROM platform.credit_hold AS hold
     WHERE hold.site_ref=$1 AND hold.credit_hold_ref=$2::uuid
     FOR UPDATE OF hold`,
    [input.siteId, creditHoldRef],
  );
  if (holds.length === 0) return null;
  if (holds.length !== 1 || exactString(holds[0], "creditHoldRef") !== creditHoldRef) {
    throw new Error("CREDIT_FINANCIAL_HOLD_AMBIGUOUS");
  }
  return Object.freeze({ creditHoldRef });
}

function exactString(row: Record<string, unknown> | undefined, field: string): string {
  const value = row?.[field];
  if (typeof value !== "string" || value.length === 0) throw new Error("CREDIT_FINANCIAL_LOCK_CORRUPT");
  return value;
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
