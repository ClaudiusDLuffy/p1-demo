// Browser-side Supabase client. Uses the publishable (anon) key — safe to expose.
// Uses plain createClient (not @supabase/ssr) so auth state persists in localStorage,
// which works correctly in a client-only Next.js setup.

import { createClient as createSb } from "@supabase/supabase-js";
import type { PrivateObjectDatabase } from "../privateObjectContracts";
import { getPublicSupabaseConfig } from "../config/public";
import { createBrowserAuthStorage } from "./browserAuthStorage";

const REMEMBER_ME_KEY = "p1_remember_me";
const REMEMBERED_EMAIL_KEY = "p1_remembered_email";

let browserStorage: ReturnType<typeof createBrowserAuthStorage> | null = null;
function authStorage() {
  if (!browserStorage) {
    const project = new URL(getPublicSupabaseConfig().url).hostname.split(".")[0];
    browserStorage = createBrowserAuthStorage({
      key: `sb-${project}-auth-token`,
      stores: () => typeof window === "undefined" ? [] : [window.localStorage, window.sessionStorage],
      remember: getRememberMePreference,
    });
  }
  return browserStorage;
}

export const beginBrowserSignOut = () => authStorage().beginSignOut();
export const beginBrowserSignIn = () => authStorage().beginSignIn();

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
  const config = getPublicSupabaseConfig();
  return createSb<PrivateObjectDatabase>(
    config.url,
    config.publishableKey,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: authStorage(),
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
