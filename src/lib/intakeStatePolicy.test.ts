import assert from "node:assert/strict";
import test from "node:test";
import {
  intakeStateActivationDecision,
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

test("allows Florida when it is present in the state allowlist", () => {
  assert.equal(
    intakeStateBlockReason("FL", "VA,TX,FL", "true"),
    null,
  );
});

test("holds Florida mail when the activation timestamp is missing or invalid", () => {
  assert.deepEqual(
    intakeStateActivationDecision("FL", "2026-08-04T13:00:00Z", undefined),
    {
      action: "hold",
      reason: "state FL intake activation timestamp is not configured; mailbox left unchanged",
    },
  );
  assert.deepEqual(
    intakeStateActivationDecision("FL", "2026-08-04T13:00:00Z", "not-a-date"),
    {
      action: "hold",
      reason: "state FL intake activation timestamp is invalid; mailbox left unchanged",
    },
  );
});

test("holds Florida mail when Graph does not provide a valid received time", () => {
  assert.deepEqual(
    intakeStateActivationDecision("FL", "", "2026-08-04T13:00:00Z"),
    {
      action: "hold",
      reason: "state FL dispatch received time is invalid; mailbox left unchanged",
    },
  );
});

test("skips Florida dispatches received before activation", () => {
  assert.deepEqual(
    intakeStateActivationDecision(
      "FL",
      "2026-08-04T08:59:59-04:00",
      "2026-08-04T09:00:00-04:00",
    ),
    {
      action: "skip",
      reason: "state FL dispatch predates Florida activation at 2026-08-04T13:00:00.000Z",
    },
  );
});

test("allows Florida dispatches at or after activation", () => {
  assert.deepEqual(
    intakeStateActivationDecision(
      "FL",
      "2026-08-04T09:00:00-04:00",
      "2026-08-04T13:00:00Z",
    ),
    { action: "allow", reason: null },
  );
  assert.deepEqual(
    intakeStateActivationDecision(
      "FL",
      "2026-08-04T09:00:01-04:00",
      "2026-08-04T13:00:00Z",
    ),
    { action: "allow", reason: null },
  );
});

test("does not apply the Florida activation timestamp to other states", () => {
  assert.deepEqual(
    intakeStateActivationDecision("VA", "", undefined),
    { action: "allow", reason: null },
  );
  assert.deepEqual(
    intakeStateActivationDecision("TX", "", undefined),
    { action: "allow", reason: null },
  );
});
