import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  "supabase/migrations/0160_restore_capital_sequence_state.sql",
  "utf8",
);
const detail = readFileSync(
  "src/features/work-orders/WorkOrderDetail.tsx",
  "utf8",
);
const hook = readFileSync(
  "src/features/work-orders/useWorkOrders.ts",
  "utf8",
);

test("capital decline restores open, paused, completed, and receiving-assignment field states", () => {
  assert.match(migration, /create or replace function public\.decline_capital_work_order_lc_core/);
  assert.match(migration, /v_work_order\.assignment_transfer_pending_visit/);
  assert.match(migration, /elsif v_has_open_visit then/);
  assert.match(migration, /elsif v_has_current_completion then/);
  assert.match(migration, /elsif v_has_closed_visit then/);
  assert.match(migration, /v_invoice_status := public\.contractor_invoice_work_order_status/);
  assert.match(migration, /'restoredFromVisitState', true/);
  assert.match(detail, /Capital declined - restore field workflow/);
  assert.match(hook, /result\.functionalStatus === "Work in Progress"/);
  assert.match(hook, /result\.functionalStatus === "Awaiting Parts"/);
  assert.match(hook, /result\.functionalStatus === "Completed"/);
});

test("administrative transfer accepts only an eligible open visit in ordinary or capital field states", () => {
  const start = migration.indexOf(
    "create or replace function public.administrative_close_visit_and_transfer_v1",
  );
  const end = migration.indexOf(
    "create or replace function public.resume_capital_work_lc_core",
  );
  assert.ok(start >= 0 && end > start);
  const command = migration.slice(start, end);
  assert.match(command, /status::text not in \('wip','capital','pending_capital_completion'\)/);
  assert.match(command, /functional_status::text not in \('Work in Progress','Pending Capital Approval','Pending Capital Completion'\)/);
  assert.match(command, /v\.check_out_at is null for update/);
  assert.match(command, /v_visit\.contractor_id is distinct from v_work\.contractor_id/);
  assert.match(command, /'capitalStagePreserved',v_work\.status::text in \('capital','pending_capital_completion'\)/);
  assert.match(command, /closure_kind='administrative_transfer'/);
  assert.match(command, /duration_review_required=true/);
});

test("capital authorization opens a new completion cycle only after a current-cycle completion", () => {
  const start = migration.indexOf(
    "create or replace function public.resume_capital_work_lc_core",
  );
  assert.ok(start >= 0);
  const command = migration.slice(start);
  assert.match(command, /activity\.event_key = 'job_completed'/);
  assert.match(command, /activity\.contractor_assignment_version =/);
  assert.match(command, /activity\.workflow_cycle = v_work_order\.workflow_cycle/);
  assert.match(command, /v_next_workflow_cycle := v_work_order\.workflow_cycle[\s\S]*v_has_current_completion/);
  assert.match(command, /insert into public\.work_order_reopen_transition_guards/);
  assert.match(command, /workflow_cycle = v_next_workflow_cycle/);
  assert.match(command, /'newCompletionCycle', v_has_current_completion/);
});

test("migration preserves private cores and the authenticated-only transfer surface", () => {
  assert.match(migration, /security definer/g);
  assert.ok((migration.match(/set search_path ?= ?public, ?pg_temp/g) || []).length >= 3);
  assert.match(migration, /revoke all on function public\.decline_capital_work_order_lc_core[\s\S]*authenticated, service_role/);
  assert.match(migration, /revoke all on function public\.resume_capital_work_lc_core[\s\S]*authenticated, service_role/);
  assert.match(migration, /grant execute on function public\.administrative_close_visit_and_transfer_v1[\s\S]*to authenticated/);
  assert.doesNotMatch(migration, /grant execute on function public\.decline_capital_work_order_lc_core/);
  assert.doesNotMatch(migration, /grant execute on function public\.resume_capital_work_lc_core/);
});
