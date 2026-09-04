import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const list = read("src/features/work-orders/WorkOrderList.tsx");
const queries = read("src/features/work-orders/queries.ts");
const dataLayer = read("src/lib/db.ts");
const migration = read("supabase/migrations/0109_immediate_seven_eleven_activity_alerts.sql");

test("exact WOT searches use the scoped family lookup instead of filtered pages", () => {
  assert.match(list, /normalizeExactPortalWorkOrderId\(deferredSearch\)/);
  assert.match(list, /useWorkOrderFamilyQuery\([\s\S]*?exactWorkOrderId/);
  assert.match(list, /listQueryEnabled[\s\S]*?!exactWorkOrderId/);
  assert.match(
    list,
    /const paginatedWOs = exactWorkOrderId[\s\S]*?exactWorkOrderQuery\.data \|\| \[\][\s\S]*?: serverPage\?\.items/,
  );
  assert.match(list, /Other filters and “Hide closed calls” are temporarily ignored/);
  assert.match(list, /Authorized reassignment copies are included/);
  assert.match(dataLayer, /\.from\("work_orders"\)/);
  assert.match(
    dataLayer,
    /id\.eq\.\$\{reference\},duplicate_root_work_order_id\.eq\.\$\{reference\}/,
  );
});

test("the exact family lookup preserves RLS and never returns soft-deleted work orders", () => {
  const functionStart = migration.indexOf(
    "create or replace function public.get_portal_work_order",
  );
  const functionEnd = migration.indexOf("\n$$;", functionStart);
  const definition = migration.slice(functionStart, functionEnd);

  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  assert.match(definition, /security invoker/);
  assert.match(definition, /where work_order\.id = p_work_order_id/);
  assert.match(definition, /and work_order\.deleted_at is null/);
  assert.doesNotMatch(definition, /security definer/);

  const familyStart = dataLayer.indexOf("export async function loadWorkOrderFamily");
  const familyEnd = dataLayer.indexOf("\nexport async function loadWorkOrders", familyStart);
  const familyLoader = dataLayer.slice(familyStart, familyEnd);
  assert.match(familyLoader, /normalizeExactPortalWorkOrderId\(workOrderId\)/);
  assert.match(familyLoader, /\.is\("deleted_at", null\)/);
  assert.match(familyLoader, /Promise\.all\(/);
  assert.match(familyLoader, /loadWorkOrderById\(candidate\.id\)/);
});

test("suffixed exact references do not expand into another assignment family", () => {
  assert.match(
    dataLayer,
    /const isRoot = !reference\.includes\("-"\)/,
  );
  assert.match(dataLayer, /: candidatesQuery\.eq\("id", reference\)/);
});

test("exact results refresh with the existing work-order invalidation boundary", () => {
  assert.match(
    queries,
    /workOrderFamilyKey[\s\S]*?\.\.\.WORK_ORDER_BY_ID_KEY, "family", workOrderId/,
  );
});
