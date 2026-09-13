import { z } from "zod";
import { FinancialNoticeError } from "../features/financial-notifications/contracts";

export const PAYMENT_HOLD_PAGE_SIZE = 25;
export const PAYMENT_HOLD_LEGACY_PAGE_SIZE = 100;
const cursor = z.string().min(1).max(4096).regex(/^[A-Za-z0-9_-]+$/);
export const paymentHoldSchema = z.strictObject({
  invoiceId: z.uuid(), invoiceNumber: z.string(), workOrderId: z.string().nullable(),
  externalWorkOrderId: z.string().nullable(), contractorName: z.string(), total: z.number().finite(),
  holdAt: z.string().datetime({ offset: true }), holdBy: z.uuid(), holdByName: z.string(), reason: z.string(),
});
export type PaymentHold = z.infer<typeof paymentHoldSchema>;
const pageSchema = z.strictObject({ holds: z.array(paymentHoldSchema).max(100), canRelease: z.boolean(),
  pageSize: z.number().int().min(1).max(100), hasMore: z.boolean(), nextCursor: cursor.nullable() });

export function parsePaymentHoldQuery(params: URLSearchParams) {
  for (const key of params.keys()) {
    if (!["limit", "cursor"].includes(key) || params.getAll(key).length !== 1) {
      throw new FinancialNoticeError("VALIDATION_FAILED");
    }
  }
  const limit = params.get("limit");
  if (limit !== null && !/^(?:[1-9][0-9]?|100)$/.test(limit)) throw new FinancialNoticeError("VALIDATION_FAILED");
  const value = params.get("cursor");
  if (value !== null && !cursor.safeParse(value).success) throw new FinancialNoticeError("INVALID_CURSOR");
  return { p_limit: limit === null ? PAYMENT_HOLD_LEGACY_PAGE_SIZE : Number(limit), p_cursor: value };
}

export function parsePaymentHoldPage(value: unknown, pageSize: number) {
  const parsed = pageSchema.safeParse(value);
  if (!parsed.success || parsed.data.pageSize !== pageSize || parsed.data.holds.length > pageSize
    || parsed.data.hasMore !== (parsed.data.nextCursor !== null)
    || (parsed.data.hasMore && parsed.data.holds.length !== pageSize)
    || new Set(parsed.data.holds.map(hold => hold.invoiceId)).size !== parsed.data.holds.length) {
    throw new FinancialNoticeError("RESULT_UNCONFIRMED");
  }
  return parsed.data;
}

/** Narrow adapter for the additive migration; generated database types remain untouched. */
export type PaymentHoldPageRpc = {
  rpc(name: "list_contractor_invoice_payment_holds_page_v1", args: ReturnType<typeof parsePaymentHoldQuery>): {
    abortSignal(signal: AbortSignal): PromiseLike<{ data: unknown; error: unknown }>;
  };
};

/** Do not trust a raw database message to classify malformed cursor failures. */
export function paymentHoldReadError(error: unknown) {
  if (error instanceof FinancialNoticeError) return error;
  const parsed = z.object({ code: z.string() }).safeParse(error);
  const code = parsed.success ? parsed.data.code : "";
  return new FinancialNoticeError(code === "PDC01" ? "INVALID_CURSOR"
    : code === "22023" ? "VALIDATION_FAILED"
      : ["PT401", "PGRST301", "PGRST302"].includes(code) ? "AUTH_REQUIRED"
        : ["42501", "PT403"].includes(code) ? "FORBIDDEN" : "RESULT_UNCONFIRMED");
}
