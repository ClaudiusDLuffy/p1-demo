// Tool-only configuration aggregation. Never imported by application runtime.
import ts from "typescript";
import { ConfigurationError, requireConfigured, type ConfigurationResult, type EnvironmentValues } from "../src/lib/config/shared";
import { getServerPublicSupabaseConfig, getServerSupabaseConfig } from "../src/lib/config/server/supabase";
import { getGraphConfig } from "../src/lib/config/server/graph";
import { getTwilioConfig } from "../src/lib/config/server/twilio";
import { getEmailIntakeConfig } from "../src/lib/config/server/emailIntake";
import { getCronConfig } from "../src/lib/config/server/cron";
import { assertScheduledJobsAllowed, getAppEnvironment, getPortalOrigin } from "../src/lib/config/server/appEnvironment";
import { getQuickBooksConfiguration } from "../src/lib/config/server/quickbooks";

export type IntendedEnvironment = "development" | "test" | "preview" | "production";
export type PreflightOptions = { namesOnly: boolean; synthetic: boolean; environment?: IntendedEnvironment;
  partsSms?: "enabled" | "disabled"; schedulerOwnerConfirmed: boolean };
export type PreflightCheck = { feature: string; status: "configured" | "disabled" | "incomplete" | "invalid";
  code?: string; variableNames?: readonly string[] };
export const scheduledOwners = [
  { path: "/api/notifications/dispatch/drain", schedule: "*/3 * * * *", owner: "receiving_dispatch", provider: "graph" },
  { path: "/api/notifications/financial/drain", schedule: "1-59/3 * * * *", owner: "financial_notifications", provider: "graph" },
  { path: "/api/notifications/parts-order", schedule: "2-59/3 * * * *", owner: "parts_sms", provider: "twilio" },
  { path: "/api/email-intake", schedule: "*/3 * * * *", owner: "email_intake", provider: "graph" },
] as const;

export function parsePreflightArguments(args: readonly string[]): PreflightOptions {
  const result: PreflightOptions = { namesOnly: false, synthetic: false, schedulerOwnerConfirmed: false };
  const used = new Set<string>();
  const invalid = (): never => { throw new ConfigurationError("CONFIG_INVALID", "app_environment"); };
  if (args.length > 8) invalid();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]; if (used.has(arg)) invalid(); used.add(arg);
    if (arg === "--names-only") result.namesOnly = true;
    else if (arg === "--synthetic") result.synthetic = true;
    else if (arg === "--scheduler-owner-confirmed") result.schedulerOwnerConfirmed = true;
    else if (arg === "--environment") {
      const value = args[++index]; if (!["development", "test", "preview", "production"].includes(value)) invalid();
      result.environment = value as IntendedEnvironment;
    } else if (arg === "--parts-sms") {
      const value = args[++index]; result.partsSms = value === "enabled" ? "enabled" : value === "disabled" ? "disabled" : invalid();
    } else invalid();
  }
  if (result.namesOnly && args.length !== 1) invalid();
  return result;
}

function check(feature: string, run: () => unknown): PreflightCheck {
  try { run(); return { feature, status: "configured" }; }
  catch (error) {
    const safe = error instanceof ConfigurationError ? error : new ConfigurationError("CONFIG_INVALID", "app_environment");
    return { feature, status: safe.code === "FEATURE_DISABLED" ? "disabled" : safe.code === "CONFIG_INCOMPLETE" ? "incomplete" : "invalid",
      code: safe.code, variableNames: safe.variableNames };
  }
}
function optional(feature: string, result: ConfigurationResult<unknown>): PreflightCheck {
  return result.status === "configured" ? { feature, status: result.status }
    : { feature, status: result.status, code: result.error.code, variableNames: result.error.variableNames };
}
function businessGet(source: string | undefined): boolean {
  if (!source || source.length > 128 * 1024) return false;
  const ast = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = new Map<string, ts.FunctionDeclaration | ts.Expression>();
  let exportedGet = false;
  for (const node of ast.statements) {
    const exported = ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(node) && node.name) {
      declarations.set(node.name.text, node); if (exported && node.name.text === "GET") exportedGet = true;
    } else if (ts.isVariableStatement(node)) for (const item of node.declarationList.declarations) {
      if (ts.isIdentifier(item.name) && item.initializer) {
        declarations.set(item.name.text, item.initializer); if (exported && item.name.text === "GET") exportedGet = true;
      }
    }
  }
  const seen = new Set<string>(); let name = "GET";
  while (exportedGet && !seen.has(name) && seen.size < 8) {
    seen.add(name); const node = declarations.get(name); if (!node) return false;
    if (ts.isIdentifier(node)) { name = node.text; continue; }
    return ts.isFunctionDeclaration(node) && !!node.body || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
  }
  return false;
}
function validateManifest(manifest: unknown, sources: Readonly<Record<string, string | undefined>>) {
  const invalid = (): never => { throw new ConfigurationError("CONFIG_INVALID", "cron"); };
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !("crons" in manifest)
    || !Array.isArray(manifest.crons) || manifest.crons.length !== scheduledOwners.length) invalid();
  const rows = (manifest as { crons: unknown[] }).crons; const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some(key => !["path", "schedule"].includes(key))
      || !("path" in row) || typeof row.path !== "string" || !("schedule" in row) || typeof row.schedule !== "string") invalid();
    const entry = row as { path: string; schedule: string };
    const owner = scheduledOwners.find(item => item.path === entry.path);
    if (!owner || seen.has(entry.path) || owner.schedule !== entry.schedule || !businessGet(sources[owner.path])) invalid();
    seen.add(entry.path);
  }
}

export function evaluateRuntimePreflight(values: EnvironmentValues, manifest: unknown,
  routeSources: Readonly<Record<string, string | undefined>>, options: PreflightOptions) {
  const checks: PreflightCheck[] = [
    check("supabase_public", () => getServerPublicSupabaseConfig(values)), check("supabase_service", () => getServerSupabaseConfig(values)),
    check("app_environment", () => getAppEnvironment(values)), check("portal_origin", () => getPortalOrigin(values)),
    check("cron", () => getCronConfig(values)), check("scheduled_jobs", () => assertScheduledJobsAllowed(values)),
    optional("graph", getGraphConfig(values)), optional("twilio", getTwilioConfig(values)), optional("quickbooks", getQuickBooksConfiguration(values)),
    check("email_intake", () => { if (!getEmailIntakeConfig(values).enabled) throw new ConfigurationError("FEATURE_DISABLED", "email_intake"); }),
    check("intended_environment", () => {
      const expected = options.environment ?? (options.synthetic ? "test" : undefined);
      if (!expected) throw new ConfigurationError("CONFIG_INCOMPLETE", "app_environment");
      if (getAppEnvironment(values).environment !== expected) throw new ConfigurationError("ENVIRONMENT_MISMATCH", "app_environment");
    }), check("schedule_manifest", () => validateManifest(manifest, routeSources)),
  ];
  const schedulesActive = checks.find(item => item.feature === "scheduled_jobs")?.status === "configured";
  const partsSms = options.partsSms ?? (options.synthetic ? "enabled" : undefined);
  const schedulerDeclared = options.schedulerOwnerConfirmed || options.synthetic;
  const requirements: { path: string; owner: string; method: "GET"; schedule: string; status: PreflightCheck["status"]; code?: string }[] = [];
  if (schedulesActive) {
    checks.push({ feature: "scheduler_owner_attestation", status: schedulerDeclared ? "configured" : "incomplete",
      ...(schedulerDeclared ? {} : { code: "SCHEDULE_OWNER_UNCONFIRMED" }) });
    checks.push({ feature: "parts_sms_database_setting_attestation", status: partsSms ? "configured" : "incomplete",
      ...(partsSms ? {} : { code: "PARTS_SMS_SETTING_UNCONFIRMED" }) });
  }
  for (const owner of scheduledOwners) {
    const required = check(`schedule_${owner.owner}`, () => {
      if (!schedulesActive) throw new ConfigurationError("FEATURE_DISABLED", "cron");
      if (owner.owner === "email_intake" && !getEmailIntakeConfig(values).enabled) throw new ConfigurationError("FEATURE_DISABLED", "email_intake");
      if (owner.owner === "parts_sms" && partsSms === "disabled") throw new ConfigurationError("FEATURE_DISABLED", "twilio");
      if (owner.owner === "parts_sms" && !partsSms) throw new ConfigurationError("CONFIG_INCOMPLETE", "twilio");
      getServerSupabaseConfig(values); getCronConfig(values); getPortalOrigin(values);
      const provider = owner.provider === "graph" ? getGraphConfig(values) : getTwilioConfig(values);
      if (provider.status !== "configured") {
        // Optional-group absence is an error when an active schedule owns it.
        if (provider.status === "disabled") throw new ConfigurationError("CONFIG_INCOMPLETE", owner.provider, provider.error.variableNames);
        requireConfigured<unknown>(provider);
      }
    });
    checks.push(required);
    requirements.push({ path: owner.path, owner: owner.owner, method: "GET", schedule: owner.schedule, status: required.status,
      ...(required.code ? { code: required.code } : {}) });
  }
  return { mode: options.synthetic ? "synthetic" : "injected-process-environment", checks, scheduleOwnership: requirements,
    declarations: { partsSms: partsSms ?? "unverified", schedulerOwner: schedulerDeclared ? "owner_declared" : "unverified" },
    promotionReady: false as const,
    promotionGates: ["target_database_parts_sms_enabled_setting_matches_declaration", "schedule_owner_cutover_and_host_activation_verified",
      "target_database_and_provider_account_identity_verified", "approved_test_recipient_and_provider_outcomes_verified"],
    environmentIdentity: "Declarations and local source checks do not verify deployed settings, scheduler ownership, accounts, or credentials.",
    exitCode: checks.some(item => item.status === "incomplete" || item.status === "invalid") ? 1 : 0 };
}
