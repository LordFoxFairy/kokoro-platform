const transactionBrand: unique symbol = Symbol("PlatformTransaction");

export interface PlatformTransaction {
  readonly [transactionBrand]: true;
}

export interface PlatformSqlTransaction {
  query<Row extends Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<readonly Row[]>;
  execute(statement: string, values?: readonly unknown[]): Promise<number>;
}

export interface PlatformTransactionLease {
  readonly transaction: PlatformTransaction;
}

const activeTransactions = new WeakMap<PlatformTransaction, PlatformSqlTransaction>();

/** @internal Infrastructure composition only. Never export from a package barrel. */
export function issuePlatformTransaction(sql: PlatformSqlTransaction): PlatformTransactionLease {
  const transaction = Object.freeze(
    Object.defineProperty({}, transactionBrand, { value: true }),
  ) as PlatformTransaction;
  activeTransactions.set(transaction, sql);
  return Object.freeze({ transaction });
}

/** @internal Owner PostgreSQL adapters only. */
export function resolvePlatformTransaction(transaction: PlatformTransaction): PlatformSqlTransaction {
  const sql = activeTransactions.get(transaction);
  if (!sql) throw new Error("PLATFORM_TRANSACTION_NOT_ACTIVE");
  return sql;
}

/** @internal Unit-of-work host only. */
export function revokePlatformTransaction(lease: PlatformTransactionLease): void {
  activeTransactions.delete(lease.transaction);
}
