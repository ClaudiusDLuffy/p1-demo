import assert from "node:assert/strict";
import test from "node:test";
import { slaLabel, slaRemaining } from "./slaDisplay";

const now = new Date("2026-09-08T12:00:00.000Z");

test("uses stored P1 escalation deadlines instead of the legacy 8-hour badge", () => {
  const workOrder = {
    priority: "p1",
    dispatchedAt: "2026-09-01T00:00:00.000Z",
    slaStartedAt: "2026-09-08T11:00:00.000Z",
    responseBreachAt: "2026-09-08T13:00:00.000Z",
    resolutionBreachAt: "2026-09-08T15:00:00.000Z",
  };

  assert.deepEqual(slaRemaining(workOrder, now), {
    remainingHours: 1,
    elapsedHours: 1,
    slaHours: 2,
    percent: 50,
  });
  assert.equal(slaLabel(workOrder, now)?.text, "1h left");
});

test("moves the headline to the stored resolution deadline after response", () => {
  const remaining = slaRemaining({
    priority: "p1",
    slaStartedAt: "2026-09-08T11:00:00.000Z",
    responseBreachAt: "2026-09-08T13:00:00.000Z",
    resolutionBreachAt: "2026-09-08T15:00:00.000Z",
    startTimeRaw: "2026-09-08T12:30:00.000Z",
  }, now);

  assert.equal(remaining?.remainingHours, 3);
  assert.equal(remaining?.slaHours, 4);
});

test("uses a single stored deadline before considering legacy priority hours", () => {
  const remaining = slaRemaining({
    priority: "p4",
    dispatchedAt: "2026-09-01T00:00:00.000Z",
    responseBreachAt: "2026-09-08T14:00:00.000Z",
  }, now);

  assert.equal(remaining?.remainingHours, 2);
});

test("keeps the legacy fallback only for rows without stored deadlines", () => {
  const remaining = slaRemaining({
    priority: "p1",
    dispatchedAt: "2026-09-08T08:00:00.000Z",
  }, now);

  assert.equal(remaining?.remainingHours, 4);
  assert.equal(remaining?.slaHours, 8);
});
