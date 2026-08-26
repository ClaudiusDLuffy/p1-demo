type ContractorInvoiceIdentity = {
  contractor?: string | null;
  state?: string | null;
};

type ContractorViewer = {
  id?: string | null;
  contractorAccountId?: string | null;
  canInvoice?: boolean | null;
};

/**
 * Client affordance for the server-enforced rejected-invoice transition.
 * Company users compare against their canonical contractor account, while a
 * legacy direct contractor compares against their own profile id.
 */
export function canEditRejectedContractorInvoice(
  invoice: ContractorInvoiceIdentity | null | undefined,
  viewer: ContractorViewer | null | undefined,
  isStaff: boolean,
): boolean {
  const contractorAccountId = viewer?.contractorAccountId || viewer?.id;

  return !isStaff
    && viewer?.canInvoice === true
    && invoice?.state === "rejected"
    && !!invoice.contractor
    && !!contractorAccountId
    && invoice.contractor === contractorAccountId;
}

export function canDeleteOwnContractorInvoice(
  invoice: ContractorInvoiceIdentity | null | undefined,
  viewer: ContractorViewer | null | undefined,
  isStaff: boolean,
): boolean {
  const contractorAccountId = viewer?.contractorAccountId || viewer?.id;

  return !isStaff
    && viewer?.canInvoice === true
    && ["draft", "rejected"].includes(String(invoice?.state || ""))
    && !!invoice?.contractor
    && !!contractorAccountId
    && invoice.contractor === contractorAccountId;
}
