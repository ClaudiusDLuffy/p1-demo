import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { ConfigurationError } from "./config/shared";
import { getGraphConfig, requireGraphConfig } from "./config/server/graph";
import { getPortalOrigin } from "./config/server/appEnvironment";
import { financialProviderAccessToken } from "./server/financialNotificationProvider";
import type { ReceivingDispatchWorkerSummary } from "./server/receivingDispatchWorker";

const graph = { OUTLOOK_TENANT_ID: "synthetic-preflight-tenant", OUTLOOK_CLIENT_ID: "synthetic-client", OUTLOOK_CLIENT_SECRET: "synthetic-secret", OUTLOOK_USER_EMAIL: "synthetic@example.invalid" };
test("financial provider refuses a malformed origin before token/network access", async () => {
  const values = { ...graph, NODE_ENV: "test", NEXT_PUBLIC_APP_URL: "javascript:invalid", PORTAL_URL: "" };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values); const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("No network permitted"); };
  try {
    assert.throws(() => financialProviderAccessToken(), error => error instanceof ConfigurationError && error.code === "CONFIG_INVALID");
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = original;
    for (const key of Object.keys(values)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});
test("receiving production wiring preflights local configuration before durable prepare", async () => {
  const filename = resolve("src/lib/server/receivingDispatchWorker.ts"); const requireHere = createRequire(import.meta.url);
  const exports: { drainReceivingDispatches?: () => Promise<ReceivingDispatchWorkerSummary> } = {};
  const commands: { name: string; args: Record<string, unknown> }[] = []; let requests = 0;
  const environment = { ...graph, NODE_ENV: "test", NEXT_PUBLIC_APP_URL: "javascript:invalid" };
  const id = "00000000-0000-4000-8000-000000000001";
  const replacements: Record<string, unknown> = {
    "../config/server/graph": { getGraphConfig: () => getGraphConfig(environment), requireGraphConfig: () => requireGraphConfig(environment), getNotificationOwnerEmails: () => "" },
    "../config/server/appEnvironment": { getPortalOrigin: () => getPortalOrigin(environment) },
    "../graphClient": { getAccessToken: async () => { requests++; return "synthetic"; }, sendEmail: async () => { requests++; }, isGraphHttpError: () => false },
    "../notificationService": { createReceivingDispatchNotification: () => { throw new Error("Message cannot be prepared"); } },
    "../supabase/server": { createServerClient: () => ({ rpc: (name: string, args: Record<string, unknown>) => ({ abortSignal: async () => {
      commands.push({ name, args });
      return { data: name === "claim_receiving_dispatch_deliveries_v1" ? [{ id }] : null, error: null };
    } }) }) },
  };
  runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, AbortSignal, require: (name: string) => replacements[name] ?? requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name) });
  assert.ok(exports.drainReceivingDispatches); const summary = await exports.drainReceivingDispatches();
  assert.equal(requests, 0); assert.equal(summary.unknown, 0); assert.equal(summary.failed, 1);
  assert.deepEqual(commands.map(command => command.name), ["claim_receiving_dispatch_deliveries_v1", "complete_receiving_dispatch_delivery_v1"]);
  assert.equal(commands[1].args.p_status, "failed");
  assert.doesNotMatch(JSON.stringify(commands), /javascript:|synthetic-secret|synthetic@example/);
});
