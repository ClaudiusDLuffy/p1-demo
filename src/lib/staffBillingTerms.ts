export const NEW_STAFF_BILLING_TERMS = "Net 60";
export const LEGACY_STAFF_BILLING_TERMS = "Net 30";
export const STAFF_BILLING_TERMS_OPTIONS: readonly string[] = Object.freeze([
  NEW_STAFF_BILLING_TERMS, LEGACY_STAFF_BILLING_TERMS, "Net 15", "Due on receipt",
]);

/** Calendar dates only: DST and the browser's timezone must not shift a due date. */
export function staffBillingDueDate(invoiceDate: string, terms: string): string | null {
  const days = terms === "Net 60" ? 60 : terms === "Net 30" ? 30
    : terms === "Net 15" ? 15 : terms === "Due on receipt" ? 0 : null;
  if (days === null || !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) return null;
  const date = new Date(`${invoiceDate}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== invoiceDate) return null;
  date.setUTCDate(date.getUTCDate() + days);
  if (date.getUTCFullYear() > 9999) return null;
  return date.toISOString().slice(0, 10);
}

/** New P1 forms default to 60 days; existing invoices retain their legacy fallback. */
export function initialStaffBillingTerms(input: {
  invoiceDate: string;
  editing?: boolean;
  terms?: string | null;
  dueDate?: string | null;
}): { terms: string; dueDate: string } {
  const fallback = input.editing ? LEGACY_STAFF_BILLING_TERMS : NEW_STAFF_BILLING_TERMS;
  const terms = input.terms || fallback;
  return {
    terms,
    dueDate: input.dueDate || staffBillingDueDate(input.invoiceDate, terms)
      || staffBillingDueDate(input.invoiceDate, fallback) || "",
  };
}

/**
 * Opening/restoring a form never changes its date. An explicit terms change
 * requests a new due date. A date-only edit moves an automatic date, but leaves
 * a manually chosen date intact. Unknown legacy terms are never reinterpreted.
 */
export function nextStaffBillingDueDate(input: {
  invoiceDate: string;
  terms: string;
  dueDate: string;
  previousInvoiceDate: string;
  previousTerms: string;
}): string | null {
  const termsChanged = input.terms !== input.previousTerms;
  const dateChanged = input.invoiceDate !== input.previousInvoiceDate;
  if (!termsChanged && !dateChanged) return null;
  const next = staffBillingDueDate(input.invoiceDate, input.terms);
  if (next === null) return null;
  if (termsChanged || !input.dueDate
    || input.dueDate === staffBillingDueDate(input.previousInvoiceDate, input.previousTerms)) return next;
  return null;
}
