import { supabase } from "../../lib/supabase/client";
import { apiFetch } from "../../lib/errors/apiFetch";
import { AppError } from "../../lib/errors/AppError";
import { readBoundedBody } from "../../lib/http/boundedBody";
import { billingReadUrl, parseBillingCount, parseBillingRows, type BillingCountFilters,
  type BillingInvoicePageParams } from "./billingReadContracts";
import { invoiceSummaryForLegacyUi, parseInvoiceSummaryDto, parseInvoiceLinePage, parseInvoiceSourceImportSummary } from "../invoices/invoiceReadContracts";
import { readCompleteInvoiceDocument, type InvoiceDocumentPurpose } from "../invoices/invoiceDocumentRead";
import { canonicalBillingReadUuid } from "./billingReadUuid";

// Read-only billing boundary. The existing mutation helper is unchanged.
async function readBillingJson(path: string, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const { data } = await supabase().auth.getSession();
  signal.throwIfAborted();
  const token = data.session?.access_token;
  if (!token) throw new AppError("AUTH_REQUIRED");
  const response = await apiFetch(path, { signal, headers: { Authorization: `Bearer ${token}` } });
  let payload: unknown;
  const body = await readBoundedBody(response.body, { maximum: 200 * 1024, timeoutMs: 15_000, signal });
  try { payload = JSON.parse(body); }
  catch { signal.throwIfAborted(); throw new AppError("INTERNAL_ERROR"); }
  signal.throwIfAborted();
  return payload;
}
export async function readBillingRows(params: BillingInvoicePageParams, signal: AbortSignal) {
  const page = parseBillingRows(await readBillingJson(billingReadUrl(params, "rows"), signal));
  return { ...page, items: page.items.map(item => invoiceSummaryForLegacyUi(parseInvoiceSummaryDto(item))) };
}
export async function readBillingCount(params: BillingCountFilters, signal: AbortSignal) {
  return parseBillingCount(await readBillingJson(billingReadUrl(params, "count"), signal));
}
export async function readBillingSummary(id: string, signal: AbortSignal) {
  const invoiceId = canonicalBillingReadUuid(id) ?? id;
  const payload = await readBillingJson(`/api/billing-invoices?contract=compact-v1&invoiceId=${encodeURIComponent(invoiceId)}`, signal);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new AppError("INTERNAL_ERROR");
  const invoice = (payload as Record<string, unknown>).invoice;
  if (invoice === null) return null;
  if (!invoice || typeof invoice !== "object" || Array.isArray(invoice)) throw new AppError("INTERNAL_ERROR");
  const row = invoice as Record<string, unknown>;
  if (canonicalBillingReadUuid(row.id) !== invoiceId) throw new AppError("INTERNAL_ERROR");
  return parseInvoiceSummaryDto({ ...row, id: invoiceId });
}
export async function readBillingInvoice(id: string, signal: AbortSignal) {
  const summary = await readBillingSummary(id, signal);
  return summary ? invoiceSummaryForLegacyUi(summary) : null;
}
export async function readBillingLines(id: string, version: number, cursor: string | null, signal: AbortSignal) {
  const search = new URLSearchParams({ contract: "compact-v1", invoiceId: canonicalBillingReadUuid(id) ?? id, lines: "1", limit: "50", expectedVersion: String(version) });
  if (cursor) search.set("cursor", cursor);
  return parseInvoiceLinePage(await readBillingJson(`/api/billing-invoices?${search}`, signal), false);
}
export function readBillingDocument(id: string, purpose: InvoiceDocumentPurpose, signal: AbortSignal, maxLines?: number) {
  return readCompleteInvoiceDocument({ purpose, signal, maxLines,
    summary: () => readBillingSummary(id, signal),
    page: (version, cursor) => readBillingLines(id, version, cursor, signal) });
}
export async function readBillingSourceSummaries(ids: readonly string[], signal: AbortSignal) {
  if (!ids.length || ids.length > 100) throw new AppError("INVALID_REQUEST");
  const invoiceIds = ids.map(id => canonicalBillingReadUuid(id) ?? id);
  if (new Set(invoiceIds).size !== invoiceIds.length) throw new AppError("INVALID_REQUEST");
  const search = new URLSearchParams({ contract: "compact-v1", sourceInvoiceIds: invoiceIds.join(",") });
  const payload = await readBillingJson(`/api/billing-invoices?${search}`, signal);
  if (!payload || typeof payload !== "object" || !("invoices" in payload) || !Array.isArray(payload.invoices)
    || payload.invoices.length !== ids.length) throw new AppError("INTERNAL_ERROR");
  const summaries = payload.invoices.map(value => {
    const summary = parseInvoiceSourceImportSummary(value);
    const id = canonicalBillingReadUuid(summary.id);
    if (id === null) throw new AppError("INTERNAL_ERROR");
    return { ...summary, id };
  });
  if (new Set(summaries.map(value => value.id)).size !== ids.length || summaries.some(value => !invoiceIds.includes(value.id))) throw new AppError("INTERNAL_ERROR");
  return summaries;
}
