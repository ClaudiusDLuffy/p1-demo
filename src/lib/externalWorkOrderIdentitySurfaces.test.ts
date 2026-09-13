import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { generateInvoicePDF, invoiceFilename } from "./invoicePdf";
import { billingRouteHarness, financialTestIds } from "./billingFinancialRouteTestHarness";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const dashboardBuckets = read("src/features/dashboard/DashboardWorkBuckets.tsx");
const billingList = read("src/features/billing/BillingInvoiceList.tsx");
const billingDetail = read("src/features/billing/BillingInvoiceDetail.tsx");
const invoiceReviewRoute = read("src/app/api/notifications/invoice-review/route.ts");
const invoiceHoldsRoute = read("src/app/api/contractor-invoice-holds/route.ts");
const controllerExportPanel = read("src/features/invoices/ControllerExportPanel.tsx");
const contractorInvoiceCreate = read("src/features/invoices/InvoiceCreateModal.tsx");
const contractorInvoiceList = read("src/features/invoices/InvoiceList.tsx");
const contractorInvoiceDetail = read("src/features/invoices/InvoiceDetail.tsx");
const contractorInvoiceHook = read("src/features/invoices/useInvoices.ts");
const notificationBoundary = read("supabase/migrations/0135_expand_financial_notification_delivery.sql");
const notificationWorker = read("src/lib/server/financialNotificationWorker.ts");

test("the 7-Eleven dashboard queue copies the canonical work-order root", () => {
  assert.match(
    dashboardBuckets,
    /bucket\.id === "seven_eleven_updates"[\s\S]*?workOrder\.externalWorkOrderId[\s\S]*?workOrder\.duplicateRootWorkOrderId/,
  );
  assert.match(
    dashboardBuckets,
    /<CopyWorkOrderButton value=\{copiedWorkOrderId\} \/>/,
  );
});

test("the P1 billing API maps an external work-order identity from provenance", async () => {
  const h = billingRouteHarness({ externalRoot: "WOT1215047" });
  const response = await h.handlers.GET(h.request("GET", undefined, `?invoiceId=${financialTestIds.invoice}`));
  assert.equal(response.status, 200);
  const { invoice } = await response.json();
  assert.equal(invoice.externalWorkOrderId, "WOT1215047");
  assert.equal(invoice.workOrderId, "WOTSYNTHETIC");
  assert.equal(invoice.assignmentVersion, 0);
});

test("P1 billing list and detail copy the external work-order identity", () => {
  assert.match(
    billingList,
    /invoice\.externalWorkOrderId \|\| invoice\.wot/,
  );
  assert.match(
    billingList,
    /workOrder\.externalWorkOrderId \|\| workOrder\.duplicateRootWorkOrderId \|\| workOrder\.id/,
  );
  assert.doesNotMatch(
    billingList,
    /<CopyWorkOrderButton value=\{invoice\.wot\} \/>/,
  );
  assert.match(
    billingDetail,
    /<CopyWorkOrderButton value=\{invoice\.externalWorkOrderId \|\| invoice\.wot\} \/>/,
  );
  assert.match(billingList, /P1 portal reassignment:/);
  assert.match(billingDetail, /P1 portal reassignment:/);
});

test("invoice review and payment-hold surfaces preserve both work-order identities", () => {
  assert.match(invoiceReviewRoute, /get_financial_notification_review_compatibility_v1/);
  assert.match(notificationBoundary, /'workOrderId',i\.work_order_id,'externalWorkOrderId',coalesce\(w\.duplicate_root_work_order_id,w\.id\)/);
  assert.match(notificationWorker, /createInvoiceReviewNotificationPlan\(\{ recipients, invoice: \{ \.\.\.message\.invoice, workOrderId: message\.invoice\.workOrderId/);
  assert.match(invoiceHoldsRoute, /list_contractor_invoice_payment_holds_page_v1/);
  const holdPage = read("supabase/migrations/0142_bounded_payment_hold_history.sql");
  assert.match(holdPage, /'externalWorkOrderId', coalesce\(nullif\(w\.duplicate_root_work_order_id, ''\), nullif\(w\.id, ''\), p\.work_order_id\)/);
  assert.match(controllerExportPanel, /hold\.externalWorkOrderId \|\| hold\.workOrderId/);
  assert.match(controllerExportPanel, /P1 portal reassignment:/);
});

test("contractor invoice screens copy the canonical WOT and retain the portal reference", () => {
  assert.match(contractorInvoiceCreate, /canonicalSevenElevenWorkOrderId\(woData\)/);
  assert.match(contractorInvoiceCreate, /CopyWorkOrderButton value=\{externalWorkOrderId\}/);
  assert.match(contractorInvoiceCreate, /P1 portal reassignment:/);
  assert.match(contractorInvoiceList, /function InvoiceWorkOrderReference/);
  assert.match(contractorInvoiceList, /CopyWorkOrderButton value=\{externalWorkOrderId\}/);
  assert.match(contractorInvoiceList, /P1 portal reassignment:/);
  assert.match(contractorInvoiceDetail, /CopyWorkOrderButton value=\{externalWorkOrderId\}/);
  assert.match(contractorInvoiceDetail, /P1 portal reassignment:/);
});

test("generated contractor PDFs use the canonical WOT without rewriting uploads", () => {
  const pdf = generateInvoicePDF({
    num: "INV-77",
    wot: "WOT1215047-2",
    externalWorkOrderId: "WOT1215047",
    store: "12345",
    invoiceDate: "09/02/2026",
    lines: [],
    subtotal: 0,
    salesTax: 0,
    total: 0,
  }, null, { perspective: "contractor" });
  const commands = (pdf.internal.pages as unknown as string[][]).flat().join("\n");

  assert.match(commands, /\(WOT1215047\) Tj/);
  assert.doesNotMatch(commands, /WOT1215047-2/);
  assert.equal(
    invoiceFilename({
      num: "INV-77",
      wot: "WOT1215047-2",
      externalWorkOrderId: "WOT1215047",
    }),
    "Invoice-INV-77-WOT1215047.pdf",
  );

  const originalDownloadAt = contractorInvoiceHook.indexOf(
    "downloadInvoicePdfBlob(inv.pdfStoragePath)",
  );
  const generatedDownloadAt = contractorInvoiceHook.indexOf(
    "[inv, null, pdfOptions], generateInvoicePDFBlob)",
  );
  assert.ok(originalDownloadAt >= 0 && generatedDownloadAt > originalDownloadAt);
  assert.match(
    contractorInvoiceHook.slice(originalDownloadAt, generatedDownloadAt),
    /triggerBlobDownload\(blob, inv\.originalPdfName \|\| filename\);[\s\S]*?return;/,
  );
});
