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

export type ModelLifecycleErrorCode =
  | "model.provider_account.not_found"
  | "model.provider_account.deleted"
  | "model.binding.not_found"
  | "model.binding.deleted";

export class ModelLifecycleError extends Error {
  constructor(
    public readonly code: ModelLifecycleErrorCode,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ModelLifecycleError";
  }
}

export function isModelLifecycleError(error: unknown): error is ModelLifecycleError {
  return error instanceof ModelLifecycleError;
}
