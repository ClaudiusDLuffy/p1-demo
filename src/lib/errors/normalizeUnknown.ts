import { z } from "zod";
import { AppError } from "./AppError";
import { errorMetadata, isPublicErrorCode } from "./catalog";
import { normalizeSupabaseCode } from "./normalizeSupabase";
import { normalizeHttpError } from "./normalizeHttp";
import { errorData } from "./errorData";

export function normalizeUnknownError(cause: unknown): AppError {
  try {
    if (cause instanceof AppError) {
      const code = errorData(cause, "code");
      const status = errorData(cause, "status");
      const correlationId = errorData(cause, "correlationId");
      const retryAfterSeconds = errorData(cause, "retryAfterSeconds");
      return new AppError(isPublicErrorCode(code) ? code : "INTERNAL_ERROR", {
        cause: errorData(cause, "cause") ?? cause,
        status: typeof status === "number" ? status : undefined,
        fieldErrors: errorData(cause, "fieldErrors"),
        correlationId: typeof correlationId === "string" ? correlationId : undefined,
        retryAfterSeconds: typeof retryAfterSeconds === "number" ? retryAfterSeconds : undefined,
      });
    }
    if (cause instanceof z.ZodError) return new AppError("VALIDATION_FAILED", { cause, fieldErrors: errorData(cause, "issues") });
    if (cause && typeof cause === "object") {
      const code = errorData(cause, "code");
      // Only exact catalog values are accepted; messages/detail text are never
      // copied. Existing RPC safe-code fields sometimes use details/message.
      if (isPublicErrorCode(code)) return new AppError(code, { cause });
      for (const key of ["details", "message"] as const) {
        const value = errorData(cause, key);
        if (isPublicErrorCode(value)) return new AppError(value, { cause });
      }
      const database = normalizeSupabaseCode(code, cause);
      if (database) return database;
      const name: unknown = cause instanceof DOMException
        ? Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get?.call(cause)
        : errorData(cause, "name");
      if (name === "AbortError") return new AppError("REQUEST_ABORTED", { cause });
      if (name === "TimeoutError") return new AppError("TIMEOUT", { cause });
      const status = errorData(cause, "status");
      if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) return normalizeHttpError(status, cause);
      const message = errorData(cause, "message");
      if (cause instanceof TypeError && typeof message === "string" && ["Failed to fetch", "fetch failed", "NetworkError when attempting to fetch resource."].includes(message)) {
        return new AppError("NETWORK_UNAVAILABLE", { cause });
      }
    }
  } catch { /* hostile getters/proxies cannot replace the safe fallback */ }
  return new AppError("INTERNAL_ERROR", { cause });
}
export function safeErrorMessage(error: unknown): string {
  const normalized = normalizeUnknownError(error);
  return errorMetadata(normalized.code).supportReference && normalized.correlationId
    ? `${normalized.message} Error reference: ${normalized.correlationId}`
    : normalized.message;
}
