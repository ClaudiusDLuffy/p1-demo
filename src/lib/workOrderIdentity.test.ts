import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalSevenElevenWorkOrderId,
  isReassignmentPortalReference,
} from "./workOrderIdentity";

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
