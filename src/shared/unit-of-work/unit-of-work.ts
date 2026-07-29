import type { PlatformTransaction } from "./platform-transaction.js";
import { assertVerifiedRequestSecurityContext, type VerifiedRequestSecurityContext } from "../security-context/index.js";

export interface PlatformTransactionFence {
  readonly context: VerifiedRequestSecurityContext;
  readonly operation: string;
}

export interface PlatformTransactionHost {
  transaction<Result>(fence: PlatformTransactionFence, work: (transaction: PlatformTransaction) => Promise<Result>): Promise<Result>;
}

export class PlatformUnitOfWork {
  readonly #host: PlatformTransactionHost;
  readonly #clock: () => string;

  constructor(host: PlatformTransactionHost, clock: () => string = () => new Date().toISOString()) {
    this.#host = host;
    this.#clock = clock;
  }

  async execute<Result>(fence: PlatformTransactionFence, work: (transaction: PlatformTransaction) => Promise<Result>): Promise<Result> {
    assertVerifiedRequestSecurityContext(fence.context, this.#clock());
    if (!fence.context.trustedCaller.allowedOperations.includes(fence.operation)) {
      throw new Error("TRANSACTION_OPERATION_NOT_ALLOWED");
    }
    return this.#host.transaction(Object.freeze({ context: fence.context, operation: fence.operation }), work);
  }
}
