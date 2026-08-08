export const QUARTER_HOUR_QUANTITY = 0.25;

export const isLaborInvoiceLineType = (type: unknown): boolean =>
  /^(?:ot\s+)?labor$/i.test(String(type || "").trim());

export const invoiceQuantityInputConstraints = (type: unknown) =>
  isLaborInvoiceLineType(type)
    ? { min: QUARTER_HOUR_QUANTITY, step: QUARTER_HOUR_QUANTITY }
    : { min: 0.01, step: "any" as const };
