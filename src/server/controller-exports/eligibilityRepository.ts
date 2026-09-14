import { z } from "zod";
import { AppError } from "../../lib/errors/AppError";

export const CONTROLLER_EXPORT_LIMIT = 500;
export const EXPORT_QUERY_CHUNK_SIZE = 100;
export const EXPORT_READ_PAGE_SIZE = 1000;
export const EXPORT_INVOICE_FIELDS = "id,num,work_order_id,store_number,store_address,invoice_date,service_date,due_date,terms,cme,subtotal,sales_tax,total,contractor_id,pdf_storage_path,state,invoice_type,deleted_at,qbo_synced_at,qbo_invoice_id,updated_at";

/** A request-scoped read capability; every returned envelope remains unknown. */
export type ControllerExportQuery = PromiseLike<unknown> & {
  eq(column: string, value: string): ControllerExportQuery;
  is(column: string, value: null): ControllerExportQuery;
  in(column: string, values: readonly string[]): ControllerExportQuery;
  order(column: string, options: { ascending: boolean }): ControllerExportQuery;
  range(from: number, to: number): ControllerExportQuery;
  abortSignal(signal: AbortSignal): ControllerExportQuery;
  retry(enabled: false): ControllerExportQuery;
};
export type ControllerExportReadSession = {
  from(table: string): { select(fields: string, options?: { count: "exact"; head: true }): ControllerExportQuery };
};
export function callExportClientMethod(target: unknown, methodName: string, args: readonly unknown[]): unknown {
  if (target === null || (typeof target !== "object" && typeof target !== "function")) throw new AppError("INTERNAL_ERROR");
  const method: unknown = Reflect.get(target, methodName);
  if (typeof method !== "function") throw new AppError("INTERNAL_ERROR");
  const result: unknown = Reflect.apply(method, target, args);
  return result;
}
const queryCapability = z.custom<ControllerExportQuery>(value => value !== null && typeof value === "object"
  && ["then", "eq", "is", "in", "order", "range", "abortSignal", "retry"].every(name => typeof Reflect.get(value, name) === "function"));

/** Validate a trusted SDK capability without casting any database result. */
export function createControllerExportReadSession(client: unknown): ControllerExportReadSession {
  return { from: table => ({ select: (fields, options) => {
    const query = callExportClientMethod(callExportClientMethod(client, "from", [table]), "select", options ? [fields, options] : [fields]);
    const parsed = queryCapability.safeParse(query);
    if (!parsed.success) throw new AppError("INTERNAL_ERROR", { cause: parsed.error });
    return parsed.data;
  } }) };
}
export type ControllerExportInvoiceFacts = {
  id: string; num: string; workOrderId: string | null; contractorId: string | null;
  storeNumber: string | null; storeAddress: string | null;
  invoiceDate: string; serviceDate: string | null; dueDate: string | null;
  terms: string | null; cme: string | null; subtotal: number | null;
  salesTax: number | null; total: number | null; pdfStoragePath: string | null;
  updatedAt: string;
};
export type ControllerExportQueueSummary = { count: number; pendingCount: number; oldestPendingAt: string | null };
export interface ControllerExportEligibilityRepository {
  loadSelected(ids: readonly string[]): Promise<readonly ControllerExportInvoiceFacts[]>;
  loadAutomatic(): Promise<readonly ControllerExportInvoiceFacts[]>;
  queueSummary(): Promise<ControllerExportQueueSummary>;
}

const uuid = z.uuid();
const text = z.string().max(10000);
const date = z.iso.date();
const timestamp = z.iso.datetime({ offset: true });
const money = z.number().finite().nullable();
const invoiceSchema = z.object({
  id: uuid, num: text, work_order_id: z.string().min(1).max(120).nullable(),
  contractor_id: uuid.nullable(), store_number: text.nullable(), store_address: text.nullable(),
  invoice_date: date, service_date: date.nullable(), due_date: date.nullable(),
  terms: text.nullable(), cme: text.nullable(), subtotal: money, sales_tax: money, total: money,
  pdf_storage_path: z.string().min(1).max(1000).nullable(), updated_at: timestamp.nullable(),
  state: z.literal("approved"), invoice_type: z.literal("contractor"),
  deleted_at: z.null(), qbo_synced_at: z.null(), qbo_invoice_id: z.null(),
});
const envelopeSchema = z.object({ data: z.unknown(), error: z.unknown() })
  .refine(value => Object.hasOwn(value, "data") && Object.hasOwn(value, "error"));

export function exportChunks<T>(values: readonly T[], size = EXPORT_QUERY_CHUNK_SIZE): T[][] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}

/** UUID columns canonicalize in PostgreSQL; textual work-order identities do not. */
export const exportUuidKey = (value: string): string => value.toLowerCase();

async function readExportCount(query: ControllerExportQuery, signal: AbortSignal | null): Promise<number> {
  signal?.throwIfAborted();
  let raw: unknown;
  try { const bounded = query.retry(false); raw = await (signal ? bounded.abortSignal(signal) : bounded); }
  catch (cause) { signal?.throwIfAborted(); throw new AppError("INTERNAL_ERROR", { cause }); }
  signal?.throwIfAborted();
  const result = z.object({ data: z.null(), error: z.null(), count: z.number().int().nonnegative().safe() }).safeParse(raw);
  if (!result.success) throw new AppError("INTERNAL_ERROR", { cause: result.error });
  return result.data.count;
}

/** No provider messages or row contents become public errors. */
export async function readExportRows<T>(query: ControllerExportQuery, schema: z.ZodType<T>, signal: AbortSignal | null): Promise<T[]> {
  signal?.throwIfAborted();
  let response: unknown;
  try { const bounded = query.retry(false); response = await (signal ? bounded.abortSignal(signal) : bounded); }
  catch (cause) { signal?.throwIfAborted(); throw new AppError("INTERNAL_ERROR", { cause }); }
  signal?.throwIfAborted();
  const envelope = envelopeSchema.safeParse(response);
  if (!envelope.success) throw new AppError("INTERNAL_ERROR", { cause: envelope.error });
  if (envelope.data.error !== null) throw new AppError("INTERNAL_ERROR", { cause: envelope.data.error });
  const rows = z.array(schema).max(EXPORT_READ_PAGE_SIZE).safeParse(envelope.data.data);
  if (!rows.success) throw new AppError("INTERNAL_ERROR", { cause: rows.error });
  return rows.data;
}

export function createEligibilityRepository(client: unknown, signal: AbortSignal | null): ControllerExportEligibilityRepository {
  const session = createControllerExportReadSession(client);
  const eligible = (fields: string, count = false) => session.from("invoices").select(fields, count ? { count: "exact", head: true } : undefined)
    .eq("invoice_type", "contractor").eq("state", "approved")
    .is("qbo_synced_at", null).is("qbo_invoice_id", null).is("deleted_at", null);

  async function exclusions(ids: readonly string[]) {
    const pending = new Set<string>(); const held = new Set<string>();
    for (const group of exportChunks(ids)) {
      signal?.throwIfAborted();
      const [pendingRows, holdRows] = await Promise.all([
        readExportRows(session.from("controller_invoice_export_items")
          .select("invoice_id,controller_invoice_export_batches!inner(status)")
          .in("invoice_id", group).eq("controller_invoice_export_batches.status", "pending")
          .order("invoice_id", { ascending: true }),
        z.object({ invoice_id: uuid, controller_invoice_export_batches: z.object({ status: z.literal("pending") }) }), signal),
        readExportRows(session.from("contractor_invoice_payment_holds").select("invoice_id")
          .in("invoice_id", group).order("invoice_id", { ascending: true }), z.object({ invoice_id: uuid }), signal),
      ]);
      for (const [rows, target] of [[pendingRows, pending], [holdRows, held]] as const) {
        for (const row of rows) {
          const key = exportUuidKey(row.invoice_id);
          if (!group.includes(key) || target.has(key)) throw new AppError("INTERNAL_ERROR");
          target.add(key);
        }
      }
    }
    return { pending, held };
  }

  function facts(row: z.infer<typeof invoiceSchema>): ControllerExportInvoiceFacts {
    if (row.updated_at === null) throw new AppError("CONFLICT");
    return { id: row.id, num: row.num, workOrderId: row.work_order_id, contractorId: row.contractor_id,
      storeNumber: row.store_number, storeAddress: row.store_address,
      invoiceDate: row.invoice_date, serviceDate: row.service_date, dueDate: row.due_date,
      terms: row.terms, cme: row.cme, subtotal: row.subtotal, salesTax: row.sales_tax, total: row.total,
      pdfStoragePath: row.pdf_storage_path, updatedAt: row.updated_at };
  }

  async function scanEligible(collect: boolean) {
    const selected: ControllerExportInvoiceFacts[] = [];
    let count = 0;
    for (let from = 0; ; from += EXPORT_READ_PAGE_SIZE) {
      signal?.throwIfAborted();
      const rows = await readExportRows(eligible(collect ? EXPORT_INVOICE_FIELDS : "id")
        .order("updated_at", { ascending: true }).order("id", { ascending: true })
        .range(from, from + EXPORT_READ_PAGE_SIZE - 1), collect ? invoiceSchema : z.object({ id: uuid }), signal);
      const ids = rows.map(row => exportUuidKey(row.id));
      if (new Set(ids).size !== ids.length) throw new AppError("INTERNAL_ERROR");
      const excluded = await exclusions(ids);
      for (const row of rows) {
        if (excluded.pending.has(exportUuidKey(row.id)) || excluded.held.has(exportUuidKey(row.id))) continue;
        count += 1;
        if (collect) {
          if (count > CONTROLLER_EXPORT_LIMIT) throw new AppError("CONFLICT");
          const parsed = invoiceSchema.safeParse(row);
          if (!parsed.success) throw new AppError("INTERNAL_ERROR", { cause: parsed.error });
          selected.push(facts(parsed.data));
        }
      }
      if (rows.length < EXPORT_READ_PAGE_SIZE) return { count, selected };
    }
  }

  return {
    async loadSelected(ids) {
      signal?.throwIfAborted();
      const unique = [...new Set(ids.map(exportUuidKey))];
      if (unique.length === 0 || unique.length > CONTROLLER_EXPORT_LIMIT || unique.some(id => !uuid.safeParse(id).success)) throw new AppError("INVALID_REQUEST");
      const excluded = await exclusions(unique);
      if (excluded.pending.size || excluded.held.size) throw new AppError("CONFLICT");
      const invoices: ControllerExportInvoiceFacts[] = [];
      const returned = new Set<string>();
      for (const group of exportChunks(unique)) {
        const rows = await readExportRows(eligible(EXPORT_INVOICE_FIELDS).in("id", group)
          .order("updated_at", { ascending: true }).order("id", { ascending: true }), invoiceSchema, signal);
        for (const row of rows) {
          const key = exportUuidKey(row.id);
          if (!group.includes(key) || returned.has(key)) throw new AppError("INTERNAL_ERROR");
          returned.add(key); invoices.push(facts(row));
        }
      }
      if (invoices.length !== unique.length) throw new AppError("CONFLICT");
      return invoices.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id));
    },
    async loadAutomatic() {
      const result = await scanEligible(true);
      if (!result.selected.length) throw new AppError("CONFLICT");
      return result.selected;
    },
    async queueSummary() {
      const total = await readExportCount(eligible("id", true), signal);
      let pendingCount = 0; let oldestPendingAt: string | null = null;
      async function* pendingIds(): AsyncGenerator<string> {
        let previous: string | null = null;
        for (let from = 0; ; from += EXPORT_READ_PAGE_SIZE) {
          const rows = await readExportRows(session.from("controller_invoice_export_items")
            .select("invoice_id,controller_invoice_export_batches!inner(status,created_at)")
            .eq("controller_invoice_export_batches.status", "pending")
            .order("invoice_id", { ascending: true }).order("batch_id", { ascending: true })
            .range(from, from + EXPORT_READ_PAGE_SIZE - 1),
          z.object({ invoice_id: uuid, controller_invoice_export_batches: z.object({ status: z.literal("pending"), created_at: timestamp }) }), signal);
          for (const row of rows) {
            const id = exportUuidKey(row.invoice_id);
            if (previous !== null && id < previous) throw new AppError("INTERNAL_ERROR");
            const created = row.controller_invoice_export_batches.created_at;
            if (oldestPendingAt === null || Date.parse(created) < Date.parse(oldestPendingAt)) oldestPendingAt = created;
            if (id !== previous) { pendingCount += 1; previous = id; yield id; }
          }
          if (rows.length < EXPORT_READ_PAGE_SIZE) return;
        }
      }
      async function* heldIds(): AsyncGenerator<string> {
        let previous: string | null = null;
        for (let from = 0; ; from += EXPORT_READ_PAGE_SIZE) {
          const rows = await readExportRows(session.from("contractor_invoice_payment_holds").select("invoice_id")
            .order("invoice_id", { ascending: true }).range(from, from + EXPORT_READ_PAGE_SIZE - 1), z.object({ invoice_id: uuid }), signal);
          for (const row of rows) {
            const id = exportUuidKey(row.invoice_id);
            if (previous !== null && id < previous) throw new AppError("INTERNAL_ERROR");
            if (id !== previous) { previous = id; yield id; }
          }
          if (rows.length < EXPORT_READ_PAGE_SIZE) return;
        }
      }
      // Merge two ordered streams. Resident IDs are two bounded pages plus one
      // 100-ID union chunk, independent of the size of the eligible population.
      const pending = pendingIds(); const held = heldIds();
      let left = await pending.next(); let right = await held.next();
      let excludedCount = 0; let previous: string | null = null; let group: string[] = [];
      while (!left.done || !right.done) {
        signal?.throwIfAborted();
        let id: string;
        if (!left.done && (right.done || left.value <= right.value)) { id = left.value; left = await pending.next(); }
        else { id = right.value; right = await held.next(); }
        if (id === previous) continue;
        previous = id; group.push(id);
        if (group.length === EXPORT_QUERY_CHUNK_SIZE) {
          excludedCount += await readExportCount(eligible("id", true).in("id", group), signal); group = [];
        }
      }
      if (group.length) excludedCount += await readExportCount(eligible("id", true).in("id", group), signal);
      return { count: Math.max(0, total - excludedCount), pendingCount, oldestPendingAt };
    },
  };
}
