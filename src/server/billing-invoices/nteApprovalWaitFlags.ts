import { z } from "zod";
import { AppError } from "../../lib/errors/AppError";
import { normalizeUnknownError } from "../../lib/errors/normalizeUnknown";

type RpcResult = { data: unknown; error: unknown };
type AbortableRpc = PromiseLike<RpcResult> & { abortSignal(signal: AbortSignal): PromiseLike<RpcResult> };
export type NteApprovalWaitReadClient = {
  rpc(name: "list_staff_invoice_nte_wait_flags_v1", args: { p_invoice_ids: string[] }): AbortableRpc;
};

const payloadSchema = z.object({
  items: z.array(z.object({ invoiceId: z.string().uuid(), waitingOnNteApproval: z.boolean() }).strict()).max(100),
}).strict();

/** Read the marker state for one bounded invoice page/detail in a single query. */
export async function loadStaffInvoiceNteWaitFlags(
  client: NteApprovalWaitReadClient,
  invoiceIds: readonly string[],
  signal: AbortSignal,
): Promise<Map<string, boolean>> {
  const ids = [...new Set(invoiceIds.map(id => id.toLowerCase()))];
  if (ids.length !== invoiceIds.length || ids.length > 100
    || ids.some(id => !z.string().uuid().safeParse(id).success)) throw new AppError("INTERNAL_ERROR");
  if (ids.length === 0) return new Map();

  signal.throwIfAborted();
  const { data, error } = await client.rpc("list_staff_invoice_nte_wait_flags_v1", { p_invoice_ids: ids }).abortSignal(signal);
  signal.throwIfAborted();
  if (error) throw normalizeUnknownError(error);
  const parsed = payloadSchema.safeParse(data);
  if (!parsed.success || parsed.data.items.length !== ids.length) throw new AppError("INTERNAL_ERROR");
  const expected = new Set(ids);
  const result = new Map<string, boolean>();
  for (const item of parsed.data.items) {
    const id = item.invoiceId.toLowerCase();
    if (!expected.has(id) || result.has(id)) throw new AppError("INTERNAL_ERROR");
    result.set(id, item.waitingOnNteApproval);
  }
  if (result.size !== ids.length) throw new AppError("INTERNAL_ERROR");
  return result;
}

export function attachStaffInvoiceNteWaitFlags<T extends { id: string }>(
  invoices: readonly T[],
  flags: ReadonlyMap<string, boolean>,
): (T & { waitingOnNteApproval: boolean })[] {
  return invoices.map(invoice => ({
    ...invoice,
    waitingOnNteApproval: flags.get(invoice.id.toLowerCase()) ?? false,
  }));
}

type InvoiceNteWaitTarget = { id: string; invoiceType?: unknown };
type NteWaitFlagReader = (invoiceIds: readonly string[], signal: AbortSignal) => Promise<ReadonlyMap<string, boolean>>;

/** Contractor source invoices are not eligible for staff NTE flags. Keep mixed
 * staff/contractor read pages intact while querying only the eligible staff IDs. */
export async function attachApplicableStaffInvoiceNteWaitFlags<T extends InvoiceNteWaitTarget>(
  invoices: readonly T[],
  readFlags: NteWaitFlagReader,
  signal: AbortSignal,
): Promise<(T & { waitingOnNteApproval: boolean })[]> {
  const staffInvoices = invoices.filter(invoice => invoice.invoiceType === "staff");
  const flags = staffInvoices.length
    ? await readFlags(staffInvoices.map(invoice => invoice.id), signal)
    : new Map<string, boolean>();

  return invoices.map(invoice => ({
    ...invoice,
    waitingOnNteApproval: invoice.invoiceType === "staff"
      ? flags.get(invoice.id.toLowerCase()) ?? false
      : false,
  }));
}
