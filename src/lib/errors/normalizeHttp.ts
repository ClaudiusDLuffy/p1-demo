import { AppError } from "./AppError";
import type { PublicErrorCode } from "./catalog";
export function httpErrorCode(status: number): PublicErrorCode {
  const known: Record<number, PublicErrorCode> = { 400: "INVALID_REQUEST", 401: "AUTH_REQUIRED", 403: "FORBIDDEN", 404: "NOT_FOUND",
    408: "TIMEOUT", 409: "CONFLICT", 413: "PAYLOAD_TOO_LARGE", 415: "UNSUPPORTED_FILE_TYPE", 422: "VALIDATION_FAILED",
    429: "RATE_LIMITED", 502: "PROVIDER_UNAVAILABLE", 503: "PROVIDER_UNAVAILABLE", 504: "TIMEOUT" };
  return known[status] ?? "INTERNAL_ERROR";
}
export function normalizeHttpError(status: number, cause?: unknown, sendMayHaveStarted = false): AppError {
  // A transport status is not evidence that a provider did not accept a send.
  return new AppError(sendMayHaveStarted ? "DELIVERY_UNKNOWN" : httpErrorCode(status), { cause, status });
}
