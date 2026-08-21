import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/0082_atomic_work_order_reopen.sql");
const db = read("src/lib/db.ts");
const hook = read("src/features/work-orders/useWorkOrders.ts");
const shell = read("src/components/PortalShell.tsx");
const detail = read("src/features/work-orders/WorkOrderDetail.tsx");
const history = read("src/features/work-orders/HistoryView.tsx");

const reopenStart = migration.indexOf("create or replace function public.reopen_work_order");
const completionStart = migration.indexOf("create or replace function public.complete_work_order_once");
const reopenFunction = migration.slice(reopenStart, completionStart);
const hookReopenStart = hook.indexOf("const doReopen = async");
const hookReopenEnd = hook.indexOf("// Staff-only edit of WO header fields", hookReopenStart);
const hookReopen = hook.slice(hookReopenStart, hookReopenEnd);

test("reopen is one authorized and row-locked database transition", () => {
  assert.ok(reopenStart >= 0);
  assert.ok(completionStart > reopenStart);
  assert.match(reopenFunction, /language plpgsql[\s\S]*security definer/);
  assert.match(reopenFunction, /profile\.active = true/);
  assert.match(reopenFunction, /profile\.role in \('manager', 'dispatcher', 'back_office'\)/);
  assert.match(reopenFunction, /profile_has_staff_permission\(v_actor\.id, 'invoice_controller'\)/);
  assert.match(reopenFunction, /from public\.work_orders work_order[\s\S]*for update/);
  assert.match(reopenFunction, /if v_work_order\.status <> 'closed'/);
  assert.match(reopenFunction, /'reason', 'already_open'/);
});

test("the database validates purpose and the required audit reason", () => {
  assert.match(reopenFunction, /v_mode not in \('resume_work', 'billing_follow_up'\)/);
  assert.match(reopenFunction, /char_length\(v_reason\) < 3/);
  assert.match(reopenFunction, /char_length\(v_reason\) > 1000/);
  assert.match(reopenFunction, /'mode', v_mode/);
  assert.match(reopenFunction, /'reason', v_reason/);
  assert.match(reopenFunction, /'work_order_reopened'/);
  assert.match(reopenFunction, /is_staff_only[\s\S]*true/);
});

test("mode-specific status rules protect billing-only, invoices, and capital", () => {
  assert.match(reopenFunction, /if v_work_order\.billing_only then/);
  assert.match(reopenFunction, /invoice\.state not in \('draft', 'approved', 'paid'\)/);
  assert.match(reopenFunction, /if v_unresolved_contractor_invoices > 0 then/);
  assert.match(reopenFunction, /document_kind = 'capital_quote'/);
  assert.match(reopenFunction, /invoice\.state in \('approved', 'paid'\)/);
  assert.match(reopenFunction, /v_next_status := 'pending_capital_completion'/);
  assert.match(reopenFunction, /v_next_status := 'capital'/);
  assert.match(reopenFunction, /v_next_status := 'unassigned'/);
  assert.match(reopenFunction, /v_next_status := 'assigned'/);
  assert.match(reopenFunction, /public\.contractor_invoice_work_order_status\(v_work_order\.id\)/);
});

test("reopen preserves invoices, assignments, visits, and historical activities", () => {
  assert.doesNotMatch(reopenFunction, /update public\.invoices/i);
  assert.doesNotMatch(reopenFunction, /update public\.work_order_visits/i);
  assert.doesNotMatch(reopenFunction, /delete from public\.activities/i);
  assert.doesNotMatch(reopenFunction, /delete from public\.invoices/i);
  assert.doesNotMatch(reopenFunction, /delete from public\.work_order_visits/i);
  assert.doesNotMatch(reopenFunction, /assigned_technician_profile_id\s*=/i);
  assert.doesNotMatch(reopenFunction, /contractor_id\s*=/i);
  assert.match(reopenFunction, /'invoicesChanged', false/);
  assert.match(reopenFunction, /'assignmentsChanged', false/);
  assert.match(reopenFunction, /'visitsChanged', false/);
});

test("a private transaction permit blocks raw client reopen and cycle tampering", () => {
  assert.match(migration, /work_order_reopen_transition_guards/);
  assert.match(migration, /revoke all on public\.work_order_reopen_transition_guards[\s\S]*authenticated/);
  assert.match(migration, /transition_guard\.transaction_id = txid_current\(\)/);
  assert.match(migration, /transition_guard\.actor_id = auth\.uid\(\)/);
  assert.match(migration, /after update on public\.work_orders/);
  assert.doesNotMatch(migration, /before update of status, workflow_cycle on public\.work_orders/);
  assert.match(migration, /contractor-assignment BEFORE trigger can change status/);
  assert.match(migration, /Closed work orders must be reopened through the reopen workflow/);
  assert.match(migration, /Work-order workflow cycle can only change during reopen/);
  assert.doesNotMatch(migration, /set_config\(/);
});

test("reopened work can complete again without rewriting prior completion history", () => {
  assert.match(migration, /add column if not exists workflow_cycle integer not null default 0/g);
  assert.match(migration, /activities_one_job_completion_per_workflow_cycle/);
  assert.match(migration, /work_order_id,[\s\S]*contractor_assignment_version,[\s\S]*workflow_cycle/);
  assert.match(migration, /activity\.workflow_cycle = v_work_order\.workflow_cycle/);
  assert.match(migration, /v_next_workflow_cycle := v_work_order\.workflow_cycle \+ 1/);
  assert.match(migration, /protect_activity_workflow_cycle_trigger/);
});

test("only authenticated operational calls can execute the reopen RPC", () => {
  assert.match(migration, /revoke all on function public\.reopen_work_order\(text, text, text\)[\s\S]*from public, anon/);
  assert.match(migration, /grant execute on function public\.reopen_work_order\(text, text, text\)[\s\S]*to authenticated, service_role/);
});

test("the client calls only the atomic RPC and patches after it commits", () => {
  assert.match(db, /rpc\("reopen_work_order", \{/);
  assert.match(hookReopen, /await reopenWorkOrder\(woId, mode, reason\)/);
  assert.doesNotMatch(hookReopen, /updateWorkOrder\(/);
  assert.doesNotMatch(hookReopen, /insertActivity\(/);
  assert.doesNotMatch(hookReopen, /loadWorkOrderInvoicesForMutation/);
  assert.ok(hookReopen.indexOf("await reopenWorkOrder") < hookReopen.indexOf("patchLocalWO"));
  assert.match(hookReopen, /invalidateWorkOrders\(\)/);
});

test("History and detail expose a guarded, deliberate reopen workflow", () => {
  assert.match(history, /canReopen/);
  assert.match(history, /onRequestReopen\?\.\(w\)/);
  assert.match(detail, /woData\.status === "closed" && isManager && !invoiceController/);
  assert.match(detail, /onRequestReopen\?\.\(woData\)/);
  assert.match(shell, /canReopen=\{isManager && !invoiceController\}/);
  assert.match(shell, /role="radiogroup" aria-label="Reopen purpose"/);
  assert.match(shell, /validateWorkOrderReopenReason\(reopenReason\)/);
  assert.match(shell, /Existing invoices, contractor and technician assignments, historical activities, and prior visits will not be changed/);
  assert.match(shell, /Reopening sends no dispatch notification/);
});
