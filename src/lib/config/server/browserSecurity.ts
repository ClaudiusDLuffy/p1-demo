import process from "node:process";
import { ConfigurationError, requiredValue, strictBoolean, type EnvironmentValues } from "../shared";
import { getAppEnvironment } from "./appEnvironment";
import { getServerPublicSupabaseConfig } from "./supabase";

export type CspReportOnlyHeader = {
  key: "Content-Security-Policy-Report-Only";
  value: string;
};

/** Preparation only: never replaces the enforced policy and never collects
 * violation payloads (URLs and script samples may contain private data). */
export function getCspReportOnlyHeaders(values: EnvironmentValues = process.env): CspReportOnlyHeader[] {
  if (!strictBoolean(values, "P1_ENABLE_CSP_REPORT_ONLY", "app_environment")) return [];
  const { environment } = getAppEnvironment(values);
  if (environment !== "development" && environment !== "preview") {
    throw new ConfigurationError("ENVIRONMENT_MISMATCH", "app_environment", [
      "P1_ENABLE_CSP_REPORT_ONLY", "P1_APP_ENV", "NEXT_PUBLIC_P1_APP_ENV", "VERCEL_ENV", "NODE_ENV",
    ]);
  }

  // WHATWG URL parsing can discard internal ASCII whitespace. Reject it
  // before using the existing public/project/environment validation boundary.
  const rawOrigin = requiredValue(values, "NEXT_PUBLIC_SUPABASE_URL", "supabase_public");
  if (/[\u0000-\u0020\u007f]/.test(rawOrigin)) {
    throw new ConfigurationError("CONFIG_INVALID", "supabase_public", ["NEXT_PUBLIC_SUPABASE_URL"]);
  }
  const { url } = getServerPublicSupabaseConfig(values);
  const origin = new URL(url);
  if (!/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])$/i.test(origin.hostname)) {
    throw new ConfigurationError("CONFIG_INVALID", "supabase_public", ["NEXT_PUBLIC_SUPABASE_URL"]);
  }
  const websocket = new URL(url);
  websocket.protocol = origin.protocol === "https:" ? "wss:" : "ws:";

  // Inline/bootstrap/style and development eval violations are deliberately
  // visible in this strict candidate. They are not newly enforced failures.
  // No report-uri/report-to/report-sample: no raw browser report is transmitted.
  return [{
    key: "Content-Security-Policy-Report-Only",
    value: [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      `img-src 'self' data: blob: ${origin.origin}`,
      "font-src 'self' data:",
      `connect-src 'self' ${origin.origin} ${websocket.origin}`,
      "worker-src 'self' blob:",
      "frame-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "manifest-src 'self'",
    ].join("; "),
  }];
}
