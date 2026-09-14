import { z } from "zod";
import { parseBillingRows, type BillingReadInput, type BillingRowsPage } from "../../features/billing/billingReadContracts";
import { AppError } from "../../lib/errors/AppError";
import { FINANCIAL_MAX_LINES, FINANCIAL_MAX_SOURCES } from "../../lib/staffInvoiceContracts";

type QueryResult = { data: unknown; error: unknown };
type AbortableRead = PromiseLike<QueryResult> & { abortSignal(signal: AbortSignal): PromiseLike<QueryResult> };
type Query = AbortableRead & {
  select(columns: string): Query;
  in(column: string, values: readonly string[]): Query;
  eq(column: string, value: string): Query;
  is(column: string, value: null): Query;
  order(column: string, options: { ascending: boolean }): Query;
  range(from: number, to: number): Query;
};
export type BillingLegacyReadPort = {
  from(table: "invoices" | "invoice_lines" | "staff_invoice_sources" | "work_orders"): Query;
  rpc(name: string, args: Record<string, unknown>): AbortableRead;
};

const text = z.string().nullable().optional();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}).nullable().optional();
const decimal = z.union([z.number().finite(), z.string().regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/)
  .refine(value => Number.isFinite(Number(value)))]).nullable().optional();
const version = z.number().int().nonnegative().safe().nullable().optional();
const invoiceSchema = z.object({
  id: z.string().uuid(), num: z.string(), work_order_id: z.string().nullable(), invoice_version: version.unwrap(),
  invoice_type: z.enum(["staff", "contractor"]), document_kind: z.enum(["invoice", "capital_quote"]).nullable().optional(),
  state: z.enum(["draft", "submitted", "approved", "rejected", "revised", "paid"]),
  store_number: text, store_address: text, contractor_id: z.string().uuid().nullable().optional(),
  source_capital_quote_id: z.string().uuid().nullable().optional(), cme: text,
  invoice_date: date, service_date: date, due_date: date, terms: text,
  subtotal: decimal.unwrap(), sales_tax: decimal.unwrap(), tax_state: text, tax_rate: decimal, total: decimal.unwrap(),
  territory: text, equipment_tag: text, pdf_storage_path: text, qbo_invoice_id: text,
  qbo_synced_at: text, created_at: text, updated_at: text, deleted_at: text,
});
const lineSchema = z.object({
  id: z.string().uuid(), invoice_id: z.string().uuid(), position: z.number().int().min(-2147483648).max(2147483647),
  type: z.string(), description: text, qty: decimal.unwrap(), rate: decimal.unwrap(), amount: decimal.unwrap(),
  is_taxable: z.boolean().nullable().optional(), source_invoice_line_id: z.string().uuid().nullable().optional(),
  source_work_order_part_id: z.string().uuid().nullable().optional(), source_unit_cost: decimal, markup_percent: decimal,
});
const linkSchema = z.object({ id: z.string().uuid(), staff_invoice_id: z.string().uuid(), contractor_invoice_id: z.string().uuid() });
const workOrderSchema = z.object({ id: z.string().min(1), duplicate_root_work_order_id: text.unwrap(),
  contractor_assignment_version: version.unwrap(), workflow_cycle: version.unwrap() });
type Invoice = z.infer<typeof invoiceSchema>;
type Line = z.infer<typeof lineSchema>;
type Link = z.infer<typeof linkSchema>;
type WorkOrder = z.infer<typeof workOrderSchema>;
export type BillingLegacyPageFacts = {
  page: Omit<BillingRowsPage, "items"> & { items: Invoice[] };
  staffLines: Line[]; sourceLinks: Link[]; sourceInvoices: Invoice[]; sourceLines: Line[]; workOrders: WorkOrder[];
};
export type BillingLegacySourceFacts = Pick<BillingLegacyPageFacts, "sourceInvoices" | "sourceLines" | "workOrders">;
export interface BillingLegacyReadRepository {
  page(input: BillingReadInput, signal: AbortSignal): Promise<BillingLegacyPageFacts>;
  invoice(invoiceId: string, signal: AbortSignal): Promise<BillingLegacyPageFacts | null>;
  sources(invoiceIds: readonly string[], controller: boolean, signal: AbortSignal): Promise<BillingLegacySourceFacts>;
  nextNumber(actorId: string, signal: AbortSignal): Promise<string | null>;
}

const INVOICE_COLUMNS = Object.keys(invoiceSchema.shape).join(",");
const LINE_COLUMNS = Object.keys(lineSchema.shape).join(",");
const LINK_COLUMNS = "id,staff_invoice_id,contractor_invoice_id";
const WORK_ORDER_COLUMNS = "id,duplicate_root_work_order_id,contractor_assignment_version,workflow_cycle";
const CHUNK_SIZE = 100;
const readEnvelope = z.object({ data: z.unknown(), error: z.unknown() }).refine(value =>
  Object.hasOwn(value, "data") && Object.hasOwn(value, "error")
  && (value.error === null || (value.data === null && typeof value.error === "object" && value.error !== null)));

function validate<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new AppError("INTERNAL_ERROR");
  return result.data;
}
async function read(query: AbortableRead, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const result = validate(readEnvelope, await query.abortSignal(signal));
  signal.throwIfAborted();
  if (result.error) throw result.error;
  return result.data;
}
async function chunks<T extends { id: string }>(ids: readonly string[], signal: AbortSignal,
  schema: z.ZodType<T>, load: (chunk: string[]) => Query, parent: (row: T) => string,
  completeRowsPerParent?: number): Promise<T[]> {
  const uniqueIds = [...new Set(ids)];
  const result: T[] = [];
  const seen = new Set<string>();
  // Preserve the legacy 100-parent batching. This is an explicit legacy
  // document response, not the compact-v1 summary or post-commit reader.
  for (let offset = 0; offset < uniqueIds.length; offset += CHUNK_SIZE) {
    signal.throwIfAborted();
    const chunk = uniqueIds.slice(offset, offset + CHUNK_SIZE);
    const rows = completeRowsPerParent === undefined
      ? validate(z.array(schema), await read(load(chunk), signal))
      : await completeRows(() => load(chunk), signal, schema, chunk.length * completeRowsPerParent);
    for (const row of rows) {
      if (!chunk.includes(parent(row)) || seen.has(row.id)) throw new AppError("INTERNAL_ERROR");
      seen.add(row.id);
      result.push(row);
    }
  }
  return result;
}

async function completeRows<T>(load: () => Query, signal: AbortSignal, schema: z.ZodType<T>, maximum: number): Promise<T[]> {
  const rows: T[] = [];
  // Only explicit legacy exact-document reads collect pages. Established
  // command bounds cap one staff document at 1,000 lines + 100 sources, and
  // each source at 1,000 lines. A one-row probe detects excess, never truncates.
  for (let offset = 0; offset <= maximum; offset += 1000) {
    signal.throwIfAborted();
    const last = Math.min(offset + 999, maximum);
    const page = validate(z.array(schema), await read(load().range(offset, last), signal));
    if (page.length > last - offset + 1 || rows.length + page.length > maximum) throw new AppError("INTERNAL_ERROR");
    rows.push(...page);
    if (page.length < last - offset + 1) return rows;
  }
  throw new AppError("INTERNAL_ERROR");
}

/** Real legacy SQL pages contain headers only. Load their separately owned
 * line/source/work-order facts; never rely on enriched mock-only RPC fields. */
export function createBillingLegacyReadRepository(client: BillingLegacyReadPort): BillingLegacyReadRepository {
  const lines = (ids: readonly string[], signal: AbortSignal, complete = false) => chunks(ids, signal, lineSchema, chunk => client
    .from("invoice_lines").select(LINE_COLUMNS).in("invoice_id", chunk)
    .order("invoice_id", { ascending: true }).order("position", { ascending: true }).order("id", { ascending: true }),
  row => row.invoice_id, complete ? FINANCIAL_MAX_LINES : undefined);
  const workOrders = (invoices: Invoice[], signal: AbortSignal) => chunks(
    invoices.flatMap(row => row.work_order_id ? [row.work_order_id] : []), signal, workOrderSchema,
    chunk => client.from("work_orders").select(WORK_ORDER_COLUMNS).in("id", chunk), row => row.id);
  const sourceHeaders = async (ids: readonly string[], signal: AbortSignal) => {
    const rows = await chunks(ids, signal, invoiceSchema, chunk => client.from("invoices").select(INVOICE_COLUMNS)
      .in("id", chunk).eq("invoice_type", "contractor").is("deleted_at", null), row => row.id);
    if (rows.some(row => row.invoice_type !== "contractor" || row.deleted_at != null)) throw new AppError("INTERNAL_ERROR");
    return rows;
  };
  const enrich = async (items: Invoice[], signal: AbortSignal, complete = false) => {
    const staffIds = items.map(row => row.id);
    const [staffLines, sourceLinks] = await Promise.all([
      lines(staffIds, signal, complete),
      chunks(staffIds, signal, linkSchema, chunk => client.from("staff_invoice_sources").select(LINK_COLUMNS)
        .in("staff_invoice_id", chunk).order("staff_invoice_id", { ascending: true })
        .order("contractor_invoice_id", { ascending: true }).order("id", { ascending: true }),
      row => row.staff_invoice_id, complete ? FINANCIAL_MAX_SOURCES : undefined),
    ]);
    const sourceIds = sourceLinks.map(row => row.contractor_invoice_id);
    const [sourceInvoices, sourceLines] = await Promise.all([sourceHeaders(sourceIds, signal), lines(sourceIds, signal, complete)]);
    return { staffLines, sourceLinks, sourceInvoices, sourceLines, workOrders: await workOrders([...items, ...sourceInvoices], signal) };
  };
  return {
    async nextNumber(actorId, signal) {
      signal.throwIfAborted();
      const raw = await read(client.rpc("peek_staff_invoice_num", { p_actor_id: actorId }), signal);
      if (raw === null || raw === "") return null;
      return validate(z.string().min(1), raw);
    },
    async sources(invoiceIds, controller, signal) {
      signal.throwIfAborted();
      const sourceInvoices = await sourceHeaders(invoiceIds, signal);
      if (sourceInvoices.length !== invoiceIds.length || (controller && sourceInvoices.some(row => !["approved", "paid"].includes(row.state)))) {
        // Preserve the existing legacy source-mode non-leaking error envelope;
        // compact-v1 has its own explicit NOT_FOUND/FORBIDDEN contract.
        throw new AppError("INTERNAL_ERROR");
      }
      const [sourceLines, contexts] = await Promise.all([lines(invoiceIds, signal), workOrders(sourceInvoices, signal)]);
      return { sourceInvoices, sourceLines, workOrders: contexts };
    },
    async invoice(invoiceId, signal) {
      signal.throwIfAborted();
      const rows = validate(z.array(invoiceSchema).max(1), await read(client.from("invoices").select(INVOICE_COLUMNS)
        .in("id", [invoiceId]).eq("invoice_type", "staff").is("deleted_at", null), signal));
      if (!rows.length) return null;
      if (rows[0].id !== invoiceId || rows[0].invoice_type !== "staff" || rows[0].deleted_at != null) throw new AppError("INTERNAL_ERROR");
      return { page: { items: rows, hasMore: false, nextCursor: null, totalCount: null }, ...await enrich(rows, signal, true) };
    },
    async page(input, signal) {
      signal.throwIfAborted();
      const raw = await read(client.rpc(input.response === "legacy" ? "list_staff_invoices_page" : "list_staff_invoices_rows_v1", {
        p_queue: input.queue, p_search: input.search, p_sort: input.sort, p_direction: input.direction,
        p_limit: input.limit, p_cursor: input.cursor, p_work_order_id: input.workOrderId,
      }), signal);
      const envelope = parseBillingRows(raw);
      const page = { ...envelope, items: envelope.items.map(row => validate(invoiceSchema, row)) };
      if (page.items.some(row => row.invoice_type !== "staff" || row.deleted_at != null)) throw new AppError("INTERNAL_ERROR");
      return { page, ...await enrich(page.items, signal) };
    },
  };
}
