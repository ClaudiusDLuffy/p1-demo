export const QUICKBOOKS_EQUIPMENT_TAGS = [
  "7-ELEVEN: HVAC",
  "7-ELEVEN: Fountain",
  "7-ELEVEN: Vault Project",
  "7-ELEVEN: A/C",
  "7-ELEVEN: Lift Station",
  "7-ELEVEN: Vault",
  "7-ELEVEN: Ice",
  "7-ELEVEN: Ovens",
  "7-ELEVEN: EMS System",
  "7-ELEVEN: Floors",
  "7-ELEVEN: Roof",
  "7-ELEVEN: Frozen",
  "7-ELEVEN: CO2",
  "7-ELEVEN: Slurpee",
  "7-ELEVEN: Miscellaneous",
  "7-ELEVEN: Coffee",
  "7-ELEVEN: Engineering Drawings",
  "7-ELEVEN: Dish Machine",
  "7-ELEVEN: Hot Food",
  "7-ELEVEN: Refrigeration",
  "7-ELEVEN: Emergency",
  "7-ELEVEN: Ceilings",
  "7-ELEVEN: Plumbing",
  "7-ELEVEN: General Maintenance",
] as const;

export type QuickBooksEquipmentTag = typeof QUICKBOOKS_EQUIPMENT_TAGS[number];

type EquipmentTagWorkOrder = {
  lineOfService?: unknown;
  line_of_service?: unknown;
  businessService?: unknown;
  business_service?: unknown;
  category?: unknown;
  subCategory?: unknown;
  sub_category?: unknown;
  summary?: unknown;
  description?: unknown;
};

const normalizeValues = (values: unknown[]) => values
  .map(value => String(value || "").trim().toLowerCase())
  .filter(Boolean)
  .join(" ");

const normalizedText = (workOrder: EquipmentTagWorkOrder | null | undefined) => normalizeValues([
  workOrder?.lineOfService,
  workOrder?.line_of_service,
  workOrder?.businessService,
  workOrder?.business_service,
  workOrder?.category,
  workOrder?.subCategory,
  workOrder?.sub_category,
  workOrder?.summary,
  workOrder?.description,
]);

const normalizedStructuredText = (workOrder: EquipmentTagWorkOrder | null | undefined) => normalizeValues([
  workOrder?.lineOfService,
  workOrder?.line_of_service,
  workOrder?.businessService,
  workOrder?.business_service,
  workOrder?.category,
  workOrder?.subCategory,
  workOrder?.sub_category,
]);

const has = (text: string, pattern: RegExp) => pattern.test(text);

const equipmentTagFromText = (text: string): QuickBooksEquipmentTag | null => {
  if (has(text, /\bvault project\b/)) return "7-ELEVEN: Vault Project";
  if (has(text, /\bengineering drawing/)) return "7-ELEVEN: Engineering Drawings";
  if (has(text, /\blift station\b|\bseptic\b/)) return "7-ELEVEN: Lift Station";
  if (has(text, /\bems\b|energy management/)) return "7-ELEVEN: EMS System";
  if (has(text, /\bdish ?machine\b|dishwash/)) return "7-ELEVEN: Dish Machine";
  if (has(text, /\bslurpee\b/)) return "7-ELEVEN: Slurpee";
  if (has(text, /frozen beverage|\bfrozen\b/)) return "7-ELEVEN: Frozen";
  if (has(text, /cold beverage|fountain|beverage dispenser/)) return "7-ELEVEN: Fountain";
  if (has(text, /\bco2\b|carbon dioxide/)) return "7-ELEVEN: CO2";
  if (has(text, /ice merchandiser|ice machine|\bice\b/)) return "7-ELEVEN: Ice";
  if (has(text, /\boven/)) return "7-ELEVEN: Ovens";
  if (has(text, /hot food|roller grill|food ?service/)) return "7-ELEVEN: Hot Food";
  if (has(text, /\bcoffee\b/)) return "7-ELEVEN: Coffee";
  if (has(text, /refrigerat/)) return "7-ELEVEN: Refrigeration";
  if (has(text, /\bhvac\b/)) return "7-ELEVEN: HVAC";
  if (has(text, /air conditioning|\ba\/?c\b|\bac unit\b/)) return "7-ELEVEN: A/C";
  if (has(text, /walk[ -]?in|cooler|freezer|\bvault\b/)) return "7-ELEVEN: Vault";
  if (has(text, /plumb|drain|water|toilet|sink/)) return "7-ELEVEN: Plumbing";
  if (has(text, /\broof/)) return "7-ELEVEN: Roof";
  if (has(text, /\bfloor/)) return "7-ELEVEN: Floors";
  if (has(text, /\bceiling/)) return "7-ELEVEN: Ceilings";
  if (has(text, /\bemergency\b/)) return "7-ELEVEN: Emergency";
  if (has(text, /general maintenance|handyman/)) return "7-ELEVEN: General Maintenance";
  return null;
};

export function resolveQuickBooksEquipmentTag(
  workOrder: EquipmentTagWorkOrder | null | undefined,
): QuickBooksEquipmentTag {
  const text = normalizedText(workOrder);
  const structuredText = normalizedStructuredText(workOrder);
  // The 7-Eleven classification fields are authoritative. Narrative notes can
  // mention adjacent equipment (for example, a roof leak above a cooler), so
  // use them only when the structured service fields do not identify a tag.
  // Slurpee is the one supported refinement of the broader Frozen Beverage
  // service: it preserves the existing, more-specific barrel classification.
  const structuredTag = equipmentTagFromText(structuredText);
  const combinedTag = equipmentTagFromText(text);
  if (structuredTag === "7-ELEVEN: Frozen" && combinedTag === "7-ELEVEN: Slurpee") {
    return combinedTag;
  }
  return structuredTag || combinedTag || "7-ELEVEN: Miscellaneous";
}

export function isQuickBooksEquipmentTag(
  value: unknown,
): value is QuickBooksEquipmentTag {
  return QUICKBOOKS_EQUIPMENT_TAGS.includes(value as QuickBooksEquipmentTag);
}
