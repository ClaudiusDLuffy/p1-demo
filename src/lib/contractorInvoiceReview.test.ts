import assert from "node:assert/strict";
import test from "node:test";
import {
  canEditRejectedContractorInvoice,
  contractorInvoiceWorkOrderStatus,
} from "./contractorInvoiceReview";

const invoice = (state: string, wot = "WOT1007298") => ({ state, wot });

test("a rejected sibling keeps a work order in invoice review", () => {
  assert.equal(
    contractorInvoiceWorkOrderStatus([
      invoice("approved"),
      invoice("rejected"),
    ], "WOT1007298"),
    "pending_approval",
  );
});

test("submitted and revised invoices remain unresolved", () => {
  assert.equal(
    contractorInvoiceWorkOrderStatus([
      invoice("submitted"),
      invoice("approved"),
    ], "WOT1007298"),
    "pending_approval",
  );
  assert.equal(
    contractorInvoiceWorkOrderStatus([
      invoice("revised"),
      invoice("paid"),
    ], "WOT1007298"),
    "pending_approval",
  );
});

test("only approved or paid live invoices make the work order ready to bill", () => {
  assert.equal(
    contractorInvoiceWorkOrderStatus([
      invoice("approved"),
      invoice("paid"),
      invoice("draft"),
      invoice("rejected", "WOT-OTHER"),
    ], "WOT1007298"),
    "pending_invoice",
  );
});

test("draft-only work orders have no aggregate review status", () => {
  assert.equal(
    contractorInvoiceWorkOrderStatus([invoice("draft")], "WOT1007298"),
    null,
  );
});

test("only rejected invoices are editable through the correction path", () => {
  assert.equal(canEditRejectedContractorInvoice(invoice("rejected")), true);
  for (const state of ["draft", "submitted", "revised", "approved", "paid"]) {
    assert.equal(canEditRejectedContractorInvoice(invoice(state)), false);
  }
});
