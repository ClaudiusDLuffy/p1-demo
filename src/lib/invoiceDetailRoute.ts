type InvoiceRouteActor = { active?: boolean; isManager?: boolean; canInvoice?: boolean };

/** Restore a UI location, never an authorization decision about the invoice.
 * The existing actor-scoped exact read must still authorize the requested ID. */
export function invoiceDetailRouteFromUrl(url: string, actor: InvoiceRouteActor | null | undefined) {
  if (actor?.active !== true || (actor.isManager !== true && actor.canInvoice !== true)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.get("portal") !== "invoices") return null;
    const id = parsed.searchParams.get("invoice") || "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    return { invoiceId: id.toLowerCase() };
  } catch { return null; }
}
