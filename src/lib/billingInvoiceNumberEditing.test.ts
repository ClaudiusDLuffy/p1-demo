import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { StaffInvoiceSaveSchema } from "./staffInvoiceContracts";
import { billingRouteHarness, validBillingRequest } from "./billingFinancialRouteTestHarness";

const modal = readFileSync(
  resolve(process.cwd(), "src/features/billing/BillingInvoiceCreateModal.tsx"),
  "utf8",
);
const atomicSaveMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/0063_atomic_staff_billing_invoice_save.sql",
  ),
  "utf8",
);
const reconciliationMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/0072_reconcile_staff_invoice_number_series.sql",
  ),
  "utf8",
);

test("auto-populated P1 invoice numbers are editable before lifecycle lock", () => {
  assert.doesNotMatch(modal, /readOnly=\{!isEditing\}/);
  assert.match(modal, /Auto-populated, but editable until approval or QuickBooks sync/);
  assert.match(modal, /setNumberEdited\(true\)/);
});

test("an untouched invoice-number preview refreshes every time create opens", () => {
  assert.match(modal, /const numberEditedRef = useRef\(false\)/);
  assert.match(modal, /billing-invoices\?nextNumber=1[\s\S]*cache: "no-store"/);
  assert.match(modal, /if \(!numberEditedRef\.current\) \{\s*setValue\("num", preview/);
  assert.match(modal, /num: editingInvoice\?\.num \|\| ""/);
  assert.doesNotMatch(modal, /num: editingInvoice\?\.num \|\| numberPreview/);
  assert.match(modal, /numberEditedRef\.current = restoredNumberEdited/);
});

test("automatic focus cannot suppress a late invoice-number preview", () => {
  const marker = 'title="Auto-populated, but editable until approval or QuickBooks sync.';
  const end = modal.indexOf(marker);
  const input = modal.slice(modal.lastIndexOf("<input", end), end + marker.length);
  assert.match(input, /register\("num", \{\s*onChange:/);
  assert.doesNotMatch(input, /onFocus=/);
  assert.doesNotMatch(modal, /numberInputFocusedRef|pendingNumberPreviewRef/);
});

test("staff invoice allocation reconciles counters with persisted numbers", () => {
  assert.match(
    reconciliationMigration,
    /update public\.staff_invoice_default_series default_series[\s\S]*max\([\s\S]*invoice\.num[\s\S]*\) \+ 1/,
  );
  assert.match(
    reconciliationMigration,
    /create or replace function public\.next_staff_invoice_num[\s\S]*greatest\([\s\S]*series\.next_number[\s\S]*\) \+ 1/,
  );
  assert.match(
    reconciliationMigration,
    /create or replace function public\.peek_staff_invoice_num[\s\S]*greatest\([\s\S]*default_series\.next_number/,
  );
  assert.doesNotMatch(reconciliationMigration, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
});

test("the server validates the requested number and preserves lifecycle locks", () => {
  for (const num of ["x".repeat(81), `INV${String.fromCharCode(0)}BAD`, `INV${String.fromCharCode(10)}BAD`]) {
    assert.equal(StaffInvoiceSaveSchema.safeParse({ ...validBillingRequest(), num }).success, false);
  }
  assert.equal(StaffInvoiceSaveSchema.safeParse({ ...validBillingRequest(), userTypedNum: "false" }).success, false);
  assert.match(atomicSaveMigration, /v_existing\.state not in \('draft', 'submitted'\)/);
  assert.match(atomicSaveMigration, /v_existing\.qbo_invoice_id is not null/);
});
test("quote conversion delegates number allocation inside the atomic financial save", async () => {
  const h = billingRouteHarness();
  const response = await h.handlers.POST(h.request("POST", { ...validBillingRequest(), num: "", userTypedNum: false }));
  assert.equal(response.status, 200);
  const saves = h.calls.filter(call => call.name === "rpc:save_staff_billing_invoice_v4");
  assert.equal(saves.length, 1);
  assert.ok(!h.calls.some(call => call.name === "rpc:next_staff_invoice_num"));
  const args = saves[0].payload as { p_payload: { userTypedNum: boolean; num: string } };
  assert.equal(args.p_payload.userTypedNum, false);
  assert.equal(args.p_payload.num, "");
});
test("edited invoice numbers are preserved and number conflicts are not retried outside the transaction", async () => {
  const h = billingRouteHarness({ commandError: { code: "23505", message: "Synthetic duplicate number" } });
  const response = await h.handlers.POST(h.request("POST", { ...validBillingRequest(), num: "MANUAL-123", userTypedNum: true }));
  assert.equal(response.status, 409);
  const saves = h.calls.filter(call => call.name === "rpc:save_staff_billing_invoice_v4");
  assert.equal(saves.length, 1);
  assert.equal((saves[0].payload as { p_payload: { num: string } }).p_payload.num, "MANUAL-123");
});

test("renumbering records the old and new values in staff-only activity", () => {
  assert.match(atomicSaveMigration, /renumbered to #%s and %s/);
  assert.match(atomicSaveMigration, /'previousInvoiceNum', v_previous_num/);
  assert.match(atomicSaveMigration, /is_staff_only/);
  assert.match(atomicSaveMigration, /'staff_billing'/);
});
