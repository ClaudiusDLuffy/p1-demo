export const roundInvoiceNumber = (value: unknown, decimals = 2): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const factor = 10 ** decimals;
  return Math.round((parsed + Number.EPSILON) * factor) / factor;
};

export const normalizeInvoiceLineNumbers = <T extends {
  qty?: unknown;
  rate?: unknown;
}>(line: T): T & { qty: number; rate: number } => ({
  ...line,
  qty: roundInvoiceNumber(line.qty),
  rate: roundInvoiceNumber(line.rate),
});

