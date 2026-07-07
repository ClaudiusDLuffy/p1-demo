// Browser-side Supabase client. Uses the publishable (anon) key — safe to expose.
// Uses plain createClient (not @supabase/ssr) so auth state persists in localStorage,
// which works correctly in a client-only Next.js setup.

import { createClient as createSb } from "@supabase/supabase-js";
import type { Database } from "./database.types";

const REMEMBER_ME_KEY = "p1_remember_me";
const REMEMBERED_EMAIL_KEY = "p1_remembered_email";

const browserStorage = {
  getItem(key: string) {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key);
  },
  setItem(key: string, value: string) {
    if (typeof window === "undefined") return;
    const remember = window.localStorage.getItem(REMEMBER_ME_KEY) !== "false";
    const primary = remember ? window.localStorage : window.sessionStorage;
    const secondary = remember ? window.sessionStorage : window.localStorage;
    secondary.removeItem(key);
    primary.setItem(key, value);
  },
  removeItem(key: string) {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(key);
    window.sessionStorage.removeItem(key);
  },
};

export function setRememberMePreference(remember: boolean, email?: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(REMEMBER_ME_KEY, remember ? "true" : "false");
  if (remember && email) {
    window.localStorage.setItem(REMEMBERED_EMAIL_KEY, email);
  } else if (!remember) {
    window.localStorage.removeItem(REMEMBERED_EMAIL_KEY);
  }
}

export function getRememberMePreference() {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(REMEMBER_ME_KEY) !== "false";
}

export function getRememberedEmail() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(REMEMBERED_EMAIL_KEY) || "";
}

export function createClient() {
  return createSb<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: browserStorage,
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
