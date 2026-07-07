// SLA windows by 7-Eleven priority code. Two deadlines per priority:
//   responseHours   — contractor must ARRIVE on site within this window
//   resolutionHours — job must be RESOLVED within this window
//
// Numbers are seeded from samples we observed in real 7-Eleven dispatch
// emails (P1 Critical: response ~2h, resolution 4h). Adjust once Jeremy
// shares the official priority matrix.

export const SLA_WINDOWS = {
  p1: { responseHours: 2,  resolutionHours: 4 },    // P1 Critical
  p2: { responseHours: 4,  resolutionHours: 8 },    // P2 Emergency
  p3: { responseHours: 24, resolutionHours: 48 },   // P3 Standard / Rush
  p4: { responseHours: 48, resolutionHours: 72 },   // P4 Minor
  p5: null,                                         // P5 Preventative / PM work has no SLA deadline
} as const;

export type Priority = keyof typeof SLA_WINDOWS;

export function computeSlaBreaches(priority: Priority, startedAt: Date) {
  const win = SLA_WINDOWS[priority];
  if (!win) {
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
  now: Date = new Date(),
): SlaState | null {
  if (!responseBreachAtIso || !resolutionBreachAtIso) return null;
  const responseBreachAt = new Date(responseBreachAtIso);
  const resolutionBreachAt = new Date(resolutionBreachAtIso);
  const responseRemainingHours = (responseBreachAt.getTime() - now.getTime()) / 3600000;
  const resolutionRemainingHours = (resolutionBreachAt.getTime() - now.getTime()) / 3600000;
  const responseBreached = responseRemainingHours <= 0;
  const resolutionBreached = resolutionRemainingHours <= 0;
  let headline: "response" | "resolution";
  if (responseBreached && !resolutionBreached) headline = "resolution";
  else if (responseBreached && resolutionBreached) headline = "resolution";
  else headline = responseRemainingHours <= resolutionRemainingHours ? "response" : "resolution";
  return {
    responseRemainingHours,
    resolutionRemainingHours,
    responseBreached,
    resolutionBreached,
    responseBreachAt,
    resolutionBreachAt,
    headline,
    headlineRemainingHours: headline === "response" ? responseRemainingHours : resolutionRemainingHours,
  };
}

// Format a remaining-hours value into a tight, glanceable countdown.
export function formatRemaining(hours: number): string {
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
