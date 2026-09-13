// Server-side Supabase client. Uses the SECRET key — never expose to the client.
// Bypasses RLS, so use sparingly and only for trusted server-side operations.

import { createClient as createSb } from "@supabase/supabase-js";
import type { PrivateObjectServerDatabase } from "../privateObjectContracts";
import { getServerSupabaseConfig } from "../config/server/supabase";
import { correlatedFetch, withRequestCorrelation } from "../server/requestOperation";

export function createServerClient(options: { fetch?: typeof fetch } = {}) {
  const config = getServerSupabaseConfig();
  return createSb<PrivateObjectServerDatabase>(
    config.url,
    config.secret,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: options.fetch ? withRequestCorrelation(options.fetch) : correlatedFetch },
    }
  );
}
