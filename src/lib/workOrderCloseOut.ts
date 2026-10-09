import { billingClosureStatusEligible } from "../features/billing/billingClosurePolicy";

export type CloseOutAction = "review_billing" | "external_quote" | "capital_complete" | "capital_billed" | "capital_to_billing" | "external_billing" | "linked_billing" | "follow_up" | "no_invoice";
export type CloseOutWorkOrder = {
  id: string; status: string; functionalStatus?: string | null; billingOnly?: boolean; isCapital?: boolean | null;
  workflowCycle?: number; contractorAssignmentVersion?: number; updatedAt?: string | null;
  hasPendingSevenElevenSync?: boolean; hasPendingContractorAttention?: boolean;
  visits?: { checkOutAt?: string | null }[];
  historyInvoiceCount?: number; billingInvoiceId?: string | null;
};
export type FollowUpCloseSnapshot = {
  id: string; workflowCycle: number; contractorAssignmentVersion: number; updatedAt: string | null;
};
export type CloseOutOption = { action: CloseOutAction; label: string; explanation: string; blocked?: string };

export function isCapitalCloseOutWork(work: CloseOutWorkOrder | null | undefined) {
  return Boolean(work && !work.billingOnly && (work.isCapital === true || ["capital", "pending_capital_completion"].includes(work.status)));
}

/** A read preflight improves conflict feedback; the RPC still enforces the exact snapshot. */
export function noInvoiceCloseSnapshotMatches(current: CloseOutWorkOrder | null, snapshot: FollowUpCloseSnapshot) {
  return Boolean(current && snapshot.updatedAt && current.id === snapshot.id
    && current.updatedAt === snapshot.updatedAt && current.workflowCycle === snapshot.workflowCycle
    && current.contractorAssignmentVersion === snapshot.contractorAssignmentVersion
    && billingClosureStatusEligible(current.status) && (current.billingOnly || current.functionalStatus === "Completed")
    && !current.hasPendingSevenElevenSync && !current.hasPendingContractorAttention
    && current.historyInvoiceCount === 0 && !current.billingInvoiceId);
}

/** Guidance, not financial authority. Every write still uses its existing guarded command. */
export function workOrderCloseOutOptions(input: {
  workOrder: CloseOutWorkOrder; hasCompleteEvidence: boolean; hasCurrentInvoice: boolean;
  hasStaffDocuments: boolean; hasAnyDocuments: boolean; hasUnresolvedContractorInvoices: boolean; canCloseFollowUp: boolean;
}): CloseOutOption[] {
  const { workOrder: work, hasCompleteEvidence, hasCurrentInvoice, hasAnyDocuments,
    hasUnresolvedContractorInvoices, canCloseFollowUp } = input;
  if (work.status === "closed") return [];
  const openVisit = work.visits?.some(visit => !visit.checkOutAt);
  const incompleteEvidence = !hasCompleteEvidence ? "Load the complete invoice and activity history before choosing a billing outcome." : undefined;
  const financialBlocker = incompleteEvidence
    || (openVisit ? "Record the active visit's actual checkout before closing." : undefined)
    || (work.hasPendingSevenElevenSync || work.hasPendingContractorAttention ? "Resolve pending 7-Eleven updates and contractor attention items first." : undefined)
    || (hasUnresolvedContractorInvoices ? "Resolve outstanding contractor invoice reviews first." : undefined);
  const closingBlocker = financialBlocker
    || (!work.billingOnly && work.functionalStatus !== "Completed" ? "Confirm field work is complete before closing." : undefined);
  const alternateBillingBlocker = closingBlocker || (hasCurrentInvoice
    ? "A P1 invoice already exists for this billing work. Review it before choosing another billing outcome." : undefined);
  if (isCapitalCloseOutWork(work)) return [
    { action: "capital_billed", label: "Completed and billed", explanation: "Confirm the existing bill and move straight to History. No second invoice or CSV export.", blocked: financialBlocker },
    { action: "capital_to_billing", label: "Completed, send to billing", explanation: "For completed capital work not billed yet. Move to billing and keep the WO open.",
      blocked: incompleteEvidence || (openVisit ? "Record the active visit's actual checkout before confirming completion." : undefined) },
  ];
  const options: CloseOutOption[] = [
    { action: "review_billing", label: hasCurrentInvoice ? "Review or finish P1 billing" : "Review or prepare final P1 invoice",
      explanation: "Use the normal invoice process. Only confirm Billed to 7-Eleven after the actual customer handoff. Prior billed invoices must not be billed again.",
      blocked: hasCurrentInvoice ? undefined : incompleteEvidence || (!billingClosureStatusEligible(work.status) ? "Finish field work and move this WO to billing before preparing the final invoice." : undefined) },
  ];
  if (billingClosureStatusEligible(work.status)) {
    options.push(
      { action: "linked_billing", label: "Billed under another work order", explanation: "Select an eligible submitted P1 invoice that covers this work. No additional invoice or revenue is created.", blocked: alternateBillingBlocker },
      { action: "external_billing", label: "Billed outside the portal", explanation: "Enter the actual billing system, invoice reference and date. This records billing, not an unbilled closure.", blocked: alternateBillingBlocker },
    );
  }
  if (canCloseFollowUp) options.push({ action: "follow_up", label: "Follow-up resolved, prior billing covers it",
    // This existing outcome itself records staff-confirmed resolution of a
    // proven reopened cycle. Do not add a new status restriction to that rule.
    explanation: "Confirm that the follow-up is resolved and no additional billing is needed. Original billed invoices remain unchanged.", blocked: financialBlocker });
  // This is never a shortcut for missing billing references. Unlike the old
  // general-close button, the guided path requires finished, invoice-free work.
  if (!hasAnyDocuments && hasCompleteEvidence && billingClosureStatusEligible(work.status)) options.push({ action: "no_invoice",
    label: "No billing is required", explanation: "Only for finished work with no invoices and no billing anywhere. Do not use for work billed externally or under another WO.", blocked: closingBlocker });
  return options;
}

/** Selecting an outcome supplies the routine reason; staff still explicitly confirm the facts. */
export function closeOutAuditNote(work: { id: string; workflowCycle?: number },
  outcome: "capital_complete" | "external_quote" | "external_billing" | "linked_billing" | "follow_up",
  details: string, reference = "") {
  const rawDetails = details.trim();
  if (rawDetails.length > 350 || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(rawDetails)) throw new Error("Keep additional details to 350 characters and remove control characters.");
  const extra = rawDetails.replace(/\s+/gu, " ");
  const facts = {
    capital_complete: "Staff confirmed installation is finished and ready for final billing. Installation alone does not close or bill the work order.",
    external_quote: `Staff confirmed a capital quote was submitted and approved outside the portal. Approved quote reference: ${reference.trim()}. No final invoice was created.`,
    external_billing: `Staff confirmed this work was billed externally. Billing reference: ${reference.trim()}. No additional portal invoice is needed.`,
    linked_billing: `Staff confirmed the selected submitted portal invoice covers this work. Coverage reference: ${reference.trim()}. No separate invoice is needed.`,
    follow_up: "Staff confirmed the follow-up is resolved and prior billing covers it. No additional billing is required; original invoices remain unchanged.",
  };
  const note = `Close out: ${work.id}, cycle ${work.workflowCycle ?? 0}. ${facts[outcome]}${extra ? ` Additional details: ${extra}` : ""}`;
  if (note.length > 1000) throw new Error("The audit note is too long. Shorten additional details.");
  return note;
}
