import { z } from "zod";
import { AppError } from "../../errors/AppError";
import { getServerSupabaseConfig } from "../../config/server/supabase";
import { readBoundedBody } from "../../http/boundedBody";
import type { EnvironmentValues } from "../../config/shared";
// No assertion of a routine absent from generated pre-migration database types.
export async function admitDiagnostic(profileId: string, signal: AbortSignal, send: typeof fetch = fetch,
  options: { environment?: EnvironmentValues; timeoutMs?: number } = {}): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  if (!z.uuid().safeParse(profileId).success) throw new AppError("AUTH_INVALID");
  if (signal.aborted) throw new AppError("REQUEST_ABORTED");
  const { url, secret } = getServerSupabaseConfig(options.environment);
  const controller = new AbortController();
  let rejectDeadline: (error: AppError) => void = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const abort = () => { rejectDeadline(new AppError("REQUEST_ABORTED")); controller.abort(); };
  const duration = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(3_000, options.timeoutMs ?? 3_000)) : 3_000;
  const timer = setTimeout(() => { rejectDeadline(new AppError("PROVIDER_UNAVAILABLE")); controller.abort(); }, duration);
  signal.addEventListener("abort", abort, { once: true });
  const consume = async () => {
  const response = await send(new URL("/rest/v1/rpc/consume_client_diagnostic_rate_limit_v1", url), {
    method: "POST", signal: controller.signal, cache: "no-store", redirect: "error",
    headers: { Authorization: `Bearer ${secret}`, apikey: secret, "Content-Type": "application/json" },
    body: JSON.stringify({ p_profile_id: profileId }),
  });
  if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new AppError(response.status === 403 ? "ACCOUNT_INACTIVE" : "PROVIDER_UNAVAILABLE"); }
  const parsed = z.object({ allowed: z.boolean(), retryAfterSeconds: z.number().int().min(0).max(60) }).safeParse(
    JSON.parse(await readBoundedBody(response.body, { maximum: 1_024, timeoutMs: duration, signal: controller.signal })),
  );
  if (!parsed.success) throw new AppError("PROVIDER_UNAVAILABLE");
  return parsed.data;
  };
  try { return await Promise.race([consume(), stopped]); }
  catch (error) {
    if (error instanceof AppError && ["ACCOUNT_INACTIVE", "REQUEST_ABORTED"].includes(error.code)) throw error;
    throw new AppError("PROVIDER_UNAVAILABLE", { cause: error });
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort(); }
}
