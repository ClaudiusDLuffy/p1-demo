import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const db = read("src/lib/db.ts");
const portal = read("src/components/PortalShell.tsx");
const workOrderHook = read("src/features/work-orders/useWorkOrders.ts");
const billingModal = read("src/features/billing/BillingInvoiceCreateModal.tsx");
const myJobs = read("src/features/work-orders/MyJobs.tsx");
const subDispatch = read("src/features/contractors/SubDispatchView.tsx");
const migration = read("supabase/migrations/0076_cursor_pagination_and_portal_indexes.sql");

test("work-order lists use RLS-aware cursor pages instead of global detail rows", () => {
  const listLoader = db.slice(
    db.indexOf("export async function loadWorkOrders"),
    db.indexOf("const formatWorkOrderDateTime"),
  );
  assert.match(db, /rpc\("list_work_orders_page"/);
  assert.doesNotMatch(listLoader, /\.from\("photos"\)/);
  assert.doesNotMatch(listLoader, /\.from\("work_order_visits"\)/);
  assert.match(migration, /security invoker/i);
  assert.match(migration, /candidate_work_orders as materialized/i);
  assert.match(migration, /where activity\.deleted_at is null/i);
  assert.match(migration, /grant execute[\s\S]*authenticated, service_role/i);
});

test("opened work-order details request only their first scoped cursor pages", () => {
  const detailLoader = db.slice(
    db.indexOf("export async function loadWorkOrderDetails"),
    db.indexOf('// "5h", "2d", "1w"'),
  );
  assert.match(detailLoader, /loadWorkOrderActivitiesPage\(workOrder\)/);
  assert.match(detailLoader, /loadWorkOrderPhotosPage\(workOrder\.id\)/);
  assert.match(detailLoader, /loadWorkOrderVisitsPage\(workOrder\.id\)/);
  assert.doesNotMatch(detailLoader, /collectSupabasePages<any>/);
  for (const rpc of [
    "list_work_order_activities_page",
    "list_work_order_photos_page",
    "list_work_order_visits_page",
  ]) assert.match(db, new RegExp(`rpc\\("${rpc}"`));
});

test("portal and billing merge scoped detail queries without a second initial reset", () => {
  assert.match(portal, /useWorkOrderDetailsQuery\(/);
  assert.match(billingModal, /useWorkOrderDetailsQuery\(/);
  assert.match(workOrderHook, /existing\?\.detailsLoaded/);
  assert.match(portal, /useWorkOrderByIdQuery\(/);
  assert.match(portal, /selectedWorkOrderForView/);
  assert.match(
    portal,
    /maskedWorkOrders\.find[\s\S]*?\|\| selectedWorkOrderForView/,
    "the exact lookup row must render without waiting for the local detail mirror",
  );
  assert.match(
    portal,
    /selectedWorkOrderQuery\.isSuccess[\s\S]*?selectedWorkOrderQuery\.data !== null/,
    "contractors should return to My Jobs only after a successful not-found lookup",
  );
  assert.doesNotMatch(portal, /qc\.resetQueries/);
  assert.match(portal, /const isAuthenticated = !!currentUser\?\.id/);
});

test("the portal shell does not restore hidden global preload queries", () => {
  for (const hook of [
    "useWorkOrdersQuery",
    "useInvoicesQuery",
    "useWoPartsQuery",
    "useStaffWorkTodosQuery",
    "useStaffNotificationReadsQuery",
  ]) {
    assert.doesNotMatch(portal, new RegExp(`${hook}\\(`));
  }
  assert.match(portal, /usePortalNavigationSummaryQuery\(/);
  assert.match(portal, /useWorkOrderByIdQuery\(/);
  assert.match(portal, /useWorkOrderDetailsQuery\(/);
});

test("contractor work-order page failures are reported and remain retryable", () => {
  assert.match(myJobs, /reportClientFailure/);
  assert.match(myJobs, /source:\s*"my-jobs-query"/);
  assert.match(myJobs, /jobsQuery\.isError/);
  assert.match(myJobs, /jobsQuery\.refetch\(\)/);
  assert.match(myJobs, /Your work orders are still saved/);
  assert.match(
    myJobs,
    /!jobsQuery\.isLoading && !jobsQuery\.isError && visibleJobs\.length === 0/,
  );
});

test("contractor active lists request receipt-ordered cursor pages", () => {
  assert.match(myJobs, /sort:\s*CONTRACTOR_ACTIVE_WORK_ORDER_SORT/);
  assert.match(subDispatch, /sort:\s*CONTRACTOR_ACTIVE_WORK_ORDER_SORT/);
  assert.doesNotMatch(myJobs, /sort:\s*"priority"/);
  assert.doesNotMatch(subDispatch, /sort:\s*"priority"/);
});

test("My Jobs reports a safe first-page result summary without row contents", () => {
  assert.match(myJobs, /reportClientDiagnostic/);
  assert.match(myJobs, /source:\s*"my-jobs-result"/);
  assert.match(myJobs, /deferredSearch\s*!==\s*""/);
  assert.match(myJobs, /position\.page\s*!==\s*1/);
  for (const detail of [
    "itemCount",
    "totalCount",
    "hasMore",
    "contractorScopeResolved",
  ]) assert.match(myJobs, new RegExp(`${detail}\\s*[:,}]`));
  assert.doesNotMatch(
    myJobs.slice(
      myJobs.indexOf('source: "my-jobs-result"'),
      myJobs.indexOf("});", myJobs.indexOf('source: "my-jobs-result"')),
    ),
    /items:|workOrder|summary|address|search:/i,
  );
});

test("invoice workflow mutations use exact or work-order-scoped reads", () => {
  assert.match(workOrderHook, /loadInvoiceById\(invoiceId\)/);
  assert.match(workOrderHook, /loadWorkOrderInvoicesForMutation/);
  assert.match(workOrderHook, /workOrderId,/);
  assert.match(workOrderHook, /loadInvoicesPage\(/);
});
