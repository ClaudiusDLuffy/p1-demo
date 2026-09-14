import { normalizeSlaPriority, SLA_COMPATIBILITY_POLICY } from "./policy";

export const SLA_HOUR_MS = 3_600_000;

export type SlaWorkOrder = {
  priority?: string | null;
  dispatchedAt?: string | null;
  dispatched_at?: string | null;
  slaStartedAt?: string | null;
  sla_started_at?: string | null;
  responseBreachAt?: string | null;
  response_breach_at?: string | null;
  resolutionBreachAt?: string | null;
  resolution_breach_at?: string | null;
  startTimeRaw?: string | null;
  start_time?: string | null;
};

export type EffectiveSla = {
  source: "stored" | "legacy" | "none";
  dueTime: number | null;
  headline: "response" | "resolution" | "legacy" | null;
  remainingHours: number | null;
  responseTime: number | null;
  resolutionTime: number | null;
  responseMetTime: number | null;
  responseRemainingHours: number | null;
  resolutionRemainingHours: number | null;
  responseMet: boolean;
  responseWasLate: boolean;
  responseBreached: boolean;
  resolutionBreached: boolean;
  breached: boolean;
  invalidStoredDeadline: boolean;
  progress: { elapsedHours: number; slaHours: number; percent: number } | null;
};

export function slaTimestamp(value?: string | null): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function hasStoredSlaDeadline(workOrder?: SlaWorkOrder | null): boolean {
  return Boolean(workOrder?.responseBreachAt || workOrder?.response_breach_at
    || workOrder?.resolutionBreachAt || workOrder?.resolution_breach_at);
}

/** Pure read model. Never mutates, persists, fills a missing half or resets an
 * anchor. `dueTime` is the actionable headline; `breached` preserves an unmet
 * response breach even when the headline moves to a future resolution.
 */
export function evaluateSla(workOrder?: SlaWorkOrder | null, now: Date = new Date()): EffectiveSla {
  const responseValue = workOrder?.responseBreachAt || workOrder?.response_breach_at;
  const resolutionValue = workOrder?.resolutionBreachAt || workOrder?.resolution_breach_at;
  const responseTime = slaTimestamp(responseValue);
  const resolutionTime = slaTimestamp(resolutionValue);
  const responseMetTime = slaTimestamp(workOrder?.startTimeRaw || workOrder?.start_time);
  const nowTime = now.getTime();
  const validNow = Number.isFinite(nowTime);
  const responseRemainingHours = responseTime !== null && validNow ? (responseTime - nowTime) / SLA_HOUR_MS : null;
  const resolutionRemainingHours = resolutionTime !== null && validNow ? (resolutionTime - nowTime) / SLA_HOUR_MS : null;
  const responseMet = responseMetTime !== null;
  const responseWasLate = responseTime !== null && responseMetTime !== null && responseMetTime > responseTime;
  const responseBreached = !responseMet && responseRemainingHours !== null && responseRemainingHours <= 0;
  const resolutionBreached = resolutionRemainingHours !== null && resolutionRemainingHours <= 0;
  const stored = hasStoredSlaDeadline(workOrder);
  const priority = normalizeSlaPriority(workOrder?.priority);
  const policy = priority ? SLA_COMPATIBILITY_POLICY[priority] : null;
  let dueTime: number | null = null;
  let headline: EffectiveSla["headline"] = null;
  let source: EffectiveSla["source"] = stored ? "stored" : "none";
  let durationHours: number | null = null;
  const dispatchTime = slaTimestamp(workOrder?.dispatchedAt || workOrder?.dispatched_at);

  if (stored) {
    if (responseTime !== null && resolutionTime !== null) {
      headline = responseMet || responseBreached || resolutionTime < responseTime ? "resolution" : "response";
    } else if (resolutionTime !== null) {
      headline = "resolution";
    } else if (responseTime !== null && !responseMet) {
      headline = "response";
    }
    dueTime = headline === "response" ? responseTime : headline === "resolution" ? resolutionTime : null;
    const anchor = slaTimestamp(workOrder?.slaStartedAt || workOrder?.sla_started_at
      || workOrder?.dispatchedAt || workOrder?.dispatched_at);
    const measured = dueTime !== null && anchor !== null ? (dueTime - anchor) / SLA_HOUR_MS : null;
    durationHours = measured !== null && measured > 0 ? measured
      : headline === "response" ? policy?.generation?.responseHours ?? null
        : headline === "resolution" ? policy?.generation?.resolutionHours ?? null : null;
  } else if (dispatchTime !== null && policy && policy.legacyHours > 0) {
    source = "legacy";
    headline = "legacy";
    dueTime = dispatchTime + policy.legacyHours * SLA_HOUR_MS;
    durationHours = policy.legacyHours;
  }

  const remainingHours = dueTime !== null && validNow ? (dueTime - nowTime) / SLA_HOUR_MS : null;
  const elapsedHours = durationHours !== null && remainingHours !== null ? durationHours - remainingHours : null;
  const progress = durationHours !== null && durationHours > 0 && elapsedHours !== null
    ? { slaHours: durationHours, elapsedHours, percent: Math.max(0, Math.min(100, elapsedHours / durationHours * 100)) }
    : null;
  return {
    source, dueTime, headline, remainingHours, responseTime, resolutionTime, responseMetTime,
    responseRemainingHours, resolutionRemainingHours, responseMet, responseWasLate,
    responseBreached, resolutionBreached,
    breached: responseBreached || resolutionBreached || (source === "legacy" && remainingHours !== null && remainingHours <= 0),
    invalidStoredDeadline: Boolean((responseValue && responseTime === null) || (resolutionValue && resolutionTime === null)),
    progress,
  };
}
