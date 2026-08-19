import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const modal = readFileSync(
  resolve(process.cwd(), "src/features/billing/BillingInvoiceCreateModal.tsx"),
  "utf8",
);
const route = readFileSync(
  resolve(process.cwd(), "src/app/api/billing-invoices/route.ts"),
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
  assert.match(route, /const suppliedNum = String\(body\.num \|\| ""\)\.trim\(\)/);
  assert.match(route, /const requestedNum = userTypedNum[\s\S]*?suppliedNum[\s\S]*?nextStaffInvoiceNum\(auth\.sb, auth\.user\.id\)/);
  assert.match(route, /const userTypedNum = !!body\.userTypedNum && Boolean\(suppliedNum\)/);
  assert.match(route, /const desiredNum = String\(body\.num \|\| ""\)\.trim\(\)/);
  assert.match(route, /Invoice number is invalid/);
  assert.match(route, /!\["draft", "submitted"\]\.includes\(existing\.state\)/);
  assert.match(route, /existing\.qbo_invoice_id \|\| existing\.qbo_synced_at/);
  assert.match(route, /error\?\.code !== "23505"/);
  assert.match(atomicSaveMigration, /v_existing\.state not in \('draft', 'submitted'\)/);
  assert.match(atomicSaveMigration, /v_existing\.qbo_invoice_id is not null/);
});

test("quote conversion can atomically allocate a staff invoice number", () => {
  assert.match(route, /\.rpc\("next_staff_invoice_num", \{ p_actor_id: actorId \}\)/);
  assert.doesNotMatch(route, /if \(!requestedNum\) return jsonError\("Invoice number is required"/);
  assert.match(route, /const tax = await resolveTax[\s\S]*?const requestedNum = userTypedNum/);
});

test("new invoices preserve an edited number and only auto-retry untouched suggestions", () => {
  assert.match(route, /let desiredNum = requestedNum/);
  assert.match(route, /error\?\.code !== "23505" \|\| userTypedNum/);
  assert.match(route, /Invoice number \$\{desiredNum\} already exists/);
});

test("renumbering records the old and new values in staff-only activity", () => {
  assert.match(atomicSaveMigration, /renumbered to #%s and %s/);
  assert.match(atomicSaveMigration, /'previousInvoiceNum', v_previous_num/);
  assert.match(atomicSaveMigration, /is_staff_only/);
  assert.match(atomicSaveMigration, /'staff_billing'/);
});
