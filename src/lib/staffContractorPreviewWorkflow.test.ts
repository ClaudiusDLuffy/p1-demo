import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/0090_staff_contractor_preview.sql");
const component = read("src/features/contractor-preview/StaffContractorPreview.tsx");

const workOrderStart = migration.indexOf("create or replace function public.list_staff_contractor_preview_work_orders");
const invoiceStart = migration.indexOf("create or replace function public.list_staff_contractor_preview_invoices");
const revokeStart = migration.indexOf("revoke all on function", invoiceStart);
const previewFunctions = migration.slice(workOrderStart, revokeStart);

test("contractor preview is an explicitly authorized read-only staff boundary", () => {
  assert.ok(workOrderStart >= 0);
  assert.ok(invoiceStart > workOrderStart);
  assert.match(previewFunctions, /security definer/g);
  assert.match(previewFunctions, /profile\.role in \('manager', 'dispatcher', 'back_office'\)/g);
  assert.match(previewFunctions, /profile_has_staff_permission\(v_actor\.id, 'invoice_controller'\)/g);
  assert.doesNotMatch(previewFunctions, /\b(?:insert|update|delete)\s+(?:into|public\.)/i);
  assert.match(migration, /revoke all on function public\.list_staff_contractor_preview_work_orders[\s\S]*from public, anon/);
  assert.match(migration, /revoke all on function public\.list_staff_contractor_preview_invoices[\s\S]*from public, anon/);
});

test("preview projects one resolved company without internal P1 data sources", () => {
  assert.match(previewFunctions, /organization\.canonical_contractor_id/g);
  assert.match(previewFunctions, /work_order\.contractor_id = v_canonical_contractor_id/);
  assert.match(previewFunctions, /invoice\.contractor_id = v_canonical_contractor_id/);
  assert.equal(
    (previewFunctions.match(/invoice\.invoice_type = 'contractor'/g) || []).length,
    2,
    "both the page and has-more query must exclude internal P1 invoices",
  );
  assert.doesNotMatch(previewFunctions, /billing_invoices|work_order_financials|markup|margin|qbo_|staff_notes_seen_at/i);
});

test("staff UI clearly labels preview and contains no mutation controls", () => {
  assert.match(component, /Read-only staff preview — no impersonation/);
  assert.match(component, /Internal P1 billing, margins, QuickBooks metadata, and staff-only notes are excluded/);
  assert.doesNotMatch(component, /onApprove|onDelete|onSubmit|onDispatch|onAssign/);
});
