import { AppError } from "./AppError";
import { normalizeUnknownError } from "./normalizeUnknown";
import { httpErrorCode } from "./normalizeHttp";
import { isPublicErrorCode } from "./catalog";
import { publicError } from "./publicError";
import { readBoundedBody } from "../http/boundedBody";
import { withRequestId, type RequestContext } from "../observability/requestContext";
import { logBoundaryFailure } from "../observability/safeLogger";
import { serviceFailureAliases } from "./serviceCompatibility";

export function errorResponse(cause: unknown, context: RequestContext): Response {
  const error = normalizeUnknownError(cause);
  logBoundaryFailure(context, error);
  const headers: Record<string, string> = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (error.retryAfterSeconds !== undefined) headers["Retry-After"] = String(error.retryAfterSeconds);
  return withRequestId(Response.json(publicError(error, context.correlationId), { status: error.status, headers }), context);
}

/** Compatibility adapter for a route's existing responses. Success payloads,
 * downloads and redirects are not consumed or re-enveloped. Auth, parsing and
 * command control flow stay in each route; this helper owns only projection. */
export async function finalizeApiResponse(response: Response | undefined, context: RequestContext): Promise<Response> {
  if (!response) return errorResponse(new AppError("INTERNAL_ERROR"), context);
  if (response.status < 400) return withRequestId(response, context);
  let raw: unknown;
  try { raw = JSON.parse(await readBoundedBody(response.body, { maximum: 32_768, timeoutMs: 1_000 })); }
  catch { return errorResponse(new AppError(httpErrorCode(response.status), { status: response.status }), context); }
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const error = new AppError(isPublicErrorCode(body.code) ? body.code : httpErrorCode(response.status), {
    status: response.status, fieldErrors: body.fieldErrors ?? body.fields,
    retryAfterSeconds: typeof body.retryAfterSeconds === "number" ? body.retryAfterSeconds : undefined,
  });
  logBoundaryFailure(context, error);
  const projected = publicError(error, context.correlationId);
  const result: Record<string, unknown> = { ...serviceFailureAliases(context.route, body), ...projected };
  // Existing file clients read `message`; financial clients read `fields`.
  if (Object.hasOwn(body, "message")) result.message = projected.error;
  if (Object.hasOwn(body, "fields")) result.fields = projected.fieldErrors ?? [];
  if (typeof body.success === "boolean") result.success = body.success;
  const headers = new Headers(response.headers);
  headers.delete("content-length"); headers.set("Cache-Control", "no-store");
  return withRequestId(Response.json(result, { status: response.status, headers }), context);
}
