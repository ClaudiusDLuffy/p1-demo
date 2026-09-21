import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");
const migration = read("supabase/migrations/0159_preserve_active_visit_during_capital_review.sql");
const detail = read("src/features/work-orders/WorkOrderDetail.tsx");
const shell = read("src/components/PortalShell.tsx");
const hook = read("src/features/work-orders/useWorkOrders.ts");

test("capital-review checkout preserves the capital stage and closes only the active visit", () => {
  assert.match(migration, /v_capital_checkout:=v_work\.status::text in \('capital','pending_capital_completion'\)/);
  assert.match(migration, /when v_capital_checkout then v_work\.status/);
  assert.match(migration, /when v_capital_checkout and v_work\.status='capital' then 'Pending Capital Approval'/);
  assert.match(migration, /when v_capital_checkout then 'Pending Capital Completion'/);
  assert.match(migration, /update public\.work_order_visits set check_out_at=p_check_out_at,checked_out_by=auth\.uid\(\)/);
  assert.match(migration, /'capitalStagePreserved',v_capital_checkout/);
});

test("capital authorization and completion cannot skip an active visit checkout", () => {
  assert.ok((migration.match(/visit\.check_out_at is null/g) || []).length >= 2);
  assert.match(migration, /Clock out the active visit before authorizing the next capital visit/);
  assert.match(migration, /Clock out the active visit before completing capital work/);
  assert.match(detail, /hasOpenVisit \? "Waiting for active visit checkout" : "Authorize & resume capital work"/);
  assert.match(detail, /hasOpenVisit \? "Checkout required before completion" : "Capital Completed"/);
});

test("authorization after an earlier visit exposes Resume and creates a genuine return visit", () => {
  assert.match(migration, /v_has_prior_visit boolean := false/);
  assert.match(migration, /when v_has_prior_visit then 'parts'/);
  assert.match(migration, /when v_has_prior_visit then 'Awaiting Parts'/);
  assert.match(migration, /'nextFieldAction', case when v_has_prior_visit then 'resume' else 'start' end/);
});

test("the browser presents a dedicated capital checkout instead of a parts pause", () => {
  assert.match(detail, /"Clock out for capital review"/);
  assert.match(shell, /title=\{capitalReviewCheckout \? "Clock out for capital review" : "Pause work"\}/);
  assert.match(shell, /Reason: Capital review/);
  assert.match(shell, /capitalReviewCheckout \? \[\] : pausePartsList/);
  assert.match(hook, /reason === "Capital review"/);
  assert.match(hook, /"Clocked out — capital status preserved"/);
});
