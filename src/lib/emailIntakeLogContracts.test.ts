import assert from "node:assert/strict";
import test from "node:test";
import { boundedIntakeText, intakeLogPayloadSchema, intakeLogResultSchema, intakeSourceIdSchema } from "./emailIntakeLogContracts";

test("trusted intake contract accepts only the four existing outcome actions", () => {
  for (const action of ["created", "updated", "skipped", "failed"]) {
    const result = intakeLogPayloadSchema.parse({ email_id: "graph-safe", action, reason: "Synthetic outcome", parse_confidence: "high", work_order_id: ["created", "updated"].includes(action) ? "WOT9600001" : null });
    assert.equal(result.action, action);
    assert.equal(result.work_order_id, ["created", "updated"].includes(action) ? "WOT9600001" : null);
    assert.equal(result.contractor_assigned, null);
  }
  for (const action of ["processed", "escalated", "", null, true, 1]) {
    assert.equal(intakeLogPayloadSchema.safeParse({ email_id: "graph-safe", action, reason: "Synthetic outcome", parse_confidence: "high" }).success, false);
  }
});

test("trusted intake rejects unknown provider payload fields, malformed IDs and confidence", () => {
  for (const extension of [
    { body: "email body" }, { headers: { Authorization: "secret" } }, { metadata: "x".repeat(33000) },
    { actor: "staff" }, { provenance: "trusted_service_v1" }, { processed_at: "2020-01-01" },
    { parse_confidence: "excellent" }, { contractor_assigned: "display name" }, { work_order_id: " " },
    { subject: {} }, { reason: 42 }, { email_id: "x".repeat(2049) },
  ]) assert.equal(intakeLogPayloadSchema.safeParse({ email_id: "graph-safe", action: "skipped", reason: "Synthetic outcome", parse_confidence: "high", ...extension }).success, false);
});

test("source identity trims only surrounding whitespace and never truncates", () => {
  assert.equal(intakeSourceIdSchema.parse("  <source@example.invalid>  "), "<source@example.invalid>");
  for (const value of [null, 42, {}, false, "", "   ", "x\ninside", "x".repeat(2049)]) {
    assert.equal(intakeSourceIdSchema.safeParse(value).success, false);
  }
});

test("human summaries are Unicode-safe, visibly truncated and credential-redacted", () => {
  assert.equal(Array.from(boundedIntakeText("😀".repeat(1100), 1024)).length, 1024);
  const summary = boundedIntakeText("Authorization: Bearer synthetic-secret\naccess_token=another-secret; ordinary reason", 2000);
  assert.doesNotMatch(summary, /synthetic-secret|another-secret|\n/);
  assert.match(summary, /ordinary reason/);
  assert.equal(intakeLogPayloadSchema.parse({ email_id: "safe", action: "failed", reason: "x".repeat(3000), parse_confidence: "low" }).reason.length, 2000);
});

test("receipt rejects contradictory success, unexpected fields, dates and IDs", () => {
  const valid = { applied: true, reason: "recorded", logId: "00000000-0000-4000-8000-000000000081", eventId: "00000000-0000-4000-8000-000000000082", sourceMessageId: "safe", processedAt: "2026-09-09T00:00:00Z" };
  assert.equal(intakeLogResultSchema.safeParse(valid).success, true);
  for (const extension of [{ applied: false }, { processedAt: "not-a-date" }, { logId: "invalid" }, { subject: "provider payload" }]) {
    assert.equal(intakeLogResultSchema.safeParse({ ...valid, ...extension }).success, false);
  }
});
