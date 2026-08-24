// This module-level registry is shared by the invoice and work-order hooks in
// one browser tab. It closes the React state timing window where a second click
// can start before a disabled button has rendered. Locks are per invoice, so
// unrelated invoices can still be reviewed concurrently.
const activeInvoiceMutations = new Set<string>();

export function acquireInvoiceMutationLocks(
  invoiceIds: readonly string[],
): (() => void) | null {
  const normalizedIds = [...new Set(
    invoiceIds.map(invoiceId => String(invoiceId || "").trim()).filter(Boolean),
  )].sort();

  if (normalizedIds.length === 0) return null;
  if (normalizedIds.some(invoiceId => activeInvoiceMutations.has(invoiceId))) {
    return null;
  }

  normalizedIds.forEach(invoiceId => activeInvoiceMutations.add(invoiceId));
  let released = false;

  return () => {
    if (released) return;
    released = true;
    normalizedIds.forEach(invoiceId => activeInvoiceMutations.delete(invoiceId));
  };
}
