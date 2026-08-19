import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (name: string) => readFileSync(
  resolve(process.cwd(), `supabase/migrations/${name}`),
  "utf8",
);

const flags = read("0073_revise_seven_eleven_activity_flags.sql");
const capitalEnum = read("0074_pending_capital_completion_functional_status.sql");
const capitalFlow = read("0075_capital_quote_completion_billing_flow.sql");

test("7-Eleven flags exclude invoice and ETA events and clear their outstanding rows", () => {
  const syncableList = flags.match(/syncable_event := new\.event_key in \(([\s\S]*?)\);/)?.[1] || "";
  assert.doesNotMatch(syncableList, /eta_updated/);
  assert.doesNotMatch(syncableList, /invoice_submitted/);
  assert.doesNotMatch(syncableList, /invoice_resubmitted/);
  assert.match(syncableList, /check_in/);
  assert.match(syncableList, /photo_added/);
  assert.match(syncableList, /job_completed/);
  assert.match(flags, /event_key in \('eta_updated', 'invoice_submitted', 'invoice_resubmitted'\)/);
  assert.match(flags, /and synced_to_7eleven_at is null/);
});

test("capital quotes and final invoices are separate, linked, and server enforced", () => {
  assert.match(capitalEnum, /Pending Capital Completion/);
  assert.match(capitalFlow, /document_kind in \('invoice', 'capital_quote'\)/);
  assert.match(capitalFlow, /source_capital_quote_id uuid/);
  assert.match(capitalFlow, /classify_staff_billing_document/);
  assert.match(capitalFlow, /work_order\.status in \('capital', 'pending_capital_completion'\)/);
  assert.match(capitalFlow, /invoice\.state in \('draft', 'submitted', 'approved'\)/);
  assert.match(capitalFlow, /Mark the capital work completed before creating its final invoice/);
  assert.match(capitalFlow, /An approved capital quote is required before final billing/);
  assert.match(capitalFlow, /functional_status = 'Pending Capital Completion'/);
  assert.match(capitalFlow, /status in \('capital', 'pending_capital_completion'\)/);
  assert.match(capitalFlow, /else 'Work in Progress'::public\.fsm_functional_status/);
  assert.match(capitalFlow, /capital_status = case[\s\S]*?'Pending approval' then null/);
  assert.match(capitalFlow, /create or replace function public\.complete_capital_work/);
  assert.match(capitalFlow, /status = 'pending_invoice'/);
  assert.match(capitalFlow, /capital_status = 'Installed'/);
  assert.match(capitalFlow, /'capital_completed'/);
  assert.match(capitalFlow, /revoke all on function public\.resume_capital_work\(text\)[\s\S]*?service_role/);
});
