import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  resolveWorkOrderCollectionState,
  WorkOrderCollectionNotice,
} from "./WorkOrderCollectionNotice";

test("work-order collection state never reports a failed request as empty", () => {
  assert.equal(resolveWorkOrderCollectionState({ itemCount: 0, isPending: false, isFetching: false, isError: true }), "error");
  assert.equal(resolveWorkOrderCollectionState({ itemCount: 0, isPending: true, isFetching: true, isError: false }), "loading");
  assert.equal(resolveWorkOrderCollectionState({ itemCount: 0, isPending: false, isFetching: false, isError: false }), "empty");
  assert.equal(resolveWorkOrderCollectionState({ itemCount: 2, isPending: false, isFetching: false, isError: false }), "ready");
  assert.equal(resolveWorkOrderCollectionState({ itemCount: 2, isPending: false, isFetching: false, isError: true }), "error");
});

test("work-order collection notices expose accessible status and retry controls", () => {
  const failed = renderToStaticMarkup(
    createElement(WorkOrderCollectionNotice, {
      state: "error",
      errorMessage: "Could not load assigned work.",
      onRetry: () => undefined,
    }),
  );
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Could not load assigned work/);
  assert.match(failed, />Retry</);

  const loading = renderToStaticMarkup(createElement(WorkOrderCollectionNotice, { state: "loading" }));
  assert.match(loading, /role="status"/);
  assert.match(loading, /Loading work orders/);
  assert.equal(renderToStaticMarkup(createElement(WorkOrderCollectionNotice, { state: "ready" })), "");
});

test("all portal work-order collections use the shared non-empty failure state", () => {
  const files = [
    "src/features/work-orders/WorkOrderList.tsx",
    "src/features/work-orders/MyJobs.tsx",
    "src/features/work-orders/HistoryView.tsx",
    "src/features/work-orders/CapitalProjects.tsx",
    "src/features/staff-work/StaffWorkHub.tsx",
    "src/features/dashboard/DashboardWorkBuckets.tsx",
  ];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /resolveWorkOrderCollectionState/);
    assert.match(source, /WorkOrderCollectionNotice/);
    assert.match(source, /\.refetch\(\)/);
  }
});
