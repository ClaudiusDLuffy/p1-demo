import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/0084_non_retryable_rpc_conflicts.sql");
const audit = read("supabase/audits/0084_non_retryable_rpc_conflicts.sql");
const workOrderHook = read("src/features/work-orders/useWorkOrders.ts");
const invoiceHook = read("src/features/invoices/useInvoices.ts");
const estimatePanel = read("src/features/estimates/ContractorEstimatePanel.tsx");

const expectedRpcSignatures = [
  "public.review_contractor_invoice(uuid,text,text)",
  "public.review_contractor_invoices(uuid[],text,text)",
  "public.resubmit_rejected_contractor_invoice(uuid,text,text,date,date,text,numeric,numeric,jsonb,text)",
  "public.retract_contractor_invoice_rejection(uuid)",
  "public.complete_controller_invoice_export(uuid,uuid,text,uuid[])",
  "public.save_contractor_estimate(uuid,text,date,date,text,text,numeric,jsonb,boolean,timestamp with time zone)",
  "public.convert_contractor_estimate_to_invoice(uuid)",
];

test("the forward-only migration changes only verified application conflict codes", () => {
  assert.match(migration, /begin;[\s\S]*commit;/);
  assert.match(migration, /pg_get_functiondef\(target_function\)/);
  assert.match(migration, /position\(target\.required_marker in function_definition\)/);
  assert.match(migration, /old_code text := quote_literal\('40001'\)/);
  assert.match(migration, /new_code text := quote_literal\('PT409'\)/);
  assert.match(migration, /execute replace\(function_definition, old_code, new_code\)/);
  assert.match(migration, /old_count = 0 and new_count = target\.expected_count/);
  assert.match(migration, /old_count <> 0 or new_count <> target\.expected_count/);

  expectedRpcSignatures.forEach(signature => assert.ok(
    migration.includes(signature),
    `missing guarded RPC signature ${signature}`,
  ));

  assert.doesNotMatch(migration, /\b(?:insert|update|delete)\s+(?:into\s+|from\s+)?public\./i);
  assert.doesNotMatch(migration, /\b(?:grant|revoke)\b/i);
  assert.doesNotMatch(migration, /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  assert.doesNotMatch(migration, /WOT[0-9]+/i);
});

test("the deployment audit is read-only and checks locks plus every conflict RPC", () => {
  expectedRpcSignatures.forEach(signature => assert.ok(
    audit.includes(signature),
    `audit is missing RPC signature ${signature}`,
  ));
  assert.match(audit, /no_retryable_application_conflicts/);
  assert.match(audit, /all_conflicts_return_once_as_http_409/);
  assert.match(audit, /row_locks_preserved/);
  assert.match(audit, /stable_atomic_batch_review_preserved/);
  assert.doesNotMatch(audit, /\b(?:insert|update|delete)\s+(?:into\s+|from\s+)?public\./i);
});

test("single and batch invoice actions share per-invoice guards and refresh conflicts", () => {
  assert.match(workOrderHook, /acquireInvoiceMutationLocks\(\[invoiceId\]\)/);
  assert.match(workOrderHook, /messageForError/);
  assert.match(workOrderHook, /isRpcConflict\(error\)/);
  assert.match(workOrderHook, /finally[\s\S]*releaseInvoiceLock\(\)/);

  assert.match(invoiceHook, /acquireInvoiceMutationLocks\(normalizedIds\)/);
  assert.match(invoiceHook, /acquireInvoiceMutationLocks\(\[inv\.id\]\)/);
  assert.match(invoiceHook, /await invalidateWorkflowData\(\);[\s\S]*rpcConflictMessage/);
  assert.match(invoiceHook, /finally[\s\S]*releaseInvoiceLocks\(\)/);
});

test("estimate conflicts also refresh without changing estimate workflow rules", () => {
  assert.match(estimatePanel, /isRpcConflict\(caught\)/);
  assert.match(estimatePanel, /await invalidateEstimateWorkflow\(\)/);
  assert.match(estimatePanel, /await invalidateConvertedInvoice\(\)/);
  assert.match(estimatePanel, /operationLock\.current/);
});
