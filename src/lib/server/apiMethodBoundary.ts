import { AppError } from "../errors/AppError";
import { publicError } from "../errors/publicError";
import { createRequestContext, withRequestId } from "../observability/requestContext";

type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

function protocolError(request: Request, route: string, code: "METHOD_NOT_ALLOWED" | "NOT_FOUND"): Response {
  const context = createRequestContext(request, route);
  const error = new AppError(code);
  const headers = { "Cache-Control": "no-store", "Content-Type": "application/json" };
  // These expected protocol responses do not consume a body, authorize an
  // operation, or generate an error log for arbitrary paths/methods.
  const response = request.method === "HEAD" ? new Response(null, { status: error.status, headers })
    : Response.json(publicError(error, context.correlationId), { status: error.status, headers });
  return withRequestId(response, context);
}

/** Metadata-only replacements for methods Next otherwise implements itself.
 * Existing GET handlers still own Next's implicit HEAD implementation. */
export function createApiMethodBoundary(route: string, implemented: readonly ApiMethod[]) {
  const allow = new Set<ApiMethod>(["OPTIONS", ...implemented]);
  if (allow.has("GET")) allow.add("HEAD");
  const allowed = [...allow].sort().join(", ");
  return {
    OPTIONS(request: Request): Response {
      return withRequestId(new Response(null, { status: 204, headers: { Allow: allowed, "Cache-Control": "no-store" } }),
        createRequestContext(request, route));
    },
    methodNotAllowed(request: Request): Response {
      const response = protocolError(request, route, "METHOD_NOT_ALLOWED");
      response.headers.set("Allow", allowed);
      return response;
    },
  };
}

/** Never reflect a caller-selected path or query into an error or log. */
export const apiNotFound = (request: Request): Response => protocolError(request, "/api/unknown", "NOT_FOUND");
