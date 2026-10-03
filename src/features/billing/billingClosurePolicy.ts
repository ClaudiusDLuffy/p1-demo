/** Visibility guidance only; authoritative closure checks remain in the RPC. */
export function billingClosureStatusEligible(status: string) {
  return ["completed", "pending_invoice", "pending_payment"].includes(status);
}

export function billingClosureUnavailableReason(status: string) {
  if (status === "closed") return "This work order is already closed. Review its billing history.";
  if (status === "parts") return "Billing closure is unavailable while this work order is Awaiting Parts. Confirm field work is complete and move it to billing first.";
  if (!billingClosureStatusEligible(status)) return "Billing closure is available after field work is complete and this work order has moved to billing. Do not change its status just to bypass outstanding work.";
  return null;
}
