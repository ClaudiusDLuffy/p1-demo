import assert from "node:assert/strict";
import test from "node:test";
import { canDisplayVaReadContent, vaQueueBadgeStyle } from "./VaCoordinatorReadFeedback";
import { T } from "../../lib/constants";
import { primitiveHarness, uiNodes } from "../../lib/forms/primitiveComponentTestHarness";

test("failed and loading VA reads cannot be rendered as a successful empty collection", () => {
  const state = { pending: true, failed: false, fetching: true, hasData: false, retry() {} };
  assert.equal(canDisplayVaReadContent(state), false);
  assert.equal(canDisplayVaReadContent({ ...state, pending: false, failed: true }), false);
  assert.equal(canDisplayVaReadContent({ ...state, pending: false, failed: false }), true);
  assert.equal(canDisplayVaReadContent({ ...state, pending: false, failed: true, hasData: true }), true);
  assert.equal(canDisplayVaReadContent(), true);
});

test("VA section feedback offers an actual retry and preserves query state", () => {
  let retries = 0;
  const h = primitiveHarness("src/features/va-coordinator/VaCoordinatorReadFeedback.tsx", {
    "../work-orders/WorkOrderCollectionNotice": { WorkOrderCollectionNotice: "ReadNotice" },
  });
  const tree = h.render("VaCoordinatorReadFeedback", { subject: "queued updates",
    state: { pending: false, failed: true, fetching: false, hasData: false, retry: () => { retries++; } } });
  const notice = uiNodes(tree).find(node => node.type === "ReadNotice")!;
  assert.equal(notice.props.state, "error");
  assert.match(String(notice.props.errorMessage), /Could not load queued updates/);
  (notice.props.onRetry as () => void)(); assert.equal(retries, 1);
});

test("queue badge reserves green for confirmed reads without pending updates", () => {
  const ready = { pending: false, failed: false, fetching: false, hasData: true, retry() {} };
  assert.equal(vaQueueBadgeStyle(ready, false).color, T.success);
  assert.equal(vaQueueBadgeStyle({ ...ready, pending: true, hasData: false }, false).background, T.warnSoft);
  assert.equal(vaQueueBadgeStyle({ ...ready, failed: true }, false).color, T.danger);
  assert.equal(vaQueueBadgeStyle({ ...ready, failed: true }, true).background, T.dangerSoft);
  assert.equal(vaQueueBadgeStyle(undefined, true).background, T.warnSoft);
});
