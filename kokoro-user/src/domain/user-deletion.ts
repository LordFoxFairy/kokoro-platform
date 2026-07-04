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

export type UserLifecycleErrorCode =
  | "user.not_found"
  | "user.deleted"
  | "user.disabled"
  | "user.cross_site"
  | "team.not_found"
  | "team.deleted"
  | "team.disabled"
  | "membership.deleted"
  | "service_account.not_found"
  | "service_account.deleted";

export class UserLifecycleError extends Error {
  constructor(
    public readonly code: UserLifecycleErrorCode,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "UserLifecycleError";
  }
}

export function isUserLifecycleError(error: unknown): error is UserLifecycleError {
  return error instanceof UserLifecycleError;
}
