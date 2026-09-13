import { parseApiError } from "./clientApiError";
import { normalizeUnknownError } from "./normalizeUnknown";
import { AppError } from "./AppError";

/** First-party JSON/download request boundary; never retries a mutation. Call
 * before consuming the response so untrusted error bodies stay byte-bounded. */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit, transport: typeof fetch = fetch): Promise<Response> {
  let response: Response;
  try { response = await transport(input, init); }
  catch (cause) {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    throw ["GET", "HEAD"].includes(method) ? normalizeUnknownError(cause) : new AppError("RESULT_UNCONFIRMED", { cause });
  }
  if (!response.ok) throw await parseApiError(response, init?.signal ?? undefined);
  return response;
}
