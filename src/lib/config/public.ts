import { absoluteOrigin, ConfigurationError, readValue, requiredValue, type EnvironmentValues } from "./shared";

export function resolvePublicAppEnvironment(values: EnvironmentValues): "development" | "test" | "preview" | "production" {
  const value = readValue(values, "NEXT_PUBLIC_P1_APP_ENV");
  if (!value && ["development", "test"].includes(readValue(values, "NODE_ENV"))) return readValue(values, "NODE_ENV") === "test" ? "test" : "development";
  if (!value) throw new ConfigurationError("CONFIG_INCOMPLETE", "app_environment", ["NEXT_PUBLIC_P1_APP_ENV"]);
  if (value !== "development" && value !== "preview" && value !== "production") throw new ConfigurationError("CONFIG_INVALID", "app_environment", ["NEXT_PUBLIC_P1_APP_ENV"]);
  return value;
}

export type PublicSupabaseConfig = { url: string; publishableKey: string };
export function resolvePublicSupabaseConfig(values: EnvironmentValues): PublicSupabaseConfig {
  resolvePublicAppEnvironment(values);
  const url = absoluteOrigin(requiredValue(values, "NEXT_PUBLIC_SUPABASE_URL", "supabase_public"), "supabase_public", "NEXT_PUBLIC_SUPABASE_URL");
  const publishableKey = requiredValue(values, "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "supabase_public");
  // Role decoding is only a placement check, never JWT authentication.
  let privileged = publishableKey.startsWith("sb_secret_");
  if (publishableKey.split(".").length === 3) {
    try {
      const payload: unknown = JSON.parse(atob(publishableKey.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      privileged ||= !!payload && typeof payload === "object" && "role" in payload && payload.role === "service_role";
    } catch { throw new ConfigurationError("CONFIG_INVALID", "supabase_public", ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]); }
  }
  if (privileged) throw new ConfigurationError("CONFIG_INVALID", "supabase_public", ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]);
  return { url, publishableKey };
}
/** Next only inlines these explicit public reads. Never pass process.env here. */
export function getPublicSupabaseConfig(): PublicSupabaseConfig {
  return resolvePublicSupabaseConfig({ NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_P1_APP_ENV: process.env.NEXT_PUBLIC_P1_APP_ENV, NODE_ENV: process.env.NODE_ENV });
}
