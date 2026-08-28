import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/0096_guarded_quickbooks_handoff.sql");
const route = read("src/app/api/controller-exports/route.ts");
const panel = read("src/features/invoices/ControllerExportPanel.tsx");

test("downloading stages a batch without marking contractor invoices paid", () => {
  const stage = migration.match(/create or replace function public\.stage_controller_invoice_export[\s\S]*?\nend;\n\$\$;/)?.[0] || "";
  assert.match(stage, /status\s*\) values[\s\S]*'pending'/);
  assert.doesNotMatch(stage, /set state = 'paid'/);
  assert.match(route, /stage_controller_invoice_export/);
  assert.match(panel, /Invoices remain Approved until the QuickBooks import is confirmed/);
});

test("only a confirmed pending batch performs the guarded QuickBooks transition", () => {
  assert.match(migration, /create or replace function public\.confirm_controller_invoice_export/);
  assert.match(migration, /set_config\('app\.quickbooks_handoff_transition', 'confirm', true\)/);
  assert.match(migration, /set state = 'paid'/);
  assert.match(migration, /qbo_synced_at = now\(\)/);
  assert.match(migration, /paid_at = null/);
  assert.match(migration, /protect_quickbooks_handoff_transition/);
  assert.match(migration, /quickbooks_handoff/);
  assert.match(route, /confirm_controller_invoice_export/);
  assert.match(route, /cancel_controller_invoice_export/);
});

test("the controller audit is filterable, exportable, and retains item detail", () => {
  assert.match(route, /params: \{ from\?: string; to\?: string; actor\?: string \}/);
  assert.match(route, /exportHistoryCsv/);
  assert.match(route, /invoiceNumber/);
  assert.match(route, /workOrderId/);
  assert.match(route, /contractorName/);
  assert.match(panel, /Export audit CSV/);
  assert.match(panel, /Run by/);
  assert.match(panel, /Re-download ZIP/);
  assert.match(route, /oldestPendingAt/);
  assert.match(panel, /Wednesday contractor-payment run/);
});
