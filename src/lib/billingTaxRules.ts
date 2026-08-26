export type BillingTaxRule = {
  id: string;
  ruleKey: string;
  name: string;
  priority: number;
  equipmentKeywords: string[];
  lineTypes: string[];
  descriptionKeywords: string[];
  taxable: boolean;
  active: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type BillingTaxRuleRow = {
  id: string;
  rule_key: string;
  name: string;
  priority: number;
  equipment_keywords: string[] | null;
  line_types: string[] | null;
  description_keywords: string[] | null;
  taxable: boolean;
  is_active: boolean;
  created_at?: string | null;
  updated_at?: string | null;
};

export type BillingTaxRuleContext = {
  equipmentText?: unknown;
  lineType?: unknown;
  description?: unknown;
};

export type BillingTaxDecision = {
  taxable: boolean;
  rule: BillingTaxRule | null;
  source: "rule" | "fallback";
};

const normalizeText = (value: unknown) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/\s+/g, " ");

const normalizeValues = (values: unknown): string[] => Array.isArray(values)
  ? [...new Set(values.map(normalizeText).filter(Boolean))]
  : [];

export function mapBillingTaxRule(row: BillingTaxRuleRow): BillingTaxRule {
  return {
    id: row.id,
    ruleKey: row.rule_key,
    name: row.name,
    priority: Number(row.priority || 0),
    equipmentKeywords: normalizeValues(row.equipment_keywords),
    lineTypes: normalizeValues(row.line_types),
    descriptionKeywords: normalizeValues(row.description_keywords),
    taxable: Boolean(row.taxable),
    active: Boolean(row.is_active),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

export function billingTaxEquipmentText(workOrder: Record<string, unknown> | null | undefined) {
  return [
    workOrder?.lineOfService,
    workOrder?.line_of_service,
    workOrder?.businessService,
    workOrder?.business_service,
    workOrder?.category,
    workOrder?.subCategory,
    workOrder?.sub_category,
    workOrder?.summary,
    workOrder?.description,
  ]
    .filter(Boolean)
    .join(" ");
}

function containsAny(haystack: string, needles: string[]) {
  return needles.length === 0 || needles.some(needle => haystack.includes(needle));
}

export function billingTaxRuleMatches(
  rule: BillingTaxRule,
  context: BillingTaxRuleContext,
): boolean {
  if (!rule.active) return false;
  const equipment = normalizeText(context.equipmentText);
  const lineType = normalizeText(context.lineType);
  const description = normalizeText(context.description);

  if (!containsAny(equipment, rule.equipmentKeywords)) return false;
  if (rule.lineTypes.length > 0 && !rule.lineTypes.includes(lineType)) return false;
  if (!containsAny(description, rule.descriptionKeywords)) return false;

  return rule.equipmentKeywords.length > 0
    || rule.lineTypes.length > 0
    || rule.descriptionKeywords.length > 0;
}

export function resolveBillingLineTaxability(
  rules: BillingTaxRule[],
  context: BillingTaxRuleContext,
  fallbackTaxable = false,
): BillingTaxDecision {
  const matchingRule = [...rules]
    .filter(rule => billingTaxRuleMatches(rule, context))
    .sort((left, right) =>
      left.priority - right.priority
      || left.ruleKey.localeCompare(right.ruleKey),
    )[0] || null;

  return matchingRule
    ? { taxable: matchingRule.taxable, rule: matchingRule, source: "rule" }
    : { taxable: fallbackTaxable, rule: null, source: "fallback" };
}

export function parseBillingTaxRuleList(value: unknown): string[] {
  return [...new Set(String(value || "")
    .split(",")
    .map(normalizeText)
    .filter(Boolean))];
}

