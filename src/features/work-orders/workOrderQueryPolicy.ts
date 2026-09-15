import type { WorkOrderPageParams } from "./data/workOrderReadContracts";
import { workOrderReadArgs } from "./data/workOrderReadRepository";
import { normalizeUnknownError } from "../../lib/errors/normalizeUnknown";
import { queryRetry } from "../../lib/errors/retryPolicy";

/**
 * Keep the shared safe-read policy, except that a table-mode statement timeout
 * must not immediately multiply the same expensive PostgreSQL plan.
 */
export function retryWorkOrderRead(
  params: WorkOrderPageParams,
  failureCount: number,
  error: unknown,
): boolean {
  const { tableMode } = workOrderReadArgs(params);
  if (tableMode && normalizeUnknownError(error).code === "TIMEOUT") return false;
  return queryRetry(failureCount, error);
}
