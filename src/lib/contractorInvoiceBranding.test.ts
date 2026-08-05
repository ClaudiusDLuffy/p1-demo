import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const detail = readFileSync(
  resolve(process.cwd(), "src/features/invoices/InvoiceDetail.tsx"),
  "utf8",
);
const hook = readFileSync(
  resolve(process.cwd(), "src/features/invoices/useInvoices.ts"),
  "utf8",
);
const pdf = readFileSync(resolve(process.cwd(), "src/lib/invoicePdf.ts"), "utf8");
const createModal = readFileSync(
  resolve(process.cwd(), "src/features/invoices/InvoiceCreateModal.tsx"),
  "utf8",
);

test("contractor invoice detail is FROM the invoice owner for staff and contractors", () => {
  assert.match(detail, /getUser\?\.\(inv\.contractor\)/);
  assert.match(detail, /const contractorName = contractorProfile\?\.company/);
  assert.doesNotMatch(detail, /contractorView \?/);
  assert.doesNotMatch(detail, /SEVEN_BILL_TO/);
});

test("generated and legacy-cached contractor PDFs use contractor framing", () => {
  assert.match(hook, /perspective: "contractor" as const/);
  assert.match(hook, /legacy cached PDFs that were generated with/);
  assert.match(hook, /generateInvoicePDFBlob\(inv, null, contractorPdfOptions\(inv\)\)/);
  assert.match(pdf, /fromEmail\?: string/);
  assert.match(pdf, /Payment terms:/);
});

test("contractor invoice numbers remain auto-populated and editable", () => {
  assert.match(createModal, /register\("num", \{ onChange:/);
  assert.doesNotMatch(createModal, /register\("num"[^>]+readOnly/);
});

