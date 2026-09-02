export type WorkOrderMatchCandidate = {
  id: string;
  deletedAt: string | null;
  matchedBy:
    | "work_order_id"
    | "canonical_work_order_id"
    | "incident_id";
  duplicateSequence?: number | null;
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
  // Once P1 creates a root-N reassignment continuation, subsequent canonical
  // WOT email updates belong to the newest non-archived continuation. The root
  // stays intact so the prior contractor can finish its separate invoicing.
  const activeContinuation = candidates
    .filter(candidate =>
      candidate.matchedBy === "canonical_work_order_id"
      && !candidate.deletedAt
    )
    .sort((left, right) =>
      Number(right.duplicateSequence || 0)
      - Number(left.duplicateSequence || 0)
    )[0];
  if (activeContinuation) {
    return { id: activeContinuation.id, archived: false };
  }

  const exactIdMatches = candidates.filter(
    candidate => candidate.matchedBy === "work_order_id",
  );
  const activeExactMatch = exactIdMatches.find(match => !match.deletedAt);
  if (activeExactMatch) return { id: activeExactMatch.id, archived: false };

  const archivedExactMatch = exactIdMatches.find(match => Boolean(match.deletedAt));
  if (archivedExactMatch) {
    return { id: archivedExactMatch.id, archived: true };
  }

  const archivedContinuation = candidates
    .filter(candidate =>
      candidate.matchedBy === "canonical_work_order_id"
      && Boolean(candidate.deletedAt)
    )
    .sort((left, right) =>
      Number(right.duplicateSequence || 0)
      - Number(left.duplicateSequence || 0)
    )[0];
  return archivedContinuation
    ? { id: archivedContinuation.id, archived: true }
    : null;
}
