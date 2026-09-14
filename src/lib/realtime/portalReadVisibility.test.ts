import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { selectedWorkOrderReadVisible, selectedWorkOrderDetailVisible } from "./portalReadVisibility";
import { createRealtimeBatcher } from "./realtimeBatcher";
import { workOrderDetailsKey, workOrderPagesKey } from "../counts/queryKeys";
import { matchesRealtimePlan, planRealtimeEvent } from "./realtimeInvalidationPlan";
import { syntheticActor, syntheticScope, routingEvent, testTimer } from "./realtimeTestSupport";

test("selected work-order reads follow actual detail views and explicit consuming forms, not retained selection alone", () => {
  for (const page of ["wo_detail", "work_orders", "history"]) assert.equal(selectedWorkOrderReadVisible(page, null), true);
  for (const page of ["dashboard", "billing", "invoices", "contractors", "staff_work", "capital", "my_jobs"]) {
    assert.equal(selectedWorkOrderReadVisible(page, null), false);
    assert.equal(selectedWorkOrderReadVisible(page, "createInvoice"), true);
    assert.equal(selectedWorkOrderReadVisible(page, "editWO"), true);
    assert.equal(selectedWorkOrderReadVisible(page, "addressBook"), false);
    assert.equal(selectedWorkOrderDetailVisible(page), false);
  }
});
test("navigating away preserves selected cache but disables refetch; restoring exact detail refreshes its stale data once", async () => {
  const client = new QueryClient(); const key = workOrderDetailsKey("WOT-A", syntheticScope); let reads = 0;
  client.setQueryData(key, { marker: "selected-cache" });
  const options = { queryKey: key, staleTime: Infinity, queryFn: async () => { reads += 1; return { marker: "fresh-authorized" }; } };
  const observer = new QueryObserver(client, { ...options, enabled: selectedWorkOrderReadVisible("wo_detail", null) });
  const unsubscribe = observer.subscribe(() => undefined);
  observer.setOptions({ ...options, enabled: selectedWorkOrderReadVisible("dashboard", null) });
  const clock = testTimer(); const batcher = createRealtimeBatcher({ client, actor: syntheticActor, timer: clock.timer, visible: () => true, online: () => true });
  batcher.add(routingEvent("photos")); await batcher.flush();
  assert.equal(reads, 0); assert.deepEqual(client.getQueryData(key), { marker: "selected-cache" }); assert.equal(client.getQueryState(key)?.isInvalidated, true);
  observer.setOptions({ ...options, enabled: selectedWorkOrderReadVisible("wo_detail", null) }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1); assert.deepEqual(client.getQueryData(key), { marker: "fresh-authorized" });
  batcher.stop(); unsubscribe(); client.clear();
});
test("activity display-dot routing touches operational active/all pages but not their counts or unrelated history/capital", () => {
  const plan = planRealtimeEvent(routingEvent("activities"), syntheticActor);
  for (const scope of ["active", "all"]) {
    assert.equal(matchesRealtimePlan(workOrderPagesKey(syntheticScope, { scope }), plan, syntheticActor), true);
    assert.equal(matchesRealtimePlan(["work-order-count", syntheticScope, { scope }], plan, syntheticActor), false);
  }
  for (const scope of ["history", "capital", "dashboard_unassigned"]) assert.equal(matchesRealtimePlan(workOrderPagesKey(syntheticScope, { scope }), plan, syntheticActor), false);
});
