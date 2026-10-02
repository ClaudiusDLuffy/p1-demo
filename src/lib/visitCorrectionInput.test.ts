import assert from "node:assert/strict";
import test from "node:test";
import { resolveVisitCorrectionTime } from "./visitCorrectionInput";

test("unchanged minute controls preserve seconds and database microseconds exactly", () => {
  const original = "2026-09-18T13:30:47.123456+00:00";
  assert.equal(resolveVisitCorrectionTime("2026-09-18", "08:30", "America/Chicago", original), original);
});

test("an actual edit resolves the requested local minute instead of retaining old seconds", () => {
  assert.equal(resolveVisitCorrectionTime("2026-09-18", "08:31", "America/Chicago", "2026-09-18T13:30:47.123Z"), "2026-09-18T13:31:00.000Z");
  assert.equal(resolveVisitCorrectionTime("2026-09-19", "08:30", "America/Chicago", "2026-09-18T13:30:47.123Z"), "2026-09-19T13:30:00.000Z");
});

test("unchanged times preserve the correct instant in a repeated DST hour", () => {
  for (const original of ["2026-11-01T06:30:42.000Z", "2026-11-01T07:30:42.000Z"]) {
    assert.equal(resolveVisitCorrectionTime("2026-11-01", "01:30", "America/Chicago", original), original);
  }
});

test("missing originals still use validated local-time conversion", () => {
  assert.equal(resolveVisitCorrectionTime("2026-09-18", "08:30", "America/Chicago", null), "2026-09-18T13:30:00.000Z");
  assert.throws(() => resolveVisitCorrectionTime("", "08:30", "America/Chicago", "2026-09-18T13:30:47Z"));
});
