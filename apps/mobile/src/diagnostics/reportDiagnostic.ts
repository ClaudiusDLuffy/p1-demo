import type { SupabaseClient } from "@supabase/supabase-js";
import { createApiClient } from "../data/apiClient";
import { getMobileEnvironment } from "../data/environment";
const allowedSources = /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/;
export async function reportDiagnostic(client: SupabaseClient, input: {
  source: string; code: "unknown" | "network" | "timeout" | "invalid_response";
  page?: number; itemCount?: number; hasMore?: boolean;
}): Promise<void> {
  try {
    const session = await client.auth.getSession();
    if (!session.data.session) return;
    const api = createApiClient(getMobileEnvironment().EXPO_PUBLIC_API_BASE_URL,
      async () => (await client.auth.getSession()).data.session?.access_token ?? null);
    await api.post("/api/client-errors", {
      version: 1, source: allowedSources.test(input.source) ? input.source : "mobile_failure",
      code: input.code, message: "The request could not be completed.", level: "error",
      route: "/", portalView: "mobile", details: {
        ...(input.page ? { page: input.page } : {}),
        ...(input.itemCount !== undefined ? { itemCount: input.itemCount } : {}),
        ...(input.hasMore !== undefined ? { hasMore: input.hasMore } : {}),
      },
    });
  } catch { /* Diagnostics never affect the primary operation. */ }
}
