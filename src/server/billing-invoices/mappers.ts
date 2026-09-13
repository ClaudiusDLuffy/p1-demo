import { normalizeStaffBillingLineType } from "../../lib/staffBilling";
import { canonicalSevenElevenWorkOrderId } from "../../lib/workOrderIdentity";

export type WorkOrderFinancialContext = { externalId: string; assignmentVersion: number | null; workflowCycle: number | null };

export const mapLine = (line: Record<string, unknown>) => ({
  id: line.id,
  type: normalizeStaffBillingLineType(line.type),
  desc: line.description || "",
  description: line.description || "",
  qty: Number(line.qty || 0), rate: Number(line.rate || 0), amount: Number(line.amount || 0),
  isTaxable: !!line.is_taxable,
  sourceInvoiceLineId: line.source_invoice_line_id || null,
  sourceWorkOrderPartId: line.source_work_order_part_id || null,
  sourceUnitCost: line.source_unit_cost == null ? null : Number(line.source_unit_cost),
  markupPercent: line.markup_percent == null ? null : Number(line.markup_percent),
});

const formatDate = (d: string | null) => {
  if (!d) return null;
  const [y, m, day] = d.split("-");
  return y && m && day ? `${m}/${day}/${y}` : d;
};

const shortMonthDay = (d: string | null) => {
  if (!d) return "";
  const date = new Date(`${d}T00:00:00`);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("en-US", { month: "short", day: "numeric" });
};

export const mapInvoice = (invoice: Record<string, unknown>, lines: Array<Record<string, unknown>>, workOrderContext: WorkOrderFinancialContext | null = null) => ({
  id: String(invoice.id || ""), num: invoice.num, wot: invoice.work_order_id, workOrderId: invoice.work_order_id,
  externalWorkOrderId: workOrderContext?.externalId || canonicalSevenElevenWorkOrderId(String(invoice.work_order_id || "")) || null,
  invoiceVersion: invoice.invoice_version == null ? null : Number(invoice.invoice_version),
  assignmentVersion: workOrderContext?.assignmentVersion ?? null, workflowCycle: workOrderContext?.workflowCycle ?? null,
  store: invoice.store_number, storeAddr: invoice.store_address, contractor: invoice.contractor_id,
  invoiceType: invoice.invoice_type || "staff", documentKind: invoice.document_kind || "invoice",
  sourceCapitalQuoteId: invoice.source_capital_quote_id || null, cme: invoice.cme,
  invoiceDate: formatDate(typeof invoice.invoice_date === "string" ? invoice.invoice_date : null), invoiceDateRaw: invoice.invoice_date,
  serviceDate: formatDate(typeof invoice.service_date === "string" ? invoice.service_date : null), serviceDateRaw: invoice.service_date,
  dueDate: formatDate(typeof invoice.due_date === "string" ? invoice.due_date : null), dueDateRaw: invoice.due_date,
  terms: invoice.terms, state: invoice.state, subtotal: Number(invoice.subtotal || 0), salesTax: Number(invoice.sales_tax || 0),
  taxState: invoice.tax_state || null, taxRate: invoice.tax_rate == null ? null : Number(invoice.tax_rate), total: Number(invoice.total || 0),
  territory: invoice.territory || null, equipmentTag: invoice.equipment_tag || "7-ELEVEN: Miscellaneous", pdfStoragePath: invoice.pdf_storage_path || null,
  qboInvoiceId: invoice.qbo_invoice_id || null, qboSyncedAt: invoice.qbo_synced_at || null,
  date: shortMonthDay(typeof invoice.invoice_date === "string" ? invoice.invoice_date : null), createdAt: invoice.created_at, updatedAt: invoice.updated_at,
  lines: lines.map(mapLine),
});

export const sourceMetrics = (sourceInvoices: Array<Record<string, unknown>>, staffSubtotal: number) => {
  const contractorCost = sourceInvoices.reduce((sum, invoice) => sum + Number(invoice.subtotal ?? Math.max(Number(invoice.total || 0) - Number(invoice.salesTax || 0), 0)), 0);
  const grossProfit = staffSubtotal - contractorCost;
  return { contractorCost, grossProfit, marginPercent: staffSubtotal > 0 ? (grossProfit / staffSubtotal) * 100 : null };
};
