export const STAFF_BILLING_LINE_TYPES = [
  "Travel",
  "Labor",
  "OT Labor",
  "Parts/Hardware",
  "Shipping",
  "Other",
] as const;

export type StaffBillingLineType = typeof STAFF_BILLING_LINE_TYPES[number];

export function normalizeStaffBillingLineType(type: unknown): StaffBillingLineType {
  const value = String(type || "").trim();
  if (/^(?:ot|overtime)\s*labor$/i.test(value)) return "OT Labor";
  if (/^labor$/i.test(value)) return "Labor";
  if (/part|hardware|material/i.test(value)) return "Parts/Hardware";
  if (/travel|truck/i.test(value)) return "Travel";
  if (/shipping|freight/i.test(value)) return "Shipping";
  return "Other";
}

export function normalizeImportedStaffBillingLineType(
  type: unknown,
  description: unknown,
): StaffBillingLineType {
  const normalizedType = normalizeStaffBillingLineType(type);
  const detail = String(description || "").trim();
  const describesOvertimeLabor = /\b(?:(?:overtime|over[\s-]?time|ot)\s+(?:labou?r|hours?|hrs?)|(?:labou?r|hours?|hrs?)\s+(?:overtime|over[\s-]?time|ot))\b/i.test(detail);
  if (
    ["Labor", "Other"].includes(normalizedType)
    && describesOvertimeLabor
  ) {
    return "OT Labor";
  }
  return normalizedType;
}

export const isStaffBillingPartsLine = (type: unknown) =>
  /part|hardware|material/i.test(String(type || ""));

export function importedStaffBillingRate(
  type: unknown,
  sourceUnitCost: unknown,
  partsMarkupPercent = 25,
) {
  const normalizedType = normalizeStaffBillingLineType(type);
  const sourceCost = Number(sourceUnitCost);
  const finiteSourceCost = Number.isFinite(sourceCost) ? sourceCost : 0;

  if (normalizedType === "Labor" || normalizedType === "Travel") return 110;
  if (normalizedType === "OT Labor") return 165;
  if (isStaffBillingPartsLine(normalizedType)) {
    return Math.round(
      finiteSourceCost * (1 + partsMarkupPercent / 100) * 100,
    ) / 100;
  }
  return Math.round(finiteSourceCost * 100) / 100;
}

export function staffBillingDescriptionPlaceholder(type: unknown) {
  const normalizedType = normalizeStaffBillingLineType(type);
  if (normalizedType === "Labor" || normalizedType === "OT Labor") {
    return "Enter job notes";
  }
  if (normalizedType === "Travel") return "Description (optional)";
  return "Description";
}

export function applyStaffBillingPartsMarkup(
  sourceUnitCost: unknown,
  currentRate: unknown,
  markupPercent: unknown,
) {
  const explicitSourceCost = Number(sourceUnitCost);
  const displayedRate = Number(currentRate);
  const markup = Number(markupPercent);
  const sourceCost = sourceUnitCost != null && Number.isFinite(explicitSourceCost)
    ? explicitSourceCost
    : displayedRate;

  if (!Number.isFinite(sourceCost) || sourceCost <= 0) return null;
  if (!Number.isFinite(markup) || markup < 0 || markup > 999) return null;

  return {
    sourceUnitCost: Math.round(sourceCost * 100) / 100,
    markupPercent: markup,
    rate: Math.round(sourceCost * (1 + markup / 100) * 100) / 100,
  };
}

export function staffBillingMarkupPercent(
  sourceUnitCost: unknown,
  rate: unknown,
) {
  const sourceCost = Number(sourceUnitCost);
  const billedRate = Number(rate);
  if (!Number.isFinite(sourceCost) || sourceCost <= 0) return null;
  if (!Number.isFinite(billedRate) || billedRate < sourceCost) return null;

  const markup = ((billedRate - sourceCost) / sourceCost) * 100;
  if (!Number.isFinite(markup) || markup > 999) return null;
  return Math.round(markup * 100) / 100;
}
