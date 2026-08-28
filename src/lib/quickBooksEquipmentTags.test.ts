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
