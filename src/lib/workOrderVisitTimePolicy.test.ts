import assert from "node:assert/strict";
import test from "node:test";
import {
  FIELD_EVENT_FUTURE_TOLERANCE_MS,
  validateFieldEventTime,
} from "./workOrderVisitTimePolicy";

const nowMs = Date.parse("2026-09-21T14:05:00Z");

test("field events accept present and five-minute clock skew but reject later future times", () => {
  for (const kind of ["arrival", "checkout", "completion"] as const) {
    assert.equal(validateFieldEventTime({
      eventAt: new Date(nowMs + FIELD_EVENT_FUTURE_TOLERANCE_MS).toISOString(),
      kind,
      nowMs,
    }), null);
    assert.match(validateFieldEventTime({
      eventAt: new Date(nowMs + FIELD_EVENT_FUTURE_TOLERANCE_MS + 1).toISOString(),
      kind,
      nowMs,
    }) || "", /cannot be more than 5 minutes in the future/);
  }
});

test("checkout and completion cannot precede the active visit while arrival has no prior-visit constraint", () => {
  const activeVisitCheckInAt = "2026-09-21T14:00:00Z";
  const earlier = "2026-09-21T13:59:59Z";
  assert.equal(validateFieldEventTime({ eventAt: earlier, kind: "arrival", activeVisitCheckInAt, nowMs }), null);
  assert.match(validateFieldEventTime({ eventAt: earlier, kind: "checkout", activeVisitCheckInAt, nowMs }) || "", /before this visit's check-in/);
  assert.match(validateFieldEventTime({ eventAt: earlier, kind: "completion", activeVisitCheckInAt, nowMs }) || "", /before this visit's check-in/);
  assert.equal(validateFieldEventTime({ eventAt: activeVisitCheckInAt, kind: "completion", activeVisitCheckInAt, nowMs }), null);
});

test("invalid timestamps fail before any lifecycle transport is attempted", () => {
  assert.equal(validateFieldEventTime({ eventAt: "not-a-time", kind: "arrival", nowMs }), "Arrival time is invalid.");
});
