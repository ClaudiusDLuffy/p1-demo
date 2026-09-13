import assert from "node:assert/strict";
import test from "node:test";
import { ConfigurationError, requireConfigured, type EnvironmentValues } from "./config/shared";
import { resolvePublicSupabaseConfig } from "./config/public";
import { getServerSupabaseConfig, getServerPublicSupabaseConfig } from "./config/server/supabase";
import { getGraphConfig, requireLegacyGraphDeliveryConfiguration } from "./config/server/graph";
import { getTwilioConfig } from "./config/server/twilio";
import { getEmailIntakeConfig } from "./config/server/emailIntake";
import { getCronConfig } from "./config/server/cron";
import { assertScheduledJobsAllowed, getAppEnvironment, getPortalOrigin } from "./config/server/appEnvironment";
import { getQuickBooksConfiguration } from "./config/server/quickbooks";

const publicValues = { NODE_ENV: "test", NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic" };
const graph = { NODE_ENV: "test", OUTLOOK_TENANT_ID: "synthetic-tenant", OUTLOOK_CLIENT_ID: "synthetic-client", OUTLOOK_CLIENT_SECRET: "synthetic-secret", OUTLOOK_USER_EMAIL: "synthetic@example.invalid" };
const twilio = { NODE_ENV: "test", TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`, TWILIO_AUTH_TOKEN: "synthetic-token", TWILIO_FROM_NUMBER: "+12025550123" };
const qb = { NODE_ENV: "test", QUICKBOOKS_SANDBOX_CLIENT_ID: "synthetic-client", QUICKBOOKS_SANDBOX_CLIENT_SECRET: "synthetic-secret",
  QUICKBOOKS_SANDBOX_REDIRECT_URI: "https://portal.example.invalid/api/quickbooks/callback", QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "11".repeat(32), NEXT_PUBLIC_APP_URL: "https://portal.example.invalid" };
const code = (expected: string) => (error: unknown) => error instanceof ConfigurationError && error.code === expected;
function jwt(role: string) { return `header.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.signature`; }

test("public Supabase configuration is explicit, normalized and rejects misplaced privileged keys", () => {
  assert.deepEqual(resolvePublicSupabaseConfig({ ...publicValues, NEXT_PUBLIC_SUPABASE_URL: `${publicValues.NEXT_PUBLIC_SUPABASE_URL}/` }), {
    url: publicValues.NEXT_PUBLIC_SUPABASE_URL, publishableKey: publicValues.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
  for (const key of ["sb_secret_synthetic", jwt("service_role")]) {
    assert.throws(() => resolvePublicSupabaseConfig({ ...publicValues, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key }), code("CONFIG_INVALID"));
  }
  assert.doesNotThrow(() => resolvePublicSupabaseConfig({ ...publicValues, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: jwt("anon") }));
});
for (const url of ["not-url", "javascript:alert(1)", "http://remote.example.invalid", "https://user:synthetic@project.example.invalid", "https://project.example.invalid/path", "https://project.example.invalid/?secret=synthetic"]) {
  test(`public configuration rejects malformed/unsafe origin form ${url.split(":")[0]}`, () => {
    assert.throws(() => resolvePublicSupabaseConfig({ ...publicValues, NEXT_PUBLIC_SUPABASE_URL: url }), code("CONFIG_INVALID"));
  });
}
test("missing core configuration is incomplete, not successful or optional disabled", () => {
  assert.throws(() => resolvePublicSupabaseConfig({}), code("CONFIG_INCOMPLETE"));
  assert.throws(() => getServerSupabaseConfig(publicValues), code("CONFIG_INCOMPLETE"));
});
test("service configuration rejects public credentials and validates explicit project identity", () => {
  for (const key of [publicValues.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, jwt("anon")]) {
    assert.throws(() => getServerSupabaseConfig({ ...publicValues, SUPABASE_SECRET_KEY: key }), code("CONFIG_INVALID"));
  }
  const values = { ...publicValues, SUPABASE_SECRET_KEY: "sb_secret_synthetic", P1_EXPECTED_SUPABASE_PROJECT_REF: "synthetic" };
  assert.equal(getServerSupabaseConfig(values).url, publicValues.NEXT_PUBLIC_SUPABASE_URL);
  assert.throws(() => getServerSupabaseConfig({ ...values, P1_EXPECTED_SUPABASE_PROJECT_REF: "other" }), code("ENVIRONMENT_MISMATCH"));
  assert.throws(() => getServerPublicSupabaseConfig({ ...values, P1_EXPECTED_SUPABASE_PROJECT_REF: "other" }), code("ENVIRONMENT_MISMATCH"));
});
test("group absence and partial credentials are distinct without loading another feature", () => {
  assert.equal(getGraphConfig({}).status, "disabled");
  assert.equal(getGraphConfig({ OUTLOOK_TENANT_ID: "synthetic" }).status, "incomplete");
  assert.equal(getGraphConfig(graph).status, "configured");
  assert.equal(getGraphConfig({ ...graph, OUTLOOK_USER_EMAIL: "invalid" }).status, "invalid");
  assert.equal(getTwilioConfig({}).status, "disabled");
  assert.equal(getTwilioConfig({ TWILIO_ACCOUNT_SID: twilio.TWILIO_ACCOUNT_SID }).status, "incomplete");
  assert.doesNotThrow(() => getServerSupabaseConfig({ ...publicValues, SUPABASE_SECRET_KEY: "sb_secret_synthetic", TWILIO_ACCOUNT_SID: "invalid" }));
});
test("legacy notification preflight preserves terminal replay and blocks new claims without configuration", () => {
  for (const state of ["sent", "unknown", "claimed", "not_deliverable"]) assert.doesNotThrow(() => requireLegacyGraphDeliveryConfiguration(state, {}));
  for (const state of [null, undefined, "pending", "failed"]) assert.throws(() => requireLegacyGraphDeliveryConfiguration(state, {}), code("FEATURE_DISABLED"));
  assert.throws(() => requireLegacyGraphDeliveryConfiguration("pending", { ...graph, NODE_ENV: "test", NEXT_PUBLIC_APP_URL: "javascript:invalid" }), code("CONFIG_INVALID"));
  assert.doesNotThrow(() => requireLegacyGraphDeliveryConfiguration("pending", { ...graph, NODE_ENV: "test", NEXT_PUBLIC_APP_URL: "https://portal.example.invalid" }));
});
test("Twilio validates complete auth alternatives and never silently falls back from a partial key pair", () => {
  assert.equal(getTwilioConfig(twilio).status, "configured");
  assert.equal(getTwilioConfig({ ...twilio, TWILIO_API_KEY_SID: `SK${"1".repeat(32)}` }).status, "incomplete");
  assert.equal(getTwilioConfig({ ...twilio, TWILIO_API_KEY_SECRET: "synthetic" }).status, "incomplete");
  const config = requireConfigured(getTwilioConfig({ ...twilio, TWILIO_API_KEY_SID: `SK${"1".repeat(32)}`, TWILIO_API_KEY_SECRET: "synthetic-key-secret", TWILIO_MESSAGING_SERVICE_SID: `MG${"2".repeat(32)}` }));
  assert.ok(config.username.startsWith("SK"));
  assert.equal(getTwilioConfig({ ...twilio, TWILIO_MESSAGING_SERVICE_SID: "invalid" }).status, "invalid");
});
test("configuration error serialization has fixed safe text and names, never values or causes", () => {
  for (const result of [getGraphConfig({ ...graph, OUTLOOK_USER_EMAIL: "private-address-secret" }), getTwilioConfig({ ...twilio, TWILIO_ACCOUNT_SID: "private-account-secret" })]) {
    assert.notEqual(result.status, "configured");
    assert.doesNotMatch(JSON.stringify(result), /private-address-secret|private-account-secret|synthetic-token/);
    if (result.status !== "configured") assert.throws(() => requireConfigured(result), code("CONFIG_INVALID"));
  }
});
test("explicit preview jobs fail closed while non-Vercel production has a deterministic identity", () => {
  const preview = { P1_APP_ENV: "preview", NEXT_PUBLIC_P1_APP_ENV: "preview", VERCEL_ENV: "preview" };
  assert.equal(getAppEnvironment({ NODE_ENV: "production", P1_APP_ENV: "production", NEXT_PUBLIC_P1_APP_ENV: "production" }).environment, "production");
  assert.throws(() => getAppEnvironment({ NODE_ENV: "production" }), code("CONFIG_INCOMPLETE"));
  assert.throws(() => getAppEnvironment({}), code("CONFIG_INCOMPLETE"));
  assert.throws(() => getAppEnvironment({ ...preview, P1_APP_ENV: "production" }), code("ENVIRONMENT_MISMATCH"));
  assert.throws(() => getAppEnvironment({ ...preview, VERCEL_ENV: "production" }), code("ENVIRONMENT_MISMATCH"));
  assert.throws(() => getAppEnvironment({ ...preview, VERCEL_ENV: undefined, NODE_ENV: "production" }), code("ENVIRONMENT_MISMATCH"));
  assert.throws(() => assertScheduledJobsAllowed(preview), code("FEATURE_DISABLED"));
  assert.doesNotThrow(() => assertScheduledJobsAllowed({ ...preview, P1_ALLOW_PREVIEW_JOBS: "true" }));
  assert.throws(() => assertScheduledJobsAllowed({ ...preview, P1_ALLOW_PREVIEW_JOBS: "yes" }), code("CONFIG_INVALID"));
});
test("canonical portal origin rejects conflicting aliases, production fallback and unsafe destinations", () => {
  const production = { NODE_ENV: "production", P1_APP_ENV: "production", NEXT_PUBLIC_P1_APP_ENV: "production" };
  assert.equal(getPortalOrigin({ NODE_ENV: "test", NEXT_PUBLIC_APP_URL: "https://portal.example.invalid/", PORTAL_URL: "https://portal.example.invalid" }), "https://portal.example.invalid");
  assert.throws(() => getPortalOrigin({ VERCEL_PROJECT_PRODUCTION_URL: "production.example.invalid" }), code("CONFIG_INCOMPLETE"));
  assert.throws(() => getPortalOrigin({ NEXT_PUBLIC_APP_URL: "https://preview.example.invalid", PORTAL_URL: "https://production.example.invalid" }), code("ENVIRONMENT_MISMATCH"));
  assert.throws(() => getPortalOrigin({ NEXT_PUBLIC_APP_URL: "https://production.example.invalid", P1_APP_ENV: "preview", NEXT_PUBLIC_P1_APP_ENV: "preview", VERCEL_ENV: "preview", VERCEL_PROJECT_PRODUCTION_URL: "production.example.invalid" }), code("ENVIRONMENT_MISMATCH"));
  for (const origin of ["http://localhost:3000", "https://localhost", "https://127.0.0.1", "https://192.168.1.1", "https://10.0.0.1", "https://[::1]"]) {
    assert.throws(() => getPortalOrigin({ ...production, NEXT_PUBLIC_APP_URL: origin }), code("ENVIRONMENT_MISMATCH"));
  }
  assert.throws(() => getServerSupabaseConfig({ ...publicValues, ...production, SUPABASE_SECRET_KEY: "sb_secret_synthetic" }), code("CONFIG_INCOMPLETE"));
  assert.equal(getServerSupabaseConfig({ ...publicValues, ...production, SUPABASE_SECRET_KEY: "sb_secret_synthetic", P1_EXPECTED_SUPABASE_PROJECT_REF: "synthetic" }).url, publicValues.NEXT_PUBLIC_SUPABASE_URL);
});
test("cron configuration requires one bounded token and does not infer enabled providers", () => {
  assert.throws(() => getCronConfig({}), code("CONFIG_INCOMPLETE"));
  assert.throws(() => getCronConfig({ CRON_SECRET: "two tokens" }), code("CONFIG_INVALID"));
  assert.deepEqual(getCronConfig({ CRON_SECRET: " synthetic-token " }), { secret: "synthetic-token" });
});
test("intake disabled is independent, enabled requires strict timestamp and preserves bounded recovery/default policy", () => {
  assert.deepEqual(getEmailIntakeConfig({}), { enabled: false });
  assert.deepEqual(getEmailIntakeConfig({ EMAIL_INTAKE_ENABLED: "false", EMAIL_INTAKE_START_AT: "broken" }), { enabled: false });
  assert.throws(() => getEmailIntakeConfig({ EMAIL_INTAKE_ENABLED: "yes" }), code("CONFIG_INVALID"));
  assert.throws(() => getEmailIntakeConfig({ EMAIL_INTAKE_ENABLED: "true" }), code("CONFIG_INCOMPLETE"));
  assert.throws(() => getEmailIntakeConfig({ EMAIL_INTAKE_ENABLED: "true", EMAIL_INTAKE_START_AT: "2026-09-10" }), code("CONFIG_INVALID"));
  assert.throws(() => getEmailIntakeConfig({ EMAIL_INTAKE_ENABLED: "true", EMAIL_INTAKE_START_AT: "2026-02-30T00:00:00Z" }), code("CONFIG_INVALID"));
  const base = { EMAIL_INTAKE_ENABLED: "true", EMAIL_INTAKE_START_AT: "2026-09-10T00:00:00Z" };
  const config = getEmailIntakeConfig(base); assert.ok(config.enabled); assert.equal(config.recoveryLookbackHours, 24);
  const capped = getEmailIntakeConfig({ ...base, EMAIL_INTAKE_RECOVERY_LOOKBACK_HOURS: "999" }); assert.ok(capped.enabled); assert.equal(capped.recoveryLookbackHours, 168);
  assert.throws(() => getEmailIntakeConfig({ ...base, EMAIL_INTAKE_RECOVERY_LOOKBACK_HOURS: "0" }), code("CONFIG_INVALID"));
  assert.throws(() => getEmailIntakeConfig({ ...base, EMAIL_INTAKE_ALLOWED_SENDERS: "not-email" }), code("CONFIG_INVALID"));
});
test("QuickBooks optional absence, partial material and wrong callback destination are distinct", () => {
  assert.equal(getQuickBooksConfiguration({}).status, "disabled");
  assert.equal(getQuickBooksConfiguration({ QUICKBOOKS_SANDBOX_CLIENT_ID: "synthetic" }).status, "incomplete");
  assert.equal(getQuickBooksConfiguration(qb).status, "configured");
  for (const uri of ["https://portal.example.invalid/wrong", "https://synthetic:synthetic@portal.example.invalid/api/quickbooks/callback", "https://portal.example.invalid/api/quickbooks/callback?unexpected=1", "https://other.example.invalid/api/quickbooks/callback"]) {
    assert.equal(getQuickBooksConfiguration({ ...qb, QUICKBOOKS_SANDBOX_REDIRECT_URI: uri }).status, "invalid");
  }
});
test("reading one configuration group does not inspect unrelated secret getters", () => {
  const values: EnvironmentValues = Object.defineProperty({ ...graph }, "TWILIO_AUTH_TOKEN", { get: () => { throw new Error("Unrelated secret read"); } });
  assert.equal(getGraphConfig(values).status, "configured");
});
test("preview Supabase requires an explicit production reference and rejects that project", () => {
  const preview = { ...publicValues, NODE_ENV: "production", VERCEL_ENV: "preview", P1_APP_ENV: "preview", NEXT_PUBLIC_P1_APP_ENV: "preview",
    SUPABASE_SECRET_KEY: "sb_secret_synthetic", P1_EXPECTED_SUPABASE_PROJECT_REF: "synthetic" };
  for (const read of [getServerPublicSupabaseConfig, getServerSupabaseConfig]) {
    assert.throws(() => read(preview), code("CONFIG_INCOMPLETE"));
    assert.throws(() => read({ ...preview, P1_PRODUCTION_SUPABASE_PROJECT_REF: "synthetic" }), code("ENVIRONMENT_MISMATCH"));
    assert.doesNotThrow(() => read({ ...preview, P1_PRODUCTION_SUPABASE_PROJECT_REF: "syntheticproduction" }));
  }
});
for (const provider of ["graph", "twilio"] as const) {
  test(`${provider} provider declaration and preview opt-in fail closed before transport`, () => {
    const read = provider === "graph" ? getGraphConfig : getTwilioConfig;
    const credentials = provider === "graph" ? graph : twilio;
    const name = provider === "graph" ? "P1_GRAPH_ENV" : "P1_TWILIO_ENV";
    const production = { ...credentials, NODE_ENV: "production", P1_APP_ENV: "production", NEXT_PUBLIC_P1_APP_ENV: "production" };
    assert.equal(read(production).status, "incomplete");
    assert.throws(() => requireConfigured<unknown>(read({ ...production, [name]: "preview" })), code("ENVIRONMENT_MISMATCH"));
    assert.equal(read({ ...production, [name]: "production" }).status, "configured");
    const preview = { ...production, VERCEL_ENV: "preview", P1_APP_ENV: "preview", NEXT_PUBLIC_P1_APP_ENV: "preview", [name]: "preview" };
    assert.equal(read(preview).status, "disabled");
    assert.throws(() => requireConfigured<unknown>(read(preview)), code("FEATURE_DISABLED"));
    assert.throws(() => requireConfigured<unknown>(read({ ...preview, P1_ALLOW_PREVIEW_PROVIDER_ACTIONS: "yes" })), code("CONFIG_INVALID"));
    assert.equal(read({ ...preview, P1_ALLOW_PREVIEW_PROVIDER_ACTIONS: "true" }).status, "configured");
    assert.throws(() => requireConfigured<unknown>(read({ ...preview, [name]: "production", P1_ALLOW_PREVIEW_PROVIDER_ACTIONS: "true" })), code("ENVIRONMENT_MISMATCH"));
    assert.equal(read({ NODE_ENV: "production", P1_APP_ENV: "preview", [name]: "production" }).status, "disabled", "Absent provider credentials remain optional, without loading another group");
  });
}
