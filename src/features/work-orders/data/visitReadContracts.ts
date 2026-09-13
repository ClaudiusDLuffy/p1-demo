/** Minimal validated row consumed by the existing eleven-field visit mapper. */
export type VisitReadRow = {
  id: string;
  work_order_id: string;
  contractor_id: string;
  check_in_at: string;
  check_out_at: string | null;
  checked_in_by: string;
  checked_out_by: string | null;
  closure_kind: "administrative_transfer" | null;
  duration_review_required: boolean;
  administrative_closed_at: string | null;
  administrative_closed_by: string | null;
};

/** The established public representation; no new duration, cycle or correction fields. */
export type VisitReadModel = {
  id: string;
  workOrderId: string;
  contractorId: string | null;
  checkInAt: string;
  checkOutAt: string | null;
  createdBy: string | null;
  closedBy: string | null;
  closureKind: "administrative_transfer" | null;
  durationReviewRequired: boolean;
  administrativeClosedAt: string | null;
  administrativeClosedBy: string | null;
};
