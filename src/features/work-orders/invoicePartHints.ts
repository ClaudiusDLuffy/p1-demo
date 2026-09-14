import { AppError } from "../../lib/errors/AppError";
import { workOrderByIdKey } from "../../lib/counts/queryKeys";
import { boundedReadRpc } from "../../lib/counts/readRpc";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_INVOICE_PART_HINTS = 1_000;

/** Informational description-match hints only; never payment or write authority. */
export function invoicePartHintIds(parts: readonly { id: string }[]): string[] {
  const ids = [...new Set(parts.map(part => part.id))].sort();
  if (ids.length > MAX_INVOICE_PART_HINTS || ids.some(id => !UUID.test(id))) {
    throw new AppError("VALIDATION_FAILED");
  }
  return ids;
}

export function invoicePartHintsKey(workOrderId: string, scope: string, partIds: readonly string[]) {
  // Existing exact-parent Realtime and mutation invalidations include this key.
  return [...workOrderByIdKey(workOrderId, scope), "invoice-part-hints-v1", partIds] as const;
}

export function parseInvoicePartHints(raw: unknown, requestedIds: readonly string[]): readonly string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AppError("INTERNAL_ERROR");
  const value = Reflect.get(raw, "billedPartIds");
  if (!Array.isArray(value) || value.length > requestedIds.length) throw new AppError("INTERNAL_ERROR");
  const requested = new Set(requestedIds);
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string" || !requested.has(id) || seen.has(id)) throw new AppError("INTERNAL_ERROR");
    seen.add(id);
  }
  return [...seen];
}

export async function readInvoicePartHints(workOrderId: string, parts: readonly { id: string }[], signal?: AbortSignal,
  read: typeof boundedReadRpc = boundedReadRpc): Promise<readonly string[]> {
  const ids = invoicePartHintIds(parts);
  signal?.throwIfAborted();
  if (!ids.length) return [];
  const result = await read("get_work_order_invoice_part_hints_v1", {
    p_work_order_id: workOrderId, p_part_ids: ids,
  }, signal);
  signal?.throwIfAborted();
  return parseInvoicePartHints(result, ids);
}
