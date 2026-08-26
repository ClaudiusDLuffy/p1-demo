import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/0086_work_order_table_sorting.sql");
const db = read("src/lib/db.ts");
const list = read("src/features/work-orders/WorkOrderList.tsx");

test("work-order table sorting and filtering operate on the full RLS result set", () => {
  assert.match(migration, /create or replace function public\.list_work_orders_table_page/);
  assert.match(migration, /security invoker/);
  assert.match(migration, /p_sort_column text/);
  assert.match(migration, /p_sort_direction text/);
  assert.match(migration, /p_work_order_filter text/);
  assert.match(migration, /p_contractor_filter text/);
  assert.match(migration, /p_created_date_filter date/);
  assert.match(migration, /p_sla_filter text/);
  assert.match(migration, /row_number\(\) over/);
  assert.match(migration, /portal_encode_cursor/);
});

test("the dedicated table RPC remains authenticated and RLS scoped", () => {
  assert.doesNotMatch(migration, /security definer/i);
  assert.match(
    migration,
    /revoke all on function public\.list_work_orders_table_page\([\s\S]*from public, anon/,
  );
  assert.match(
    migration,
    /grant execute on function public\.list_work_orders_table_page\([\s\S]*to authenticated, service_role/,
  );
  assert.doesNotMatch(migration, /set row_security\s*=\s*off/i);
});

test("unfinished jobs cannot display as pending 7-Eleven updates", () => {
  assert.match(
    migration,
    /when work_order\.functional_status::text = 'Completed'[\s\S]*then coalesce\(summary\.raw_pending_7eleven_sync_count/,
  );
  assert.match(migration, /else 0::bigint/);
});

test("client selects the table RPC and forwards every column control", () => {
  assert.match(db, /"list_work_orders_table_page"/);
  assert.match(db, /p_sort_column: params\.tableSortColumn/);
  assert.match(db, /p_work_order_filter: params\.workOrderFilter/);
  assert.match(db, /p_contractor_filter: params\.contractorFilter/);
  assert.match(list, /aria-sort=/);
  assert.match(list, /selectTableSort\(column\)/);
  assert.match(list, /renderColumnFilter\(column\)/);
});
