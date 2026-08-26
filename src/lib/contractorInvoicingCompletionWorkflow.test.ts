import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0085_contractor_invoicing_completion.sql"),
  "utf8",
);

const finishStart = migration.indexOf(
  "create or replace function public.finish_contractor_invoicing",
);
const deleteStart = migration.indexOf(
  "create or replace function public.delete_own_contractor_invoice",
);
const finishFunction = migration.slice(finishStart, deleteStart);
const deleteFunction = migration.slice(deleteStart);

test("invoice transitions cannot pull unfinished field work into billing", () => {
  assert.match(migration, /preserve_operational_work_order_status/);
  assert.match(
    migration,
    /old\.functional_status::text in \([\s\S]*'Awaiting Parts'[\s\S]*new\.status := old\.status/,
  );
  assert.match(
    migration,
    /set status = case work_order\.functional_status::text[\s\S]*when 'Awaiting Parts' then 'parts'/,
  );
});

test("done invoicing is assignment- and workflow-cycle scoped", () => {
  assert.match(migration, /contractor_invoicing_assignment_version/);
  assert.match(migration, /contractor_invoicing_workflow_cycle/);
  assert.match(migration, /contractor_invoicing_is_complete/);
  assert.match(
    migration,
    /new\.contractor_id is distinct from old\.contractor_id[\s\S]*contractor_invoicing_completed_at := null/,
  );
  assert.match(
    migration,
    /contractor_invoicing_is_complete[\s\S]*public\.can_access_contractor_work_order\(work_order\.id\)/,
  );
});

test("any live invoice-set change clears the done marker", () => {
  assert.match(migration, /after insert or update of state, deleted_at on public\.invoices/);
  assert.match(migration, /if tg_op = 'INSERT'[\s\S]*new\.deleted_at is null/);
  assert.match(
    migration,
    /new\.state::text in \('submitted', 'revised', 'rejected'\)/,
  );
  assert.match(
    migration,
    /set contractor_invoicing_completed_at = null/,
  );
});

test("finish invoicing is authenticated, locked, validated, and audited", () => {
  assert.match(finishFunction, /security definer/);
  assert.match(finishFunction, /public\.can_invoice_for_contractor\(account_id\)/);
  assert.match(finishFunction, /public\.can_access_contractor_work_order\(p_work_order_id\)/);
  assert.match(finishFunction, /for update/);
  assert.match(finishFunction, /functional_status::text <> 'Completed'/);
  assert.match(finishFunction, /invoice\.state::text in \('draft', 'rejected'\)/);
  assert.match(finishFunction, /'contractor_invoicing_completed'/);
  assert.match(finishFunction, /'already_complete'/);
});

test("contractors may soft-delete only their current draft or rejected invoice", () => {
  assert.match(deleteFunction, /security definer/);
  assert.match(deleteFunction, /candidate\.contractor_id = account_id/);
  assert.match(deleteFunction, /for update/);
  assert.match(deleteFunction, /invoice\.state::text not in \('draft', 'rejected'\)/);
  assert.match(deleteFunction, /staff_invoice_sources/);
  assert.match(deleteFunction, /set deleted_at = now\(\),[\s\S]*deleted_by = actor_id/);
  assert.doesNotMatch(deleteFunction, /delete from public\.invoices/i);
  assert.match(deleteFunction, /'invoice_deleted_by_contractor'/);
});

test("the new workflow RPCs are not executable by anonymous users", () => {
  assert.match(
    migration,
    /revoke all on function public\.finish_contractor_invoicing\(text\)[\s\S]*from public, anon/,
  );
  assert.match(
    migration,
    /revoke all on function public\.delete_own_contractor_invoice\(uuid\)[\s\S]*from public, anon/,
  );
});
