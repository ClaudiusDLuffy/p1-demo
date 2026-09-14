import { evaluateSla } from "./sla/evaluation";
import { SLA_WINDOWS, type Priority } from "./sla/policy";

// Existing creation/escalation API; compatibility values are not an approved
// contractual matrix. The single policy source documents their provenance.
export { SLA_WINDOWS, type Priority } from "./sla/policy";

export function computeSlaBreaches(priority: Priority, startedAt: Date) {
  const win = SLA_WINDOWS[priority];
  if (!win || !Number.isFinite(startedAt.getTime())) {
    return {
      responseBreachAt: null,
      resolutionBreachAt: null,
    };
  }

  return {
    responseBreachAt: new Date(startedAt.getTime() + win.responseHours * 3600 * 1000),
    resolutionBreachAt: new Date(startedAt.getTime() + win.resolutionHours * 3600 * 1000),
  };
}

// Used by both the badge and the dashboard alert pickers. Returns null when
// the WO is missing breach fields entirely (pre-migration legacy rows).
export type SlaState = {
  responseRemainingHours: number;
  resolutionRemainingHours: number;
  responseBreached: boolean;
  responseMet: boolean;
  responseMetAt: Date | null;
  responseWasLate: boolean;
  resolutionBreached: boolean;
  responseBreachAt: Date;
  resolutionBreachAt: Date;
  // The deadline that's most urgent / most damaging to surface as headline:
  //   - if neither breached, whichever is closest
  //   - if only response breached, surface resolution (still actionable)
  //   - if both breached, resolution (it's the bigger contractual miss)
  headline: "response" | "resolution";
  headlineRemainingHours: number;
};

export function computeSlaState(
  responseBreachAtIso: string | null,
  resolutionBreachAtIso: string | null,
  responseMetAtIso: string | null = null,
  now: Date = new Date(),
): SlaState | null {
  const state = evaluateSla({ responseBreachAt: responseBreachAtIso, resolutionBreachAt: resolutionBreachAtIso, startTimeRaw: responseMetAtIso }, now);
  if (state.responseTime === null || state.resolutionTime === null
    || state.responseRemainingHours === null || state.resolutionRemainingHours === null
    || state.remainingHours === null || (state.headline !== "response" && state.headline !== "resolution")) return null;
  return {
    responseRemainingHours: state.responseRemainingHours,
    resolutionRemainingHours: state.resolutionRemainingHours,
    responseBreached: state.responseBreached,
    responseMet: state.responseMet,
    responseMetAt: state.responseMetTime === null ? null : new Date(state.responseMetTime),
    responseWasLate: state.responseWasLate,
    resolutionBreached: state.resolutionBreached,
    responseBreachAt: new Date(state.responseTime),
    resolutionBreachAt: new Date(state.resolutionTime),
    headline: state.headline,
    headlineRemainingHours: state.remainingHours,
  };
}

// Format a remaining-hours value into a tight, glanceable countdown.
export function formatRemaining(hours: number): string {
  if (!Number.isFinite(hours)) return "Not set";
  if (hours <= 0) {
    const past = -hours;
    if (past < 1) return `${Math.round(past * 60)}m past`;
    if (past < 24) return `${Math.floor(past)}h past`;
    return `${Math.floor(past / 24)}d past`;
  }
  if (hours < 1) return `${Math.round(hours * 60)}m left`;
  if (hours < 24) return `${Math.floor(hours)}h ${Math.round((hours % 1) * 60)}m`;
  return `${Math.floor(hours / 24)}d ${Math.floor(hours % 24)}h`;
}
