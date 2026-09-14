import "server-only";
import { z } from "zod";
import { AppError } from "../../lib/errors/AppError";
import type { ControllerExportContext } from "./controllerExportContext";
import type { ControllerExportHistoryFilter } from "./contracts";

const timestamp = z.string().datetime({ offset: true });
const money = z.union([z.number(), z.string().regex(/^\d+(?:\.\d{1,2})?$/)])
  .transform(Number).refine(value => Number.isFinite(value) && value >= 0);
const status = z.enum(["pending", "confirmed", "cancelled"]);
const format = z.enum(["reference_manifest_v2", "legacy_saas_ant_v1"]);
const batchSchema = z.object({ id: z.string().uuid(), status,
  created_at: timestamp, created_by: z.string().uuid(),
  confirmed_at: timestamp.nullable(), confirmed_by: z.string().uuid().nullable(),
  cancelled_at: timestamp.nullable(), cancelled_by: z.string().uuid().nullable(),
  cancellation_reason: z.string().nullable(), invoice_count: z.number().int().positive().max(500), total: money,
}).refine(row => row.status === "pending"
  ? row.confirmed_at === null && row.confirmed_by === null && row.cancelled_at === null && row.cancelled_by === null
  : row.status === "confirmed"
    ? row.confirmed_at !== null && row.confirmed_by !== null && row.cancelled_at === null && row.cancelled_by === null
    : row.cancelled_at !== null && row.cancelled_by !== null && row.confirmed_at === null && row.confirmed_by === null
      && Boolean(row.cancellation_reason?.trim()));
const itemSchema = z.object({ batch_id: z.string().uuid(), invoice_id: z.string().uuid(),
  invoice_num: z.string().nullable(), work_order_id: z.string().nullable(), contractor_id: z.string().uuid().nullable(),
  total: money, exported_at: timestamp });
const profileSchema = z.object({ id: z.string().uuid(), name: z.string().nullable(), company: z.string().nullable() });
const downloadSchema = z.object({ id: z.string().uuid(), object_path: z.string(), status,
  created_at: timestamp, archive_format: format.nullable() });
export type ControllerExportHistoryBatchFacts = {
  id: string; status: "pending" | "confirmed" | "cancelled"; createdAt: string; createdBy: string;
  confirmedAt: string | null; confirmedBy: string | null; cancelledAt: string | null; cancelledBy: string | null;
  cancellationReason: string | null; invoiceCount: number; total: number;
};
export type ControllerExportHistoryItemFacts = { batchId: string; invoiceId: string; invoiceNumber: string;
  workOrderId: string | null; contractorId: string | null; total: number };
export type ControllerExportHistoryPage = {
  batches: readonly ControllerExportHistoryBatchFacts[];
  items: readonly ControllerExportHistoryItemFacts[];
  profiles: readonly { id: string; name: string | null; company: string | null }[];
};
export type ControllerExportDownloadBinding = { batchId: string; objectPath: string;
  status: "pending" | "confirmed" | "cancelled"; createdAt: string;
  format: "reference_manifest_v2" | "legacy_saas_ant_v1" };
export interface ControllerExportHistoryRepository {
  loadRecent(filter: ControllerExportHistoryFilter): Promise<ControllerExportHistoryPage>;
  pages(filter: ControllerExportHistoryFilter): AsyncIterable<ControllerExportHistoryPage>;
  loadDownload(batchId: string): Promise<ControllerExportDownloadBinding | null>;
}
const COLUMNS = "id,status,created_at,created_by,confirmed_at,confirmed_by,cancelled_at,cancelled_by,cancellation_reason,invoice_count,total";
const key = (id: string) => id.toLowerCase();
const malformed = (): never => { throw new AppError("INTERNAL_ERROR"); };
function validated<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = z.object({ data: schema, error: z.null() }).safeParse(raw);
  return result.success ? result.data.data : malformed();
}

export function createHistoryRepository(context: ControllerExportContext): ControllerExportHistoryRepository {
  const { dataSession: session, signal } = context;
  const check = () => signal?.throwIfAborted();
  async function batchPage(filter: ControllerExportHistoryFilter, offset: number, ascending: boolean) {
    check();
    let query = session.from("controller_invoice_export_batches").select(COLUMNS)
      .order("created_at", { ascending }).order("id", { ascending }).range(offset, offset + 99).retry(false);
    if (filter.from) query = query.gte("created_at", `${filter.from}T00:00:00.000Z`);
    if (filter.toExclusive) query = query.lt("created_at", filter.toExclusive);
    if (filter.actor) query = query.eq("created_by", filter.actor);
    const result = await (signal ? query.abortSignal(signal) : query);
    check();
    const rows = validated(z.array(batchSchema).max(100), result);
    if (new Set(rows.map(row => key(row.id))).size !== rows.length) return malformed();
    return rows;
  }
  async function hydrate(rows: z.infer<typeof batchSchema>[]): Promise<ControllerExportHistoryPage> {
    if (!rows.length) return { batches: [], items: [], profiles: [] };
    const ids = rows.map(row => row.id);
    const allowed = new Map(rows.map(row => [key(row.id), row.invoice_count]));
    const items: ControllerExportHistoryItemFacts[] = [];
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    // Each immutable batch has at most 500 items. Paging cannot become an unbounded collector.
    const maximum = rows.reduce((sum, row) => sum + row.invoice_count, 0);
    for (let offset = 0; ; offset += 1000) {
      check();
      const query = session.from("controller_invoice_export_items")
        .select("batch_id,invoice_id,invoice_num,work_order_id,contractor_id,total,exported_at")
        .in("batch_id", ids).order("exported_at", { ascending: true })
        .order("invoice_id", { ascending: true }).order("batch_id", { ascending: true }).range(offset, offset + 999).retry(false);
      const result = await (signal ? query.abortSignal(signal) : query);
      check();
      const page = validated(z.array(itemSchema).max(1000), result);
      for (const item of page) {
        const binding = key(item.batch_id);
        const identity = `${binding}:${key(item.invoice_id)}`;
        if (!allowed.has(binding) || seen.has(identity)) return malformed();
        seen.add(identity);
        const count = (counts.get(binding) ?? 0) + 1;
        if (count > (allowed.get(binding) ?? 0)) return malformed();
        counts.set(binding, count);
        items.push({ batchId: item.batch_id, invoiceId: item.invoice_id, invoiceNumber: item.invoice_num ?? "",
          workOrderId: item.work_order_id, contractorId: item.contractor_id, total: item.total });
      }
      if (items.length > maximum) return malformed();
      if (page.length < 1000) break;
    }
    if (rows.some(row => (counts.get(key(row.id)) ?? 0) !== row.invoice_count)) return malformed();
    const profileIds = [...new Set([...rows.flatMap(row => [row.created_by, row.confirmed_by, row.cancelled_by]),
      ...items.map(item => item.contractorId)].filter((id): id is string => id !== null).map(key))];
    const profiles: ControllerExportHistoryPage["profiles"][number][] = [];
    for (let index = 0; index < profileIds.length; index += 100) {
      check();
      const chunk = profileIds.slice(index, index + 100);
      const query = session.from("profiles").select("id,name,company").in("id", chunk).order("id", { ascending: true }).retry(false);
      const result = await (signal ? query.abortSignal(signal) : query);
      check();
      const page = validated(z.array(profileSchema).max(chunk.length), result);
      if (page.some(row => !chunk.includes(key(row.id))) || new Set(page.map(row => key(row.id))).size !== page.length) return malformed();
      profiles.push(...page.map(row => ({ id: row.id, name: row.name ?? null, company: row.company ?? null })));
    }
    return { batches: rows.map(row => ({ id: row.id, status: row.status, createdAt: row.created_at,
      createdBy: row.created_by, confirmedAt: row.confirmed_at, confirmedBy: row.confirmed_by,
      cancelledAt: row.cancelled_at, cancelledBy: row.cancelled_by, cancellationReason: row.cancellation_reason,
      invoiceCount: row.invoice_count, total: row.total })), items, profiles };
  }
  return {
    async loadRecent(filter) { return hydrate(await batchPage(filter, 0, false)); },
    async *pages(filter) {
      // Complete CSV, bounded resident page. Do not truncate historical exports.
      for (let offset = 0; ; offset += 100) {
        const rows = await batchPage(filter, offset, true);
        if (rows.length) yield await hydrate(rows);
        if (rows.length < 100) return;
      }
    },
    async loadDownload(batchId) {
      check();
      const query = session.from("controller_invoice_export_batches")
        .select("id,object_path,status,created_at,archive_format").eq("id", batchId).retry(false);
      const result = await (signal ? query.abortSignal(signal) : query).maybeSingle();
      check();
      const row = validated(downloadSchema.nullable(), result);
      if (row === null) return null;
      if (key(row.id) !== key(batchId)
        || !/^\d{4}-\d{2}-\d{2}\/[^/]+\.zip$/.test(row.object_path)
        || !z.iso.date().safeParse(row.object_path.slice(0, 10)).success
        || key(row.object_path.slice(11, -4)) !== key(batchId)) return malformed();
      return { batchId: row.id, objectPath: row.object_path, status: row.status, createdAt: row.created_at,
        format: row.archive_format ?? "legacy_saas_ant_v1" };
    },
  };
}
