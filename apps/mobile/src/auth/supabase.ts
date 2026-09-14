import "react-native-url-polyfill/auto";
import { AppState, type AppStateStatus } from "react-native";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getMobileEnvironment } from "../data/environment";
import { createChunkedSecureStorage } from "../storage/secureSessionStorage";

let client: SupabaseClient | undefined;
export function getNativeSupabase(): SupabaseClient {
  if (client) return client;
  const environment = getMobileEnvironment();
  client = createClient(environment.EXPO_PUBLIC_SUPABASE_URL, environment.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      storage: createChunkedSecureStorage(),
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
    global: { headers: { "X-Client-Info": "p1-pros-mobile/0.1.0" } },
  });
  return client;
}
export type RefreshAuth = { startAutoRefresh(): void; stopAutoRefresh(): void };
export type AppStatePort = {
  currentState: AppStateStatus;
  addEventListener(type: "change", listener: (state: AppStateStatus) => void): { remove(): void };
};
export function bindAuthRefresh(auth: RefreshAuth, appState: AppStatePort = AppState): () => void {
  const apply = (state: AppStateStatus) => state === "active" ? auth.startAutoRefresh() : auth.stopAutoRefresh();
  apply(appState.currentState);
  const subscription = appState.addEventListener("change", apply);
  return () => { subscription.remove(); auth.stopAutoRefresh(); };
}
