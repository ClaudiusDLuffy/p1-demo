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
const notificationCommands = read("src/lib/financialNotificationCommands.ts");
const notificationBoundary = read("supabase/migrations/0136_expand_financial_notification_delivery.sql");
const operationIdCorrection = read("supabase/migrations/0154_rfc_batch_financial_operation_ids.sql");

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

test("client uses one versioned batch RPC whose transaction owns rejected-invoice intent", () => {
  assert.match(database, /export async function reviewContractorInvoices/);
  assert.match(database, /return reviewInvoicesWithNotification\(/);
  assert.match(notificationCommands, /rpc\("review_contractor_invoices_with_notification_v1"/);
  assert.match(notificationCommands, /p_operation_id: operationId, p_expected_revisions: context\.revisions/);
  assert.match(invoiceHook, /await reviewContractorInvoices\(/);
  assert.match(notificationBoundary, /foreach v_id in array v_ids loop[\s\S]*review_contractor_invoice_with_notification_v1/);
  assert.match(notificationBoundary, /financial_notification_review_source after insert on public\.activities/);
  assert.match(invoiceHook, /notifications queued/);
  assert.doesNotMatch(invoiceHook, /notifyInvoiceReview|notifications\/invoice-review/);
  assert.match(portalShell, /doBatchReviewInvoices=\{doBatchReviewInvoices\}/);
});

test("batch child receipts use deterministic RFC UUIDs accepted by the client contract", () => {
  assert.match(operationIdCorrection, /v_child_digest := md5\(p_operation_id::text \|\| ':' \|\| v_id::text\)/);
  assert.match(operationIdCorrection, /substr\(v_child_digest, 9, 4\) \|\| '-5'/);
  assert.match(operationIdCorrection, /substr\(v_child_digest, 14, 3\) \|\| '-8'/);
  assert.doesNotMatch(operationIdCorrection, /md5\([^;]+\)::uuid/);
  assert.match(operationIdCorrection, /review_contractor_invoice_with_notification_v1\([\s\S]*v_child/);
});
