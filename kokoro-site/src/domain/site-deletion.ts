export interface DeletionAudit {
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteReason: string | null;
}

export interface DeleteInput {
  id: string;
  deletedBy?: string | undefined;
  reason?: string | undefined;
}

export interface RestoreInput {
  id: string;
}

export interface ListOptions {
  includeDeleted?: boolean | undefined;
}

export type SiteLifecycleErrorCode =
  | "site.not_found"
  | "site.deleted"
  | "site_domain.not_found"
  | "site_domain.deleted"
  | "site_app.deleted"
  | "site_policy.deleted"
  | "site_feature_flag.deleted";

export class SiteLifecycleError extends Error {
  constructor(
    readonly code: SiteLifecycleErrorCode,
    message: string,
    readonly statusCode: 404 | 409,
  ) {
    super(message);
    this.name = "SiteLifecycleError";
  }
}

export function isSiteLifecycleError(error: unknown): error is SiteLifecycleError {
  return error instanceof SiteLifecycleError;
}
