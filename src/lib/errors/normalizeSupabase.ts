import { AppError } from "./AppError";
import type { PublicErrorCode } from "./catalog";
const databaseCodes: Record<string, PublicErrorCode> = {
  "42501": "FORBIDDEN", PT403: "FORBIDDEN", PGRST301: "AUTH_INVALID", PGRST302: "AUTH_REQUIRED", PT401: "AUTH_REQUIRED",
  "23505": "CONFLICT", "23503": "VALIDATION_FAILED", "23514": "VALIDATION_FAILED", "22023": "VALIDATION_FAILED", PT422: "VALIDATION_FAILED",
  PT409: "STALE_VERSION", "40001": "STALE_VERSION", "55000": "INVALID_TRANSITION", "40P01": "CONFLICT",
  P0002: "NOT_FOUND", PT404: "NOT_FOUND", PGRST116: "NOT_FOUND", PGRST202: "PROVIDER_UNAVAILABLE", "42883": "PROVIDER_UNAVAILABLE",
  PT429: "RATE_LIMITED", "57014": "TIMEOUT", "08006": "NETWORK_UNAVAILABLE",
  invalid_credentials: "AUTH_INVALID", refresh_token_not_found: "SESSION_EXPIRED", refresh_token_already_used: "SESSION_EXPIRED",
  user_banned: "ACCOUNT_INACTIVE", over_request_rate_limit: "RATE_LIMITED",
};
export function normalizeSupabaseCode(code: unknown, cause: unknown): AppError | null {
  return typeof code === "string" && Object.hasOwn(databaseCodes, code) ? new AppError(databaseCodes[code], { cause }) : null;
}
