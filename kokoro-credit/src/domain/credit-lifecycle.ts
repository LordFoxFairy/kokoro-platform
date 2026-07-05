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

export type CreditLifecycleErrorCode =
  | "credit.account.not_found"
  | "credit.account.deleted"
  | "credit.account.active_hold_exists"
  | "credit.pricing_rule.not_found"
  | "credit.pricing_rule.deleted";

export class CreditLifecycleError extends Error {
  constructor(
    public readonly code: CreditLifecycleErrorCode,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "CreditLifecycleError";
  }
}

export function isCreditLifecycleError(error: unknown): error is CreditLifecycleError {
  return error instanceof CreditLifecycleError;
}
