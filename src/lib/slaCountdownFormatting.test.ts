import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { formatHourMinuteDuration, formatRemaining } from "./slaConfig";

for (const [hours, expected] of [[71.999, "72h 0m"], [1.999, "2h 0m"], [1.99, "1h 59m"],
  [0, "0h 0m"], [0.5, "0h 30m"], [24, "24h 0m"], [-1.999, "-2h 0m"], [Number.NaN, "Not set"], [Infinity, "Not set"]] as const) {
  test(`hour/minute duration ${hours} is normalized as ${expected}`, () => assert.equal(formatHourMinuteDuration(hours), expected));
}
test("compact SLA badges share normalized minutes without changing overdue/day policy", () => {
  assert.equal(formatRemaining(1.999), "2h 0m");
  assert.equal(formatRemaining(24), "1d 0h");
  assert.equal(formatRemaining(-1.999), "1h past");
});
test("both authoritative and compatibility detail countdowns share minute carry formatting",()=>{
  const detail=readFileSync("src/features/work-orders/WorkOrderDetail.tsx","utf8");
  assert.match(detail,/formatHourMinuteDuration\(sla2\.headlineRemainingHours\)/);
  assert.match(detail,/formatHourMinuteDuration\(slaR\.remainingHours\)/);
  assert.doesNotMatch(detail,/Math\.round\(\(sla2\.headlineRemainingHours % 1\) \* 60\)/);
});
