import Constants from "expo-constants";
import { parseMobileEnvironment, type MobileEnvironment } from "@p1/mobile-contracts";

let cached: MobileEnvironment | undefined;
export function getMobileEnvironment(): MobileEnvironment {
  if (cached) return cached;
  const extra = Constants.expoConfig?.extra ?? {};
  cached = parseMobileEnvironment({
    EXPO_PUBLIC_P1_APP_ENV: extra.p1AppEnv,
    EXPO_PUBLIC_SUPABASE_URL: extra.supabaseUrl,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: extra.supabasePublishableKey,
    EXPO_PUBLIC_API_BASE_URL: extra.apiBaseUrl,
    EXPO_PUBLIC_RELEASE_SHA: extra.releaseSha,
  });
  return cached;
}
export function resetEnvironmentForTests(): void { cached = undefined; }
