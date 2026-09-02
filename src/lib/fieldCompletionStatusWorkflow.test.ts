import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read(
  "supabase/migrations/0113_preserve_invoice_status_on_field_completion.sql",
);
const audit = read(
  "supabase/audits/0113_preserve_invoice_status_on_field_completion_verification.sql",
);
const hook = read("src/features/work-orders/useWorkOrders.ts");

const functionStart = migration.indexOf(
  "create or replace function public.complete_work_order_once",
);
const completionFunction = migration.slice(functionStart);
const guardStart = migration.indexOf(
  "create or replace function public.prevent_direct_work_order_reopen",
);
const lifecycleGuard = migration.slice(guardStart, functionStart);

test("field completion preserves every invoice-driven work-order queue", () => {
  assert.ok(functionStart >= 0);
  assert.match(completionFunction, /v_result_status public\.wo_status/);
  for (const status of [
    "pending_invoice",
    "pending_approval",
    "pending_payment",
  ]) {
    assert.match(completionFunction, new RegExp(`'${status}'`));
  }
  assert.match(
    completionFunction,
    /then v_work_order\.status[\s\S]*else 'completed'::public\.wo_status/,
  );
  assert.match(completionFunction, /set status = v_result_status/);
  assert.doesNotMatch(completionFunction, /set status = 'completed'/);
  assert.match(
    hook,
    /status: workOrderStatusAfterFieldCompletion\(existing\?\.status\)/,
  );
});

test("the replacement RPC remains locked, replay-safe, and access controlled", () => {
  assert.match(completionFunction, /language plpgsql[\s\S]*security definer/);
  assert.match(completionFunction, /set search_path = public, pg_temp/);
  assert.match(completionFunction, /profile\.active = true[\s\S]*if not found/);
  assert.match(completionFunction, /can_access_contractor_work_order/);
  assert.match(
    completionFunction,
    /profile_has_staff_permission\([\s\S]*'invoice_controller'/,
  );
  assert.match(completionFunction, /from public\.work_orders work_order[\s\S]*for update/);
  assert.match(
    completionFunction,
    /functional_status::text = 'Completed'[\s\S]*'already_completed'/,
  );
  assert.match(
    completionFunction,
    /v_work_order\.billing_only[\s\S]*status::text not in \([\s\S]*'wip'[\s\S]*'pending_invoice'[\s\S]*'pending_approval'[\s\S]*'pending_payment'/,
  );
  assert.match(completionFunction, /p_completed_at is null/);
  assert.match(
    completionFunction,
    /Equipment make, model, and serial number are required/,
  );
  assert.match(completionFunction, /'job_completed'/);
  assert.match(
    migration,
    /revoke all on function public\.complete_work_order_once\([\s\S]*from public, anon/,
  );
  assert.match(
    migration,
    /grant execute on function public\.complete_work_order_once\([\s\S]*to authenticated, service_role/,
  );
});

test("the deployment audit verifies the replacement without mutating data", () => {
  assert.match(audit, /active_profile_required/);
  assert.match(audit, /assignment_scope_and_row_lock_preserved/);
  assert.match(audit, /functional_completion_replay_safe/);
  assert.match(audit, /server_completion_inputs_guarded/);
  assert.match(audit, /invoice_workflow_status_preserved/);
  assert.match(audit, /anonymous_execute_blocked/);
  assert.match(audit, /completed_lifecycle_regression_blocked/);
  assert.match(audit, /lifecycle_guard_trigger_enabled/);
  assert.match(audit, /as all_checks_pass/);
  assert.doesNotMatch(
    audit,
    /\b(?:insert|update|delete)\s+(?:into\s+|from\s+)?public\./i,
  );
});

test("completed field work cannot be paused without the guarded reopen flow", () => {
  assert.ok(guardStart >= 0);
  assert.match(
    lifecycleGuard,
    /old\.functional_status::text = 'Completed'[\s\S]*new\.functional_status::text is distinct from 'Completed'/,
  );
  assert.doesNotMatch(
    lifecycleGuard,
    /new\.functional_status::text <> 'Completed'/,
  );
  assert.match(lifecycleGuard, /work_order_reopen_transition_guards/);
  assert.match(lifecycleGuard, /Completed field work must be reopened/);
  assert.match(
    lifecycleGuard,
    /revoke all on function public\.prevent_direct_work_order_reopen\(\)[\s\S]*authenticated/,
  );
});

test("the client guards Pause without blocking check-in or resume", () => {
  const startAt = hook.indexOf("const doStartWork");
  const pauseAt = hook.indexOf("const doPauseWork");
  const partsAt = hook.indexOf("const patchPartsCache", pauseAt);
  assert.ok(startAt >= 0 && pauseAt > startAt && partsAt > pauseAt);

  const startHandler = hook.slice(startAt, pauseAt);
  const pauseHandler = hook.slice(pauseAt, partsAt);
  assert.doesNotMatch(startHandler, /Only work in progress can be paused/);
  assert.match(
    pauseHandler,
    /existing\?\.functionalStatus !== "Work in Progress"[\s\S]*Only work in progress can be paused/,
  );
});
