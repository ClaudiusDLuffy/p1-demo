import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0153_allow_email_intake_assignments_to_start.sql"),
  "utf8",
);

test("email-intake assigned New work can set ETA and start", () => {
  assert.match(migration, /set_work_order_eta_v1[\s\S]*functional_status::text not in \('New','Dispatched'\)/);
  assert.match(migration, /v_regular_start:=not p_resume[\s\S]*status='assigned'[\s\S]*functional_status::text in \('New','Dispatched'\)/);
});

test("resume and receiving-transfer eligibility remain narrowly scoped", () => {
  assert.match(migration, /v_regular_resume:=p_resume[\s\S]*status='parts'[\s\S]*functional_status='Awaiting Parts'/);
  assert.match(migration, /v_receiving:=v_work\.assignment_transfer_pending_visit[\s\S]*assignment_transfer_operation_id is not null[\s\S]*status='wip'[\s\S]*functional_status='Work in Progress'/);
  assert.match(migration, /not \(v_receiving or v_regular_start or v_regular_resume\)/);
});

test("visit overlap and authoritative evidence protections are preserved", () => {
  assert.match(migration, /check_out_at is null/);
  assert.match(migration, /The requested visit overlaps existing work/);
  assert.match(migration, /insert_work_order_lifecycle_activity/);
  assert.match(migration, /insert into public\.work_order_visits/);
  assert.match(migration, /finish_work_order_lifecycle_command/);
  assert.doesNotMatch(migration, /update public\.work_orders[\s\S]*where functional_status='New'/);
});
