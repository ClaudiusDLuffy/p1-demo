import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { T } from "./constants";
import { generateStaffInvoicePDFBlob, type Invoice } from "./invoicePdf";
import { summarizeInvoiceLineTypes } from "./invoiceLineSubtotals";
import { assertStaffInvoiceIntegrity, inspectStaffInvoiceIntegrity } from "./staffInvoiceIntegrity";

const warranty = { type: "Warranty", desc: "Synthetic no-charge warranty repair", qty: 1, rate: 0, amount: 0 };
function invoice(lines = [warranty]): Invoice {
  const subtotal = lines.reduce((sum, line) => sum + line.qty * line.rate, 0);
  return { num: "P1-SYNTH-WARRANTY", wot: "WOT-SYNTH-100", store: "100", storeAddr: "Synthetic address",
    invoiceDate: "09/09/2026", serviceDate: "09/09/2026", terms: "Net 60", lines, subtotal, salesTax: 0, total: subtotal };
}

test("type subtotals retain a distinct zero-dollar Warranty category and count every no-charge line", () => {
  const summary = summarizeInvoiceLineTypes([warranty, { ...warranty, desc: "Second synthetic warranty visit" }], 0);
  assert.deepEqual(summary, {
    categories: [{ category: "Warranty", label: "Warranty", amount: 0, lineCount: 2 }],
    subtotal: 0, salesTax: 0, grandTotal: 0,
  });
});

test("mixed invoice summaries retain Warranty without inflating or reducing billable totals", () => {
  const summary = summarizeInvoiceLineTypes([warranty, { type: "Labor", qty: 2, rate: 110, amount: 220 }], 15.4);
  assert.deepEqual(summary.categories.find(category => category.category === "Warranty"),
    { category: "Warranty", label: "Warranty", amount: 0, lineCount: 1 });
  assert.equal(summary.categories.find(category => category.category === "Labor")?.amount, 220);
  assert.equal(summary.subtotal, 220); assert.equal(summary.salesTax, 15.4); assert.equal(summary.grandTotal, 235.4);
});

test("the actual totals component renders the zero-dollar Warranty category rather than hiding it", () => {
  const filename = resolve("src/features/billing/InvoiceLineTypeSubtotals.tsx");
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: { default?: React.ComponentType<{
    lines: Array<Record<string, unknown>>; salesTax: number; fmt: (value: number) => string;
  }> } = {};
  runInNewContext(compiled, { exports, require: (name: string): unknown => {
    if (name === "react") return React;
    if (name === "react/jsx-runtime") return jsxRuntime;
    if (name.endsWith("/constants")) return { T };
    if (name.endsWith("/invoiceLineSubtotals")) return { summarizeInvoiceLineTypes };
    throw new Error(`Unexpected synthetic totals-component import: ${name}`);
  } }, { filename });
  assert.ok(exports.default);
  const html = renderToStaticMarkup(React.createElement(exports.default, {
    lines: [warranty], salesTax: 0, fmt: value => `$${value.toFixed(2)}`,
  }));
  assert.match(html, /aria-label="Invoice totals by line type"/);
  assert.match(html, /Warranty/); assert.doesNotMatch(html, />Other</);
  assert.match(html, /Pre-tax subtotal/); assert.match(html, /Grand total/);
  assert.equal(html.match(/\$0\.00/g)?.length, 3, "Warranty category, subtotal and grand total remain visible");
});

test("export integrity admits actual persisted all-zero Warranty lines but still rejects empty or inconsistent invoices", () => {
  const value = invoice();
  assert.doesNotThrow(() => assertStaffInvoiceIntegrity(value));
  assert.deepEqual(inspectStaffInvoiceIntegrity(value), {
    ok: true, lineCount: 1, calculatedSubtotal: 0, calculatedTotal: 0, reason: null,
  });
  assert.throws(() => assertStaffInvoiceIntegrity({ ...value, lines: [] }), /no persisted line items/);
  assert.throws(() => assertStaffInvoiceIntegrity({ ...value, total: 10 }), /stored total/);
  assert.throws(() => assertStaffInvoiceIntegrity({ ...value, lines: [{ ...warranty, qty: 0 }] }), /invalid quantity/);
});

async function readPdfText(blob: Blob): Promise<string[]> {
  // Parse only the in-memory synthetic generator output. Read page text rather
  // than the invoice-extraction heuristic, which does not claim zero-line or
  // Warranty-label recognition and is intentionally outside this change.
  Object.assign(globalThis, {
    DOMMatrix: globalThis.DOMMatrix ?? DOMMatrix,
    ImageData: globalThis.ImageData ?? ImageData,
    Path2D: globalThis.Path2D ?? Path2D,
  });
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.match(new TextDecoder().decode(bytes.slice(0, 9)), /^%PDF-1\.[0-7]/);
  const task = pdfjs.getDocument({ data: bytes, disableFontFace: true, isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
  try {
    const document = await task.promise;
    assert.ok(document.numPages >= 1);
    const text: string[] = [];
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      try {
        const content = await page.getTextContent();
        for (const item of content.items) if ("str" in item) text.push(item.str);
      } finally { page.cleanup(); }
    }
    return text;
  } finally { await task.destroy(); }
}

test("generated all-zero staff PDF remains a valid PDF containing Warranty, quantity one, zero rate and zero total", async () => {
  const value = invoice();
  const before = structuredClone(value);
  const text = await readPdfText(generateStaffInvoicePDFBlob(value, null));
  assert.ok(text.includes("Warranty"));
  assert.ok(text.includes(warranty.desc));
  assert.ok(text.includes("1"));
  assert.equal(text.filter(value => value === "$0.00").length, 5, "Rate, amount, subtotal, sales tax and total all remain explicit zeros");
  assert.ok(text.includes("Net 60"));
  assert.deepEqual(value, before, "Generating a document must not mutate persisted values");
});

test("mixed staff PDF preserves the no-charge Warranty row alongside unchanged paid work", async () => {
  const value = invoice([warranty, { type: "Labor", desc: "Separate synthetic paid work", qty: 2, rate: 110, amount: 220 }]);
  const text = await readPdfText(generateStaffInvoicePDFBlob(value, null));
  assert.ok(text.includes("Warranty")); assert.ok(text.includes(warranty.desc));
  assert.ok(text.includes("Labor")); assert.ok(text.includes("Separate synthetic paid work"));
  assert.equal(text.filter(value => value === "$0.00").length, 3, "Zero rate and line amount plus unchanged zero sales tax");
  assert.equal(text.filter(value => value === "$220.00").length, 3, "Paid line amount, subtotal and total");
  assert.ok(text.includes("$110.00"));
});
