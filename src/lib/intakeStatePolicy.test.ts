import assert from "node:assert/strict";
import test from "node:test";
import {
  intakeStateBlockReason,
  parseAllowedIntakeStates,
} from "./intakeStatePolicy";

test("normalizes and deduplicates configured intake states", () => {
  assert.deepEqual(parseAllowedIntakeStates(" va, TX,va "), ["VA", "TX"]);
});

test("keeps Texas disabled even when it is present in the state allowlist", () => {
  assert.equal(
    intakeStateBlockReason("TX", "VA,TX", undefined),
    "state TX intake is not enabled",
  );
});

test("allows Texas only when both production controls are enabled", () => {
  assert.equal(
    intakeStateBlockReason("tx", "VA,TX", "true"),
    null,
  );
});

test("continues to enforce the normal state allowlist", () => {
  assert.match(
    intakeStateBlockReason("FL", "VA,TX", "true") || "",
    /not in allowed intake states/,
  );
});
