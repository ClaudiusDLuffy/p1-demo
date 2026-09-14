import { MobileContractError, mapPublicError } from "@p1/mobile-contracts";
export type TokenProvider = () => Promise<string | null>;
const requestId = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, character => {
  const value = Math.floor(Math.random() * 16);
  return (character === "x" ? value : (value & 3) | 8).toString(16);
});
export function createApiClient(baseUrl: string, token: TokenProvider, fetcher: typeof fetch = fetch) {
  const request = async <T>(path: string, init: RequestInit = {}, timeoutMs = 8000): Promise<T> => {
    const accessToken = await token();
    if (!accessToken) throw new MobileContractError("auth_required", "Please sign in again.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(Math.max(timeoutMs, 1000), 15000));
    const externalAbort = () => controller.abort();
    init.signal?.addEventListener("abort", externalAbort, { once: true });
    try {
      const response = await fetcher(new URL(path, baseUrl).toString(), {
        ...init, signal: controller.signal, headers: {
          Accept: "application/json", Authorization: `Bearer ${accessToken}`,
          "X-Request-ID": requestId(), ...init.headers,
        },
      });
      const raw = await response.text();
      let body: unknown = null;
      if (raw) { try { body = JSON.parse(raw) as unknown; } catch { throw new MobileContractError("invalid_response"); } }
      if (!response.ok) throw mapPublicError({ status: response.status });
      return body as T;
    } catch (error) { throw mapPublicError(error); }
    finally { clearTimeout(timeout); init.signal?.removeEventListener("abort", externalAbort); }
  };
  return {
    get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { method: "GET", ...(signal ? { signal } : {}) }),
    post: <T>(path: string, body: unknown, signal?: AbortSignal) =>
      request<T>(path, { method: "POST", ...(signal ? { signal } : {}), headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  };
}
