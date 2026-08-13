const MONEY_TOLERANCE = 0.011;

type StaffInvoiceLineLike = {
  qty?: unknown;
  rate?: unknown;
};

type StaffInvoiceLike = {
  num?: unknown;
  subtotal?: unknown;
  salesTax?: unknown;
  total?: unknown;
  lines?: StaffInvoiceLineLike[] | null;
};

export type StaffInvoiceIntegrity = {
  ok: boolean;
  lineCount: number;
  calculatedSubtotal: number;
  calculatedTotal: number;
  reason: string | null;
};

const money = (value: number) => Math.round(value * 100) / 100;

/**
 * P1 billing totals are derived exclusively from persisted lines plus tax.
 * Validate that invariant before producing an external PDF/CSV so an
 * incomplete client payload can never become a document sent to 7-Eleven.
 */
export function inspectStaffInvoiceIntegrity(
  invoice: StaffInvoiceLike,
): StaffInvoiceIntegrity {
  const lines = Array.isArray(invoice.lines) ? invoice.lines : [];
  const subtotal = Number(invoice.subtotal);
  const salesTax = Number(invoice.salesTax || 0);
  const total = Number(invoice.total);

  if (lines.length === 0) {
    return {
      ok: false,
      lineCount: 0,
      calculatedSubtotal: 0,
      calculatedTotal: money(salesTax),
      reason: "no persisted line items were returned",
    };
  }

  let invalidLine = false;
  const calculatedSubtotal = money(lines.reduce((sum, line) => {
    const qty = Number(line.qty);
    const rate = Number(line.rate);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(rate) || rate < 0) {
      invalidLine = true;
      return sum;
    }
    return sum + qty * rate;
  }, 0));
  const calculatedTotal = money(calculatedSubtotal + salesTax);

  if (invalidLine) {
    return {
      ok: false,
      lineCount: lines.length,
      calculatedSubtotal,
      calculatedTotal,
      reason: "one or more line items have an invalid quantity or rate",
    };
  }
  if (!Number.isFinite(subtotal) || Math.abs(subtotal - calculatedSubtotal) > MONEY_TOLERANCE) {
    return {
      ok: false,
      lineCount: lines.length,
      calculatedSubtotal,
      calculatedTotal,
      reason: "the stored subtotal does not match the line items",
    };
  }
  if (!Number.isFinite(total) || Math.abs(total - calculatedTotal) > MONEY_TOLERANCE) {
    return {
      ok: false,
      lineCount: lines.length,
      calculatedSubtotal,
      calculatedTotal,
      reason: "the stored total does not match the line items and tax",
    };
  }

  return {
    ok: true,
    lineCount: lines.length,
    calculatedSubtotal,
    calculatedTotal,
    reason: null,
  };
}

export function assertStaffInvoiceIntegrity(invoice: StaffInvoiceLike): void {
  const integrity = inspectStaffInvoiceIntegrity(invoice);
  if (integrity.ok) return;

  const invoiceNumber = String(invoice.num || "unknown");
  throw new Error(
    `Invoice #${invoiceNumber} cannot be exported because ${integrity.reason}. Refresh and reopen the invoice before trying again.`,
  );
}
