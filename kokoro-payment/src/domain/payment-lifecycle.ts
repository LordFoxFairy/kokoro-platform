export interface DeletionAudit {
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteReason: string | null;
}

export interface DeleteInput {
  id: string;
  deletedBy: string;
  reason?: string | undefined;
}

export interface RestoreInput {
  id: string;
}

export interface ListOptions {
  includeDeleted?: boolean | undefined;
}

export type PaymentLifecycleErrorCode = "payment.plan.not_found" | "payment.plan.deleted";

export class PaymentLifecycleError extends Error {
  constructor(
    public readonly code: PaymentLifecycleErrorCode,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "PaymentLifecycleError";
  }
}

export function isPaymentLifecycleError(error: unknown): error is PaymentLifecycleError {
  return error instanceof PaymentLifecycleError;
}
