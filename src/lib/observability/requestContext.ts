import { normalizeCorrelationId, REQUEST_ID_HEADER } from "./correlationId";
export type RequestContext = { readonly correlationId: string; readonly route: string; readonly method: string;
  readonly startedAt: number; failureLogged: boolean };
export function createRequestContext(request: Request, route: string): RequestContext {
  return { correlationId: normalizeCorrelationId(request.headers.get(REQUEST_ID_HEADER)),
    route: /^\/api\/[a-z0-9/-]{1,150}$/.test(route) ? route : "/api/unknown",
    method: /^(GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)$/.test(request.method) ? request.method : "OTHER",
    startedAt: performance.now(), failureLogged: false };
}
export function withRequestId(response: Response, context: RequestContext): Response {
  const headers = new Headers(response.headers);
  headers.set(REQUEST_ID_HEADER, context.correlationId);
  // No CORS origin is opened. Existing same-origin clients can read the header.
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
