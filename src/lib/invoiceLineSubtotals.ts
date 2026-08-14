import {
  normalizeStaffBillingLineType,
  type StaffBillingLineType,
} from "./staffBilling";

export type InvoiceSubtotalCategory = StaffBillingLineType;

export type InvoiceLineSubtotal = {
  category: InvoiceSubtotalCategory;
  label: string;
  amount: number;
  lineCount: number;
};

export type InvoiceLineSubtotalSummary = {
  categories: InvoiceLineSubtotal[];
  subtotal: number;
  salesTax: number;
  grandTotal: number;
};

const CATEGORY_ORDER: InvoiceSubtotalCategory[] = [
  "Labor",
  "OT Labor",
  "Travel",
  "Parts/Hardware",
  "Shipping",
  "Other",
];

const CATEGORY_LABEL: Record<InvoiceSubtotalCategory, string> = {
  Labor: "Labor",
  "OT Labor": "OT labor",
  Travel: "Travel",
  "Parts/Hardware": "Parts",
  Shipping: "Shipping",
  Other: "Other",
};

const money = (value: number) => Math.round(value * 100) / 100;

const finiteNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const lineSellAmount = (line: Record<string, unknown>) => {
  const quantity = finiteNumber(line.qty ?? line.quantity);
  const rate = finiteNumber(line.rate ?? line.unitPrice);
  return money(quantity * rate);
};

/**
 * Groups P1 sell-price lines before tax. Categories are emitted only when at
 * least one line belongs to them, while tax and grand total remain separate.
 */
export function summarizeInvoiceLineTypes(
  lines: Array<Record<string, unknown>> | null | undefined,
  salesTaxValue: unknown,
): InvoiceLineSubtotalSummary {
  const totals = new Map<InvoiceSubtotalCategory, { amount: number; lineCount: number }>();

  for (const line of lines || []) {
    const category = normalizeStaffBillingLineType(line.type);
    const current = totals.get(category) || { amount: 0, lineCount: 0 };
    totals.set(category, {
      amount: money(current.amount + lineSellAmount(line)),
      lineCount: current.lineCount + 1,
    });
  }

  const categories = CATEGORY_ORDER.flatMap(category => {
    const value = totals.get(category);
    if (!value) return [];
    return [{
      category,
      label: CATEGORY_LABEL[category],
      amount: value.amount,
      lineCount: value.lineCount,
    }];
  });
  const subtotal = money(categories.reduce((sum, category) => sum + category.amount, 0));
  const salesTax = money(Math.max(finiteNumber(salesTaxValue), 0));

  return {
    categories,
    subtotal,
    salesTax,
    grandTotal: money(subtotal + salesTax),
  };
}
