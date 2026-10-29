import assert from "node:assert/strict";
import test from "node:test";
import { loadStaffInvoiceNteWaitFlags, attachApplicableStaffInvoiceNteWaitFlags, attachStaffInvoiceNteWaitFlags } from "./nteApprovalWaitFlags";

const ids = ["85000000-0000-4000-8000-000000000001", "85000000-0000-4000-8000-000000000002"];

function client(response: unknown, failure: unknown = null) {
  const calls: { name: string; args: unknown; signal?: AbortSignal }[] = [];
  return {
    calls,
    rpc(name: string, args: unknown) {
      const result = Promise.resolve({ data: response, error: failure });
      return Object.assign(result, { abortSignal(signal: AbortSignal) {
        calls.push({ name, args, signal }); signal.throwIfAborted(); return result;
      } });
    },
  };
}

test("NTE marker read batches one page and binds exact invoice ids", async () => {
  const signal = new AbortController().signal;
  const h = client({ items: [
    { invoiceId: ids[0], waitingOnNteApproval: true },
    { invoiceId: ids[1], waitingOnNteApproval: false },
  ] });
  const flags = await loadStaffInvoiceNteWaitFlags(h, ids, signal);
  assert.equal(flags.get(ids[0]), true);
  assert.equal(flags.get(ids[1]), false);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].args, { p_invoice_ids: ids });
  assert.equal(h.calls[0].signal, signal);
  assert.deepEqual(attachStaffInvoiceNteWaitFlags([{ id: ids[0], num: "synthetic" }], flags), [
    { id: ids[0], num: "synthetic", waitingOnNteApproval: true },
  ]);
});

test("NTE marker reads reject incomplete, duplicate, and mismatched database receipts", async () => {
  for (const payload of [
    { items: [{ invoiceId: ids[0], waitingOnNteApproval: true }] },
    { items: ids.map(id => ({ invoiceId: id, waitingOnNteApproval: true })).concat({ invoiceId: ids[0], waitingOnNteApproval: false }) },
    { items: ids.map(id => ({ invoiceId: id, waitingOnNteApproval: "true" })) },
  ]) {
    await assert.rejects(loadStaffInvoiceNteWaitFlags(client(payload), ids, new AbortController().signal), { code: "INTERNAL_ERROR" });
  }
  await assert.rejects(loadStaffInvoiceNteWaitFlags(client(null, { code: "42501" }), ids, new AbortController().signal));
});

test("NTE marker reads short-circuit empty pages and reject duplicate request ids", async () => {
  const empty = client({ items: [] });
  assert.equal((await loadStaffInvoiceNteWaitFlags(empty, [], new AbortController().signal)).size, 0);
  assert.equal(empty.calls.length, 0);
  await assert.rejects(loadStaffInvoiceNteWaitFlags(client({ items: [] }), [ids[0], ids[0]], new AbortController().signal), { code: "INTERNAL_ERROR" });
});

test("NTE annotation queries only staff invoices in mixed billing reads", async () => {
  const signal = new AbortController().signal;
  const calls: string[][] = [];
  const annotated = await attachApplicableStaffInvoiceNteWaitFlags([
    { id: ids[0], invoiceType: "contractor", num: "synthetic source" },
    { id: ids[1], invoiceType: "staff", num: "synthetic P1" },
  ], async (invoiceIds, receivedSignal) => {
    assert.equal(receivedSignal, signal);
    calls.push([...invoiceIds]);
    return new Map([[ids[1], true]]);
  }, signal);

  assert.deepEqual(calls, [[ids[1]]]);
  assert.deepEqual(annotated.map(invoice => invoice.waitingOnNteApproval), [false, true]);
});

test("contractor-only source reads skip the staff NTE database function", async () => {
  let called = false;
  const annotated = await attachApplicableStaffInvoiceNteWaitFlags([
    { id: ids[0], invoiceType: "contractor" },
  ], async () => { called = true; throw new Error("must not read a staff-only marker for contractor invoices"); },
  new AbortController().signal);

  assert.equal(called, false);
  assert.deepEqual(annotated, [{ id: ids[0], invoiceType: "contractor", waitingOnNteApproval: false }]);
});
