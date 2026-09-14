import { AppError } from "./AppError";
import type { PublicErrorCode } from "./catalog";
import type { PublicFieldError } from "./fieldErrors";
import { normalizeCorrelationId } from "../observability/correlationId";
import { normalizeUnknownError } from "./normalizeUnknown";
export type PublicErrorResponse = { error: string; code: PublicErrorCode; correlationId: string;
  fieldErrors?: PublicFieldError[]; retryAfterSeconds?: number };
export function publicError(error: AppError, correlationId: string): PublicErrorResponse {
  const safe = normalizeUnknownError(error);
  return { error: safe.message, code: safe.code, correlationId: normalizeCorrelationId(correlationId),
    ...(safe.fieldErrors ? { fieldErrors: safe.fieldErrors } : {}),
    ...(safe.retryAfterSeconds !== undefined ? { retryAfterSeconds: safe.retryAfterSeconds } : {}) };
}
