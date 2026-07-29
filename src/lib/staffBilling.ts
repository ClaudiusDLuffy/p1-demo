export const STAFF_BILLING_LINE_TYPES = [
  "Travel",
  "Labor",
  "Parts/Hardware",
  "Shipping",
  "Other",
] as const;

export type StaffBillingLineType = typeof STAFF_BILLING_LINE_TYPES[number];

export function normalizeStaffBillingLineType(type: unknown): StaffBillingLineType {
  const value = String(type || "").trim();
  if (/^labor$/i.test(value)) return "Labor";
  if (/part|hardware|material/i.test(value)) return "Parts/Hardware";
  if (/travel|truck/i.test(value)) return "Travel";
  if (/shipping|freight/i.test(value)) return "Shipping";
  return "Other";
}
