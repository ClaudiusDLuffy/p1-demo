import process from "node:process";
import { absoluteOrigin, ConfigurationError, readValue, strictBoolean, type EnvironmentValues } from "../shared";

export function getAppEnvironment(values: EnvironmentValues = process.env): { environment: "development" | "test" | "preview" | "production"; allowPreviewJobs: boolean } {
  const hosted = readValue(values, "VERCEL_ENV"); const node = readValue(values, "NODE_ENV");
  if ((hosted && !["development", "preview", "production"].includes(hosted)) || (node && !["development", "test", "production"].includes(node))) {
    throw new ConfigurationError("CONFIG_INVALID", "app_environment", ["VERCEL_ENV", "NODE_ENV"]);
  }
  const server = readValue(values, "P1_APP_ENV"); const browser = readValue(values, "NEXT_PUBLIC_P1_APP_ENV");
  const local = !hosted && ["development", "test"].includes(node);
  if ((!server || !browser) && !(local && !server && !browser)) {
    throw new ConfigurationError("CONFIG_INCOMPLETE", "app_environment", ["P1_APP_ENV", "NEXT_PUBLIC_P1_APP_ENV"]);
  }
  if ([server, browser].some(value => value && !["development", "preview", "production"].includes(value))) {
    throw new ConfigurationError("CONFIG_INVALID", "app_environment", ["P1_APP_ENV", "NEXT_PUBLIC_P1_APP_ENV"]);
  }
  if (server !== browser || (hosted && server !== hosted) || (!hosted && node === "production" && server !== "production")) {
    throw new ConfigurationError("ENVIRONMENT_MISMATCH", "app_environment", ["P1_APP_ENV", "NEXT_PUBLIC_P1_APP_ENV", "VERCEL_ENV", "NODE_ENV"]);
  }
  const environment = server === "production" || server === "preview" ? server : node === "test" ? "test" : "development";
  return { environment, allowPreviewJobs: strictBoolean(values, "P1_ALLOW_PREVIEW_JOBS", "app_environment") };
}

export function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::" || host === "::1" || /^(fc|fd|fe8|fe9|fea|feb)/.test(host) && host.includes(":")) return true;
  if (host.includes(":")) return true; // Literal IPv6 is not an approved hosted origin.
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  const [a, b] = host.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 198 && (b === 18 || b === 19) || a >= 224;
}
export function assertScheduledJobsAllowed(values: EnvironmentValues = process.env): void {
  const config = getAppEnvironment(values);
  if (config.environment === "preview" && !config.allowPreviewJobs) {
    throw new ConfigurationError("FEATURE_DISABLED", "cron", ["P1_ALLOW_PREVIEW_JOBS"]);
  }
}
/** Owner declarations enforce environment separation, not actual account identity. */
export function assertProviderEnvironment(provider: "graph" | "twilio", values: EnvironmentValues): void {
  const environment = getAppEnvironment(values).environment;
  const name = provider === "graph" ? "P1_GRAPH_ENV" : "P1_TWILIO_ENV";
  const declared = readValue(values, name);
  if (["production", "preview"].includes(environment) && !declared) {
    throw new ConfigurationError("CONFIG_INCOMPLETE", provider, [name]);
  }
  if (declared && !["development", "preview", "production"].includes(declared)) {
    throw new ConfigurationError("CONFIG_INVALID", provider, [name]);
  }
  const expected = environment === "test" ? "development" : environment;
  if (declared && declared !== expected) {
    throw new ConfigurationError("ENVIRONMENT_MISMATCH", provider, [name, "P1_APP_ENV"]);
  }
  const previewAllowed = strictBoolean(values, "P1_ALLOW_PREVIEW_PROVIDER_ACTIONS", provider);
  if (environment === "preview" && !previewAllowed) {
    throw new ConfigurationError("FEATURE_DISABLED", provider, ["P1_ALLOW_PREVIEW_PROVIDER_ACTIONS"]);
  }
}
/** One explicit origin for links and callbacks. No implicit production fallback. */
export function getPortalOrigin(values: EnvironmentValues = process.env): string {
  const publicValue = readValue(values, "NEXT_PUBLIC_APP_URL"); const serverValue = readValue(values, "PORTAL_URL");
  if (!publicValue && !serverValue) throw new ConfigurationError("CONFIG_INCOMPLETE", "app_environment", ["NEXT_PUBLIC_APP_URL", "PORTAL_URL"]);
  const publicOrigin = publicValue ? absoluteOrigin(publicValue, "app_environment", "NEXT_PUBLIC_APP_URL") : null;
  const serverOrigin = serverValue ? absoluteOrigin(serverValue, "app_environment", "PORTAL_URL") : null;
  if (publicOrigin && serverOrigin && publicOrigin !== serverOrigin) throw new ConfigurationError("ENVIRONMENT_MISMATCH", "app_environment", ["NEXT_PUBLIC_APP_URL", "PORTAL_URL"]);
  const origin = publicOrigin ?? serverOrigin;
  if (!origin) throw new ConfigurationError("CONFIG_INCOMPLETE", "app_environment");
  const environment = getAppEnvironment(values).environment;
  if (["production", "preview"].includes(environment) && (new URL(origin).protocol !== "https:" || isLocalOrPrivateHost(new URL(origin).hostname))) {
    throw new ConfigurationError("ENVIRONMENT_MISMATCH", "app_environment", ["NEXT_PUBLIC_APP_URL", "PORTAL_URL"]);
  }
  const productionHost = readValue(values, "VERCEL_PROJECT_PRODUCTION_URL").toLowerCase();
  if (environment === "preview" && productionHost && new URL(origin).hostname === productionHost) {
    throw new ConfigurationError("ENVIRONMENT_MISMATCH", "app_environment", ["NEXT_PUBLIC_APP_URL", "VERCEL_PROJECT_PRODUCTION_URL"]);
  }
  return origin;
}
