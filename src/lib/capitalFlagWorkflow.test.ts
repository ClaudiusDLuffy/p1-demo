import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const detail = read("src/features/work-orders/WorkOrderDetail.tsx");
const hook = read("src/features/work-orders/useWorkOrders.ts");

test("flag capital is immediate and does not require the retired intake modal", () => {
  assert.doesNotMatch(detail, /CapitalFlagModal|setModal\("capitalFlag"\)/);
  assert.match(detail, /onClick=\{\(\) => void doCapitalFlag\(woData\.id\)\}/);
  assert.match(hook, /const doCapitalFlag = async \(woId: string\) =>/);
});

test("flagging preserves historical capital metadata instead of overwriting it", () => {
  const capitalFlagBody = hook.match(
    /const doCapitalFlag = async[\s\S]*?const doCapitalDecline = async/,
  )?.[0] || "";

  assert.doesNotMatch(
    capitalFlagBody,
    /repairQuote\s*:|installQuote\s*:|assetYear\s*:|capitalNotes\s*:/,
  );
  assert.match(capitalFlagBody, /status: "capital"/);
  assert.match(capitalFlagBody, /isCapital: true/);
});
