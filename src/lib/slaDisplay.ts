import { PRIORITY, T } from "./constants";
import { computeSlaState, SLA_WINDOWS, type Priority } from "./slaConfig";

export type SlaDisplayWorkOrder = {
  priority?: string | null;
  dispatchedAt?: string | null;
  slaStartedAt?: string | null;
  responseBreachAt?: string | null;
  resolutionBreachAt?: string | null;
  startTimeRaw?: string | null;
  start_time?: string | null;
};

export type SlaRemaining = {
  remainingHours: number;
  elapsedHours: number;
  slaHours: number;
  percent: number;
};

const HOURS_MS = 3_600_000;

const timestamp = (value?: string | null) => {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizedPriority = (value?: string | null): Priority | null => {
  const candidate = String(value || "").toLowerCase() as Priority;
  return Object.prototype.hasOwnProperty.call(SLA_WINDOWS, candidate)
    ? candidate
    : null;
};

const progress = (
  deadline: number,
  startedAt: number | null,
  configuredHours: number | null,
  now: Date,
): SlaRemaining | null => {
  const remainingHours = (deadline - now.getTime()) / HOURS_MS;
  const measuredHours = startedAt === null
    ? null
    : (deadline - startedAt) / HOURS_MS;
  const slaHours = measuredHours && measuredHours > 0
    ? measuredHours
    : configuredHours;
  if (!slaHours || !Number.isFinite(slaHours) || slaHours <= 0) return null;

  const elapsedHours = slaHours - remainingHours;
  return {
    remainingHours,
    elapsedHours,
    slaHours,
    percent: Math.max(0, Math.min(100, (elapsedHours / slaHours) * 100)),
  };
};

export const slaRemaining = (
  workOrder: SlaDisplayWorkOrder,
  now: Date = new Date(),
): SlaRemaining | null => {
  const priority = normalizedPriority(workOrder.priority);
  const window = priority ? SLA_WINDOWS[priority] : null;
  const startedAt = timestamp(
    workOrder.slaStartedAt || workOrder.dispatchedAt,
  );
  const responseAt = timestamp(workOrder.responseBreachAt);
  const resolutionAt = timestamp(workOrder.resolutionBreachAt);
  const responseMetAt = workOrder.startTimeRaw || workOrder.start_time || null;

  if (responseAt !== null && resolutionAt !== null) {
    const state = computeSlaState(
      workOrder.responseBreachAt || null,
      workOrder.resolutionBreachAt || null,
      responseMetAt,
      now,
    );
    if (state && Number.isFinite(state.headlineRemainingHours)) {
      const responseHeadline = state.headline === "response";
      return progress(
        responseHeadline ? responseAt : resolutionAt,
        startedAt,
        window
          ? responseHeadline
            ? window.responseHours
            : window.resolutionHours
          : null,
        now,
      );
    }
  }

  // A partially backfilled row must still honor its stored authoritative
  // deadline. Legacy priority-hour fallback is reserved for rows with no
  // stored deadline at all.
  const storedDeadline = responseMetAt
    ? resolutionAt ?? responseAt
    : responseAt ?? resolutionAt;
  if (storedDeadline !== null) {
    const usesResponse = storedDeadline === responseAt;
    return progress(
      storedDeadline,
      startedAt,
      window
        ? usesResponse
          ? window.responseHours
          : window.resolutionHours
        : null,
      now,
    );
  }

  const legacyHours = priority ? PRIORITY[priority]?.slaHours || 0 : 0;
  const legacyStart = timestamp(workOrder.dispatchedAt);
  if (legacyStart === null || legacyHours <= 0) return null;
  return progress(
    legacyStart + legacyHours * HOURS_MS,
    legacyStart,
    legacyHours,
    now,
  );
};

export const slaLabel = (
  workOrder: SlaDisplayWorkOrder,
  now: Date = new Date(),
) => {
  const sla = slaRemaining(workOrder, now);
  if (!sla) return null;
  if (sla.remainingHours <= 0) {
    return {
      text: `${Math.floor(-sla.remainingHours)}h past SLA`,
      color: T.danger,
      bg: T.dangerSoft,
      severity: "breach",
    };
  }
  if (sla.remainingHours < 1) {
    return {
      text: `${Math.round(sla.remainingHours * 60)}m to breach`,
      color: T.danger,
      bg: T.dangerSoft,
      severity: "critical",
    };
  }
  if (sla.percent >= 75) {
    return {
      text: `${Math.floor(sla.remainingHours)}h left`,
      color: T.accent,
      bg: T.accentSoft,
      severity: "warn",
    };
  }
  if (sla.percent >= 50) {
    return {
      text: `${Math.floor(sla.remainingHours)}h left`,
      color: T.warn,
      bg: T.warnSoft,
      severity: "ok",
    };
  }
  return {
    text: `${Math.floor(sla.remainingHours)}h left`,
    color: T.success,
    bg: T.successSoft,
    severity: "safe",
  };
};
