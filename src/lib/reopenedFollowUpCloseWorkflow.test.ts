import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/0119_close_reopened_follow_up_without_billing.sql");
const database = read("src/lib/db.ts");
const hook = read("src/features/work-orders/useWorkOrders.ts");
const detail = read("src/features/work-orders/WorkOrderDetail.tsx");
const modal = read("src/features/work-orders/CloseReopenedFollowUpModal.tsx");
const shell = read("src/components/PortalShell.tsx");
const workOrderView = read("src/lib/workOrderView.ts");

test("follow-up close is one guarded and stale-safe database transition", () => {
  assert.match(migration, /close_reopened_work_order_without_additional_billing\([\s\S]*p_expected_workflow_cycle integer[\s\S]*p_expected_contractor_assignment_version integer[\s\S]*p_expected_updated_at timestamptz/);
  assert.match(migration, /profile\.active = true[\s\S]*profile\.role in \('manager', 'dispatcher', 'back_office'\)/);
  assert.match(migration, /profile_has_staff_permission\(v_actor\.id, 'invoice_controller'\)/);
  assert.match(migration, /from public\.work_orders work_order[\s\S]*for update/);
  assert.match(migration, /workflow_cycle is distinct from p_expected_workflow_cycle/);
  assert.match(migration, /contractor_assignment_version[\s\S]*p_expected_contractor_assignment_version/);
  assert.match(migration, /updated_at is distinct from p_expected_updated_at/);
  assert.match(migration, /status::text not in \([\s\S]*'unassigned', 'assigned', 'wip', 'parts', 'completed'/);
});

test("follow-up close proves the prior cycle and rejects unresolved current work", () => {
  assert.match(migration, /event_key = 'work_order_reopened'[\s\S]*event_data ->> 'mode'.*'resume_work'/);
  assert.match(migration, /invoice\.created_at >= v_reopen_activity\.created_at/);
  assert.match(migration, /activity\.requires_7eleven_sync = true[\s\S]*synced_to_7eleven_at is null/);
  assert.match(migration, /activity\.requires_contractor_attention = true[\s\S]*contractor_attention_acknowledged_at is null/);
  assert.match(migration, /invoice\.id::text = activity\.event_data ->> 'invoiceId'/);
  assert.match(migration, /invoice\.state in \('approved', 'paid'\)/);
  assert.match(migration, /activity\.workflow_cycle < v_work_order\.workflow_cycle/);
  assert.match(migration, /Every prior P1 invoice must be billed to 7-Eleven/);
  assert.match(migration, /billing_activity\.event_key in \([\s\S]*'staff_invoice_ready'[\s\S]*'invoice_resubmitted'[\s\S]*'invoice_approved'/);
  assert.match(migration, /created_at >= v_reopen_activity\.created_at/);
});

test("follow-up close preserves billing data and writes one auditable cycle close", () => {
  assert.doesNotMatch(migration, /delete from public\.invoices/);
  assert.match(migration, /update public\.work_order_visits/);
  assert.match(migration, /set status = 'closed',[\s\S]*functional_status = 'Completed'/);
  assert.match(migration, /'work_order_follow_up_closed_without_additional_billing'/);
  assert.match(migration, /'invoicesChanged', false/);
  assert.match(migration, /activities_follow_up_close_cycle_unique/);
  assert.match(migration, /grant execute on function public\.close_reopened_work_order_without_additional_billing\([\s\S]*to authenticated, service_role/);
});

test("pending field activity and visits cannot reopen terminal work", () => {
  assert.match(migration, /guard_terminal_work_order_activity_mutation\(\)[\s\S]*for key share/);
  assert.match(migration, /tg_op = 'INSERT'[\s\S]*new\.activity_channel = 'field_note'/);
  assert.match(migration, /new\.requires_7eleven_sync = true[\s\S]*new\.synced_to_7eleven_at is null/);
  assert.match(migration, /new\.requires_contractor_attention = true[\s\S]*new\.contractor_attention_acknowledged_at is null/);
  assert.match(migration, /zz_guard_terminal_work_order_activity_trigger[\s\S]*before insert or update/);
  assert.match(migration, /guard_terminal_work_order_visit_mutation\(\)[\s\S]*v_work_order_status = 'closed'/);
  assert.match(migration, /old\.check_out_at is not null and new\.check_out_at is null/);
  assert.match(migration, /zz_guard_terminal_work_order_visit_mutation_trigger[\s\S]*before insert or update/);
});

test("direct terminal updates and forged lifecycle evidence are blocked", () => {
  assert.match(migration, /create table if not exists public\.work_order_close_transition_guards/);
  assert.match(migration, /revoke all on public\.work_order_close_transition_guards[\s\S]*authenticated, service_role/);
  assert.match(migration, /prevent_direct_work_order_close\(\)[\s\S]*work_order_close_transition_guards/);
  assert.match(migration, /zz_prevent_direct_work_order_close_trigger[\s\S]*before insert or update/);
  assert.match(migration, /Work orders cannot be created in a closed state/);
  assert.match(migration, /new\.closed_at is distinct from old\.closed_at/);
  assert.match(migration, /protect_authoritative_close_activity\(\)[\s\S]*Authoritative work-order lifecycle activity is immutable/);
  assert.match(migration, /Billed-to-7-Eleven activity must be created by the billing workflow/);
  assert.match(migration, /Terminal close activity must be created by its owning workflow/);
  assert.match(migration, /activities_one_reopen_per_workflow_cycle/);
  assert.match(migration, /create or replace function public\.close_work_order_without_invoice\([\s\S]*'without_invoice'/);
});

test("no-invoice close rejects a delayed request after a newer reopen cycle", () => {
  const noInvoiceClose = migration.slice(
    migration.indexOf("create or replace function public.close_work_order_without_invoice("),
    migration.indexOf("-- Keep the V3 RPC signature"),
  );
  assert.match(noInvoiceClose, /workflow_cycle is distinct from p_expected_workflow_cycle/);
  assert.ok(noInvoiceClose.indexOf("workflow_cycle is distinct") < noInvoiceClose.indexOf("status = 'closed'"));
  assert.match(noInvoiceClose, /updated_at is distinct from p_expected_updated_at/);
  assert.match(migration, /revoke all on function public\.close_work_order_without_invoice\(text\)\s+from public, anon, authenticated, service_role/);
});

test("invoice acknowledgment remains available without permitting evidence edits", () => {
  const protection = migration.slice(
    migration.indexOf("create or replace function public.protect_authoritative_close_activity()"),
    migration.indexOf("drop trigger if exists zy_protect_authoritative_close_activity_trigger"),
  );
  assert.match(protection, /v_old_protected := old.event_key in \([\s\S]*'invoice_submitted'[\s\S]*'invoice_rejected'/);
  assert.match(protection, /to_jsonb\(new\) - array\[[\s\S]*'contractor_attention_acknowledged_at'/);
  assert.doesNotMatch(protection, /- array\[[^\]]*'(deleted_at|event_data|created_at)'/);
});

test("staff-invoice wrapper migration can be replayed without a second rename", () => {
  assert.match(migration, /to_regprocedure\([\s\S]*save_staff_billing_invoice_v3_core/);
  assert.match(migration, /if to_regprocedure\([\s\S]*\) is null then[\s\S]*rename to save_staff_billing_invoice_v3_core/);
});

test("invoice and QuickBooks paths cannot reopen or mutate a newer operational cycle", () => {
  assert.match(migration, /rename to save_staff_billing_invoice_v3_core/);
  assert.match(migration, /create or replace function public\.save_staff_billing_invoice_v3\([\s\S]*from public\.work_orders work_order[\s\S]*for update/);
  assert.match(migration, /before insert or update of work_order_id, deleted_at, invoice_type/);
  assert.match(migration, /v_already_finalized[\s\S]*'already_billed'[\s\S]*return jsonb_build_object/);
  assert.match(migration, /v_work_order\.status = 'closed'[\s\S]*work_order_follow_up_closed_without_additional_billing[\s\S]*reopen it before billing another invoice/);
  assert.match(migration, /quickbooks_transition = 'confirm' then[\s\S]*return null/);
});

test("staff UI requires a reason and submits the exact optimistic-concurrency snapshot", () => {
  assert.match(detail, /canCloseReopenedFollowUpWithoutBilling/);
  assert.match(detail, /hasCompleteEvidence:[\s\S]*contractorInvoiceQuery\.data\?\.hasMore === false[\s\S]*billingInvoiceQuery\.data\?\.hasMore === false[\s\S]*activityPage\?\.hasMore === false/);
  assert.match(detail, /setModal\("closeReopenedFollowUp"\)/);
  assert.match(detail, /Close follow-up — no additional billing/);
  assert.match(modal, /validateFollowUpCloseReason\(reason\)/);
  assert.match(modal, /Existing contractor and P1 invoices will remain unchanged/);
  assert.match(shell, /modal === "closeReopenedFollowUp"/);
  assert.match(shell, /woData\.workflowCycle[\s\S]*woData\.contractorAssignmentVersion[\s\S]*woData\.updatedAt[\s\S]*reason/);
  assert.match(database, /p_expected_workflow_cycle: expectedWorkflowCycle/);
  assert.match(database, /p_expected_contractor_assignment_version:[\s\S]*expectedContractorAssignmentVersion/);
  assert.match(database, /p_expected_updated_at: expectedUpdatedAt/);
  assert.match(hook, /closeReopenedWorkOrderWithoutAdditionalBilling/);
});

test("unsafe legacy close is absent and closure attribution recognizes this event", () => {
  assert.doesNotMatch(hook, /const doCloseWO/);
  assert.doesNotMatch(shell, /modal === "closeWO"/);
  assert.match(workOrderView, /work_order_follow_up_closed_without_additional_billing/);
});
