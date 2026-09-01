import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/0109_immediate_seven_eleven_activity_alerts.sql");
const tableStart = migration.indexOf(
  "create or replace function public.list_work_orders_table_page",
);
const tableEnd = migration.indexOf("\n$$;", tableStart);
const tableDefinition = migration.slice(
  tableStart,
  tableEnd + 4,
);
const tableMigration = migration.slice(tableStart);
const db = read("src/lib/db.ts");
const list = read("src/features/work-orders/WorkOrderList.tsx");

test("work-order table sorting and filtering operate on the full RLS result set", () => {
  assert.match(tableMigration, /create or replace function public\.list_work_orders_table_page/);
  assert.match(tableMigration, /security invoker/);
  assert.match(tableMigration, /p_sort_column text/);
  assert.match(tableMigration, /p_sort_direction text/);
  assert.match(tableMigration, /p_work_order_filter text/);
  assert.match(tableMigration, /p_contractor_filter text/);
  assert.match(tableMigration, /p_created_date_filter date/);
  assert.match(tableMigration, /p_sla_filter text/);
  assert.match(tableMigration, /row_number\(\) over/);
  assert.match(tableMigration, /portal_encode_cursor/);
});

test("every CTE that reads normalized arguments joins the args row", () => {
  const filteredStart = tableMigration.indexOf("filtered as (");
  const sortableStart = tableMigration.indexOf("sortable as (", filteredStart);
  const filtered = tableMigration.slice(filteredStart, sortableStart);

  assert.ok(filteredStart >= 0);
  assert.ok(sortableStart > filteredStart);
  assert.match(filtered, /left join activity_summary[\s\S]*cross join args[\s\S]*case args\.scope_name/);
});

test("the dedicated table RPC remains authenticated and RLS scoped", () => {
  assert.doesNotMatch(tableDefinition, /security definer/i);
  assert.match(tableDefinition, /security invoker/i);
  assert.match(
    tableMigration,
    /revoke all on function public\.list_work_orders_table_page\([\s\S]*from public, anon/,
  );
  assert.match(
    tableMigration,
    /grant execute on function public\.list_work_orders_table_page\([\s\S]*to authenticated, service_role/,
  );
  assert.doesNotMatch(tableMigration, /set row_security\s*=\s*off/i);
});

test("active jobs display pending 7-Eleven updates immediately", () => {
  assert.match(
    tableMigration,
    /when 'dashboard_seven_eleven_updates' then[\s\S]*coalesce\(summary\.pending_7eleven_sync_count, 0\) > 0/,
  );
  assert.match(
    tableMigration,
    /when 'staff_work' then \([\s\S]*or coalesce\(summary\.pending_7eleven_sync_count, 0\) > 0/,
  );
  assert.doesNotMatch(tableMigration, /when work_order\.functional_status::text = 'Completed'/);
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
