import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { logIntakeOutcome } from "./server/logIntakeOutcome";
import { runRequestOperation } from "./server/requestOperation";
import { createRequestContext } from "./observability/requestContext";

test("handled intake failures use the request correlation and never emit provider payloads", async () => {
  const lines: string[] = []; const original = console.info;
  console.info = (line: string) => { lines.push(line); };
  const correlationId = "11111111-1111-4111-8111-111111111111";
  const eventId = "22222222-2222-4222-8222-222222222222";
  const context = createRequestContext(new Request("https://portal.example.invalid/api/email-intake", {
    method: "POST", headers: { "X-Request-ID": correlationId },
  }), "/api/email-intake");
  try {
    logIntakeOutcome("intake_processing_failed", eventId);
    assert.equal(lines.length, 0, "Standalone calls do not invent a second request identity");
    await runRequestOperation(context, async () => {
      logIntakeOutcome("intake_priority_delivery_failed", eventId);
      logIntakeOutcome("intake_removal_delivery_failed", "private@example.invalid Bearer synthetic-token");
    });
    assert.equal(lines.length, 2);
    const entries = lines.map(line => JSON.parse(line) as Record<string, unknown>);
    assert.ok(entries.every(entry => entry.correlationId === correlationId && entry.code === "RESULT_UNCONFIRMED"));
    assert.equal(entries[0].eventId, eventId); assert.equal(entries[1].eventId, undefined);
    assert.equal(context.failureLogged, false, "Handled outcomes do not consume the separate boundary-failure receipt");
    assert.doesNotMatch(lines.join(""), /private@|Bearer|synthetic-token|stack|reason|description/);
  } finally { console.info = original; }
});

test("intake and notification helpers contain no raw console error paths", () => {
  for (const path of ["emailIntakeProcessor.ts", "autoDispatch.ts", "emailPriorityEscalationProcessor.ts",
    "emailAssignmentRemovalProcessor.ts", "notificationService.ts"]) {
    const source = readFileSync(`src/lib/${path}`, "utf8");
    assert.doesNotMatch(source, /console\.(error|warn|info|log)\(/, path);
    assert.match(source, /logIntakeOutcome\(/, path);
  }
});
