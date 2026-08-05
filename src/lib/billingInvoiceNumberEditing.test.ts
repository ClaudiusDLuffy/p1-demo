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

test("existing eligible P1 invoice numbers are editable but new ones stay automatic", () => {
  assert.match(modal, /readOnly=\{!isEditing\}/);
  assert.match(modal, /Editable until approval or QuickBooks sync/);
});

test("the server validates the requested number and preserves lifecycle locks", () => {
  assert.match(route, /const desiredNum = String\(body\.num \|\| ""\)\.trim\(\)/);
  assert.match(route, /Invoice number is invalid/);
  assert.match(route, /!\["draft", "submitted"\]\.includes\(existing\.state\)/);
  assert.match(route, /existing\.qbo_invoice_id \|\| existing\.qbo_synced_at/);
  assert.match(route, /updateError\?\.code === "23505"/);
});

test("renumbering records the old and new values in staff-only activity", () => {
  assert.match(route, /renumbered to #\$\{desiredNum\}/);
  assert.match(route, /previousInvoiceNum: previousNum/);
  assert.match(route, /is_staff_only: true/);
});
