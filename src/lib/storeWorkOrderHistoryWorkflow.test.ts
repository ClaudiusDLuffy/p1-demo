import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const shell = read("src/components/PortalShell.tsx");
const detail = read("src/features/work-orders/WorkOrderDetail.tsx");
const list = read("src/features/work-orders/WorkOrderList.tsx");
const timeline = read("src/features/work-orders/VisitTimeline.tsx");
const storeHistory = read("src/features/work-orders/StoreWorkOrderHistory.tsx");

test("dispatch detail uses the existing exact-store authorized work-order query", () => {
  assert.match(detail, /scope: "all",[\s\S]*storeNumber: woData\?\.store \|\| null/);
  assert.match(detail, /isManager && woData\.store/);
  assert.match(detail, /<StoreWorkOrderHistory/);
});

test("view-all navigation resets broad filters and requests an exact store view", () => {
  assert.match(shell, /const openStoreWorkOrders = useCallback/);
  assert.match(shell, /setFilterC\("all"\)/);
  assert.match(shell, /setFilterP\("all"\)/);
  assert.match(shell, /setFilterStatus\("all"\)/);
  assert.match(shell, /setWorkOrderStoreView\(\{[\s\S]*storeNumber: exactStoreNumber/);
  assert.match(detail, /onViewStoreWorkOrders\(String\(woData\.store\)\)/);
});

test("the work-order list includes closed store calls and preserves exact-store filtering", () => {
  assert.match(list, /useState\(!storeView\)/);
  assert.match(list, /storeNumber: storeView\?\.storeNumber \|\| null/);
  assert.match(list, /String\(workOrder\.store \|\| ""\) === storeView\.storeNumber/);
  assert.match(list, /scope: hideClosed \? "active" : "all"/);
  assert.match(shell, /key=\{workOrderStoreView[\s\S]*store-\$\{workOrderStoreView\.requestId\}/);
});

test("field visits and store work-order history have distinct labels", () => {
  assert.match(timeline, /Field visit timeline/);
  assert.doesNotMatch(timeline, />Visit history/);
  assert.match(detail, /StoreWorkOrderHistory/);
});

test("store history starts collapsed and remains independently expandable", () => {
  assert.match(storeHistory, /useState\(false\)/);
  assert.match(storeHistory, /aria-expanded=\{expanded\}/);
  assert.match(storeHistory, /expanded \? "Collapse history" : "Expand history"/);
  assert.match(storeHistory, /\{expanded && \(/);
});

test("the in-app work-order back action restores the prior history entry", () => {
  assert.match(shell, /const backFromWorkOrder = useCallback/);
  assert.match(shell, /portalHistoryDepthRef\.current > 0/);
  assert.match(shell, /window\.history\.back\(\)/);
  assert.match(shell, /onBackFromWorkOrder=\{backFromWorkOrder\}/);
});
