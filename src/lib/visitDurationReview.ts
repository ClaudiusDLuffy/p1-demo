// Administrative closure records an observation, never an approved duration.
// Time correction does not remove this provenance or approve the elapsed time.
export type VisitDurationReview = {
  closureKind?: string | null;
  durationReviewRequired?: boolean;
};

export function requiresVisitDurationReview(visit: VisitDurationReview): boolean {
  return visit.durationReviewRequired === true || visit.closureKind === "administrative_transfer";
}

export const VISIT_DURATION_REVIEW_MESSAGE = "Administratively closed for transfer. Duration is unverified and requires review; it is not approved for billing, payroll, or performance reporting.";
