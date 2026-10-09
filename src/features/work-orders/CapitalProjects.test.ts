import assert from "node:assert/strict";
import test from "node:test";
import { primitiveHarness, uiInvoke, uiNodes, uiText } from "../../lib/forms/primitiveComponentTestHarness";
import type { WorkOrderPageParams } from "./data/workOrderReadContracts";

function setup() {
  const requests: { params: WorkOrderPageParams; enabled: boolean }[] = [];
  const harness = primitiveHarness("src/features/work-orders/CapitalProjects.tsx", {
    "./queries": { useWorkOrdersPageQuery: (params: WorkOrderPageParams, enabled: boolean) => {
      requests.push({ params, enabled });
      return { data: { items: [], totalCount: 0, hasMore: true, nextCursor: "synthetic-next-page" },
        isPending: false, isFetching: false, isError: false, refetch() {} };
    } },
    "../directory/queries": { useDirectoryLabels: () => ({ getUser: () => null }) },
    "./WorkOrderCollectionNotice": { resolveWorkOrderCollectionState: () => "empty", WorkOrderCollectionNotice: "Notice" },
    "./WorkOrderSortControls": { default: "SortControls" },
  });
  const render = (page = "capital", isManager = true) => harness.render("default", {
    page, isManager, setSelectedWO() {}, setPage() {}, setAiNote() {},
  });
  return { render, requests, latest: () => requests.at(-1)! };
}

test("capital search is server-side, retains the stage filter, and resets a later page", () => {
  const view = setup();
  let tree = view.render();
  assert.equal(view.latest().params.scope, "capital");
  assert.equal(view.latest().params.status, "capital_active");
  const next = uiNodes(tree).find(node => node.type === "button" && uiText(node) === "Next")!;
  uiInvoke(next, "onClick");
  tree = view.render();
  assert.equal(view.latest().params.cursor, "synthetic-next-page");
  const search = uiNodes(tree).find(node => node.props["aria-label"] === "Search capitals")!;
  uiInvoke(search, "onChange", { target: { value: "  SYNTHETIC-CAPITAL  " } });
  tree = view.render();
  assert.equal(view.latest().params.search, "SYNTHETIC-CAPITAL");
  assert.equal(view.latest().params.cursor, null);
  assert.equal(view.latest().params.status, "capital_active");
  const status = uiNodes(tree).find(node => node.props["aria-label"] === "Capital status")!;
  uiInvoke(status, "onChange", { target: { value: "capital_waiting_quote" } });
  view.render();
  assert.equal(view.latest().params.status, "capital_waiting_quote");
  assert.equal(view.latest().params.search, "SYNTHETIC-CAPITAL");
  assert.equal(view.latest().params.cursor, null);
});

test("clearing capital search resets pagination without navigating out of the Capital tab", () => {
  const view = setup();
  let tree = view.render();
  uiInvoke(uiNodes(tree).find(node => node.props["aria-label"] === "Search capitals")!, "onChange", { target: { value: "E2E001" } });
  tree = view.render();
  uiInvoke(uiNodes(tree).find(node => node.type === "button" && uiText(node) === "Next")!, "onClick");
  tree = view.render();
  uiInvoke(uiNodes(tree).find(node => node.props["aria-label"] === "Search capitals")!, "onChange", { target: { value: "" } });
  view.render();
  assert.equal(view.latest().params.search, "");
  assert.equal(view.latest().params.cursor, null);
  assert.equal(view.latest().enabled, true);
});

test("the capital read stays disabled outside its staff tab", () => {
  const view = setup();
  view.render("work_orders");
  assert.equal(view.latest().enabled, false);
  view.render("capital", false);
  assert.equal(view.latest().enabled, false);
});
