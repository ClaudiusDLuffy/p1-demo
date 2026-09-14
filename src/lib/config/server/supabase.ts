import process from "node:process";
import { resolvePublicSupabaseConfig } from "../public";
import { absoluteOrigin, ConfigurationError, readValue, requiredValue, type EnvironmentValues } from "../shared";
import { getAppEnvironment, isLocalOrPrivateHost } from "./appEnvironment";

function validateProject(url: string, values: EnvironmentValues): void {
  const expected = readValue(values, "P1_EXPECTED_SUPABASE_PROJECT_REF");
  const environment = getAppEnvironment(values).environment;
  if (["production", "preview"].includes(environment) && !expected) {
    throw new ConfigurationError("CONFIG_INCOMPLETE", "supabase_service", ["P1_EXPECTED_SUPABASE_PROJECT_REF"]);
  }
  if (expected && (!/^[a-z0-9]{1,64}$/.test(expected) || new URL(url).hostname !== `${expected}.supabase.co`)) {
    throw new ConfigurationError("ENVIRONMENT_MISMATCH", "supabase_service", ["NEXT_PUBLIC_SUPABASE_URL", "P1_EXPECTED_SUPABASE_PROJECT_REF"]);
  }
  const production = readValue(values, "P1_PRODUCTION_SUPABASE_PROJECT_REF");
  if (environment === "preview" && !production) {
    throw new ConfigurationError("CONFIG_INCOMPLETE", "supabase_service", ["P1_PRODUCTION_SUPABASE_PROJECT_REF"]);
  }
  if (production && !/^[a-z0-9]{1,64}$/.test(production)) {
    throw new ConfigurationError("CONFIG_INVALID", "supabase_service", ["P1_PRODUCTION_SUPABASE_PROJECT_REF"]);
  }
  if (production && ((environment === "preview" && expected === production) || (environment === "production" && expected !== production))) {
    throw new ConfigurationError("ENVIRONMENT_MISMATCH", "supabase_service", ["P1_EXPECTED_SUPABASE_PROJECT_REF", "P1_PRODUCTION_SUPABASE_PROJECT_REF"]);
  }
  if (["production", "preview"].includes(environment) && (new URL(url).protocol !== "https:" || isLocalOrPrivateHost(new URL(url).hostname))) {
    throw new ConfigurationError("ENVIRONMENT_MISMATCH", "supabase_service", ["NEXT_PUBLIC_SUPABASE_URL"]);
  }
}
export function getServerPublicSupabaseConfig(values: EnvironmentValues = process.env) {
  const config = resolvePublicSupabaseConfig(values); validateProject(config.url, values); return config;
}
export function getServerSupabaseConfig(values: EnvironmentValues = process.env): { url: string; secret: string } {
  const url = absoluteOrigin(requiredValue(values, "NEXT_PUBLIC_SUPABASE_URL", "supabase_service"), "supabase_service", "NEXT_PUBLIC_SUPABASE_URL");
  const secret = requiredValue(values, "SUPABASE_SECRET_KEY", "supabase_service");
  validateProject(url, values);
  let publicKey = secret.startsWith("sb_publishable_");
  if (secret.split(".").length === 3) {
    try {
      const payload: unknown = JSON.parse(Buffer.from(secret.split(".")[1], "base64url").toString("utf8"));
      publicKey ||= !!payload && typeof payload === "object" && "role" in payload && payload.role !== "service_role";
    } catch { throw new ConfigurationError("CONFIG_INVALID", "supabase_service", ["SUPABASE_SECRET_KEY"]); }
  }
  if (publicKey) throw new ConfigurationError("CONFIG_INVALID", "supabase_service", ["SUPABASE_SECRET_KEY"]);
  return { url, secret };
}
