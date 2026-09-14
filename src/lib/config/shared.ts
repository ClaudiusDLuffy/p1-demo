export type EnvironmentValues = Readonly<Record<string, string | undefined>>;
export type ConfigurationCode = "FEATURE_DISABLED" | "CONFIG_INCOMPLETE" | "CONFIG_INVALID" | "ENVIRONMENT_MISMATCH";
export type ConfigurationFeature = "supabase_public" | "supabase_service" | "graph" | "twilio" | "email_intake" | "cron" | "app_environment" | "quickbooks";
const messages: Record<ConfigurationCode, string> = {
  FEATURE_DISABLED: "This optional service is not configured.",
  CONFIG_INCOMPLETE: "Required service configuration is incomplete.",
  CONFIG_INVALID: "Service configuration is invalid.",
  ENVIRONMENT_MISMATCH: "Service configuration does not match this application environment.",
};
/** Deliberately contains variable NAMES, never values, credentials or causes. */
export class ConfigurationError extends Error {
  readonly code: ConfigurationCode;
  readonly feature: ConfigurationFeature;
  readonly variableNames: readonly string[];
  constructor(code: ConfigurationCode, feature: ConfigurationFeature, variableNames: readonly string[] = []) {
    super(messages[code]); this.name = "ConfigurationError"; this.code = code; this.feature = feature;
    this.variableNames = Object.freeze([...new Set(variableNames)].filter(name => /^[A-Z][A-Z0-9_]{0,99}$/.test(name)).slice(0, 32));
  }
}
export type ConfigurationResult<T> = { status: "configured"; value: T }
  | { status: "disabled" | "incomplete" | "invalid"; error: ConfigurationError };
export const readValue = (values: EnvironmentValues, name: string): string => (values[name] ?? "").trim();
export function requiredValue(values: EnvironmentValues, name: string, feature: ConfigurationFeature, max = 4096): string {
  const value = readValue(values, name);
  if (!value) throw new ConfigurationError("CONFIG_INCOMPLETE", feature, [name]);
  if (value.length > max || /[\r\n\u0000]/.test(value)) throw new ConfigurationError("CONFIG_INVALID", feature, [name]);
  return value;
}
export function optionalGroup<T>(feature: ConfigurationFeature, names: readonly string[], values: EnvironmentValues, parse: () => T): ConfigurationResult<T> {
  if (!names.some(name => readValue(values, name))) return { status: "disabled", error: new ConfigurationError("FEATURE_DISABLED", feature) };
  try { return { status: "configured", value: parse() }; }
  catch (error) {
    const safe = error instanceof ConfigurationError ? error : new ConfigurationError("CONFIG_INVALID", feature);
    return { status: safe.code === "FEATURE_DISABLED" ? "disabled" : safe.code === "CONFIG_INCOMPLETE" ? "incomplete" : "invalid", error: safe };
  }
}
export function requireConfigured<T>(result: ConfigurationResult<T>): T {
  if (result.status !== "configured") throw result.error;
  return result.value;
}
export function absoluteOrigin(raw: string, feature: ConfigurationFeature, name: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ConfigurationError("CONFIG_INVALID", feature, [name]); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) throw new ConfigurationError("CONFIG_INVALID", feature, [name]);
  return url.origin;
}
export function strictBoolean(values: EnvironmentValues, name: string, feature: ConfigurationFeature, fallback = false): boolean {
  const raw = readValue(values, name);
  if (!raw) return fallback;
  if (raw !== "true" && raw !== "false") throw new ConfigurationError("CONFIG_INVALID", feature, [name]);
  return raw === "true";
}
