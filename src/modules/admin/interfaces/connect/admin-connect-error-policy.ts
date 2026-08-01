import { Code } from "@connectrpc/connect";

export const ADMIN_UNAUTHENTICATED_ERROR_CODES = Object.freeze([
  "ADMIN_SESSION_UNAUTHENTICATED",
  "ADMIN_SESSION_INVALID",
  "ADMIN_SESSION_AUTHORITY_MISMATCH",
  "ADMIN_SESSION_SECURITY_EPOCH_STALE",
  "ADMIN_OPERATOR_AUTHORITY_INVALID",
  "ADMIN_OPERATOR_ATTESTATION_MISMATCH",
  "ADMIN_VERIFIED_PEER_REQUIRED",
  "ADMIN_SESSION_CREDENTIAL_REQUIRED",
  "ADMIN_SESSION_CREDENTIAL_INVALID",
] as const);

export const ADMIN_PERMISSION_DENIED_ERROR_CODES = Object.freeze([
  "ADMIN_PERMISSION_DENIED",
  "ADMIN_SCOPE_DEPLOYMENT_MISMATCH",
  "ADMIN_SELF_ESCALATION_DENIED",
  "ADMIN_SITE_SCOPE_INVALID",
  "ADMIN_SITE_SCOPE_DENIED",
  "ADMIN_GLOBAL_SCOPE_INVALID",
  "ADMIN_GLOBAL_SCOPE_DENIED",
  "ADMIN_BREAKGLASS_SCOPE_INVALID",
  "ADMIN_BREAKGLASS_SCOPE_DENIED",
  "ADMIN_BREAKGLASS_TARGET_DENIED",
  "ADMIN_WORKLOAD_AXIS_MISMATCH",
] as const);

export const ADMIN_STEP_UP_REQUIRED_ERROR_CODES = Object.freeze([
  "ADMIN_STEP_UP_REQUIRED",
] as const);

export const ADMIN_REQUEST_INVALID_ERROR_CODES = Object.freeze([
  "ADMIN_STEP_UP_TARGET_REQUIRED",
  "ADMIN_SCOPE_REQUIRED",
  "ADMIN_BREAKGLASS_EXPIRY_REQUIRED",
  "ADMIN_REQUEST_ID_INVALID",
] as const);

export type AdminConnectErrorClassification =
  | "unauthenticated"
  | "permissionDenied"
  | "stepUpRequired"
  | "invalidRequest"
  | "unclassified";

export interface StableAdminConnectError {
  readonly code: Code;
  readonly domainCode: string;
  readonly safeMessage: string;
}

export function classifyAdminConnectError(error: unknown): AdminConnectErrorClassification {
  const value = error instanceof Error ? error.message : "";
  if (contains(ADMIN_UNAUTHENTICATED_ERROR_CODES, value)) return "unauthenticated";
  if (contains(ADMIN_PERMISSION_DENIED_ERROR_CODES, value)) return "permissionDenied";
  if (contains(ADMIN_STEP_UP_REQUIRED_ERROR_CODES, value)) return "stepUpRequired";
  if (contains(ADMIN_REQUEST_INVALID_ERROR_CODES, value)) return "invalidRequest";
  return "unclassified";
}

export function stableAdminConnectError(error: unknown): StableAdminConnectError | null {
  const classification = classifyAdminConnectError(error);
  if (classification === "unauthenticated") {
    return Object.freeze({ code: Code.Unauthenticated, domainCode: "admin.session.unauthenticated",
      safeMessage: "Admin session authentication failed" });
  }
  if (classification === "permissionDenied") {
    return Object.freeze({ code: Code.PermissionDenied, domainCode: "admin.permission_denied",
      safeMessage: "Admin operation is not permitted" });
  }
  if (classification === "stepUpRequired") {
    return Object.freeze({ code: Code.FailedPrecondition, domainCode: "admin.step_up_required",
      safeMessage: "Fresh phishing-resistant authentication is required" });
  }
  if (classification === "invalidRequest") {
    return Object.freeze({ code: Code.InvalidArgument, domainCode: "admin.request.invalid",
      safeMessage: "Invalid admin request" });
  }
  return null;
}

function contains(values: readonly string[], value: string): boolean {
  return values.includes(value);
}
