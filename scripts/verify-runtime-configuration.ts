// Explicit read-only local preflight. Does not load .env, call providers or DB,
// modify configuration, expose values, or run automatically on server import.
import { CONFIGURATION_ENVIRONMENT_NAMES } from "../src/lib/config/inventory";
import { readFileSync, statSync } from "node:fs";
import type { EnvironmentValues } from "../src/lib/config/shared";
import { evaluateRuntimePreflight, parsePreflightArguments, scheduledOwners } from "./runtime-configuration-preflight";

const synthetic: EnvironmentValues = { NODE_ENV: "test", NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic", SUPABASE_SECRET_KEY: "sb_secret_synthetic",
  NEXT_PUBLIC_APP_URL: "https://portal.example.invalid", CRON_SECRET: "synthetic-cron", OUTLOOK_TENANT_ID: "synthetic-tenant",
  OUTLOOK_CLIENT_ID: "synthetic-client", OUTLOOK_CLIENT_SECRET: "synthetic-secret", OUTLOOK_USER_EMAIL: "synthetic@example.invalid",
  TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`, TWILIO_AUTH_TOKEN: "synthetic-token", TWILIO_FROM_NUMBER: "+12025550123",
  EMAIL_INTAKE_ENABLED: "true", EMAIL_INTAKE_START_AT: "2026-09-10T00:00:00Z",
  QUICKBOOKS_SANDBOX_CLIENT_ID: "synthetic-client", QUICKBOOKS_SANDBOX_CLIENT_SECRET: "synthetic-secret",
  QUICKBOOKS_SANDBOX_REDIRECT_URI: "https://portal.example.invalid/api/quickbooks/callback", QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "11".repeat(32) };
function boundedSource(path: string, maximum: number): string | undefined {
  try { return statSync(path).size <= maximum ? readFileSync(path, "utf8") : undefined; } catch { return undefined; }
}
try {
  const options = parsePreflightArguments(process.argv.slice(2));
  if (options.namesOnly) console.info(JSON.stringify({ variableNames: CONFIGURATION_ENVIRONMENT_NAMES }));
  else {
    let manifest: unknown = null;
    try { manifest = JSON.parse(boundedSource("vercel.json", 16_384) ?? "null"); } catch { /* Safe invalid-manifest check below. */ }
    // Only repository-owned fixed paths are read. Manifest input cannot select
    // another file, credentials, a URL, or arbitrary route source.
    const sources = Object.fromEntries(scheduledOwners.map(owner => [owner.path, boundedSource(`src/app${owner.path}/route.ts`, 128 * 1024)]));
    const result = evaluateRuntimePreflight(options.synthetic ? synthetic : process.env, manifest, sources, options);
    console.info(JSON.stringify(result)); process.exitCode = result.exitCode;
  }
} catch {
  console.info(JSON.stringify({ mode: "invalid_arguments", checks: [{ feature: "arguments", status: "invalid", code: "CONFIG_INVALID" }], promotionReady: false }));
  process.exitCode = 2;
}
