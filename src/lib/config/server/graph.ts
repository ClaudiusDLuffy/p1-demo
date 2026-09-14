import process from "node:process";
import { ConfigurationError, optionalGroup, readValue, requiredValue, requireConfigured, type EnvironmentValues } from "../shared";
import { assertProviderEnvironment, getPortalOrigin } from "./appEnvironment";

export type GraphConfig = { tenantId: string; clientId: string; clientSecret: string; userEmail: string; folderName: string };
const names = ["OUTLOOK_TENANT_ID", "OUTLOOK_CLIENT_ID", "OUTLOOK_CLIENT_SECRET", "OUTLOOK_USER_EMAIL", "OUTLOOK_FOLDER_NAME"] as const;
export function getGraphConfig(values: EnvironmentValues = process.env) {
  return optionalGroup("graph", names, values, (): GraphConfig => {
    const tenantId = requiredValue(values, names[0], "graph", 255);
    const clientId = requiredValue(values, names[1], "graph", 255);
    const clientSecret = requiredValue(values, names[2], "graph");
    const userEmail = requiredValue(values, names[3], "graph", 320);
    const folderName = readValue(values, names[4]) || "7-Eleven Dispatch";
    if (!/^[A-Za-z0-9.-]+$/.test(tenantId) || !/^[A-Za-z0-9._-]+$/.test(clientId)
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail) || folderName.length > 255 || /[\r\n\u0000]/.test(folderName)) {
      throw new ConfigurationError("CONFIG_INVALID", "graph", names.filter(name => name !== "OUTLOOK_CLIENT_SECRET"));
    }
    assertProviderEnvironment("graph", values);
    return { tenantId, clientId, clientSecret, userEmail, folderName };
  });
}
export const requireGraphConfig = (values?: EnvironmentValues): GraphConfig => requireConfigured(getGraphConfig(values));

export function graphDeliveryConfigurationError(values: EnvironmentValues = process.env, options: { includeOwnerRecipients?: boolean } = {}): ConfigurationError | null {
  const configuration = getGraphConfig(values);
  if (configuration.status !== "configured") return configuration.error;
  try { getPortalOrigin(values); if (options.includeOwnerRecipients) getNotificationOwnerEmails(values); return null; }
  catch (error) { return error instanceof ConfigurationError ? error : new ConfigurationError("CONFIG_INVALID", "app_environment"); }
}

/** Existing owner fallback policy stays in its owner; configuration contains no default recipient. */
export function getNotificationOwnerEmails(values: EnvironmentValues = process.env): string {
  const raw = readValue(values, "NOTIFY_OWNER_EMAILS");
  const addresses = raw.split(",").map(value => value.trim()).filter(Boolean);
  if (raw.length > 8192 || addresses.some(value => value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) {
    throw new ConfigurationError("CONFIG_INVALID", "graph", ["NOTIFY_OWNER_EMAILS"]);
  }
  return raw;
}

/** Legacy claimed rows are already quarantined for automatic sending. This
 * preflight never replaces the authoritative claim's role/scope/replay checks. */
export function requireLegacyGraphDeliveryConfiguration(state: string | null | undefined, values: EnvironmentValues = process.env): void {
  if (["sent", "unknown", "claimed", "not_deliverable"].includes(state ?? "")) return;
  requireGraphConfig(values);
  getPortalOrigin(values);
}
