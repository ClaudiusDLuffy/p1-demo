import assert from "node:assert/strict";
import test from "node:test";
import { jsPDF } from "jspdf";
import "./pdf/test-fixtures/prepareInvoicePdfRuntime";
import { InvoicePdfError } from "./pdf/invoicePdfBudget";

import {
  extractInvoiceDataFromPdf,
  extractInvoiceTotalFromPdf,
} from "./invoicePdfParser";
import { parseInvoicePdf } from "./invoicePdfParserClient";

// All documents are generated locally from synthetic text, never customer PDFs.
const pdfBytes = (document: jsPDF) => new Uint8Array(document.output("arraybuffer"));

const invoiceFixture = () => {
  const document = new jsPDF();
  document.text("Invoice Number SYNTH-1042", 20, 20);
  document.text("Purchase Order PO-555 / WOT9999999", 20, 28);
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
  document.text("Subtotal 210.00", 130, 75);
  document.text("Sales Tax 10.50", 130, 85);
  document.text("Total Due 220.50", 130, 95);
  return document;
};

test("characterization: a supported synthetic invoice preserves the exact public result", async () => {
  const result = await extractInvoiceDataFromPdf(pdfBytes(invoiceFixture()));

  assert.deepEqual(result, {
    total: 220.5,
    confidence: "high",
    matchedLabel: "total due",
    invoiceNumber: "SYNTH-1042",
    invoiceNumberConfidence: "high",
    matchedNumberLabel: "invoice number",
    lines: [
      {
        type: "Labor",
        desc: "Labor service",
        qty: 2,
        rate: 80,
        amount: 160,
        confidence: "high",
      },
      {
        type: "Parts/Hardware",
        desc: "Replacement filter",
        qty: 1,
        rate: 50,
        amount: 50,
        confidence: "high",
      },
    ],
    lineConfidence: "high",
  });
  // Tax, subtotal, and PO/WOT references are not separate supported result fields.
});

test("characterization: the total-only facade retains its three-field contract", async () => {
  assert.deepEqual(await extractInvoiceTotalFromPdf(pdfBytes(invoiceFixture())), {
    total: 220.5,
    confidence: "high",
    matchedLabel: "total due",
  });
});

test("characterization: a valid blank PDF returns no match rather than throwing", async () => {
  assert.deepEqual(await extractInvoiceDataFromPdf(pdfBytes(new jsPDF())), {
    total: null,
    confidence: "none",
    matchedLabel: null,
    invoiceNumber: null,
    invoiceNumberConfidence: "none",
    matchedNumberLabel: null,
    lines: [],
    lineConfidence: "none",
  });
});

test("characterization: a PDF with ordinary unmatched text returns no match", async () => {
  const document = new jsPDF();
  document.text("Synthetic service notes without invoice fields", 20, 20);

  assert.deepEqual(await extractInvoiceDataFromPdf(pdfBytes(document)), {
    total: null,
    confidence: "none",
    matchedLabel: null,
    invoiceNumber: null,
    invoiceNumberConfidence: "none",
    matchedNumberLabel: null,
    lines: [],
    lineConfidence: "none",
  });
});

test("characterization: malformed PDF bytes reject with an Error", async () => {
  await assert.rejects(
    extractInvoiceDataFromPdf(new TextEncoder().encode("%PDF-1.7\nnot a valid PDF\n")),
    Error,
  );
});

test("characterization: zero-byte document parsing rejects rather than returning no match", async () => {
  await assert.rejects(extractInvoiceDataFromPdf(new Uint8Array()), Error);
});

test("security: over-25-page PDFs now reject instead of silently ignoring page 26", async () => {
  const document = new jsPDF();
  for (let page = 1; page <= 26; page += 1) {
    if (page > 1) document.addPage();
    document.text(`Synthetic page ${page}`, 20, 20);
    if (page === 25) document.text("Total Due 25.00", 20, 40);
    if (page === 26) {
      document.text("Invoice Number OMIT-26", 20, 30);
      document.text("Total Due 26.00", 20, 40);
    }
  }

  await assert.rejects(extractInvoiceDataFromPdf(pdfBytes(document)),
    (error: unknown) => error instanceof InvoicePdfError && error.code === "PDF_PAGE_LIMIT");
});

test("security: enormous single items reject before the legacy final matching-text truncation", async () => {
  const paddedDocument = (paddingLength: number) => {
    const document = new jsPDF();
    // Tiny synthetic text stays within page bounds so PDF.js returns all of it.
    document.setFontSize(0.001);
    document.text("x".repeat(paddingLength), 20, 20);
    document.setFontSize(12);
    document.text("Invoice Number SYNTH-1043", 20, 30);
    document.text("Total Due 999.00", 20, 40);
    return document;
  };

  for (const count of [249_000, 250_010]) {
    await assert.rejects(extractInvoiceDataFromPdf(pdfBytes(paddedDocument(count))),
      (error: unknown) => error instanceof InvoicePdfError && error.code === "PDF_TEXT_LIMIT");
  }
});

test("characterization: file validation retains empty/size feedback and rejects invalid actual signatures", async () => {
  await assert.rejects(
    parseInvoicePdf(new File([], "empty.pdf", { type: "application/pdf" })),
    { message: "PDF file is empty" },
  );
  await assert.rejects(
    parseInvoicePdf(new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.pdf", {
      type: "application/pdf",
    })),
    { message: "PDF must be 5 MB or smaller" },
  );
  await assert.rejects(
    parseInvoicePdf(new File(["synthetic text"], "notes.txt", { type: "text/plain" })),
    (error: unknown) => error instanceof InvoicePdfError && error.code === "PDF_INVALID_SIGNATURE",
  );
});
