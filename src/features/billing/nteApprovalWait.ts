import { isInvoiceController } from "../../lib/staffPermissions";

type NteInvoice = {
  invoiceType?: string | null;
  documentKind?: string | null;
  state?: string | null;
  qboInvoiceId?: string | null;
  qboSyncedAt?: string | null;
  waitingOnNteApproval?: boolean;
};

type NteActor = {
  active?: boolean | null;
  role?: string | null;
  staffPermissions?: string[] | null;
};

const NTE_WAIT_ROLES = new Set(["manager", "dispatcher", "back_office"]);

/** The NTE marker is an operational staff-invoice note, not a financial edit. */
export function canManageNteApprovalWait(invoice: NteInvoice | null | undefined, actor: NteActor | null | undefined): boolean {
  if (!invoice || !actor || actor.active !== true || !NTE_WAIT_ROLES.has(actor.role || "")
    || isInvoiceController(actor) || invoice.invoiceType !== "staff"
    || invoice.documentKind === "capital_quote") return false;

  // Always allow clearing a stale marker; only set a new one before submission.
  if (invoice.waitingOnNteApproval === true) return true;
  return ["draft", "submitted"].includes(invoice.state || "")
    && !invoice.qboInvoiceId && !invoice.qboSyncedAt;
}

export function isNteApprovalSubmissionBlocked(invoice: NteInvoice | null | undefined): boolean {
  return invoice?.waitingOnNteApproval === true;
}
