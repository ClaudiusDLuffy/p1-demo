import assert from "node:assert/strict";
import test from "node:test";

import {
  contractorBillPdfPath,
  generateContractorBillManifestCsv,
} from "./contractorBillManifest";

test("contractor bill manifest is explicitly reference-only and preserves payables detail", () => {
  const csv = generateContractorBillManifestCsv([{
    portalInvoiceId: "invoice-id",
    contractorInvoiceNumber: "INV-42",
    contractorName: "Acme, LLC",
    contractorEmail: "billing@example.com",
    externalWorkOrderId: "WOT123",
    portalWorkOrderId: "WOT123-1",
    storeNumber: "456",
    equipmentTag: "7-ELEVEN: Refrigeration",
    invoiceDate: "2026-09-04",
    serviceDate: "2026-09-03",
    dueDate: "2026-10-04",
    subtotal: 125,
    salesTax: 10.3125,
    total: 135.3125,
    sourcePdf: "Contractor-Bill-PDFs/Invoice-INV-42-WOT123-invoice-id.pdf",
  }]);

  assert.match(csv, /^Reference Only,Portal Invoice ID,Contractor Invoice Number/);
  assert.match(csv, /Not a QuickBooks import file/);
  assert.match(csv, /"Acme, LLC"/);
  assert.match(csv, /WOT123,WOT123-1/);
  assert.match(csv, /456,7-ELEVEN: Refrigeration/);
  assert.match(csv, /125\.00,10\.31,135\.31/);
  assert.match(csv, /Contractor-Bill-PDFs\/Invoice-INV-42-WOT123-invoice-id\.pdf/);
});

test("source PDF paths stay unique when vendors reuse an invoice number", () => {
  const common = {
    contractorInvoiceNumber: "INV-42",
    externalWorkOrderId: "WOT123",
  };
  const first = contractorBillPdfPath({ ...common, portalInvoiceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  const second = contractorBillPdfPath({ ...common, portalInvoiceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });

  assert.notEqual(first, second);
  assert.match(first, /aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\.pdf$/);
  assert.match(second, /bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\.pdf$/);
});

test("contractor bill manifest protects spreadsheet cells from formula execution", () => {
  const csv = generateContractorBillManifestCsv([{
    portalInvoiceId: "invoice-id",
    contractorInvoiceNumber: "=DANGEROUS()",
    contractorName: "\t+Contractor",
    subtotal: 0,
    salesTax: 0,
    total: 0,
    sourcePdf: "bill.pdf",
  }]);

  assert.match(csv, /'=DANGEROUS\(\)/);
  assert.match(csv, /'\t\+Contractor/);
});

test("source PDF paths stay within portable component limits", () => {
  const path = contractorBillPdfPath({
    portalInvoiceId: "a".repeat(200),
    contractorInvoiceNumber: "b".repeat(200),
    externalWorkOrderId: "c".repeat(200),
  });

  assert.ok(new TextEncoder().encode(path).byteLength <= 255);
  assert.match(path, /^Contractor-Bill-PDFs\/Invoice-/);
});

test("contractor bill manifest rejects an empty package", () => {
  assert.throws(
    () => generateContractorBillManifestCsv([]),
    /No contractor bills are available/,
  );
});
