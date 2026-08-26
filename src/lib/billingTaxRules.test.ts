import assert from "node:assert/strict";
import test from "node:test";

import {
  billingTaxEquipmentText,
  mapBillingTaxRule,
  parseBillingTaxRuleList,
  resolveBillingLineTaxability,
  type BillingTaxRule,
} from "./billingTaxRules";

const rule = (overrides: Partial<BillingTaxRule>): BillingTaxRule => ({
  id: "rule-1",
  ruleKey: "test",
  name: "Test",
  priority: 100,
  equipmentKeywords: [],
  lineTypes: [],
  descriptionKeywords: [],
  taxable: false,
  active: true,
  ...overrides,
});

test("first matching active rule wins deterministically", () => {
  const decision = resolveBillingLineTaxability([
    rule({ ruleKey: "parts", priority: 30, lineTypes: ["parts/hardware"], taxable: true }),
    rule({ ruleKey: "vault", priority: 10, equipmentKeywords: ["vault"], taxable: false }),
  ], {
    equipmentText: "7-Eleven cash vault",
    lineType: "Parts/Hardware",
    description: "Lock assembly",
  }, true);

  assert.equal(decision.taxable, false);
  assert.equal(decision.rule?.ruleKey, "vault");
});

test("labor and travel exemptions can override equipment rules", () => {
  const decision = resolveBillingLineTaxability([
    rule({ ruleKey: "labor", priority: 20, lineTypes: ["labor", "travel"], taxable: false }),
    rule({ ruleKey: "slurpee", priority: 40, equipmentKeywords: ["slurpee"], taxable: true }),
  ], {
    equipmentText: "Slurpee machine",
    lineType: "Labor",
  });

  assert.equal(decision.taxable, false);
  assert.equal(decision.rule?.ruleKey, "labor");
});

test("unmatched and inactive rules preserve the explicit fallback", () => {
  const decision = resolveBillingLineTaxability([
    rule({ ruleKey: "inactive", active: false, lineTypes: ["other"], taxable: true }),
  ], { lineType: "Other" }, true);
  assert.deepEqual(decision, { taxable: true, rule: null, source: "fallback" });
});

test("rule rows and comma lists normalize once at the boundary", () => {
  assert.deepEqual(parseBillingTaxRuleList(" Parts, parts,  Hardware "), ["parts", "hardware"]);
  assert.deepEqual(mapBillingTaxRule({
    id: "1",
    rule_key: "PARTS",
    name: "Parts",
    priority: 30,
    equipment_keywords: null,
    line_types: ["Parts/Hardware"],
    description_keywords: [],
    taxable: true,
    is_active: true,
  }).lineTypes, ["parts/hardware"]);
});

test("equipment context includes canonical and legacy work-order fields", () => {
  assert.match(billingTaxEquipmentText({
    businessService: "Slurpee",
    sub_category: "Frozen beverage",
  }), /Slurpee.*Frozen beverage/);
});
