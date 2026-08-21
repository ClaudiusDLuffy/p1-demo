import assert from "node:assert/strict";
import test from "node:test";
import {
  WORK_ORDER_REOPEN_MODE,
  WORK_ORDER_REOPEN_REASON_MAX_LENGTH,
  normalizeWorkOrderReopenReason,
  validateWorkOrderReopenReason,
  workOrderReopenOptions,
} from "./workOrderReopen";

test("reopen reasons are trimmed and validated at both boundaries", () => {
  assert.equal(normalizeWorkOrderReopenReason("  Return visit needed  "), "Return visit needed");
  assert.match(validateWorkOrderReopenReason("  ") || "", /at least 3 characters/);
  assert.equal(validateWorkOrderReopenReason("Fix"), null);
  assert.match(
    validateWorkOrderReopenReason("x".repeat(WORK_ORDER_REOPEN_REASON_MAX_LENGTH + 1)) || "",
    /1000 characters or fewer/,
  );
});

test("billing-only work orders cannot be offered a field-work reopen", () => {
  const options = workOrderReopenOptions({ billingOnly: true });
  const billing = options.find(option => option.value === WORK_ORDER_REOPEN_MODE.billingFollowUp);
  const field = options.find(option => option.value === WORK_ORDER_REOPEN_MODE.resumeWork);

  assert.equal(billing?.disabled, false);
  assert.equal(field?.disabled, true);
  assert.match(field?.disabledReason || "", /Billing-only orders/);
});

test("capital reopen choices explain the distinct work and billing stages", () => {
  const options = workOrderReopenOptions({ isCapital: true });
  const billing = options.find(option => option.value === WORK_ORDER_REOPEN_MODE.billingFollowUp);
  const field = options.find(option => option.value === WORK_ORDER_REOPEN_MODE.resumeWork);

  assert.equal(field?.label, "Resume capital work");
  assert.match(field?.description || "", /capital quote\/completion stage/);
  assert.match(billing?.description || "", /approved quote/);
});
