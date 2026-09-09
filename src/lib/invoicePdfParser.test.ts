import assert from "node:assert/strict";
import test from "node:test";
import { jsPDF } from "jspdf";

import {
  extractInvoiceDataFromPdf,
  findInvoiceNumber,
} from "./invoicePdfParser";
import { parseInvoicePdf } from "./invoicePdfParserClient";
import { generateStaffInvoiceCsv } from "./invoiceCsv";
import { normalizeInvoiceLineNumbers } from "./invoiceMath";

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
    generateStaffInvoiceCsv({
      num: parsed.invoiceNumber,
      wot: "WOT0909771",
      store: "23995",
      invoiceDateRaw: "2026-07-30",
      serviceDateRaw: "2026-07-29",
      territory: "Virginia",
      lines: parsed.lines,
    }),
    [
      "Invoice Number,*Customer,Sub Customer,Terms,*Invoice Date,*Service Date,Due Date,Location,Shipping To,Store Number,Memo,Message on Invoice,Work Order #,*Product/Service,Description,Quantity,Rate,*Amount,Tax Rate,Equipment Tag,Class",
      "INV-100,7-Eleven Inc,7-ELEVEN STORE - 23995,Net 30,07/30/2026,07/29/2026,,Virginia,,23995,,,WOT0909771,Labor,Labor service,2,80,160,,,",
      "INV-100,,,,,,,,,,,,,Parts/Hardware,Replacement filter,1,50,50,,,",
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

test("keeps continued service charges before a later materials header on the same page", async () => {
  const document = new jsPDF();
  document.setFontSize(10);
  document.text("Invoice Number INV-CONTINUED", 20, 20);
  document.text("Services", 20, 40);
  document.text("Qty", 100, 40);
  document.text("Rate", 125, 40);
  document.text("Amount", 160, 40);
  document.text("Service description continued on the next page", 20, 50);

  document.addPage();
  const serviceLines = [
    { desc: "Overtime labor", qty: 2.5, rate: 135, amount: 337.5 },
    { desc: "Labor service", qty: 12, rate: 90, amount: 1080 },
    { desc: "Helper labor", qty: 12, rate: 70, amount: 840 },
    { desc: "Trip charge", qty: 3, rate: 35, amount: 105 },
  ];
  for (const [index, line] of serviceLines.entries()) {
    const y = 30 + index * 10;
    document.text(line.desc, 20, y);
    document.text(String(line.qty), 100, y);
    document.text(line.rate.toFixed(2), 125, y);
    document.text(line.amount.toFixed(2), 160, y);
  }

  // A later table header must not make the parser jump over the service rows.
  // The new section also moves its numeric columns further right.
  document.text("Materials", 20, 80);
  document.text("Qty", 120, 80);
  document.text("Price", 150, 80);
  document.text("Total", 180, 80);
  const materialLines = [
    { desc: "Compressor", qty: 2, rate: 3732.85, amount: 7465.7 },
    { desc: "Filter", qty: 2, rate: 50, amount: 100 },
    { desc: "Sight glass", qty: 2, rate: 57.6, amount: 115.2 },
    { desc: "Flush kit", qty: 2, rate: 145, amount: 290 },
    { desc: "Recovery fee", qty: 2, rate: 35, amount: 70 },
    { desc: "Vacuum fee", qty: 2, rate: 35, amount: 70 },
    { desc: "Torch fee", qty: 2, rate: 85, amount: 170 },
    { desc: "Nitrogen fee", qty: 2, rate: 45, amount: 90 },
    { desc: "Thermostat", qty: 1, rate: 224.46, amount: 224.46 },
    { desc: "Refrigerant", qty: 30, rate: 35, amount: 1050 },
  ];
  for (const [index, line] of materialLines.entries()) {
    const y = 90 + index * 10;
    document.text(line.desc, 20, y);
    document.text(String(line.qty), 120, y);
    document.text(line.rate.toFixed(2), 150, y);
    document.text(line.amount.toFixed(2), 180, y);
  }
  document.text("Subtotal 12,007.86", 130, 200);
  document.text("Amount Due 12,007.86", 130, 210);

  const pdf = document.output("arraybuffer");
  const direct = await extractInvoiceDataFromPdf(new Uint8Array(pdf.slice(0)));
  const uploaded = await parseInvoicePdf(new File([pdf], "continued.pdf", { type: "application/pdf" }));
  for (const parsed of [direct, uploaded]) {
    assert.deepEqual(
      parsed.lines.map(({ desc, qty, rate, amount }) => ({ desc, qty, rate, amount })),
      [...serviceLines, ...materialLines],
    );
    assert.equal(parsed.total, 12007.86);
    assert.equal(Math.round(parsed.lines.reduce((sum, line) => sum + line.qty * line.rate, 0) * 100), 1200786);
    assert.equal(parsed.lineConfidence, "high");
    const savedLines = parsed.lines.map(normalizeInvoiceLineNumbers);
    assert.equal(savedLines[0].qty, 2.5);
    assert.equal(Math.round(savedLines.reduce((sum, line) => sum + line.qty * line.rate, 0) * 100), 1200786);
  }
});

test("recognizes labor table headers before a materials section", async () => {
  for (const label of ["Labor", "Labour"]) {
    const document = new jsPDF();
    document.text(label, 20, 40);
    document.text("Hours", 100, 40);
    document.text("Rate", 125, 40);
    document.text("Amount", 160, 40);
    document.text("Labor service", 20, 50);
    document.text("2.5", 100, 50);
    document.text("100.00", 125, 50);
    document.text("250.00", 160, 50);
    document.text("Materials", 20, 70);
    document.text("Qty", 100, 70);
    document.text("Rate", 125, 70);
    document.text("Amount", 160, 70);
    document.text("Replacement filter", 20, 80);
    document.text("1", 100, 80);
    document.text("50.00", 125, 80);
    document.text("50.00", 160, 80);
    document.text("Total Due 300.00", 130, 100);

    const parsed = await extractInvoiceDataFromPdf(new Uint8Array(document.output("arraybuffer")));
    assert.deepEqual(parsed.lines.map(line => line.desc), ["Labor service", "Replacement filter"]);
    assert.equal(parsed.lines[0].qty, 2.5);
    assert.equal(parsed.total, 300);
  }
});

test("reads a repeated table after a continuation-page amount-due heading", async () => {
  const document = new jsPDF();
  for (let page = 0; page < 2; page += 1) {
    if (page > 0) document.addPage();
    document.text("Amount Due 400.00", 130, 20);
    document.text("Description", 20, 40);
    document.text("Qty", 100, 40);
    document.text("Rate", 125, 40);
    document.text("Amount", 160, 40);
    document.text(`Labor visit ${page + 1}`, 20, 50);
    document.text("2", 100, 50);
    document.text("100.00", 125, 50);
    document.text("200.00", 160, 50);
  }
  document.text("Subtotal 400.00", 130, 70);

  const parsed = await extractInvoiceDataFromPdf(new Uint8Array(document.output("arraybuffer")));
  assert.deepEqual(parsed.lines.map(line => line.desc), ["Labor visit 1", "Labor visit 2"]);
  assert.equal(parsed.total, 400);
});

test("reads later sections after a subtotal without importing footer or attachment rows", async () => {
  const document = new jsPDF();
  const row = (desc: string, y: number) => {
    document.text(desc, 20, y);
    document.text("1", 100, y);
    document.text("50.00", 125, y);
    document.text("50.00", 160, y);
  };
  const header = (label: string, y: number) => {
    document.text(label, 20, y);
    document.text("Qty", 100, y);
    document.text("Rate", 125, y);
    document.text("Amount", 160, y);
  };
  header("Services", 40);
  row("Labor service", 50);
  document.text("Subtotal 50.00", 130, 70);
  row("Not a line item", 80);
  header("Materials", 100);
  row("Replacement filter", 110);
  document.text("Subtotal 100.00", 130, 130);
  document.text("Amount Due 100.00", 130, 140);
  row("Payment reference", 160);
  document.addPage();
  row("Attachment reference", 40);

  const parsed = await extractInvoiceDataFromPdf(new Uint8Array(document.output("arraybuffer")));
  assert.deepEqual(parsed.lines.map(line => line.desc), ["Labor service", "Replacement filter"]);
  assert.equal(parsed.total, 100);
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
