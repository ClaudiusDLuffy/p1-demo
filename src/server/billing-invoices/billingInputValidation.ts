import { z } from "zod";
import { FinancialRequestError } from "../../lib/financialHttpBoundary";

export type BillingInputRepositoryContext = {
  signal: AbortSignal | null;
  requestId?: string | null;
  actor?: { userId: string };
};

const envelopeSchema = z.object({ data: z.unknown(), error: z.unknown() })
  .refine(value => Object.hasOwn(value, "data") && Object.hasOwn(value, "error"));
const errorCodeSchema = z.object({ code: z.string().regex(/^[A-Z0-9_]{1,80}$/) });

export function invalidBillingInputResult(): never {
  throw new FinancialRequestError("FINANCIAL_RESULT_INVALID", "Financial input could not be validated", 500);
}

class BillingInputReadError extends Error {
  readonly code: string;
  constructor(cause: unknown) {
    super("Billing input read failed", { cause });
    this.name = "BillingInputReadError";
    const parsed = errorCodeSchema.safeParse(cause);
    this.code = parsed.success ? parsed.data.code : "FINANCIAL_INPUT_READ_FAILED";
  }
}

/** Validate every real query envelope; only the operation boundary logs failures. */
export async function readBillingInputData(query: PromiseLike<unknown>, signal: AbortSignal | null): Promise<unknown> {
  let raw: unknown;
  try { raw = await query; }
  catch (cause) {
    signal?.throwIfAborted();
    throw new BillingInputReadError(cause);
  }
  signal?.throwIfAborted();
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) return invalidBillingInputResult();
  if (parsed.data.error !== null) throw new BillingInputReadError(parsed.data.error);
  return parsed.data.data;
}
