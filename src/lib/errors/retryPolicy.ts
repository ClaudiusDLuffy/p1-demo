import { normalizeUnknownError } from "./normalizeUnknown";
export const SAFE_QUERY_RETRIES = 2;
export const QUERY_RETRY_DELAY_CAP_MS = 10_000;
export function queryRetry(failureCount: number, error: unknown): boolean {
  const normalized = normalizeUnknownError(error);
  return Number.isInteger(failureCount) && failureCount >= 0 && failureCount < SAFE_QUERY_RETRIES
    && normalized.retry === "safe_read"
    && (normalized.retryAfterSeconds ?? 0) * 1_000 <= QUERY_RETRY_DELAY_CAP_MS;
}
export function queryRetryDelay(attempt: number, error: unknown): number {
  const normalized = normalizeUnknownError(error);
  const boundedAttempt = Number.isInteger(attempt) && attempt >= 0 ? Math.min(attempt, 4) : 0;
  return Math.min(QUERY_RETRY_DELAY_CAP_MS, Math.max(1_000 * 2 ** boundedAttempt, (normalized.retryAfterSeconds ?? 0) * 1_000));
}
// No global mutation retry, even with a transient transport error. Existing
// guarded command adapters own unchanged-payload operation-UUID reconciliation.
export const mutationRetry = false;
