import { defineConfig, devices } from "@playwright/test";
import { localSupabaseRuntime } from "./scripts/e2e/local-supabase-runtime.mjs";

const runtime = localSupabaseRuntime();
const baseURL = runtime.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3000";

// Prevent a developer's ordinary .env.local provider settings from becoming
// active inside the synthetic browser server. These explicit empty values win
// over dotenv loading and keep every provider/scheduler boundary disabled.
const disabledExternalProviders = {
  VERCEL_ENV: "",
  P1_EXPECTED_SUPABASE_PROJECT_REF: "",
  P1_PRODUCTION_SUPABASE_PROJECT_REF: "",
  P1_ALLOW_PREVIEW_PROVIDER_ACTIONS: "false",
  P1_ALLOW_PREVIEW_JOBS: "false",
  CRON_SECRET: "",
  EMAIL_INTAKE_ENABLED: "false",
  OUTLOOK_TENANT_ID: "",
  OUTLOOK_CLIENT_ID: "",
  OUTLOOK_CLIENT_SECRET: "",
  OUTLOOK_USER_EMAIL: "",
  TWILIO_ACCOUNT_SID: "",
  TWILIO_API_KEY_SID: "",
  TWILIO_API_KEY_SECRET: "",
  TWILIO_AUTH_TOKEN: "",
  TWILIO_MESSAGING_SERVICE_SID: "",
  TWILIO_FROM_NUMBER: "",
  QUICKBOOKS_SANDBOX_CLIENT_ID: "",
  QUICKBOOKS_SANDBOX_CLIENT_SECRET: "",
  QUICKBOOKS_PRODUCTION_CLIENT_ID: "",
  QUICKBOOKS_PRODUCTION_CLIENT_SECRET: "",
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "",
  P1_E2E_ALLOW_LOCAL_CSP: "true",
};

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results/e2e-artifacts",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [
    ["line"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL,
    // The production CSP still permits hosted Supabase origins only. The local
    // server adds its exact loopback Supabase origin under a development-only
    // flag because WebKit does not consistently honor CSP bypass for fetches.
    bypassCSP: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  webServer: {
    command: "node_modules/.bin/next dev --hostname 127.0.0.1 --port 3000",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      ...runtime,
      ...disabledExternalProviders,
      NODE_ENV: "development",
      PORTAL_URL: baseURL,
      NEXT_PUBLIC_APP_URL: baseURL,
      P1_APP_ENV: "development",
      NEXT_PUBLIC_P1_APP_ENV: "development",
    },
  },
  projects: [
    {
      name: "desktop-chrome",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
    {
      name: "desktop-webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
});
