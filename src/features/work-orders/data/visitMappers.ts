import type { VisitReadModel, VisitReadRow } from "./visitReadContracts";

/** Representation only; RLS, correction and billing-duration policy stay with their owners. */
export const mapVisit = (visit: VisitReadRow): VisitReadModel => ({
  id: visit.id,
  workOrderId: visit.work_order_id,
  contractorId: visit.contractor_id || null,
  checkInAt: visit.check_in_at,
  checkOutAt: visit.check_out_at || null,
  createdBy: visit.checked_in_by || null,
  closedBy: visit.checked_out_by || null,
  closureKind: visit.closure_kind || null,
  durationReviewRequired: visit.duration_review_required === true,
  administrativeClosedAt: visit.administrative_closed_at || null,
  administrativeClosedBy: visit.administrative_closed_by || null,
});
