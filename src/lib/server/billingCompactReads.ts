import { AppError } from "../errors/AppError";
import { normalizeUnknownError } from "../errors/normalizeUnknown";
import { parseBillingRows } from "../../features/billing/billingReadContracts";
import { invoiceReadRecord, parseInvoiceLinePage, parseInvoiceSummary } from "../../features/invoices/invoiceReadContracts";
import type { CompactBillingRead } from "./billingCompactReadInput";
import { canonicalBillingReadUuid } from "../../features/billing/billingReadUuid";

type ReadResult = { data: unknown; error: unknown };
type AbortableRead = PromiseLike<ReadResult> & { abortSignal(signal: AbortSignal): PromiseLike<ReadResult> };
export type CompactBillingReadPort = {
  rpc(name: string,
    args: Record<string, unknown>): AbortableRead;
  from(name: "invoices"): {
    select(columns: string): {
      eq(column: string, value: string): {
        is(column: string, value: null): { maybeSingle(): AbortableRead };
      };
    };
  };
};

async function read(query: AbortableRead, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const { data, error } = await query.abortSignal(signal);
  signal.throwIfAborted();
  if (error) throw normalizeUnknownError(error);
  return data;
}

function resultUuid(value: unknown): string {
  const id = canonicalBillingReadUuid(value);
  if (id === null) throw new AppError("INTERNAL_ERROR");
  return id;
}

function parseBoundedLinePage(value: unknown) {
  const page = invoiceReadRecord(value);
  if (!Array.isArray(page.items) || page.items.length > 100) throw new AppError("INTERNAL_ERROR");
  // Normalize before the shared parser checks row ordering and duplicates.
  // UUID spelling is not relational identity; opaque cursors remain untouched.
  return parseInvoiceLinePage({ ...page, items: page.items.map(value => {
    const line = invoiceReadRecord(value);
    return { ...line, id: resultUuid(line.id), invoice_id: resultUuid(line.invoice_id) };
  }) });
}

function assertSourcePermission(type: unknown, state: unknown, controller: boolean): void {
  if (type !== "staff" && type !== "contractor") throw new AppError("NOT_FOUND");
  // The existing staff source endpoint admits contractor documents for
  // operational staff, but controllers only see approved/paid sources.
  if (type === "contractor" && controller && state !== "approved" && state !== "paid") throw new AppError("FORBIDDEN");
}

/** Called only AFTER the route's current active staff/grant authorization.
 * The existing server-authorized billing read scope is deliberately retained.
 * No provider call or ordinary browser service-role client is introduced. */
export async function loadCompactBillingRead(client: CompactBillingReadPort, controller: boolean,
  input: Exclude<CompactBillingRead, { kind: "count" }>, signal: AbortSignal): Promise<unknown> {
  if (input.kind === "page") {
    const page = input.page;
    const raw = await read(client.rpc("list_staff_invoices_rows_v2", {
      p_queue: page.queue, p_search: page.search, p_sort: page.sort, p_direction: page.direction,
      p_limit: page.limit, p_cursor: page.cursor, p_work_order_id: page.workOrderId,
    }), signal);
    const result = parseBillingRows(raw);
    return { projection: "summary", items: result.items.map(parseInvoiceSummary),
      pageSize: page.limit, nextCursor: result.nextCursor, hasMore: result.hasMore };
  }
  if (input.kind === "sources") {
    // One set-based query for an explicit import preflight, not one header RPC
    // per source. Full documents are requested only after this bounded check.
    const raw = invoiceReadRecord(await read(client.rpc("get_invoice_source_summaries_v1", {
      p_invoice_ids: input.invoiceIds,
    }), signal));
    if (!Array.isArray(raw.invoices) || raw.invoices.length !== input.invoiceIds.length) throw new AppError("NOT_FOUND");
    const seen = new Set<string>();
    const invoices = raw.invoices.map(value => {
      const source = invoiceReadRecord(value);
      const invoice = parseInvoiceSummary({ ...source, id: resultUuid(source.id), projection: "summary" });
      if (!input.invoiceIds.includes(invoice.id) || seen.has(invoice.id) || invoice.invoiceType !== "contractor") throw new AppError("NOT_FOUND");
      seen.add(invoice.id);
      assertSourcePermission(invoice.invoiceType, invoice.state, controller);
      return { id: invoice.id, num: invoice.num, state: invoice.state, workOrderId: invoice.workOrderId ?? null,
        invoiceVersion: invoice.invoiceVersion, lineCount: invoice.lineCount,
        subtotal: invoice.subtotal, salesTax: invoice.salesTax, total: invoice.total };
    });
    return { invoices };
  }
  if (input.kind === "summary") {
    const raw = await read(client.rpc("get_invoice_summary_v1", { p_invoice_id: input.invoiceId }), signal);
    if (raw === null) throw new AppError("NOT_FOUND");
    const row = invoiceReadRecord(raw);
    const invoice = parseInvoiceSummary({ ...row, id: resultUuid(row.id) });
    if (invoice.id !== input.invoiceId) throw new AppError("NOT_FOUND");
    assertSourcePermission(invoice.invoiceType, invoice.state, controller);
    return { invoice };
  }
  // Header authorization/version only: no COUNT or line/category aggregation
  // is repeated on a continuation. The line RPC rejects a concurrent revision.
  const rawGate = await read(client.from("invoices")
    .select("id,invoice_type,state,invoice_version")
    .eq("id", input.invoiceId).is("deleted_at", null).maybeSingle(), signal);
  if (rawGate === null) throw new AppError("NOT_FOUND");
  const gate = invoiceReadRecord(rawGate);
  if (resultUuid(gate.id) !== input.invoiceId) throw new AppError("NOT_FOUND");
  assertSourcePermission(gate.invoice_type, gate.state, controller);
  const version = gate.invoice_version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) throw new AppError("INTERNAL_ERROR");
  if (input.expectedVersion !== null && version !== input.expectedVersion) throw new AppError("STALE_VERSION");
  const result = parseBoundedLinePage(await read(client.rpc("list_invoice_lines_page_v1", {
    p_invoice_id: input.invoiceId, p_limit: input.limit, p_cursor: input.cursor,
    p_expected_version: input.expectedVersion ?? version,
  }), signal));
  if (result.invoiceVersion !== version || result.items.some(line => line.invoiceId !== input.invoiceId)) throw new AppError("STALE_VERSION");
  return result;
}
