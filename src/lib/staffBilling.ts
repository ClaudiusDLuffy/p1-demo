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
