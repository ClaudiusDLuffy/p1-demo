import assert from "node:assert/strict";
import test from "node:test";

import { findInvoiceNumber } from "./invoicePdfParser";

test("extracts an invoice number shown beside an explicit label", () => {
  assert.deepEqual(findInvoiceNumber("Invoice Number: ACME-1042"), {
    invoiceNumber: "ACME-1042",
    invoiceNumberConfidence: "high",
    matchedNumberLabel: "invoice number",
  });
});

test("extracts an invoice number from a QuickBooks-style header row", () => {
  assert.deepEqual(
    findInvoiceNumber(
      [
        "INVOICE # DATE TOTAL DUE DUE DATE",
        "ACME-1042 07/27/2026 $1,235.00 08/26/2026",
      ].join("\n"),
    ),
    {
      invoiceNumber: "ACME-1042",
      invoiceNumberConfidence: "high",
      matchedNumberLabel: "invoice header",
    },
  );
});

test("does not mistake a work-order reference for an invoice number", () => {
  assert.deepEqual(findInvoiceNumber("Invoice # WOT0909771"), {
    invoiceNumber: null,
    invoiceNumberConfidence: "none",
    matchedNumberLabel: null,
  });
});

test("uses a contractor job number when the invoice has no invoice-number label", () => {
  assert.deepEqual(findInvoiceNumber("JOB #4331\nINVOICE"), {
    invoiceNumber: "4331",
    invoiceNumberConfidence: "medium",
    matchedNumberLabel: "job #",
  });
});
