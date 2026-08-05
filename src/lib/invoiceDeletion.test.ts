import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const contractorRoute = readFileSync(
  resolve(process.cwd(), "src/app/api/contractor-invoices/route.ts"),
  "utf8",
);
const billingRoute = readFileSync(
  resolve(process.cwd(), "src/app/api/billing-invoices/route.ts"),
  "utf8",
);
const db = readFileSync(resolve(process.cwd(), "src/lib/db.ts"), "utf8");

test("contractor invoice deletion is authenticated staff-only server work", () => {
  assert.match(contractorRoute, /auth\.auth\.getUser\(token\)/);
  assert.match(contractorRoute, /STAFF_ROLES\.has/);
  assert.match(contractorRoute, /eq\("invoice_type", "contractor"\)/);
  assert.match(db, /\/api\/contractor-invoices\?id=/);
});

test("deletion reports linked billing invoices and verifies the updated row", () => {
  assert.match(contractorRoute, /is used by billing invoice/);
  assert.match(contractorRoute, /select\("id, num, work_order_id, deleted_at"\)/);
  assert.match(contractorRoute, /Invoice changed before it could be deleted/);
});

test("audit outages do not turn completed deletes into false UI failures", () => {
  assert.match(contractorRoute, /Contractor invoice delete audit failed/);
  assert.match(billingRoute, /Billing invoice delete audit failed/);
  assert.match(billingRoute, /Billing invoice changed before it could be deleted/);
});

