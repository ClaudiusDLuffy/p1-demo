// Server-side Supabase client. Uses the SECRET key — never expose to the client.
// Bypasses RLS, so use sparingly and only for trusted server-side operations.

import { createClient as createSb } from "@supabase/supabase-js";

export function createServerClient() {
  return createSb(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
    }
  );
}
