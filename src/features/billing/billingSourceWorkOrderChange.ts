export type BillingLineSourceMetadata = {
  sourceInvoiceLineId?: unknown;
  sourceWorkOrderPartId?: unknown;
  sourceUnitCost?: unknown;
  markupPercent?: unknown;
};

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

export function hasWorkOrderBoundBillingMetadata(line: BillingLineSourceMetadata): boolean {
  return hasValue(line.sourceInvoiceLineId)
    || hasValue(line.sourceWorkOrderPartId)
    || hasValue(line.sourceUnitCost)
    || hasValue(line.markupPercent);
}

export function countWorkOrderBoundBillingLines(lines: BillingLineSourceMetadata[]): number {
  return lines.filter(hasWorkOrderBoundBillingMetadata).length;
}

/** Keep entered amounts, but detach source identities that cannot cross work orders. */
export function makeWorkOrderBoundBillingLinesManual<T extends BillingLineSourceMetadata>(
  lines: T[],
): { lines: T[]; detachedLineCount: number } {
  let detachedLineCount = 0;
  const nextLines = lines.map(line => {
    if (!hasWorkOrderBoundBillingMetadata(line)) return line;
    detachedLineCount += 1;
    return {
      ...line,
      sourceInvoiceLineId: null,
      sourceWorkOrderPartId: null,
      sourceUnitCost: null,
      markupPercent: null,
    };
  });
  return { lines: nextLines, detachedLineCount };
}
