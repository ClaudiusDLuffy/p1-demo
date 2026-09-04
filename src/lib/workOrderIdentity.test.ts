import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalSevenElevenWorkOrderId,
  isReassignmentPortalReference,
  normalizeExactPortalWorkOrderId,
} from "./workOrderIdentity";

test("complete portal WOT searches are normalized without accepting partial text", () => {
  assert.equal(
    normalizeExactPortalWorkOrderId("  wot1271715  "),
    "WOT1271715",
  );
  assert.equal(
    normalizeExactPortalWorkOrderId("wot1215047-2"),
    "WOT1215047-2",
  );

  for (const value of [
    "WOT2",
    "WOT12717",
    "WOT1271715-0",
    "WOT1271715-",
    "WOT1271715 extra",
    "INC27385198",
    "41591",
    "temperature",
  ]) {
    assert.equal(normalizeExactPortalWorkOrderId(value), null, value);
  }
});

test("explicit duplicate provenance owns the external 7-Eleven identity", () => {
  const copy = {
    id: "WOT1215047-2",
    duplicateRootWorkOrderId: "WOT1215047",
  };
  assert.equal(canonicalSevenElevenWorkOrderId(copy), "WOT1215047");
  assert.equal(isReassignmentPortalReference(copy), true);
});

test("external documents safely normalize a generated WOT suffix", () => {
  assert.equal(
    canonicalSevenElevenWorkOrderId("WOT1215047-2"),
    "WOT1215047",
  );
  assert.equal(
    canonicalSevenElevenWorkOrderId("WOT1215047"),
    "WOT1215047",
  );
  assert.equal(
    canonicalSevenElevenWorkOrderId("FWKD11400001-2"),
    "FWKD11400001-2",
  );
});
