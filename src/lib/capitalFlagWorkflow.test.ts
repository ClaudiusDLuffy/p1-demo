import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const detail = read("src/features/work-orders/WorkOrderDetail.tsx");
const hook = read("src/features/work-orders/useWorkOrders.ts");
const correctiveMigration = read("supabase/migrations/0152_allow_guarded_capital_reclassification.sql");

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

test("completed capital reclassification honors only the command-owned lifecycle capability", () => {
  assert.match(correctiveMigration, /command_kind = 'capital_flag'/);
  assert.match(correctiveMigration, /transition_guard\.actor_id = auth\.uid\(\)/);
  assert.match(correctiveMigration, /transition_guard\.parent_allowed/);
  assert.match(correctiveMigration, /not v_guarded[\s\S]*and not v_capital_guarded/);
  assert.doesNotMatch(correctiveMigration, /v_capital_guarded\s*:=\s*true/);
  assert.match(correctiveMigration, /revoke all on function public\.prevent_direct_work_order_reopen\(\)/);
});

test("capital flag waits for authoritative success and refreshes its lifecycle snapshot", () => {
  const capitalFlagBody = hook.match(
    /const doCapitalFlag = async[\s\S]*?const doCapitalDecline = async/,
  )?.[0] || "";
  assert.match(capitalFlagBody, /const authoritativeWorkOrder = await loadWorkOrderById\(woId\)/);
  assert.match(capitalFlagBody, /confirmedLifecycleVersion = context\.expectedLifecycleVersion \+ 1/);
  assert.match(capitalFlagBody, /if \(!saved\) return false/);
  assert.ok(capitalFlagBody.indexOf("await flagWorkOrderCapital") < capitalFlagBody.indexOf('fire("Flagged for capital")'));
  assert.doesNotMatch(capitalFlagBody, /restoreWorkOrders\(snapshot\)/);
});
