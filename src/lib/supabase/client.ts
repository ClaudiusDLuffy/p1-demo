// Browser-side Supabase client. Uses the publishable (anon) key — safe to expose.
// Auth state is persisted to localStorage so users stay signed in across reloads.

import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
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
