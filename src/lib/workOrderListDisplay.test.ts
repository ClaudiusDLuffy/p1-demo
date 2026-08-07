import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const list = readFileSync(
  resolve(process.cwd(), "src/features/work-orders/WorkOrderList.tsx"),
  "utf8",
);

test("work-order rows reserve their visible flag for pending 7-Eleven updates", () => {
  assert.doesNotMatch(list, />\s*Action required\s*</);
  assert.match(list, /SevenElevenSyncBadge count=\{wo\.pendingSevenElevenSyncCount\}/);
});

test("desktop work orders keep status near the work-order number", () => {
  assert.match(list, /\["WO#", "Status", "Priority", "INC#", "Store"/);
  assert.match(list, /minWidth: 980/);
});
