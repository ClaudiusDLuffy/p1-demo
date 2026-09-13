export type RetryClass = "never" | "safe_read" | "reconcile";
export type RecoveryAction = "sign_in" | "contact_admin" | "correct_fields" | "refresh_record" | "retry_read" | "wait" | "reconcile" | "contact_support";
export type ErrorMetadata = {
  message: string; status: number; retry: RetryClass; recovery: RecoveryAction;
  fieldErrors: boolean; supportReference: boolean; refreshSession: boolean; mutationReplayRequired: boolean;
};
const entry = (message: string, status: number, retry: RetryClass, recovery: RecoveryAction, fieldErrors = false): ErrorMetadata => Object.freeze({
  message, status, retry, recovery, fieldErrors, supportReference: status >= 500,
  refreshSession: recovery === "sign_in", mutationReplayRequired: retry !== "never",
});
export const coreErrorCodes = Object.freeze({
  AUTH_REQUIRED: entry("Please sign in again.", 401, "never", "sign_in"),
  SESSION_EXPIRED: entry("Your session expired. Please sign in again.", 401, "never", "sign_in"),
  AUTH_INVALID: entry("Your sign-in could not be verified. Please sign in again.", 401, "never", "sign_in"),
  ACCOUNT_INACTIVE: entry("Your account is inactive. Contact an administrator.", 403, "never", "contact_admin"),
  AUTH_TIMEOUT: entry("Your session could not be verified in time. Try signing in again.", 408, "never", "sign_in"),
  FORBIDDEN: entry("You do not have permission to perform this action.", 403, "never", "contact_admin"),
  ROLE_NOT_ALLOWED: entry("Your account cannot perform this action.", 403, "never", "contact_admin"),
  RESOURCE_ACCESS_DENIED: entry("This resource is not available to your account.", 403, "never", "contact_admin"),
  VALIDATION_FAILED: entry("Check the required fields and try again.", 422, "never", "correct_fields", true),
  INVALID_REQUEST: entry("The request is invalid. Check the details and try again.", 400, "never", "correct_fields", true),
  INVALID_CURSOR: entry("This page is no longer valid. Start at the newest results.", 400, "never", "refresh_record"),
  FILE_REJECTED: entry("This file could not be accepted. Check its format and size.", 422, "never", "correct_fields"),
  UNSUPPORTED_FILE_TYPE: entry("This file format is not supported.", 415, "never", "correct_fields"),
  PAYLOAD_TOO_LARGE: entry("The request exceeds the supported size.", 413, "never", "correct_fields"),
  NOT_FOUND: entry("This record is unavailable. Refresh the list.", 404, "never", "refresh_record"),
  METHOD_NOT_ALLOWED: entry("This request method is not supported.", 405, "never", "correct_fields"),
  CONFLICT: entry("This action conflicts with the current record. Refresh and review its status.", 409, "never", "refresh_record"),
  STALE_VERSION: entry("The record changed. Refresh and review it before trying again.", 409, "never", "refresh_record"),
  INVALID_TRANSITION: entry("This action is not available in the current state. Refresh the record.", 422, "never", "refresh_record"),
  DUPLICATE_OPERATION: entry("This operation already exists. Review its recorded outcome.", 409, "never", "reconcile"),
  OPERATION_REUSED: entry("The request differs from its original details. Review the recorded outcome.", 409, "never", "reconcile"),
  RATE_LIMITED: entry("Too many requests. Wait before trying again.", 429, "safe_read", "wait"),
  NETWORK_UNAVAILABLE: entry("The connection is unavailable. Check your connection and refresh the result.", 503, "safe_read", "retry_read"),
  TIMEOUT: entry("The request timed out. Check the current result before repeating an action.", 504, "safe_read", "retry_read"),
  REQUEST_ABORTED: entry("The request was cancelled. Check its current result before repeating an action.", 408, "never", "reconcile"),
  PROVIDER_UNAVAILABLE: entry("This service is temporarily unavailable. Saved work remains unchanged.", 503, "safe_read", "retry_read"),
  DELIVERY_UNKNOWN: entry("Delivery could not be confirmed and may already have occurred. Review the status; do not resend automatically.", 502, "reconcile", "reconcile"),
  RESULT_UNCONFIRMED: entry("The result could not be confirmed. Refresh and reconcile the recorded outcome before another action.", 503, "reconcile", "reconcile"),
  STORAGE_UNAVAILABLE: entry("File storage is temporarily unavailable. Check the same file's status before retrying.", 503, "safe_read", "retry_read"),
  FEATURE_DISABLED: entry("This feature is not enabled in this environment.", 503, "never", "contact_admin"),
  CONFIG_INCOMPLETE: entry("This feature's configuration is incomplete. Contact an administrator.", 503, "never", "contact_admin"),
  CONFIG_INVALID: entry("This feature's configuration is invalid. Contact an administrator.", 503, "never", "contact_admin"),
  ENVIRONMENT_MISMATCH: entry("This feature is unavailable because the environment configuration does not match.", 503, "never", "contact_admin"),
  INTERNAL_ERROR: entry("The request could not be completed. Contact support with the error reference if it continues.", 500, "never", "contact_support"),
} as const satisfies Record<string, ErrorMetadata>);
export type CoreErrorCode = keyof typeof coreErrorCodes;
