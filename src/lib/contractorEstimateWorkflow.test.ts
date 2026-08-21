import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/0083_contractor_estimates.sql");
const db = read("src/lib/db.ts");
const panel = read("src/features/estimates/ContractorEstimatePanel.tsx");
const detail = read("src/features/work-orders/WorkOrderDetail.tsx");

const saveStart = migration.indexOf("create or replace function public.save_contractor_estimate");
const convertStart = migration.indexOf("create or replace function public.convert_contractor_estimate_to_invoice");
const revokeStart = migration.indexOf("revoke all on function public.save_contractor_estimate", convertStart);
const saveFunction = migration.slice(saveStart, convertStart);
const convertFunction = migration.slice(convertStart, revokeStart);
const estimateTableStart = migration.indexOf("create table if not exists public.contractor_estimates");
const estimateLineTableStart = migration.indexOf("create table if not exists public.contractor_estimate_lines");
const estimateTables = migration.slice(estimateTableStart, migration.indexOf("create index", estimateLineTableStart));

test("estimates use dedicated tables with no internal P1 pricing metadata", () => {
  assert.ok(estimateTableStart >= 0);
  assert.ok(estimateLineTableStart > estimateTableStart);
  assert.doesNotMatch(estimateTables, /source_unit_cost|markup_percent|margin_percent|qbo_/i);
  assert.match(estimateTables, /state in \('draft', 'submitted', 'converted'\)/);
  assert.match(estimateTables, /converted_invoice_id uuid unique/);
  assert.match(estimateTables, /contractor_assignment_version integer not null/);
});

test("authenticated writes go only through assignment-scoped RPCs", () => {
  assert.match(migration, /alter table public\.contractor_estimates enable row level security/);
  assert.match(migration, /revoke all on table public\.contractor_estimates[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant select on table public\.contractor_estimates[\s\S]*to authenticated, service_role/);
  assert.doesNotMatch(migration, /grant insert, update, delete on table public\.contractor_estimates\s+to authenticated/);
  assert.match(saveFunction, /public\.current_contractor_account_id\(\)/);
  assert.match(saveFunction, /public\.can_invoice_for_contractor\(contractor_account_id\)/);
  assert.match(saveFunction, /public\.can_access_contractor_work_order\(candidate\.id\)/);
  assert.match(saveFunction, /candidate\.contractor_assignment_version/);
  assert.match(saveFunction, /for update/);
});

test("saving or submitting an estimate cannot mutate invoices or work-order state", () => {
  assert.doesNotMatch(saveFunction, /insert into public\.invoices/i);
  assert.doesNotMatch(saveFunction, /update public\.invoices/i);
  assert.doesNotMatch(saveFunction, /update public\.work_orders/i);
  assert.match(saveFunction, /insert into public\.contractor_estimates/);
  assert.match(saveFunction, /insert into public\.contractor_estimate_lines/);
  assert.match(saveFunction, /contractor_estimate_submitted/);
  assert.match(saveFunction, /p_expected_updated_at/);
  assert.match(saveFunction, /if p_expected_updated_at is null/);
  assert.match(saveFunction, /calculated_subtotal <= 0/);
});

test("conversion atomically creates one ordinary editable invoice draft", () => {
  assert.match(convertFunction, /if estimate\.state = 'converted'[\s\S]*'alreadyConverted', true/);
  assert.match(convertFunction, /insert into public\.invoices/);
  assert.match(convertFunction, /'draft'/);
  assert.match(convertFunction, /insert into public\.invoice_lines/);
  assert.match(convertFunction, /from public\.contractor_estimate_lines line/);
  assert.match(convertFunction, /converted_invoice_id = invoice\.id/);
  assert.doesNotMatch(convertFunction, /update public\.work_orders/i);
  assert.doesNotMatch(convertFunction, /qbo_invoice_id|qbo_synced_at|paid_at/i);
});

test("conversion rechecks current assignment, access, and closed-state boundaries", () => {
  assert.match(convertFunction, /candidate\.status <> 'closed'/);
  assert.match(convertFunction, /candidate\.contractor_id = estimate\.contractor_id/);
  assert.match(convertFunction, /candidate\.contractor_assignment_version\s+= estimate\.contractor_assignment_version/);
  assert.match(convertFunction, /public\.can_access_contractor_work_order\(candidate\.id\)/);
  assert.match(convertFunction, /for update/);
});

test("client conversion opens the existing invoice editor instead of duplicating invoice logic", () => {
  assert.match(db, /rpc\(\s*"convert_contractor_estimate_to_invoice"/);
  assert.match(panel, /loadInvoiceById\(result\.invoiceId\)/);
  assert.match(panel, /onOpenInvoiceDraft\?\.\(invoice\)/);
  assert.match(detail, /onOpenInvoiceDraft=\{draft => openCreate\(draft\)\}/);
  assert.doesNotMatch(panel, /QuoteCalculatorWorkspace|sourceUnitCost|markupPercent|overallMargin/i);
});

test("the existing staff quote calculator remains manager-only and separate", () => {
  assert.match(detail, /isManager && onConvertQuote/);
  assert.match(detail, /<QuoteCalculator/);
  assert.match(detail, /<ContractorEstimatePanel/);
});
