import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { GraphEmail } from "../graphClient";
import type { IntakeResult } from "../emailIntakeProcessor";

const requireHere = createRequire(import.meta.url);
export const syntheticEmail: GraphEmail = {
  id: "synthetic-intake-graph-id", internetMessageId: "<synthetic-intake@example.invalid>",
  subject: "Synthetic dispatch", receivedDateTime: "2026-09-09T00:00:00Z",
  body: { contentType: "text", content: "Synthetic body must never enter the operational log" },
  from: { emailAddress: { address: "synthetic@example.invalid", name: "Synthetic sender" } },
  toRecipients: [],
};
type RpcResponse = { data: unknown; error: unknown };
export type IntakeTestOptions = {
  confirmed?: boolean;
  mode?: "unknown" | "create" | "capital";
  logError?: unknown;
  processingError?: unknown;
  mailboxError?: unknown;
  rpcResult?: (name: string, args: Record<string, unknown>) => RpcResponse;
};

// Execute the real processor and its server-only log adapter, replacing only
// external IO. This does not connect to Graph/Supabase or emulate their gateways.
export function intakeProcessorFixture(options: IntakeTestOptions = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const writes: { table: string; row: unknown }[] = [];
  const order: string[] = [];
  const diagnostics: unknown[][] = [];
  const sb = {
    from(table: string) {
      const done = Promise.resolve({ data: [], error: null });
      const query = {
        select: () => query, eq: () => query, order: () => query, is: () => query,
        maybeSingle: async () => ({ data: options.mode === "capital" ? { id: "WOT9600001", deleted_at: null } : null, error: options.processingError ?? null }),
        insert: async (row: unknown) => { writes.push({ table, row }); order.push(`insert:${table}`); return { error: table === "email_intake_log" ? options.logError ?? null : null }; },
        upsert: async (row: unknown) => { writes.push({ table, row }); return { error: null }; },
        then: done.then.bind(done),
      };
      return query;
    },
    rpc: async (name: string, args: Record<string, unknown>): Promise<RpcResponse> => {
      calls.push({ name, args }); order.push(name);
      if (options.rpcResult) return options.rpcResult(name, args);
      if (name === "record_email_intake_result_v1") return {
        data: { applied: true, reason: "recorded", logId: "00000000-0000-4000-8000-000000000081", eventId: args.p_event_id, sourceMessageId: args.p_source_message_id, processedAt: "2026-09-09T00:00:00.000Z" },
        error: options.logError ?? null,
      };
      if (options.processingError) return { data: null, error: options.processingError };
      return { error: null, data: { applied: true, reason: "created", workOrderId: "WOT9600001", operationId: args.p_operation_id, assignmentVersion: 0, lifecycleVersion: 0, workflowCycle: 0, contractorId: null, activityId: null } };
    },
  };
  const load = (filename: string): Record<string, unknown> => {
    const exports: Record<string, unknown> = {};
    const customRequire = (name: string): unknown => {
      if (name === "server-only") return {};
      if (name.endsWith("/supabase/server")) return { createServerClient: () => sb };
      if (name === "./server/emailIntakeLog") return load(resolve("src/lib/server/emailIntakeLog.ts"));
      if (name === "./graphClient") return {
        getAccessToken: async () => "synthetic-token-not-logged",
        markEmailRead: async () => { order.push("mark-read"); if (options.mailboxError) throw options.mailboxError; },
        moveEmailToFolder: async () => { order.push("move"); },
      };
      if (name === "./emailParser") return {
        isConfirmedWorkOrderIntakeEmail: () => options.confirmed ?? true,
        parseDispatchEmail: () => ({ emailType: options.mode === "create" ? "TYPE_DISPATCHED" : options.mode === "capital" ? "TYPE_CAPITAL_PENDING" : "TYPE_UNKNOWN", wotId: "WOT9600001", priority: "p4", parseConfidence: "high", state: "VA", storeNumber: "96000", summary: "Synthetic work", description: "Synthetic description", nte: 0 }),
      };
      if (name === "./intakeStatePolicy") return { intakeStateBlockReason: () => null, intakeStateActivationDecision: () => ({ action: "allow" }) };
      if (name === "./autoDispatch") return { resolveContractor: async () => null };
      if (["./notificationService", "./emailPriorityEscalationProcessor", "./emailAssignmentRemovalProcessor"].includes(name)) return {};
      return requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name);
    };
    runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { exports, require: customRequire, Date, Set, process: { env: {} }, console: { error: (...args: unknown[]) => diagnostics.push(args) } }, { filename });
    return exports;
  };
  const loaded = load(resolve("src/lib/emailIntakeProcessor.ts"));
  assert.equal(typeof loaded.processEmail, "function");
  // Type is the public source contract; the synthetic VM exports are checked above.
  const processEmail = loaded.processEmail as (email: GraphEmail, folder: string) => Promise<IntakeResult>;
  return { process: (email = syntheticEmail) => processEmail(email, "synthetic-folder"), calls, writes, order, diagnostics };
}
