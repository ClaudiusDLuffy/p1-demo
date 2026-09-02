import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/0111_reject_unassigned_work_orders.sql");
const audit = read("supabase/audits/0111_reject_unassigned_work_orders_verification.sql");
const dataLayer = read("src/lib/db.ts");
const hook = read("src/features/work-orders/useWorkOrders.ts");
const detail = read("src/features/work-orders/WorkOrderDetail.tsx");
const shell = read("src/components/PortalShell.tsx");

const functionStart = migration.indexOf(
  "create or replace function public.reject_unassigned_work_order",
);
const rejectionFunction = migration.slice(functionStart);

test("dispatch rejection is an atomic staff-only soft removal", () => {
  assert.ok(functionStart >= 0);
  assert.match(rejectionFunction, /language plpgsql[\s\S]*security definer/);
  assert.match(rejectionFunction, /set search_path = public, pg_temp/);
  assert.match(rejectionFunction, /profile\.active = true/);
  assert.match(rejectionFunction, /profile\.role in \('manager', 'dispatcher', 'back_office'\)/);
  assert.match(rejectionFunction, /profile_has_staff_permission\(v_actor\.id, 'invoice_controller'\)/);
  assert.match(rejectionFunction, /from public\.work_orders work_order[\s\S]*for update/);
  assert.match(rejectionFunction, /char_length\(v_reason\) < 5[\s\S]*char_length\(v_reason\) > 500/);

  const auditInsert = rejectionFunction.indexOf("insert into public.activities");
  const softRemoval = rejectionFunction.indexOf("update public.work_orders work_order");
  assert.ok(auditInsert >= 0 && softRemoval > auditInsert);
  assert.doesNotMatch(rejectionFunction, /delete\s+from\s+public\.work_orders/i);
});

test("only a truly never-assigned and unbilled work order can be rejected", () => {
  assert.match(rejectionFunction, /v_work_order\.status <> 'unassigned'/);
  assert.match(rejectionFunction, /v_work_order\.functional_status::text[\s\S]*<> 'New'/);
  assert.match(rejectionFunction, /v_work_order\.contractor_assignment_version <> 0/);
  assert.match(rejectionFunction, /v_work_order\.contractor_assignment_started_at is not null/);
  assert.match(rejectionFunction, /from public\.work_order_assignment_history history/);
  assert.match(rejectionFunction, /from public\.invoices invoice[\s\S]*invoice\.deleted_at is null/);
  assert.match(rejectionFunction, /using errcode = 'PT409'/);
  assert.match(rejectionFunction, /'work_order_rejected'/);
  assert.match(rejectionFunction, /'system_event'/);
  assert.match(rejectionFunction, /true,[\s\S]*false,[\s\S]*false,[\s\S]*'work_order_rejected'/);
});

test("archive columns and archived rows are protected from contractor updates", () => {
  assert.match(migration, /create or replace function public\.guard_work_order_archive_mutations/);
  assert.match(migration, /if old\.deleted_at is not null[\s\S]*Archived work orders cannot be changed/);
  assert.match(migration, /new\.deleted_at is distinct from old\.deleted_at/);
  assert.match(migration, /new\.deleted_by is distinct from old\.deleted_by/);
  assert.match(migration, /not public\.is_staff\(\)/);
  assert.match(migration, /or public\.is_invoice_controller\(\)/);
  assert.match(migration, /before update on public\.work_orders/);
  assert.match(migration, /revoke all on function public\.guard_work_order_archive_mutations\(\)[\s\S]*authenticated/);
});

test("invoice attachment serializes with rejection and rejects archived parents", () => {
  assert.match(
    migration,
    /create or replace function public\.guard_invoice_active_work_order/,
  );
  assert.match(
    migration,
    /work_order\.deleted_at is null[\s\S]*for share/,
  );
  assert.match(
    migration,
    /before insert or update of work_order_id, deleted_at on public\.invoices/,
  );
  assert.match(
    migration,
    /old\.deleted_at is not null[\s\S]*new\.deleted_at is null/,
  );
  const invoiceGuardStart = migration.indexOf(
    "create or replace function public.guard_invoice_active_work_order",
  );
  const rejectionStart = migration.indexOf(
    "create or replace function public.reject_unassigned_work_order",
  );
  const invoiceGuard = migration.slice(invoiceGuardStart, rejectionStart);
  assert.doesNotMatch(invoiceGuard, /service_role/);
  assert.match(
    migration,
    /Invoices cannot be attached to an archived work order/,
  );
  assert.match(
    migration,
    /revoke all on function public\.guard_invoice_active_work_order\(\)[\s\S]*authenticated/,
  );
});

test("the portal confirms a reason and waits for the RPC before navigating", () => {
  assert.match(dataLayer, /rpc\("reject_unassigned_work_order"/);
  assert.match(hook, /await rejectUnassignedWorkOrder\(woId, normalizedReason\)/);
  assert.match(hook, /await rejectUnassignedWorkOrder[\s\S]*setWorkOrders\(prev => prev\.filter/);
  assert.match(hook, /setPage\("dashboard"\)/);
  assert.match(detail, /canRejectUnassignedWorkOrder/);
  assert.match(detail, /setModal\("rejectUnassignedWO"\)/);
  assert.match(shell, /title="Reject work order\?"/);
  assert.match(shell, /Reason \(required\)/);
  assert.match(shell, /rejectWorkOrderReason\.trim\(\)\.length < 5/);
  assert.match(shell, /await doRejectUnassignedWO/);
});

test("the deployment audit is read-only and verifies scope plus privileges", () => {
  assert.match(audit, /rejection_function_guarded/);
  assert.match(audit, /archive_guard_trigger_enabled/);
  assert.match(audit, /invoice_parent_guard_trigger_enabled/);
  assert.match(audit, /invoice_parent_lock_guarded/);
  assert.match(audit, /invoice_restore_guarded/);
  assert.match(audit, /service_role_invoice_parent_guarded/);
  assert.match(audit, /anonymous_rejection_blocked/);
  assert.match(audit, /rejection_activity_scope_issue_count/);
  assert.match(audit, /rejected_work_order_state_issue_count/);
  assert.match(audit, /rejected_work_order_invoice_issue_count/);
  assert.match(audit, /as all_checks_pass/);
  assert.doesNotMatch(audit, /\b(?:insert|update|delete)\s+(?:into\s+|from\s+)?public\./i);
});
