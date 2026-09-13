import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const filename = resolve("src/lib/emailIntakeProcessor.ts");
const requireHere = createRequire(import.meta.url);
// Golden synthetic outcomes were characterized against the actual committed
// 19270673 processor before retaining this test. No Git history, real email,
// provider credential or customer record is needed to run it in a clean CI.
const expected = {
  emailId: "synthetic-email", subject: "Synthetic capital status", action: "updated",
  workOrderId: "WOT9000123", reason: "capital status noted on existing active work order",
  parseConfidence: "high", contractorAssigned: null, processedAt: null, logStatus: "recorded",
};
type Result = { action: string; workOrderId: string; reason: string; processedAt: string };

async function exercise(source: string, archived = false) {
  const writes: { target: string; value: unknown }[] = [];
  const rpcCalls: { name: string; args: unknown }[] = [];
  const match = { id: "WOT9000123", deleted_at: archived ? "2026-09-01T00:00:00Z" : null };
  const client = {
    from: (table: string) => {
      const done = Promise.resolve({ data: [], error: null });
      const query = {
        select: () => query, eq: () => query, order: () => query, is: () => query,
        maybeSingle: async () => ({ data: match, error: null }),
        update: (value: unknown) => { writes.push({ target: table, value }); return query; },
        insert: async (value: unknown) => { writes.push({ target: table, value }); return { error: null }; },
        then: done.then.bind(done),
      };
      return query;
    },
    rpc: async (name: string, args: unknown) => { rpcCalls.push({ name, args }); return { data: { applied: true }, error: null }; },
  };
  const customRequire = (name: string): unknown => {
    if (name === "server-only") return {};
    // Trusted receipt transport has separate real-adapter behavior coverage.
    if (name === "./server/emailIntakeLog") return { recordTrustedEmailIntakeResult: async () => ({ reason: "recorded" }) };
    if (name === "./supabase/server") return { createServerClient: () => client };
    if (name === "./graphClient") return { getAccessToken: async () => null };
    if (name === "./emailParser") return {
      isConfirmedWorkOrderIntakeEmail: () => true,
      parseDispatchEmail: () => ({ emailType: "TYPE_CAPITAL_PENDING", wotId: match.id, state: null, parseConfidence: "high" }),
    };
    if (name === "./intakeStatePolicy") return { intakeStateBlockReason: () => null };
    // Unused integrations must not construct a real provider client in this test.
    if (["./autoDispatch", "./notificationService", "./emailPriorityEscalationProcessor", "./emailAssignmentRemovalProcessor"].includes(name)) return {};
    return requireHere(resolve(filename, "..", name));
  };
  const exports: { processEmail?: (email: unknown, folder: string) => Promise<Result> } = {};
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: customRequire, process: { env: {} }, console, Date, Set }, { filename });
  assert.ok(exports.processEmail);
  const result = await exports.processEmail({ id: "synthetic-email", subject: "Synthetic capital status" }, "synthetic-folder");
  return { result, writes, rpcCalls };
}

test("capital-intake RPC cutover preserves the committed processor result without a second activity write", async () => {
  const current = await exercise(readFileSync(filename, "utf8"));
  assert.deepEqual({ ...current.result, processedAt: null }, expected);
  assert.equal(current.writes.filter(write => ["work_orders", "activities"].includes(write.target)).length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(current.rpcCalls)), [{ name: "record_email_capital_pending_v1", args: { p_work_order_id: "WOT9000123" } }]);
});

test("archived capital-intake records remain skipped without calling the new command", async () => {
  const current = await exercise(readFileSync(filename, "utf8"), true);
  assert.equal(current.result.action, "skipped");
  assert.deepEqual({ ...current.result, processedAt: null }, {
    ...expected, action: "skipped", reason: "status email matched an archived work order; archived row was not updated",
  });
  assert.equal(current.rpcCalls.length, 0);
});
