import { AppError } from "./AppError";
import { isPublicErrorCode } from "./catalog";
import { httpErrorCode } from "./normalizeHttp";
import { readBoundedBody } from "../http/boundedBody";
import { REQUEST_ID_HEADER, validCorrelationId } from "../observability/correlationId";

export async function parseApiError(response: Response, signal?: AbortSignal): Promise<AppError> {
  const correlationId = validCorrelationId(response.headers.get(REQUEST_ID_HEADER)) ?? undefined;
  let body: unknown = null;
  try { body = JSON.parse(await readBoundedBody(response.body, { maximum: 16_384, timeoutMs: 3_000, signal })); }
  catch { /* HTML, oversized, empty and malformed responses are not UI text. */ }
  const fields = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const code = isPublicErrorCode(fields.code) ? fields.code : httpErrorCode(response.status);
  const retryAfter = response.headers.get("retry-after");
  const retryAfterSeconds = typeof fields.retryAfterSeconds === "number" ? fields.retryAfterSeconds
    : retryAfter !== null && /^\d{1,3}$/.test(retryAfter) ? Number(retryAfter) : undefined;
  return new AppError(code, { status: response.status, fieldErrors: fields.fieldErrors ?? fields.fields,
    correlationId: correlationId ?? validCorrelationId(fields.correlationId) ?? undefined, retryAfterSeconds });
}
