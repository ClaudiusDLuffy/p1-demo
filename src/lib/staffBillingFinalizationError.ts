// These are exact public.mark_staff_invoice_billed/visit-checkout failures, not a
// general permission to disclose PostgREST messages, hints or SQL details.
const rules = [
  {
    sqlCode: "23514",
    sqlMessage: 'new row for relation "work_order_visits" violates check constraint "work_order_visits_checkout_complete"',
    code: "BILLING_VISIT_TIME_REVIEW_REQUIRED",
    status: 409,
    error: "An open visit could not be checked out. Its check-in time or checkout details need review before billing can continue. Contact support to correct the visit record.",
  },
  {
    sqlCode: "40001",
    sqlMessage: "This billing document belongs to a prior workflow cycle and cannot close the reopened work order",
    code: "BILLING_PRIOR_WORKFLOW",
    status: 409,
    error: "This invoice cannot close the current reopened follow-up because its creation date is missing or predates reopening. Review the billing history with your billing team.",
  },
  {
    sqlCode: "23514",
    sqlMessage: "Only a billing document ready for 7-Eleven can be submitted",
    code: "BILLING_NOT_READY",
    status: 409,
    error: "This invoice is not ready for 7-Eleven. Refresh it and review its current status.",
  },
  {
    sqlCode: "23514",
    sqlMessage: "Current reopened workflow metadata is missing",
    code: "BILLING_WORKFLOW_REVIEW_REQUIRED",
    status: 409,
    error: "The reopened work order's history is incomplete. Contact support before making another billing change.",
  },
  {
    sqlCode: "23514",
    sqlMessage: "Billing audit state does not match the invoice state",
    code: "BILLING_AUDIT_REVIEW_REQUIRED",
    status: 409,
    error: "The billing history and invoice status do not match. Contact support before making another billing change.",
  },
  {
    sqlCode: "23514",
    sqlMessage: "This work order was closed without additional billing; reopen it before billing another invoice",
    code: "BILLING_WORK_ORDER_CLOSED",
    status: 409,
    error: "This work order was closed without additional billing. Review it with your billing team before making another billing change.",
  },
  {
    sqlCode: "23514",
    sqlMessage: "Capital quote is not linked to an active capital work order",
    code: "BILLING_CAPITAL_LINK_REQUIRED",
    status: 409,
    error: "This capital quote is not linked to an active capital work order. Review the work order before submitting.",
  },
  ...["Staff access required", "Operational staff access required"].map(sqlMessage => ({
    sqlCode: "42501",
    sqlMessage,
    code: "BILLING_FORBIDDEN",
    status: 403,
    error: "You do not have permission to finalize this billing invoice.",
  })),
  {
    sqlCode: "P0002",
    sqlMessage: "Billing invoice not found",
    code: "BILLING_NOT_FOUND",
    status: 404,
    error: "Billing invoice not found. Refresh the billing list.",
  },
];

export type StaffBillingFinalizationFailure = {
  status: number;
  code: string;
  error: string;
};

export function staffBillingFinalizationFailure(error: unknown): StaffBillingFinalizationFailure {
  if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
    const match = rules.find(rule => rule.sqlCode === error.code && rule.sqlMessage === error.message);
    if (match) return { status: match.status, code: match.code, error: match.error };
  }
  // A lost RPC response does not prove that the database rolled back. Do not
  // automatically retry the mutation or tell staff the billing never happened.
  return {
    status: 500,
    code: "BILLING_FINALIZATION_UNCONFIRMED",
    error: "Unable to confirm the billing update. Refresh the invoice before trying again. If this continues, contact support.",
  };
}
