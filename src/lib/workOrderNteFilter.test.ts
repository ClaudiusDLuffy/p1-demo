import assert from "node:assert/strict";
import test from "node:test";
import { createWorkOrderReadHarness, rawPage, respond } from "./work-order-read-test-support/harness";
import { workOrderCountFilters } from "./counts/countFilters";
import { primitiveHarness, uiInvoke, uiNodes, uiText } from "./forms/primitiveComponentTestHarness";
import type { WorkOrderPageParams } from "../features/work-orders/data/workOrderReadContracts";

for (const table of [false, true]) {
  test(`NTE ${table ? "table" : "preset"} rows and count use paired reads with identical membership filters`, async () => {
    const h = createWorkOrderReadHarness([respond(rawPage([])), respond({ totalCount: 12 })]);
    const params = { ntePendingApproval: true, search: "Synthetic", state: "TX", priority: "p2",
      status: "pending_invoice", limit: 10, cursor: "synthetic-cursor",
      ...(table ? { summaryFilter: "approval", tableSortColumn: "summary" } : {}) };
    const signal = new AbortController().signal;
    await h.loadPage(params, signal);
    assert.deepEqual(await h.loadCount(workOrderCountFilters(params), signal), { totalCount: 12 });
    assert.equal(h.calls[0].name, table ? "list_work_orders_nte_table_rows_v1" : "list_work_orders_nte_rows_v1");
    assert.equal(h.calls[1].name, table ? "count_work_orders_nte_table_v1" : "count_work_orders_nte_v1");
    for (const call of h.calls) {
      assert.equal(call.signal, signal);
      assert.equal(call.args.p_search, "Synthetic");
      assert.equal(call.args.p_state, "TX");
      assert.equal(call.args.p_priority, "p2");
      assert.equal(call.args.p_status, "pending_invoice");
      assert.ok(!("ntePendingApproval" in call.args));
    }
    assert.equal(h.calls[0].args.p_cursor, "synthetic-cursor");
    assert.ok(!("p_cursor" in h.calls[1].args));
    assert.ok(!("p_limit" in h.calls[1].args));
  });
}

test("NTE filter remains in count identity but pagination and sort do not", () => {
  const filter = { ntePendingApproval: true, state: "FL" };
  assert.deepEqual(workOrderCountFilters({ ...filter, cursor: "page-2", sort: "oldest", limit: 10 }), filter);
  assert.notDeepEqual(workOrderCountFilters(filter), workOrderCountFilters({ state: "FL" }));
});

function view(role = "manager", active = true, pending = false) {
  const requests: WorkOrderPageParams[] = [];
  const signatures: string[] = [];
  const harness = primitiveHarness("src/features/work-orders/WorkOrderList.tsx", {
    "./queries": {
      useWorkOrderFamilyQuery: () => ({ data: [] }),
      useWorkOrdersPageQuery: (params: WorkOrderPageParams) => {
        requests.push(params);
        return { data: pending ? undefined : { items: [], hasMore: true, nextCursor: "next", totalCount: 12 },
          isPending: pending, isFetching: pending, isError: false };
      },
    },
    "../../lib/useCursorPagination": { useCursorPagination: (signature: string) => {
      signatures.push(signature);
      return { position: { page: 1, cursor: null }, next() {}, previous() {} };
    } },
    "../directory/queries": { useDirectoryLabels: () => ({ getUser: () => null }) },
    "../va-coordinator/queries": { useVaCoordinatorWorkOrders: () => ({ data: undefined }) },
    "../billing/queries": { useWorkOrderNteWaitIndicatorsQuery: () => ({ data: [] }) },
  });
  const props = { page: "work_orders", selectedWO: null, search: "", setSearch() {},
    isManager: role !== "contractor" && role !== "va_coordinator", currentUser: { id: "synthetic", role, active },
    filterC: "all", setFilterC() {}, filterP: "all", setFilterP() {}, filterStatus: "all", setFilterStatus() {},
    filteredWOs: [], getUser: () => null, slaNow: 0, slaLabel: () => "", setSelectedWO() {}, setAiNote() {}, setPage() {} };
  return { render: () => harness.render("default", props), requests, signatures };
}

test("staff can choose NTE Pending Approval, combine a state, and Clear it without changing status", () => {
  const h = view();
  let tree = h.render();
  const filter = () => uiNodes(tree).find(n => n.props["aria-label"] === "Filter work orders by NTE approval")!;
  assert.ok(filter());
  uiInvoke(filter(), "onChange", { target: { value: "pending" } }); tree = h.render();
  assert.equal(h.requests.at(-1)?.ntePendingApproval, true);
  assert.equal(h.requests.at(-1)?.status, "all");
  assert.notEqual(h.signatures.at(-1), h.signatures[0]);
  uiInvoke(uiNodes(tree).find(n => n.props["aria-label"] === "Filter work orders by state")!, "onChange", { target: { value: "TX" } });
  tree = h.render();
  assert.equal(h.requests.at(-1)?.state, "TX");
  assert.equal(h.requests.at(-1)?.ntePendingApproval, true);
  uiInvoke(uiNodes(tree).find(n => n.type === "button" && uiText(n) === "Clear")!, "onClick");
  h.render();
  assert.equal(h.requests.at(-1)?.ntePendingApproval, false);
  assert.equal(h.requests.at(-1)?.state, "all");
});

for (const role of ["contractor", "va_coordinator"]) {
  test(`${role} cannot see or activate the staff NTE filter`, () => {
    const h = view(role); const tree = h.render();
    assert.equal(uiNodes(tree).some(n => n.props["aria-label"] === "Filter work orders by NTE approval"), false);
    assert.equal(h.requests.at(-1)?.ntePendingApproval, false);
  });
}

test("inactive staff cannot see the NTE filter", () => {
  const h = view("manager", false);
  assert.equal(uiNodes(h.render()).some(n => n.props["aria-label"] === "Filter work orders by NTE approval"), false);
});
