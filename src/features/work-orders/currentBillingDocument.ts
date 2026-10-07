/** A sent capital quote is not an already-finalized customer invoice. */
export function belongsToCurrentBillingWork(invoice: {
  documentKind?: string; state?: string; createdAt?: string;
}, reopenedAt: number): boolean {
  if (invoice.documentKind === "capital_quote" || !reopenedAt || !["approved", "paid"].includes(invoice.state || "")) return true;
  const createdAt = Date.parse(invoice.createdAt || "");
  return Number.isFinite(createdAt) && createdAt >= reopenedAt;
}
