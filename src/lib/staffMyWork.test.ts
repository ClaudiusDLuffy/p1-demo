import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0059_staff_my_work.sql"),
  "utf8",
);

test("one active to-do owner and the five-item cap are database-enforced", () => {
  assert.match(migration, /staff_work_order_todos_one_active_owner/);
  assert.match(migration, /where completed_at is null/);
  assert.match(migration, />= 5 then/);
  assert.match(migration, /pg_advisory_xact_lock/);
});

test("to-dos support add, complete, transfer, and automatic close", () => {
  assert.match(migration, /add_work_order_to_my_todos/);
  assert.match(migration, /complete_my_work_order_todo/);
  assert.match(migration, /transfer_work_order_todo/);
  assert.match(migration, /close_staff_todos_with_work_order/);
  assert.match(migration, /work_order_closed/);
});

test("notification read position is private to each staff login", () => {
  assert.match(migration, /primary key \(user_id, work_order_id\)/);
  assert.match(migration, /user_id = auth\.uid\(\)/);
  assert.match(migration, /mark_staff_work_order_read/);
  assert.match(migration, /greatest\(/);
});

test("existing activity is baselined without hardcoded users", () => {
  assert.match(migration, /Existing contractor[\s\S]*does not flood/);
  assert.match(migration, /activity\.entered_by_role = 'contractor'/);
  assert.doesNotMatch(migration, /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
});

