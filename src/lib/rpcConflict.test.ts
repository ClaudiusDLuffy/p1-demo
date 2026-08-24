import assert from "node:assert/strict";
import test from "node:test";

import { acquireInvoiceMutationLocks } from "./invoiceMutationGuard";
import {
  isRpcConflict,
  RPC_CONFLICT_CODE,
  rpcConflictMessage,
  rpcErrorMessage,
} from "./rpcConflict";

test("only the non-retryable RPC conflict code is classified as a stale record", () => {
  assert.equal(RPC_CONFLICT_CODE, "PT409");
  assert.equal(isRpcConflict({ code: "PT409" }), true);
  assert.equal(isRpcConflict({ code: "pt409" }), true);
  assert.equal(isRpcConflict({ code: "40001" }), false);
  assert.equal(isRpcConflict(new Error("conflict")), false);
  assert.match(rpcConflictMessage("Invoice"), /changed in another session/i);
  assert.equal(rpcErrorMessage({ message: "latest state" }), "latest state");
});

test("invoice mutation locks block overlaps without serializing unrelated invoices", () => {
  const releaseFirst = acquireInvoiceMutationLocks(["invoice-b", "invoice-a", "invoice-a"]);
  assert.equal(typeof releaseFirst, "function");

  const releaseUnrelated = acquireInvoiceMutationLocks(["invoice-c"]);
  assert.equal(typeof releaseUnrelated, "function");
  assert.equal(acquireInvoiceMutationLocks(["invoice-a"]), null);
  assert.equal(acquireInvoiceMutationLocks(["invoice-c", "invoice-d"]), null);

  releaseFirst?.();
  const releaseAfterCompletion = acquireInvoiceMutationLocks(["invoice-a"]);
  assert.equal(typeof releaseAfterCompletion, "function");

  releaseFirst?.();
  releaseAfterCompletion?.();
  releaseUnrelated?.();
});
