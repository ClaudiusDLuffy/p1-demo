import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { createWorkOrderDetailReadHarness, rawPage, respond } from "./activity-visit-read-test-support/harness";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const db = read("src/lib/db.ts");
const portal = read("src/components/PortalShell.tsx");
const workOrderHook = read("src/features/work-orders/useWorkOrders.ts");
const billingModal = read("src/features/billing/BillingInvoiceCreateModal.tsx");
const myJobs = read("src/features/work-orders/MyJobs.tsx");
const subDispatch = read("src/features/contractors/SubDispatchView.tsx");
const migration = read("supabase/migrations/0076_cursor_pagination_and_portal_indexes.sql");
const tableMigration = read("supabase/migrations/0086_work_order_table_sorting.sql");

test("work-order lists use RLS-aware cursor pages instead of global detail rows", () => {
  const listLoader = read("src/features/work-orders/data/workOrderReadRepository.ts");
  assert.ok(/\? "list_work_orders_table_rows_v2"\s*:\s*"list_work_orders_rows_v1"/.test(listLoader));
  assert.ok(/dependencies\.read\(tableMode[^\n]+args, signal\)/.test(listLoader));
  assert.match(listLoader, /parseWorkOrderReadPage\(data\)/);
  assert.doesNotMatch(listLoader, /\.from\("photos"\)/);
  assert.doesNotMatch(listLoader, /\.from\("work_order_visits"\)/);
  assert.match(migration, /security invoker/i);
  assert.match(migration, /candidate_work_orders as materialized/i);
  assert.match(migration, /where activity\.deleted_at is null/i);
  assert.match(migration, /grant execute[\s\S]*authenticated, service_role/i);
  assert.match(tableMigration, /security invoker/i);
  assert.match(tableMigration, /grant execute[\s\S]*authenticated, service_role/i);
});

test("opened work-order details request only their first scoped cursor pages", async () => {
  const parsed = ts.createSourceFile("db.ts", db, ts.ScriptTarget.Latest, true);
  const owner = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "loadWorkOrderDetails");
  assert.ok(owner && ts.isFunctionDeclaration(owner) && owner.body);
  const detailLoader = owner.body.getText(parsed);
  assert.ok(/loadWorkOrderActivitiesPage\(workOrder, null, 30, signal\)/.test(detailLoader));
  assert.ok(/loadWorkOrderPhotosPage\(workOrder\.id, null, 24, signal\)/.test(detailLoader));
  assert.ok(/loadWorkOrderVisitsPage\(workOrder\.id, null, 30, signal\)/.test(detailLoader));
  assert.doesNotMatch(detailLoader, /collectSupabasePages<any>/);
  const harness = createWorkOrderDetailReadHarness([
    respond(rawPage([])), respond(rawPage([])), respond(rawPage([])), respond(null),
  ]);
  const controller = new AbortController();
  await harness.loadDetails({ id: "SYNTHETIC-SCOPED-PARENT" }, controller.signal);
  assert.deepEqual(harness.calls.map(call => call.name), [
    "list_work_order_activities_rows_v1",
    "list_work_order_photos_rows_v1",
    "list_work_order_visits_rows_v1",
    "get_portal_work_order",
  ]);
  assert.deepEqual(harness.calls.slice(0, 3).map(call => call.args.p_limit), [30, 24, 30]);
  for (const call of harness.calls) assert.strictEqual(call.signal, controller.signal);
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
  assert.match(myJobs, /activeJobsQuery\.isError/);
  assert.match(myJobs, /activeJobsQuery\.refetch\(\)/);
  assert.match(myJobs, /Your work orders are still saved/);
  assert.match(myJobs, /resolveWorkOrderCollectionState\(\{/);
  assert.match(myJobs, /isError:\s*activeJobsQuery\.isError \|\| !contractorId/);
  assert.match(myJobs, /state=\{collectionState\}/);
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

test("invoice review uses exact reads and no longer collects invoice pages for raw paid writes", () => {
  assert.match(workOrderHook, /loadInvoiceSummaryById\(invoiceId\)/);
  assert.doesNotMatch(workOrderHook, /loadWorkOrderInvoicesForMutation|loadInvoicesPage\(/);
  assert.match(workOrderHook, /reviewContractorInvoice\(/);
});
