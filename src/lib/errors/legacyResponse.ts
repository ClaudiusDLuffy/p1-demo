import { AppError } from "./AppError";
import { normalizeUnknownError } from "./normalizeUnknown";
import { httpErrorCode } from "./normalizeHttp";

/** Transitional route-local factory. The route boundary supplies correlation
 * and owns the single log. Unknown prose is never a public message. */
export function legacyErrorResponse(cause: unknown, status: number): Response {
  const normalized = normalizeUnknownError(cause);
  const error = normalized.code === "INTERNAL_ERROR" ? new AppError(httpErrorCode(status), { cause, status }) : normalized;
  const effectiveStatus = ["FEATURE_DISABLED", "CONFIG_INCOMPLETE", "CONFIG_INVALID", "ENVIRONMENT_MISMATCH"].includes(error.code)
    ? error.status : status;
  return Response.json({ error: error.message, code: error.code }, { status: effectiveStatus, headers: { "Cache-Control": "no-store" } });
}
