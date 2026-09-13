import process from "node:process";
import { resolveQuickBooksConfig, resolveQuickBooksEnvironment, resolveQuickBooksTokenKeyMaterial, type QuickBooksEnvironment } from "../../server/quickBooksOnlineCore";
import { ConfigurationError, optionalGroup, readValue, type EnvironmentValues } from "../shared";
import { getPortalOrigin } from "./appEnvironment";

export function getQuickBooksEnvironment(values: EnvironmentValues = process.env): QuickBooksEnvironment {
  try { return resolveQuickBooksEnvironment(values.QUICKBOOKS_ENVIRONMENT); }
  catch { throw new ConfigurationError("CONFIG_INVALID", "quickbooks", ["QUICKBOOKS_ENVIRONMENT"]); }
}
export function getQuickBooksTokenKeyMaterial(version: number, values: EnvironmentValues = process.env) {
  try { return resolveQuickBooksTokenKeyMaterial(values, version); }
  catch { throw new ConfigurationError("CONFIG_INVALID", "quickbooks", ["QUICKBOOKS_TOKEN_ENCRYPTION_KEY", "QUICKBOOKS_TOKEN_KEY_VERSION"]); }
}

export function getQuickBooksConfiguration(values: EnvironmentValues = process.env, requestedEnvironment?: QuickBooksEnvironment) {
  let environment: QuickBooksEnvironment;
  try { environment = requestedEnvironment ?? getQuickBooksEnvironment(values); }
  catch { return { status: "invalid" as const, error: new ConfigurationError("CONFIG_INVALID", "quickbooks", ["QUICKBOOKS_ENVIRONMENT"]) }; }
  const prefix = environment === "sandbox" ? "QUICKBOOKS_SANDBOX" : "QUICKBOOKS_PRODUCTION";
  const names = [`${prefix}_CLIENT_ID`, `${prefix}_CLIENT_SECRET`, `${prefix}_REDIRECT_URI`, "QUICKBOOKS_TOKEN_ENCRYPTION_KEY", "QUICKBOOKS_TOKEN_KEY_VERSION"];
  return optionalGroup("quickbooks", names, values, () => {
    const missing = names.slice(0, 4).filter(name => !readValue(values, name));
    if (missing.length) throw new ConfigurationError("CONFIG_INCOMPLETE", "quickbooks", missing);
    let config;
    try { config = resolveQuickBooksConfig(values, environment); }
    catch { throw new ConfigurationError("CONFIG_INVALID", "quickbooks", names); }
    const callback = new URL(config.redirectUri);
    if (callback.username || callback.password || callback.pathname !== "/api/quickbooks/callback" || callback.search || callback.hash) {
      throw new ConfigurationError("CONFIG_INVALID", "quickbooks", [`${prefix}_REDIRECT_URI`]);
    }
    if (callback.origin !== getPortalOrigin(values)) throw new ConfigurationError("ENVIRONMENT_MISMATCH", "quickbooks", [`${prefix}_REDIRECT_URI`, "NEXT_PUBLIC_APP_URL", "PORTAL_URL"]);
    return config;
  });
}
