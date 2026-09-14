import { errorMetadata, isPublicErrorCode, type PublicErrorCode } from "./catalog";
import type { RetryClass, RecoveryAction } from "./codes";
import { safeFieldErrors, type PublicFieldError } from "./fieldErrors";
import { validCorrelationId } from "../observability/correlationId";
import { errorData } from "./errorData";
export class AppError extends Error {
  readonly code: PublicErrorCode;
  readonly status: number;
  readonly retry: RetryClass;
  readonly recovery: RecoveryAction;
  readonly fieldErrors?: PublicFieldError[];
  readonly correlationId?: string;
  readonly retryAfterSeconds?: number;
  readonly isOperational: boolean;
  constructor(code: PublicErrorCode, options: {
    cause?: unknown; status?: number; fieldErrors?: unknown; correlationId?: string; retryAfterSeconds?: number;
  } = {}) {
    const safeCode = isPublicErrorCode(code) ? code : "INTERNAL_ERROR";
    const metadata = errorMetadata(safeCode);
    super(metadata.message, { cause: errorData(options, "cause") });
    this.code = safeCode;
    this.name = "AppError";
    const status = errorData(options, "status");
    this.status = typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : metadata.status;
    this.retry = metadata.retry; this.recovery = metadata.recovery;
    this.fieldErrors = metadata.fieldErrors ? safeFieldErrors(errorData(options, "fieldErrors")) : undefined;
    this.correlationId = validCorrelationId(errorData(options, "correlationId")) ?? undefined;
    const retryAfterSeconds = errorData(options, "retryAfterSeconds");
    this.retryAfterSeconds = typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? Math.min(60, Math.ceil(retryAfterSeconds)) : undefined;
    this.isOperational = safeCode !== "INTERNAL_ERROR";
  }
}
