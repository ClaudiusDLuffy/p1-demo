export const BILLING_ONLY_INTAKE_REASON =
  "billing-only work order created; contractor assignment and dispatch notifications suppressed";

export const BILLING_ONLY_ACTIVITY =
  "Billing-only work order received from 7-Eleven. No contractor was dispatched.";

export function billingOnlyIntakeFields(readyAt: string) {
  return {
    status: "pending_invoice" as const,
    functional_status: "Completed" as const,
    contractor_id: null,
    assigned_technician_profile_id: null,
    technician_on_job: null,
    technician_assigned_at: null,
    technician_assigned_by: null,
    contractor_assignment_started_at: null,
    eta: null,
    dispatched_at: null,
    sla_started_at: null,
    billing_only: true,
    billing_ready_at: readyAt,
    billing_ready_by: null,
  };
}
