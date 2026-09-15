import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  resolveWorkOrderCollectionState,
  WorkOrderCollectionNotice,
} from "./WorkOrderCollectionNotice";

test("work-order collection state never presents a failed request as empty", () => {
  assert.equal(resolveWorkOrderCollectionState({ itemCount: 0, isPending: false, isFetching: false, isError: true }), "error");
  assert.equal(resolveWorkOrderCollectionState({ itemCount: 0, isPending: true, isFetching: false, isError: false }), "loading");
  assert.equal(resolveWorkOrderCollectionState({ itemCount: 0, isPending: false, isFetching: true, isError: false }), "loading");
  assert.equal(resolveWorkOrderCollectionState({ itemCount: 0, isPending: false, isFetching: false, isError: false }), "empty");
  assert.equal(resolveWorkOrderCollectionState({ itemCount: 3, isPending: false, isFetching: true, isError: false }), "ready");
  assert.equal(resolveWorkOrderCollectionState({ itemCount: 3, isPending: false, isFetching: false, isError: true }), "error");
});

test("work-order collection notices expose accessible loading, error, and retry states", () => {
  const common = {
    loadingMessage: "Loading synthetic work orders…",
    errorMessage: "Synthetic work orders could not load.",
    emptyMessage: "No synthetic work orders.",
  };
  const loading = renderToStaticMarkup(createElement(WorkOrderCollectionNotice, { ...common, state: "loading" }));
  const failed = renderToStaticMarkup(createElement(WorkOrderCollectionNotice, { ...common, state: "error", onRetry() {} }));
  const empty = renderToStaticMarkup(createElement(WorkOrderCollectionNotice, { ...common, state: "empty" }));
  const ready = renderToStaticMarkup(createElement(WorkOrderCollectionNotice, { ...common, state: "ready" }));

  assert.match(loading, /role="status"/);
  assert.match(loading, /Loading synthetic work orders/);
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Synthetic work orders could not load/);
  assert.match(failed, />Retry</);
  assert.match(empty, /No synthetic work orders/);
  assert.equal(ready, "");
});

test("every staff-facing work-order collection uses the shared request-state contract", () => {
  const files = [
    "src/features/work-orders/WorkOrderList.tsx",
    "src/features/work-orders/HistoryView.tsx",
    "src/features/work-orders/CapitalProjects.tsx",
    "src/features/dashboard/DashboardWorkBuckets.tsx",
    "src/features/staff-work/StaffWorkHub.tsx",
  ];

  for (const filename of files) {
    const source = readFileSync(resolve(process.cwd(), filename), "utf8");
    assert.match(source, /resolveWorkOrderCollectionState/);
    assert.match(source, /WorkOrderCollectionNotice/);
    assert.match(source, /\.refetch\(\)/);
  }
});
