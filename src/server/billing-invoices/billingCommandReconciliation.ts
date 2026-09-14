import { FinancialRequestError } from "../../lib/financialHttpBoundary";
import { errorData } from "../../lib/errors/errorData";

export const BILLING_RECONCILIATION_TIMEOUT_MS = 5000;
const rejectionCodes = new Set([
  "42501", "P0002", "23505", "55000", "40001", "PT409", "40P01",
  "22023", "23514", "23503", "PGRST202", "42883",
  "P0001", "23502", "22001", "22003", "22P02",
]);

export class BillingCommandRejection extends Error {
  readonly phase = "KNOWN_REJECTED";
  constructor(readonly code: string, readonly cause: unknown) {
    super("The authoritative billing command rejected the request");
    this.name = "BillingCommandRejection";
  }
}
export class BillingCommandUnconfirmed extends FinancialRequestError {
  readonly phase = "DISPATCHED_OUTCOME_UNKNOWN";
  constructor(readonly cause: unknown, malformed: boolean) {
    super(malformed ? "FINANCIAL_RESULT_INVALID" : "FINANCIAL_COMMAND_FAILED",
      "The result could not be confirmed. Retry the unchanged operation or refresh and reconcile the invoice.", 500);
  }
}
type Attempt<T> =
  | { phase: "CONFIRMED_COMMITTED"; receipt: T }
  | { phase: "KNOWN_REJECTED"; rejection: BillingCommandRejection | FinancialRequestError }
  | { phase: "DISPATCHED_OUTCOME_UNKNOWN"; cause: unknown; malformed: boolean };

async function attempt<T>(invoke: (signal: AbortSignal | null) => Promise<T>, signal: AbortSignal | null): Promise<Attempt<T>> {
  try {
    return { phase: "CONFIRMED_COMMITTED", receipt: await invoke(signal) };
  } catch (cause: unknown) {
    if (cause instanceof FinancialRequestError && cause.code !== "FINANCIAL_RESULT_INVALID") {
      return { phase: "KNOWN_REJECTED", rejection: cause };
    }
    const code = errorData(cause, "code");
    if (typeof code === "string" && rejectionCodes.has(code)) {
      return { phase: "KNOWN_REJECTED", rejection: new BillingCommandRejection(code, cause) };
    }
    return { phase: "DISPATCHED_OUTCOME_UNKNOWN", cause,
      malformed: cause instanceof FinancialRequestError && cause.code === "FINANCIAL_RESULT_INVALID" };
  }
}

/** Only operation-bound save/delete commands may use this owner. A second
 * rejection after ambiguity cannot establish that the first transaction rolled
 * back: SQL can reject replay when its recorded snapshots have since changed. */
export async function reconcileBillingCommand<T>(invoke: (signal: AbortSignal | null) => Promise<T>,
  signal: AbortSignal | null): Promise<T> {
  signal?.throwIfAborted();
  const first = await attempt(invoke, signal);
  if (first.phase === "CONFIRMED_COMMITTED") return first.receipt;
  if (first.phase === "KNOWN_REJECTED") throw first.rejection;
  if (signal?.aborted) throw new BillingCommandUnconfirmed(first.cause, first.malformed);
  const timeout = AbortSignal.timeout(BILLING_RECONCILIATION_TIMEOUT_MS);
  const reconciliationSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const second = await attempt(invoke, reconciliationSignal);
  if (second.phase === "CONFIRMED_COMMITTED") return second.receipt;
  throw new BillingCommandUnconfirmed({ first: first.cause, reconciliation: second },
    first.malformed || (second.phase === "DISPATCHED_OUTCOME_UNKNOWN" && second.malformed));
}

/** Legacy action RPCs lack an operation UUID. Their response loss remains
 * unconfirmed; no automatic retry invents an idempotency contract. */
export async function executeBillingAction<T>(invoke: (signal: AbortSignal | null) => Promise<T>,
  signal: AbortSignal | null): Promise<T> {
  signal?.throwIfAborted();
  const result = await attempt(invoke, signal);
  if (result.phase === "CONFIRMED_COMMITTED") return result.receipt;
  if (result.phase === "KNOWN_REJECTED") throw result.rejection;
  throw new BillingCommandUnconfirmed(result.cause, result.malformed);
}
