import assert from "node:assert/strict";
import test from "node:test";
import { jsPDF } from "jspdf";

import {
  extractInvoiceDataFromPdf,
  findInvoiceNumber,
} from "./invoicePdfParser";
import { parseInvoicePdf } from "./invoicePdfParserClient";
import { generateInvoiceCsv } from "./invoiceCsv";

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

test("extracts each item from a multi-line invoice PDF", async () => {
  const document = new jsPDF();
  document.text("Invoice Number INV-100", 20, 20);
  document.text("Description", 20, 40);
  document.text("Qty", 100, 40);
  document.text("Rate", 125, 40);
  document.text("Amount", 160, 40);
  document.text("Labor service", 20, 50);
  document.text("2", 100, 50);
  document.text("80.00", 125, 50);
  document.text("160.00", 160, 50);
  document.text("Replacement filter", 20, 60);
  document.text("1", 100, 60);
  document.text("50.00", 125, 60);
  document.text("50.00", 160, 60);
  document.text("Total Due 210.00", 130, 80);

  const parsed = await extractInvoiceDataFromPdf(
    new Uint8Array(document.output("arraybuffer")),
  );

  assert.deepEqual(
    parsed.lines.map(line => ({
      type: line.type,
      desc: line.desc,
      qty: line.qty,
      rate: line.rate,
      amount: line.amount,
    })),
    [
      {
        type: "Labor",
        desc: "Labor service",
        qty: 2,
        rate: 80,
        amount: 160,
      },
      {
        type: "Parts/Hardware",
        desc: "Replacement filter",
        qty: 1,
        rate: 50,
        amount: 50,
      },
    ],
  );

  assert.equal(
    generateInvoiceCsv({
      num: parsed.invoiceNumber,
      wot: "WOT0909771",
      store: "23995",
      invoiceDateRaw: "2026-07-30",
      serviceDateRaw: "2026-07-29",
      territory: "Virginia",
      lines: parsed.lines,
    }),
    [
      "Invoice Number,*Customer,Sub Customer,Terms,*Invoice Date,*Service Date,Due Date,Location,Shipping To,Store Number,Memo,Message on Invoice,Work Order #,*Product/Service,Description,Quantity,Rate,*Amount,Tax Rate,Class",
      "INV-100,7-Eleven Inc,7-ELEVEN STORE - 23995,Net 30,7/30/2026,7/29/2026,,Virginia,7-ELEVEN STORE - 23995,23995,,,WOT0909771,Labor,Labor service,2,80,160,,",
      "INV-100,,,,,,,,,,,,,Parts/Hardware,Replacement filter,1,50,50,,",
    ].join("\r\n"),
  );
});

test("continues extracting line items when a second page omits the table header", async () => {
  const document = new jsPDF();
  document.text("JOB #4347", 20, 20);
  document.text("Description", 20, 40);
  document.text("Qty", 100, 40);
  document.text("Rate", 125, 40);
  document.text("Amount", 160, 40);
  document.text("Labor", 20, 50);
  document.text("3", 100, 50);
  document.text("80.00", 125, 50);
  document.text("240.00", 160, 50);

  document.addPage();
  document.text("Condenser fan motor", 20, 30);
  document.text("1", 100, 30);
  document.text("120.00", 125, 30);
  document.text("120.00", 160, 30);
  document.text("Subtotal 360.00", 130, 50);
  document.text("Total Due 360.00", 130, 60);

  const parsed = await extractInvoiceDataFromPdf(
    new Uint8Array(document.output("arraybuffer")),
  );

  assert.equal(parsed.invoiceNumber, "4347");
  assert.deepEqual(
    parsed.lines.map(line => ({
      desc: line.desc,
      qty: line.qty,
      rate: line.rate,
      amount: line.amount,
    })),
    [
      { desc: "Labor", qty: 3, rate: 80, amount: 240 },
      { desc: "Condenser fan motor", qty: 1, rate: 120, amount: 120 },
    ],
  );
});

test("parses an uploaded invoice without calling the protected parser API", async () => {
  const document = new jsPDF();
  document.text("Invoice Number INV-300", 20, 20);
  document.text("Description", 20, 40);
  document.text("Qty", 100, 40);
  document.text("Rate", 125, 40);
  document.text("Amount", 160, 40);
  document.text("Travel", 20, 50);
  document.text("1", 100, 50);
  document.text("236.00", 125, 50);
  document.text("236.00", 160, 50);
  document.text("Total Due 236.00", 130, 70);
  const file = new File([document.output("arraybuffer")], "invoice.pdf", {
    type: "application/pdf",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("PDF parsing must not make a network request");
  }) as typeof fetch;

  try {
    const parsed = await parseInvoicePdf(file);
    assert.equal(parsed.invoiceNumber, "INV-300");
    assert.equal(parsed.total, 236);
    assert.deepEqual(parsed.lines.map(line => line.desc), ["Travel"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
