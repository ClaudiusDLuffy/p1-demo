import { z } from "zod";
import { AppError } from "../../errors/AppError";
import { getServerPublicSupabaseConfig } from "../../config/server/supabase";
import { readBoundedBody } from "../../http/boundedBody";
import type { EnvironmentValues } from "../../config/shared";
export async function authorizeDiagnostic(request: Request, send: typeof fetch = fetch,
  options: { environment?: EnvironmentValues; timeoutMs?: number } = {}): Promise<string> {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S{1,8192})$/i)?.[1];
  if (!token) throw new AppError("AUTH_REQUIRED");
  const { url, publishableKey } = getServerPublicSupabaseConfig(options.environment);
  const controller = new AbortController();
  let rejectDeadline: (error: AppError) => void = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const abort = () => { rejectDeadline(new AppError("REQUEST_ABORTED")); controller.abort(); };
  const duration = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(3_000, options.timeoutMs ?? 3_000)) : 3_000;
  const timer = setTimeout(() => { rejectDeadline(new AppError("AUTH_TIMEOUT")); controller.abort(); }, duration);
  request.signal.addEventListener("abort", abort, { once: true });
  const get = async (target: URL, denial: "AUTH_INVALID" | "FORBIDDEN"): Promise<unknown> => {
    if (controller.signal.aborted) throw new AppError("REQUEST_ABORTED");
    const response = await send(target, { cache: "no-store", redirect: "error", signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, apikey: publishableKey, Accept: "application/json" } });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new AppError(response.status >= 500 || response.status === 429 ? "PROVIDER_UNAVAILABLE" : denial);
    }
    try { return JSON.parse(await readBoundedBody(response.body, { maximum: 16_384, timeoutMs: duration, signal: controller.signal })); }
    catch (error) { if (controller.signal.aborted) throw error; throw new AppError(denial, { cause: error }); }
  };
  try {
    if (request.signal.aborted) throw new AppError("REQUEST_ABORTED");
    const authorize = async () => {
    const identity = z.object({ id: z.uuid() }).safeParse(await get(new URL("/auth/v1/user", url), "AUTH_INVALID"));
    if (!identity.success) throw new AppError("AUTH_INVALID");
    const target = new URL("/rest/v1/profiles", url);
    target.searchParams.set("select", "id,active"); target.searchParams.set("id", `eq.${identity.data.id}`); target.searchParams.set("limit", "1");
    const profiles = z.array(z.object({ id: z.uuid(), active: z.boolean() })).length(1).safeParse(await get(target, "FORBIDDEN"));
    if (!profiles.success || profiles.data[0].id !== identity.data.id) throw new AppError("FORBIDDEN");
    if (!profiles.data[0].active) throw new AppError("ACCOUNT_INACTIVE");
    return identity.data.id;
    };
    return await Promise.race([authorize(), stopped]);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("PROVIDER_UNAVAILABLE", { cause: error });
  } finally { clearTimeout(timer); request.signal.removeEventListener("abort", abort); controller.abort(); }
}
