import assert from "node:assert/strict";
import test from "node:test";

import {
  isQuickBooksEquipmentTag,
  QUICKBOOKS_EQUIPMENT_TAGS,
  resolveQuickBooksEquipmentTag,
} from "./quickBooksEquipmentTags";

test("uses only Emily's exact QuickBooks equipment tags", () => {
  assert.equal(QUICKBOOKS_EQUIPMENT_TAGS.length, 24);
  assert.ok(QUICKBOOKS_EQUIPMENT_TAGS.every(isQuickBooksEquipmentTag));
  assert.equal(isQuickBooksEquipmentTag("HVAC"), false);
});

test("auto-fills a tag from the work order service and equipment text", () => {
  assert.equal(
    resolveQuickBooksEquipmentTag({ lineOfService: "Frozen Beverage - Equipment", summary: "Slurpee barrel" }),
    "7-ELEVEN: Slurpee",
  );
  assert.equal(
    resolveQuickBooksEquipmentTag({ businessService: "HVAC", summary: "RTU not cooling" }),
    "7-ELEVEN: HVAC",
  );
  assert.equal(
    resolveQuickBooksEquipmentTag({ summary: "Uncategorized repair" }),
    "7-ELEVEN: Miscellaneous",
  );
});

test("structured 7-Eleven services outrank conflicting narrative equipment terms", () => {
  assert.equal(
    resolveQuickBooksEquipmentTag({
      lineOfService: "Refrigeration",
      summary: "Open air cooler is not holding temperature",
    }),
    "7-ELEVEN: Refrigeration",
  );
  assert.equal(
    resolveQuickBooksEquipmentTag({
      business_service: "HVAC",
      description: "Walk-in freezer is warm",
    }),
    "7-ELEVEN: HVAC",
  );
  assert.equal(
    resolveQuickBooksEquipmentTag({
      lineOfService: "Roof",
      description: "Water is leaking above the walk-in cooler",
    }),
    "7-ELEVEN: Roof",
  );
  assert.equal(
    resolveQuickBooksEquipmentTag({
      businessService: "Plumbing",
      summary: "Roof drain and ceiling leak",
    }),
    "7-ELEVEN: Plumbing",
  );
  assert.equal(
    resolveQuickBooksEquipmentTag({
      line_of_service: "Refrigeration",
      description: "Ice buildup inside the freezer",
    }),
    "7-ELEVEN: Refrigeration",
  );
  assert.equal(
    resolveQuickBooksEquipmentTag({
      category: "Roof",
      description: "Water is leaking above the walk-in cooler",
    }),
    "7-ELEVEN: Roof",
  );
  assert.equal(
    resolveQuickBooksEquipmentTag({
      sub_category: "Floors",
      summary: "Sink drain is leaking through the ceiling",
    }),
    "7-ELEVEN: Floors",
  );
});

test("narrative equipment remains a fallback when structured services are absent", () => {
  assert.equal(
    resolveQuickBooksEquipmentTag({ summary: "Walk-in freezer is warm" }),
    "7-ELEVEN: Vault",
  );
  assert.equal(
    resolveQuickBooksEquipmentTag({ description: "Roof membrane is leaking" }),
    "7-ELEVEN: Roof",
  );
});
