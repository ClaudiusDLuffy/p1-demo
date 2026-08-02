export type WorkOrderMatchCandidate = {
  id: string;
  deletedAt: string | null;
  matchedBy: "work_order_id" | "incident_id";
};

export type IntakeWorkOrderMatch = {
  id: string;
  archived: boolean;
};

export function chooseIntakeWorkOrderMatch(
  candidates: WorkOrderMatchCandidate[],
): IntakeWorkOrderMatch | null {
  // 7-Eleven work-order numbers are canonical. Incident numbers may be
  // reused, so an incident match can inform staff but must never merge WOTs.
  const exactIdMatches = candidates.filter(
    candidate => candidate.matchedBy === "work_order_id",
  );
  const activeExactMatch = exactIdMatches.find(match => !match.deletedAt);
  if (activeExactMatch) return { id: activeExactMatch.id, archived: false };

  const archivedExactMatch = exactIdMatches.find(match => Boolean(match.deletedAt));
  return archivedExactMatch
    ? { id: archivedExactMatch.id, archived: true }
    : null;
}
