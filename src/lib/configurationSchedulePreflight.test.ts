import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { evaluateRuntimePreflight, parsePreflightArguments, scheduledOwners, type PreflightOptions } from "../../scripts/runtime-configuration-preflight";
import type { EnvironmentValues } from "./config/shared";

const production = { NODE_ENV: "production", P1_APP_ENV: "production", NEXT_PUBLIC_P1_APP_ENV: "production",
  P1_EXPECTED_SUPABASE_PROJECT_REF: "synthetic", NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic", SUPABASE_SECRET_KEY: "sb_secret_synthetic",
  NEXT_PUBLIC_APP_URL: "https://portal.example.invalid", CRON_SECRET: "synthetic-token" };
const graph = { P1_GRAPH_ENV: "production", OUTLOOK_TENANT_ID: "synthetic", OUTLOOK_CLIENT_ID: "synthetic",
  OUTLOOK_CLIENT_SECRET: "synthetic-secret", OUTLOOK_USER_EMAIL: "synthetic@example.invalid" };
const twilio = { P1_TWILIO_ENV: "production", TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`, TWILIO_AUTH_TOKEN: "synthetic-token", TWILIO_FROM_NUMBER: "+12025550123" };
const manifest = { crons: scheduledOwners.map(({ path, schedule }) => ({ path, schedule })) };
const sources = Object.fromEntries(scheduledOwners.map(owner => [owner.path, "export async function POST() {}\nexport const GET = POST;"]));
const options: PreflightOptions = { namesOnly: false, synthetic: false, environment: "production", schedulerOwnerConfirmed: true, partsSms: "disabled" };
const run = (values: EnvironmentValues = { ...production, ...graph }, config = manifest, source = sources, flags: PreflightOptions = options) => evaluateRuntimePreflight(values, config, source, flags);
const status = (result: ReturnType<typeof run>, name: string) => result.checks.find(item => item.feature === name)?.status;

test("actual repository schedules have exact closed ownership, GET methods and cadences", () => {
  const realManifest: unknown = JSON.parse(readFileSync("vercel.json", "utf8"));
  const realSources = Object.fromEntries(scheduledOwners.map(owner => [owner.path, readFileSync(`src/app${owner.path}/route.ts`, "utf8")]));
  const result = evaluateRuntimePreflight({ ...production, ...graph }, realManifest, realSources, options);
  assert.equal(result.exitCode, 0); assert.equal(result.scheduleOwnership.length, 4);
  assert.equal(result.promotionReady, false); assert.ok(result.promotionGates.includes("target_database_parts_sms_enabled_setting_matches_declaration"));
});
for (const variation of ["missing", "duplicate", "unknown", "cadence", "extra_method", "missing_get", "generated405_get"] as const) {
  test(`schedule preflight rejects ${variation} without executing a handler`, () => {
    const rows: Record<string, string>[] = manifest.crons.map(row => ({ ...row })); const routeSources = { ...sources };
    if (variation === "missing") rows.pop();
    if (variation === "duplicate") rows[1] = { ...rows[0] };
    if (variation === "unknown") rows[0].path = "/api/private-unapproved";
    if (variation === "cadence") rows[0].schedule = "* * * * *";
    if (variation === "extra_method") rows[0].method = "POST";
    if (variation === "missing_get") routeSources[rows[0].path] = "export function POST() {}";
    if (variation === "generated405_get") routeSources[rows[0].path] = "export const GET = apiMethodBoundary.methodNotAllowed;";
    const result = evaluateRuntimePreflight({ ...production, ...graph }, { crons: rows }, routeSources, options);
    assert.equal(status(result, "schedule_manifest"), "invalid"); assert.equal(result.exitCode, 1);
    assert.doesNotMatch(JSON.stringify(result), /private-unapproved|synthetic-secret|synthetic@example/);
  });
}
test("active production Graph schedules cannot pass with an entirely absent optional Graph group", () => {
  const result = run(production); assert.equal(status(result, "graph"), "disabled");
  assert.equal(status(result, "schedule_receiving_dispatch"), "incomplete");
  assert.equal(status(result, "schedule_financial_notifications"), "incomplete"); assert.equal(result.exitCode, 1);
});
test("disabled email intake is exempt without bypassing receiving and financial requirements", () => {
  const result = run(); assert.equal(status(result, "schedule_email_intake"), "disabled");
  assert.equal(status(result, "schedule_receiving_dispatch"), "configured");
  assert.equal(status(run({ ...production, ...graph, EMAIL_INTAKE_ENABLED: "true" }), "schedule_email_intake"), "incomplete");
});
test("active parts schedule needs explicit database-setting declaration and matching provider configuration", () => {
  const unknown = run(undefined, undefined, undefined, { ...options, partsSms: undefined });
  assert.equal(status(unknown, "parts_sms_database_setting_attestation"), "incomplete"); assert.equal(unknown.exitCode, 1);
  const enabled = { ...options, partsSms: "enabled" as const };
  assert.equal(status(run(undefined, undefined, undefined, enabled), "schedule_parts_sms"), "incomplete");
  const configured = run({ ...production, ...graph, ...twilio }, undefined, undefined, enabled);
  assert.equal(configured.exitCode, 0); assert.equal(configured.declarations.partsSms, "enabled"); assert.equal(configured.promotionReady, false);
  assert.equal(status(run(), "schedule_parts_sms"), "disabled");
});
test("scheduler owner and cutover must be explicitly attested but are never claimed verified", () => {
  const result = run(undefined, undefined, undefined, { ...options, schedulerOwnerConfirmed: false });
  assert.equal(result.exitCode, 1); assert.equal(result.declarations.schedulerOwner, "unverified");
  assert.equal(status(result, "scheduler_owner_attestation"), "incomplete");
  assert.ok(result.promotionGates.includes("schedule_owner_cutover_and_host_activation_verified"));
});
test("preview disabled jobs do not require optional providers, opted-in jobs do", () => {
  const preview = { ...production, VERCEL_ENV: "preview", P1_APP_ENV: "preview", NEXT_PUBLIC_P1_APP_ENV: "preview", P1_PRODUCTION_SUPABASE_PROJECT_REF: "syntheticproduction" };
  const flags = { ...options, environment: "preview" as const, partsSms: undefined, schedulerOwnerConfirmed: false };
  const disabled = run(preview, undefined, undefined, flags); assert.equal(disabled.exitCode, 0);
  assert.ok(disabled.scheduleOwnership.every(owner => owner.status === "disabled"));
  const enabled = run({ ...preview, P1_ALLOW_PREVIEW_JOBS: "true" }, undefined, undefined, flags); assert.equal(enabled.exitCode, 1);
});
test("intended environment is mandatory and must match the explicitly derived identity", () => {
  assert.equal(status(run(undefined, undefined, undefined, { ...options, environment: undefined }), "intended_environment"), "incomplete");
  assert.equal(status(run(undefined, undefined, undefined, { ...options, environment: "preview" }), "intended_environment"), "invalid");
});
test("preflight rejects unknown, duplicate, conflicting and incomplete command arguments safely", () => {
  for (const args of [["--private-secret"], ["--environment"], ["--environment", "unknown"], ["--parts-sms", "true"],
    ["--environment", "test", "--environment", "test"], ["--names-only", "--synthetic"], ["--scheduler-owner-confirmed", "--scheduler-owner-confirmed"]]) {
    assert.throws(() => parsePreflightArguments(args));
  }
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/verify-runtime-configuration.ts", "--private-secret"], {
    cwd: process.cwd(), env: { NODE_ENV: "test" }, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(result.status, 2); assert.doesNotMatch(result.stdout + result.stderr, /private-secret|stack|synthetic-token/);
});
