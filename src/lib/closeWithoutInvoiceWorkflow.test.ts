import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/0069_close_work_order_without_invoice.sql");
const detail = read("src/features/work-orders/WorkOrderDetail.tsx");
const shell = read("src/components/PortalShell.tsx");
const hook = read("src/features/work-orders/useWorkOrders.ts");
const capitalWorkflow = read("supabase/migrations/0068_pending_capital_completion_workflow.sql");

test("close without invoice is an atomic operational-staff transition", () => {
  assert.match(migration, /create or replace function public\.close_work_order_without_invoice/);
  assert.match(migration, /profile\.active = true/);
  assert.match(migration, /profile\.role in \('manager', 'dispatcher', 'back_office'\)/);
  assert.match(migration, /profile_has_staff_permission\(v_actor\.id, 'invoice_controller'\)/);
  assert.match(migration, /from public\.work_orders[\s\S]*for update/);
  assert.match(migration, /from public\.invoices invoice[\s\S]*invoice\.deleted_at is null/);
  assert.match(migration, /if v_invoice_count > 0 then/);
  assert.match(migration, /update public\.work_order_visits/);
  assert.match(migration, /set status = 'closed'/);
  assert.match(migration, /'work_order_closed_without_invoice'/);
  assert.match(migration, /'closed_without_invoice'/);
});

test("closed work orders reject unsafe new invoice headers at the database boundary", () => {
  assert.match(migration, /prevent_invoice_on_closed_work_order/);
  assert.match(migration, /before insert on public\.invoices/);
  assert.match(migration, /for key share/);
  assert.match(migration, /new\.invoice_type = 'contractor'/);
  assert.match(migration, /v_status <> 'closed'/);
  assert.match(migration, /activity\.event_key = 'work_order_closed_without_invoice'/);
  assert.match(migration, /new\.invoice_type = 'staff'/);
  assert.match(migration, /auth\.role\(\)[\s\S]*= 'service_role'/);
});

test("the UI separates no-invoice close from the existing invoiced close path", () => {
  assert.match(detail, /const hasAnyLiveInvoice = woAllInvoices\.length > 0 \|\| woBillingInvoices\.length > 0/);
  assert.match(detail, /hasAnyLiveInvoice \? \(/);
  assert.match(detail, /setModal\("closeWithoutInvoice"\)/);
  assert.match(detail, /Close — no invoice/);
  assert.match(detail, /setModal\("closeWO"\)/);
  assert.match(shell, /modal === "closeWithoutInvoice"/);
  assert.match(shell, /await doCloseWithoutInvoice\(woData\.id\)/);
  assert.match(hook, /closeWorkOrderWithoutInvoice\(woId\)/);
  assert.match(hook, /doCloseWO, doCloseWithoutInvoice, doReopen/);
});

test("the existing capital quote handoff still parks work in pending capital completion", () => {
  assert.match(capitalWorkflow, /v_requires_capital_authorization/);
  assert.match(capitalWorkflow, /set status = 'pending_capital_completion'/);
  assert.match(capitalWorkflow, /'capital_invoice_sent'/);
  assert.match(capitalWorkflow, /create or replace function public\.resume_capital_work/);
});
