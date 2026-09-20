/** Synthetic full current RPC row. No real visit, actor or customer information. */
export const visitParent = "WOT-900001-2";
export const visitId = "11111111-1111-4111-8111-111111111111";
export const visitActor = "22222222-2222-4222-8222-222222222222";
export const visitContractor = "33333333-3333-4333-8333-333333333333";
export const visitStaff = "44444444-4444-4444-8444-444444444444";
export const visitOperation = "55555555-5555-4555-8555-555555555555";

export function visitRow(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: visitId, work_order_id: visitParent, contractor_id: visitContractor,
    check_in_at: "2026-09-10T08:00:00.000Z", check_out_at: "2026-09-10T10:00:00.000Z",
    checked_in_by: visitActor, checked_out_by: visitActor, technician_profile_id: visitActor,
    check_in_activity_id: null, check_out_activity_id: null,
    created_at: "2026-09-10T08:00:00.000Z", updated_at: "2026-09-10T10:00:00.000Z",
    closure_kind: null, duration_review_required: false,
    administrative_closed_at: null, administrative_closed_by: null,
    administrative_close_reason: null, administrative_transfer_operation_id: null,
    ...patch,
  };
}

export function administrativeVisitRow(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return visitRow({
    checked_out_by: visitStaff, closure_kind: "administrative_transfer", duration_review_required: true,
    administrative_closed_at: "2026-09-10T10:00:00.000Z", administrative_closed_by: visitStaff,
    administrative_close_reason: "Synthetic administrative transfer observation",
    administrative_transfer_operation_id: visitOperation,
    ...patch,
  });
}

/** Literal expected DTO, independent of the production mapper. */
export function visitExpected(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: visitId, workOrderId: visitParent, contractorId: visitContractor,
    checkInAt: "2026-09-10T08:00:00.000Z", checkOutAt: "2026-09-10T10:00:00.000Z",
    createdBy: visitActor, closedBy: visitActor, technicianProfileId: visitActor, closureKind: null,
    durationReviewRequired: false, administrativeClosedAt: null, administrativeClosedBy: null,
    ...patch,
  };
}
