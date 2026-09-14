import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestContext } from "../observability/requestContext";

const operations = new AsyncLocalStorage<RequestContext>();
/** Scope, not authorization or replay identity. run() isolates overlapping
 * requests and restores the parent even when an operation rejects. */
export function runRequestOperation<T>(context: RequestContext, operation: () => Promise<T>): Promise<T> {
  return operations.run(context, operation);
}
export function currentRequestOperation(): RequestContext | undefined { return operations.getStore(); }

/** Server-to-server correlation only; credentials and bodies are untouched. */
function fetchWithCorrelation(send: typeof fetch, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const context = currentRequestOperation();
  if (!context) return send(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("X-Request-ID", context.correlationId);
  return send(input, { ...init, headers });
}
export function correlatedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetchWithCorrelation(fetch, input, init);
}
/** Preserve an injected transport's deadline/cancellation behavior while adding
 * the current scope at call time, never capturing one request in a client. */
export function withRequestCorrelation(send: typeof fetch): typeof fetch {
  return (input, init) => fetchWithCorrelation(send, input, init);
}
