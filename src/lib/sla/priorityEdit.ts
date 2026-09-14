import { computeSlaBreaches } from "../slaConfig";
import { hasStoredSlaDeadline, type SlaWorkOrder } from "./evaluation";
import { normalizeSlaPriority } from "./policy";

/** Manual header edits do not have authority to replace stored deadlines.
 * Preserve the old generation behavior only for a row with neither deadline;
 * trusted email escalation remains its separate authoritative command.
 */
export function priorityEditSlaPatch(workOrder: SlaWorkOrder, nextPriority: string, now: Date = new Date()): {
  responseBreachAt?: string | null;
  resolutionBreachAt?: string | null;
} {
  if (hasStoredSlaDeadline(workOrder)) return {};
  const priority = normalizeSlaPriority(nextPriority);
  if (!priority) return {};
  const anchorValue = workOrder.slaStartedAt || workOrder.sla_started_at;
  const anchor = anchorValue ? new Date(anchorValue) : now;
  if (!Number.isFinite(anchor.getTime())) return {};
  const deadlines = computeSlaBreaches(priority, anchor);
  return {
    responseBreachAt: deadlines.responseBreachAt?.toISOString() ?? null,
    resolutionBreachAt: deadlines.resolutionBreachAt?.toISOString() ?? null,
  };
}
