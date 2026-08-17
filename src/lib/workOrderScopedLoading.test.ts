import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const db = read("src/lib/db.ts");
const portal = read("src/components/PortalShell.tsx");
const workOrderHook = read("src/features/work-orders/useWorkOrders.ts");
const billingModal = read("src/features/billing/BillingInvoiceCreateModal.tsx");
const migration = read("supabase/migrations/0070_work_order_activity_summaries.sql");

test("work-order list uses an RLS-aware aggregate instead of global detail rows", () => {
  const listLoader = db.slice(
    db.indexOf("export async function loadWorkOrders"),
    db.indexOf("const formatWorkOrderDateTime"),
  );
  assert.match(db, /rpc\("get_work_order_activity_summaries"\)/);
  assert.doesNotMatch(listLoader, /\.from\("photos"\)/);
  assert.doesNotMatch(listLoader, /\.from\("work_order_visits"\)/);
  assert.match(migration, /security invoker/i);
  assert.match(migration, /where activity\.deleted_at is null/i);
  assert.match(migration, /grant execute[\s\S]*authenticated, service_role/i);
});

test("opened work-order details are filtered and completely paged", () => {
  const detailLoader = db.slice(
    db.indexOf("export async function loadWorkOrderDetails"),
    db.indexOf('// "5h", "2d", "1w"'),
  );
  for (const table of ["activities", "photos", "work_order_visits"]) {
    assert.match(detailLoader, new RegExp(`\\.from\\("${table}"\\)`));
  }
  assert.equal(
    (detailLoader.match(/\.eq\("work_order_id", workOrder\.id\)/g) || []).length,
    3,
  );
  assert.equal(
    (detailLoader.match(/collectSupabasePages<any>/g) || []).length,
    3,
  );
});

test("portal and billing merge scoped detail queries without a second initial reset", () => {
  assert.match(portal, /useWorkOrderDetailsQuery\(/);
  assert.match(billingModal, /useWorkOrderDetailsQuery\(/);
  assert.match(workOrderHook, /existing\?\.detailsLoaded/);
  assert.match(workOrderHook, /qc\.getQueryData\(workOrderDetailsKey\(workOrder\.id\)\)/);
  assert.doesNotMatch(portal, /qc\.resetQueries/);
  assert.match(portal, /const isAuthenticated = !!currentUser\?\.id/);
});
