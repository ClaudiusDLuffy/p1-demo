import assert from "node:assert/strict";
import { test } from "node:test";
import { jsPDF } from "jspdf";

import "./pdf/test-fixtures/prepareInvoicePdfRuntime";
import { createNodeBrowserPdfParity } from "./pdf/test-fixtures/browserPdfHarness";
import { InvoicePdfError } from "./pdf/invoicePdfBudget";
import { loadInvoicePdfPages } from "./pdf/invoicePdfDocument";
import { extractInvoiceDataFromPdf as parseServerPdf } from "./pdf/invoicePdfServer";
import { parseInvoicePdfPages } from "./pdf/invoicePdfTextParser";

// Explicit Node fixture for actual modern/legacy loader parity, not a
// production fake-worker fallback or physical browser/CSP certification.
let pendingBrowser: ReturnType<typeof createNodeBrowserPdfParity> | undefined;
const browser = () => pendingBrowser ??= createNodeBrowserPdfParity();
const parseBrowserPdf = async (data: Uint8Array) => (await browser()).parse(data);
const parseInvoicePdf = async (file: File) => (await browser()).client.parse(file);

const bytes = (document: jsPDF) => new Uint8Array(document.output("arraybuffer"));

const multipageInvoice = () => {
  const document = new jsPDF();
  document.text("Invoice Number SYNTH-1050", 20, 20);
  document.text("Description", 20, 40);
  document.text("Qty", 100, 40);
  document.text("Rate", 125, 40);
  document.text("Amount", 160, 40);
  document.text("Labor service", 20, 50);
  document.text("2", 100, 50);
  document.text("80.00", 125, 50);
  document.text("160.00", 160, 50);
  document.addPage();
  document.text("Replacement filter", 20, 20);
  document.text("1", 100, 20);
  document.text("50.00", 125, 20);
  document.text("50.00", 160, 20);
  document.text("Subtotal 210.00", 130, 40);
  document.text("Sales Tax 10.50", 130, 50);
  document.text("Total Due 220.50", 130, 60);
  return document;
};

test("PDF parity: actual browser and legacy loaders yield identical pure page input and extraction", async () => {
  const data = bytes(multipageInvoice());
  await browser();
  const browserPages = await loadInvoicePdfPages(data.slice(), () => import("pdfjs-dist/build/pdf.mjs"));
  const serverPages = await loadInvoicePdfPages(data.slice(), () => import("pdfjs-dist/legacy/build/pdf.mjs"));

  assert.equal(browserPages.length, 2);
  assert.deepEqual(browserPages, serverPages);
  const pureResult = parseInvoicePdfPages(browserPages);
  assert.deepEqual(pureResult, parseInvoicePdfPages(serverPages));
  assert.deepEqual(await parseBrowserPdf(data.slice()), pureResult);
  assert.deepEqual(await parseServerPdf(data.slice()), pureResult);
  assert.equal(pureResult.total, 220.5);
  assert.equal(pureResult.invoiceNumber, "SYNTH-1050");
  assert.deepEqual(pureResult.lines.map(line => [line.desc, line.qty, line.rate, line.amount]), [
    ["Labor service", 2, 80, 160],
    ["Replacement filter", 1, 50, 50],
  ]);
});

test("PDF parity: valid blank and non-matching documents remain no-match on both adapters", async () => {
  const documents = [new jsPDF(), new jsPDF()];
  documents[1].text("Synthetic service notes without financial fields", 20, 20);

  for (const document of documents) {
    const data = bytes(document);
    const browserResult = await parseBrowserPdf(data.slice());
    assert.deepEqual(browserResult, await parseServerPdf(data.slice()));
    assert.deepEqual(browserResult, {
      total: null,
      confidence: "none",
      matchedLabel: null,
      invoiceNumber: null,
      invoiceNumberConfidence: "none",
      matchedNumberLabel: null,
      lines: [],
      lineConfidence: "none",
    });
  }
});

test("PDF parity: malformed and empty bytes expose safe typed failures", async () => {
  const fixtures = [
    new TextEncoder().encode("%PDF-1.7\nsynthetic malformed document\n"),
    new Uint8Array(),
  ];

  for (const fixture of fixtures) {
    for (const parse of [parseBrowserPdf, parseServerPdf]) {
      await assert.rejects(parse(fixture.slice()), (error: unknown) => {
        assert.ok(error instanceof InvoicePdfError);
        assert.equal(error.code, "PDF_MALFORMED");
        assert.equal(error.message, "The PDF text could not be read");
        return true;
      });
    }
  }
});

test("PDF parity: both adapters accept page 25 and explicitly reject page 26 instead of partial extraction", async () => {
  const document = new jsPDF();
  for (let page = 1; page <= 26; page += 1) {
    if (page > 1) document.addPage();
    document.text(`Synthetic page ${page}`, 20, 20);
    if (page === 25) document.text("Total Due 25.00", 20, 40);
    if (page === 25) {
      const data = bytes(document);
      const browserResult = await parseBrowserPdf(data.slice());
      assert.deepEqual(browserResult, await parseServerPdf(data.slice()));
      assert.equal(browserResult.total, 25);
    }
    if (page === 26) {
      document.text("Invoice Number OMIT-26", 20, 30);
      document.text("Total Due 26.00", 20, 40);
    }
  }
  const data = bytes(document);
  for (const parse of [parseBrowserPdf, parseServerPdf]) {
    await assert.rejects(parse(data.slice()), (error: unknown) => error instanceof InvoicePdfError && error.code === "PDF_PAGE_LIMIT");
  }
});

test("PDF parity: previously truncated enormous single text items now reject explicitly on both adapters", async () => {
  for (const paddingLength of [249_000, 250_010]) {
    const document = new jsPDF();
    document.setFontSize(0.001);
    document.text("x".repeat(paddingLength), 20, 20);
    document.setFontSize(12);
    document.text("Invoice Number SYNTH-1043", 20, 30);
    document.text("Total Due 999.00", 20, 40);
    const data = bytes(document);

    for (const parse of [parseBrowserPdf, parseServerPdf]) {
      await assert.rejects(parse(data.slice()), (error: unknown) => error instanceof InvoicePdfError && error.code === "PDF_TEXT_LIMIT");
    }
  }
});

test("PDF parity: the browser File facade matches the server result without a parsing API request", async () => {
  const data = bytes(multipageInvoice());
  const expected = await parseServerPdf(data.slice());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Local invoice parsing must not make an API request");
  };

  try {
    const file = new File([data], "synthetic-invoice.pdf", { type: "application/pdf" });
    assert.deepEqual(await parseInvoicePdf(file), expected);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
