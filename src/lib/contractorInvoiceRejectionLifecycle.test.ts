import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const migration = read("supabase/migrations/0060_contractor_invoice_rejection_lifecycle.sql");
const aliasHotfix = read("supabase/migrations/0061_fix_invoice_review_work_order_alias.sql");
const workOrderHook = read("src/features/work-orders/useWorkOrders.ts");
const invoiceHook = read("src/features/invoices/useInvoices.ts");
const invoiceModal = read("src/features/invoices/InvoiceCreateModal.tsx");
const invoiceDetail = read("src/features/invoices/InvoiceDetail.tsx");
const invoiceList = read("src/features/invoices/InvoiceList.tsx");
const workOrderDetail = read("src/features/work-orders/WorkOrderDetail.tsx");
const portalShell = read("src/components/PortalShell.tsx");
const notificationRoute = read("src/app/api/notifications/invoice-review/route.ts");

test("migration installs an atomic, guarded contractor invoice lifecycle", () => {
  assert.match(migration, /^begin;/m);
  assert.match(migration, /^commit;/m);
  assert.match(migration, /review_revision integer not null default 1/);
  assert.match(migration, /before insert or update on public\.invoices/);
  assert.match(migration, /old\.state in \('submitted', 'revised'\)/);
  assert.match(migration, /old\.state = 'rejected'[\s\S]*new\.state = 'revised'/);
  assert.match(migration, /old\.state = 'rejected'[\s\S]*new\.state = 'approved'/);
  assert.match(migration, /raise exception 'Invoice cannot move from % to % in this operation'/);
});

test("review is per invoice and rejected siblings remain unresolved", () => {
  assert.match(migration, /create or replace function public\.contractor_invoice_work_order_status/);
  assert.match(migration, /invoice\.state not in \('approved', 'paid'\)/);
  assert.match(migration, /create or replace function public\.review_contractor_invoice/);
  assert.match(migration, /where candidate\.id = p_invoice_id[\s\S]*for update;/);
  assert.match(migration, /activity_key := 'invoice_approved'/);
  assert.match(migration, /activity_key := 'invoice_rejected'/);
  assert.match(migration, /'invoiceNum', invoice\.num/);
  assert.match(migration, /Invoice belongs to a prior contractor assignment and cannot be reviewed/);
  assert.match(workOrderHook, /contractorInvoiceWorkOrderStatus/);
  assert.doesNotMatch(workOrderHook, /All contractor invoices approved/);
});

test("rejected invoice resubmission preserves identity and replaces content atomically", () => {
  const signature = migration.match(
    /create or replace function public\.resubmit_rejected_contractor_invoice\(([\s\S]*?)\)\s*returns jsonb/,
  );
  assert.ok(signature);
  assert.doesNotMatch(signature[1], /p_num/);
  assert.match(migration, /invoice\.state <> 'rejected'/);
  assert.match(migration, /public\.can_invoice_for_contractor\(invoice\.contractor_id\)/);
  assert.match(migration, /public\.can_access_contractor_work_order\(invoice\.work_order_id\)/);
  assert.match(migration, /invoice\.created_at >= candidate\.contractor_assignment_started_at/);
  assert.match(migration, /state = 'revised'/);
  assert.match(migration, /review_revision = candidate\.review_revision \+ 1/);
  assert.match(migration, /delete from public\.invoice_lines/);
  assert.match(migration, /insert into public\.invoice_lines/);
  assert.match(migration, /'invoice_resubmitted'/);
});

test("staff can retract only an untouched rejection and the correction is audited", () => {
  assert.match(migration, /create or replace function public\.retract_contractor_invoice_rejection/);
  assert.match(migration, /if invoice\.state <> 'rejected'/);
  assert.match(migration, /set state = 'approved'/);
  assert.match(migration, /'invoice_rejection_retracted'/);
  assert.match(migration, /its rejection cannot be retracted here/);
  assert.match(invoiceHook, /retractContractorInvoiceRejection/);
  assert.match(invoiceDetail, /Undo rejection and approve/);
  assert.match(workOrderDetail, /Undo rejection and approve/);
});

test("contractor UI exposes correction only for rejected invoices", () => {
  assert.match(invoiceDetail, /canEditRejectedContractorInvoice/);
  assert.match(invoiceDetail, /Edit and resubmit/);
  assert.match(invoiceList, /canEditRejectedContractorInvoice/);
  assert.match(invoiceList, /Edit and resubmit/g);
  assert.match(workOrderDetail, /canEditRejectedContractorInvoice/);
  assert.match(invoiceModal, /resubmittingRejected: isRejectedResubmission/);
  assert.match(invoiceModal, /readOnly=\{isRejectedResubmission\}/);
  assert.match(invoiceModal, /!isRejectedResubmission/);
  assert.match(invoiceModal, /Resubmit invoice/);
  assert.match(invoiceHook, /resubmitRejectedContractorInvoice/);
  assert.match(portalShell, /i\.state === "rejected"/);
});

test("rejection notification endpoint authenticates staff and scopes company recipients", () => {
  const authCheck = notificationRoute.indexOf("await requireStaff(request)");
  const serviceUse = notificationRoute.indexOf("auth.sb");
  assert.ok(authCheck >= 0 && serviceUse > authCheck);
  assert.match(notificationRoute, /STAFF_ROLES/);
  assert.match(notificationRoute, /loadStaffPermissions/);
  assert.match(notificationRoute, /isInvoiceControllerProfile/);
  assert.doesNotMatch(notificationRoute, /INVOICE_CONTROLLER_EMAIL/);
  assert.match(notificationRoute, /\.eq\("active", true\)/);
  assert.match(notificationRoute, /\.eq\("contractor_access_level", "company_admin"\)/);
  assert.match(notificationRoute, /invoice\.created_by/);
  assert.match(notificationRoute, /revision: invoice\.review_revision/);
  assert.doesNotMatch(notificationRoute, /report_only/);
  assert.match(invoiceHook, /notifyInvoiceReview\(inv\.id, "rejected"\)/);
});

test("invoice activity remains behind the contractor invoicing permission ceiling", () => {
  assert.match(migration, /drop policy if exists act_read on public\.activities/);
  assert.match(migration, /'invoice_resubmitted'/);
  assert.match(migration, /public\.can_invoice_for_contractor/);
  assert.match(migration, /coalesce\(activity\.event_key, ''\) <> 'invoice_rejected'/);
  assert.match(migration, /Pending contractor attention item not found/);
});

test("invoice review work-order aliases are unambiguous", () => {
  // Applied migrations remain immutable; 0061 replaces the affected live
  // functions without rewriting the historical 0060 migration.
  assert.match(migration, /update public\.work_orders work_order\n  set status = case/);
  assert.match(aliasHotfix, /create or replace function public\.review_contractor_invoice/);
  assert.match(aliasHotfix, /create or replace function public\.retract_contractor_invoice_rejection/);
  assert.match(aliasHotfix, /update public\.work_orders target_work_order/);
  assert.doesNotMatch(aliasHotfix, /update public\.work_orders work_order\n  set status = case/);
});
