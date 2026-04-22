// Browser-side Supabase client. Uses the publishable (anon) key — safe to expose.
// Uses plain createClient (not @supabase/ssr) so auth state persists in localStorage,
// which works correctly in a client-only Next.js setup.

import { createClient as createSb } from "@supabase/supabase-js";

export function createClient() {
  return createSb(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    }
  );
}

// Module-level singleton so React renders don't churn through new clients.
let _supabase: ReturnType<typeof createClient> | null = null;
export function supabase() {
  if (typeof window === "undefined") {
    throw new Error("supabase() called on the server — use createServerClient() instead");
  }
  if (!_supabase) _supabase = createClient();
  return _supabase;
}
