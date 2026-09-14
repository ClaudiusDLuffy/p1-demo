/** Compatibility values, not an approved contractual SLA matrix.
 * Creation windows preserve the sample-derived existing generator. The single
 * legacy read fallback preserves the existing badge's dispatched-at anchor.
 * Stored deadlines always win; none of these values authorize a backfill.
 */
export const SLA_COMPATIBILITY_POLICY = {
  p1: { generation: { responseHours: 2, resolutionHours: 4 }, legacyHours: 8 },
  p2: { generation: { responseHours: 4, resolutionHours: 8 }, legacyHours: 24 },
  p3: { generation: { responseHours: 24, resolutionHours: 48 }, legacyHours: 72 },
  p4: { generation: { responseHours: 48, resolutionHours: 72 }, legacyHours: 168 },
  p5: { generation: null, legacyHours: 0 },
} as const;

export const SLA_POLICY_PROVENANCE = {
  approval: "owner_confirmation_required",
  generation: "existing_sample_derived_windows",
  legacy: "existing_display_compatibility",
  legacyAnchor: "dispatched_at",
  storedDeadlines: "authoritative_no_backfill",
} as const;

export type Priority = keyof typeof SLA_COMPATIBILITY_POLICY;

/** Keep the old presentation constants' public `number` type while deriving
 * their values from this policy, rather than duplicating an editable matrix. */
export function legacySlaHours(priority: Priority): number {
  return SLA_COMPATIBILITY_POLICY[priority].legacyHours;
}

export function normalizeSlaPriority(value?: string | null): Priority | null {
  switch (value?.toLowerCase()) {
    case "p1": return "p1";
    case "p2": return "p2";
    case "p3": return "p3";
    case "p4": return "p4";
    case "p5": return "p5";
    default: return null;
  }
}

// Compatibility export for existing creation/escalation callers.
export const SLA_WINDOWS = {
  p1: SLA_COMPATIBILITY_POLICY.p1.generation,
  p2: SLA_COMPATIBILITY_POLICY.p2.generation,
  p3: SLA_COMPATIBILITY_POLICY.p3.generation,
  p4: SLA_COMPATIBILITY_POLICY.p4.generation,
  p5: SLA_COMPATIBILITY_POLICY.p5.generation,
} as const;
