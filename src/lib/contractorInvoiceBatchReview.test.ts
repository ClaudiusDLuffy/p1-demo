import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

const migration = read(
  "supabase/migrations/0062_batch_contractor_invoice_review.sql",
);
const invoiceList = read("src/features/invoices/InvoiceList.tsx");
const invoiceHook = read("src/features/invoices/useInvoices.ts");
const database = read("src/lib/db.ts");
const portalShell = read("src/components/PortalShell.tsx");

test("batch review is transactional and delegates every row to the guarded lifecycle", () => {
  assert.match(migration, /^begin;/m);
  assert.match(migration, /^commit;/m);
  assert.match(
    migration,
    /create or replace function public\.review_contractor_invoices/,
  );
  assert.match(migration, /order by candidate\.id[\s\S]*for update;/);
  assert.match(migration, /order by target_work_order\.id[\s\S]*for update;/);
  assert.match(migration, /foreach invoice_id in array normalized_ids loop/);
  assert.match(migration, /public\.review_contractor_invoice\(/);
  assert.match(migration, /A batch can contain at most 100 invoices/);
});

test("batch review accepts only current contractor invoices awaiting review", () => {
  assert.match(migration, /candidate\.invoice_type = 'contractor'/);
  assert.match(migration, /candidate\.deleted_at is null/);
  assert.match(migration, /candidate\.state in \('submitted', 'revised'\)/);
  assert.match(
    migration,
    /One or more selected invoices are missing or no longer awaiting review/,
  );
  assert.match(migration, /A rejection reason is required/);
});

test("batch review remains staff-only and excludes the invoice controller", () => {
  assert.match(migration, /not public\.is_staff\(\)/);
  assert.match(migration, /public\.is_invoice_controller\(\)/);
  assert.match(invoiceList, /const canBatchReview = isManager && !controller/);
  assert.match(invoiceList, /invoice\.state === "submitted" \|\| invoice\.state === "revised"/);
});

test("invoice list provides desktop and mobile selection with explicit confirmations", () => {
  assert.match(invoiceList, /Select all visible submitted and revised invoices/);
  assert.match(invoiceList, /Select invoice \$\{inv\.num\} for batch review/g);
  assert.match(invoiceList, /Approve selected/);
  assert.match(invoiceList, /Reject selected/);
  assert.match(invoiceList, /Shared rejection reason/);
  assert.match(invoiceList, /none will be approved/);
  assert.match(invoiceList, /entire batch is rolled back/);
});

test("client uses one batch RPC and notifies every rejected invoice after commit", () => {
  assert.match(database, /export async function reviewContractorInvoices/);
  assert.match(database, /"review_contractor_invoices"/);
  assert.match(invoiceHook, /await reviewContractorInvoices\(/);
  assert.match(invoiceHook, /Promise\.allSettled\(/);
  assert.match(invoiceHook, /notifyInvoiceReview\(invoiceId, "rejected"\)/);
  assert.match(portalShell, /doBatchReviewInvoices=\{doBatchReviewInvoices\}/);
});
