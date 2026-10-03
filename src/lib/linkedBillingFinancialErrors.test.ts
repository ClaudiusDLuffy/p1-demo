import assert from "node:assert/strict";
import test from "node:test";
import { financialErrorResponse } from "./financialHttpBoundary";
import { BillingCommandRejection } from "../server/billing-invoices/billingCommandReconciliation";
import { safeErrorMessage } from "./errors/normalizeUnknown";

test("financial routes retain safe linked-invoice guidance through command rejections", async () => {
  for (const code of ["LINKED_BILLING_INVOICE_IN_USE", "LINKED_BILLING_ALREADY_RECORDED"]) {
    for (const wrapped of [false, true]) {
      const cause = { code: "23514", message: code, details: "private SQL" };
      const response = financialErrorResponse(wrapped ? new BillingCommandRejection("23514", cause) : cause);
      assert.equal(response.status, 409);
      const body = await response.json(); assert.equal(body.code, code); assert.doesNotMatch(body.error, /private SQL/);
      assert.doesNotMatch(safeErrorMessage(cause), /Contact support|Check the required fields/);
    }
  }
});
test("unknown provider messages still never cross the financial boundary", async () => {
  const response = financialErrorResponse(new BillingCommandRejection("23514", { message: "private SQL" }));
  assert.equal(response.status, 422); assert.doesNotMatch(JSON.stringify(await response.json()), /private SQL/);
});
