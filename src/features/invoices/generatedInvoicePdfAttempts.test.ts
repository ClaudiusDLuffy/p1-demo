import assert from "node:assert/strict";
import test from "node:test";
import type { Invoice, generateInvoicePDFBlob } from "../../lib/invoicePdf";
import { createGeneratedInvoicePdfAttempts } from "./generatedInvoicePdfAttempts";

type Options = NonNullable<Parameters<typeof generateInvoicePDFBlob>[2]>;
type Args = [Invoice, string | null, Options];
const identity = { actorId: "synthetic-actor", invoiceId: "synthetic-invoice", invoiceVersion: 4, operationId: "synthetic-operation" };
const args = (): Args => [{ num: "TEST-1", wot: "WOTTEST1", store: "100", storeAddr: "Synthetic store",
  invoiceDate: "2026-09-09", serviceDate: "2026-09-08", terms: "Net 30", cme: "SYNTHETIC",
  lines: [{ type: "Labor", desc: "Synthetic work", qty: 1, rate: 10, amount: 10 }], subtotal: 10, salesTax: 1, total: 11 },
null, { perspective: "contractor", fromName: "Synthetic Company", fromEmail: "synthetic@example.invalid", fromPhone: "Synthetic phone" }];

test("equivalent generated-PDF inputs retain the exact Blob and downstream upload identity", () => {
  const attempts = createGeneratedInvoicePdfAttempts();
  let generations = 0;
  const generate = () => new Blob([`synthetic-generation-${++generations}`], { type: "application/pdf" });
  const first = attempts.get(identity, args(), generate);
  const uploads = new WeakMap<Blob, string>([[first, "reserved-operation"]]);
  const retry = attempts.get({ ...identity }, args(), generate);
  assert.equal(first, retry);
  assert.equal(uploads.get(retry), "reserved-operation");
  assert.equal(generations, 1);
});

test("every public invoice rendering field invalidates a generated-PDF attempt", () => {
  const changes: ((value: Args) => void)[] = [
    value => { value[0].num = "TEST-2"; }, value => { value[0].documentKind = "capital_quote"; },
    value => { value[0].wot = "WOTTEST2"; }, value => { value[0].externalWorkOrderId = "WOTEXTERNAL"; },
    value => { value[0].store = "200"; }, value => { value[0].storeAddr = "Changed address"; },
    value => { value[0].invoiceDate = "2026-09-10"; }, value => { value[0].serviceDate = "2026-09-07"; },
    value => { value[0].terms = "Net 15"; }, value => { value[0].cme = "Changed reference"; },
    value => { const line = value[0].lines[0]; if (line) line.type = "Travel"; },
    value => { const line = value[0].lines[0]; if (line) line.desc = "Changed description"; },
    value => { const line = value[0].lines[0]; if (line) line.qty = 2; },
    value => { const line = value[0].lines[0]; if (line) line.rate = 11; },
    value => { const line = value[0].lines[0]; if (line) line.amount = 12; },
    value => { value[0].lines = []; }, value => { value[0].subtotal = 12; },
    value => { value[0].salesTax = 2; }, value => { value[0].total = 13; },
  ];
  for (const change of changes) {
    const attempts = createGeneratedInvoicePdfAttempts();
    const generate = () => new Blob(["synthetic"]);
    const first = attempts.get(identity, args(), generate);
    const changed = args(); change(changed);
    assert.notEqual(first, attempts.get(identity, changed, generate));
  }
});

test("branding, logo and bill-to changes never reuse the old generated document", () => {
  const changes: ((value: Args) => void)[] = [
    value => { value[1] = "data:image/jpeg;base64,synthetic"; },
    value => { value[2].perspective = "staff"; }, value => { value[2].fromName = "Changed company"; },
    value => { value[2].fromEmail = "changed@example.invalid"; }, value => { value[2].fromPhone = "Changed phone"; },
    value => { value[2].billTo = { name: "Changed name", apAddr1: "A", apAddr2: "B" }; },
    value => { value[2].billTo = { name: "Same name", apAddr1: "Changed address", apAddr2: "B" }; },
    value => { value[2].billTo = { name: "Same name", apAddr1: "A", apAddr2: "Changed city" }; },
  ];
  for (const change of changes) {
    const attempts = createGeneratedInvoicePdfAttempts();
    const generate = () => new Blob(["synthetic"]);
    const original = args(); original[2].billTo = { name: "Same name", apAddr1: "A", apAddr2: "B" };
    const first = attempts.get(identity, original, generate);
    const changed = structuredClone(original); change(changed);
    assert.notEqual(first, attempts.get(identity, changed, generate));
  }
});

test("invoice, version, financial operation and actor identities isolate retry attempts", () => {
  for (const changed of [{ ...identity, actorId: "another-actor" }, { ...identity, invoiceId: "another-invoice" },
    { ...identity, invoiceVersion: 5 }, { ...identity, operationId: "another-operation" }]) {
    const attempts = createGeneratedInvoicePdfAttempts();
    const generate = () => new Blob(["synthetic"]);
    const first = attempts.get(identity, args(), generate);
    assert.notEqual(first, attempts.get(changed, args(), generate));
  }
});

test("input mutation is detected without retaining a mutable invoice reference", () => {
  const attempts = createGeneratedInvoicePdfAttempts();
  const input = args();
  const generate = () => new Blob(["synthetic"]);
  const first = attempts.get(identity, input, generate);
  input[0].total = 100;
  assert.notEqual(first, attempts.get(identity, input, generate));
});

test("only the last generation per invoice is retained and the cache is bounded to eight invoices", () => {
  const attempts = createGeneratedInvoicePdfAttempts();
  const generate = () => new Blob(["synthetic"]);
  const first = attempts.get(identity, args(), generate);
  for (let index = 0; index < 8; index++) attempts.get({ ...identity, invoiceId: `other-${index}` }, args(), generate);
  assert.notEqual(first, attempts.get(identity, args(), generate));
  const second = attempts.get(identity, args(), generate);
  attempts.get({ ...identity, invoiceVersion: 5 }, args(), generate);
  assert.notEqual(second, attempts.get(identity, args(), generate));
});

test("failed generation does not cache success, and oversized download-only documents are not retained", () => {
  const attempts = createGeneratedInvoicePdfAttempts();
  assert.throws(() => attempts.get(identity, args(), () => { throw new Error("Synthetic renderer failure"); }));
  const oversized = () => {
    const blob = new Blob(["synthetic"]);
    Object.defineProperty(blob, "size", { value: 5 * 1024 * 1024 + 1 });
    return blob;
  };
  assert.notEqual(attempts.get(identity, args(), oversized), attempts.get(identity, args(), oversized));
});
