import assert from "node:assert/strict";
import test from "node:test";
import { intakeProcessorFixture, syntheticEmail } from "./email-intake-test-support/processor";
import { intakeLogPayloadSchema } from "./emailIntakeLogContracts";

test("intake preserves supported skipped and creation outcomes and mailbox finalization", async () => {
  for (const mode of ["unknown", "create", "capital"] as const) {
    const h = intakeProcessorFixture({ mode });
    const result = await h.process();
    assert.equal(result.action, mode === "unknown" ? "skipped" : mode === "create" ? "created" : "updated");
    assert.ok(h.order.indexOf("mark-read") < h.order.indexOf("move"));
    assert.equal(result.workOrderId, mode === "unknown" ? null : "WOT9600001");
    assert.equal(result.logStatus, "recorded");
    assert.equal(h.writes.filter(write => write.table === "email_intake_log").length, 0);
    assert.equal(h.calls.filter(call => call.name === "record_email_intake_result_v1").length, 1);
  }
});

test("unconfirmed email leaves the mailbox and work orders unchanged", async () => {
  const h = intakeProcessorFixture({ confirmed: false });
  const result = await h.process();
  assert.equal(result.action, "skipped");
  assert.doesNotMatch(h.order.join(" "), /mark-read|move|create_email_work_order/);
});

test("trusted log failure is visible without falsely undoing a committed work-order action", async () => {
  const h = intakeProcessorFixture({ mode: "create", logError: { message: "synthetic private SQL detail", code: "XX000" } });
  const result = await h.process();
  assert.equal(result.action, "created");
  assert.ok("logStatus" in result);
  assert.equal(result.logStatus, "unconfirmed");
  assert.doesNotMatch(JSON.stringify(result), /private SQL detail/);
  assert.doesNotMatch(JSON.stringify(h.diagnostics), /private SQL detail/);
});

test("the same normalized source outcome keeps its event identity across processor retries", async () => {
  const h = intakeProcessorFixture();
  await h.process(); await h.process();
  const [first, second] = h.calls.filter(call => call.name === "record_email_intake_result_v1");
  assert.deepEqual(first.args, second.args);
  assert.equal(first.args.p_source_message_id, syntheticEmail.internetMessageId);
  assert.doesNotMatch(JSON.stringify(first.args), /processed_at|created_at|Synthetic body|synthetic-token/);
});

test("failed then successful processing remains distinct multi-event source history", async () => {
  const failed = intakeProcessorFixture({ mode: "create", processingError: { message: "private db text" } });
  const success = intakeProcessorFixture({ mode: "create" });
  assert.equal((await failed.process()).action, "failed");
  assert.equal((await success.process()).action, "created");
  const f = failed.calls.find(call => call.name === "record_email_intake_result_v1");
  const s = success.calls.find(call => call.name === "record_email_intake_result_v1");
  assert.ok(f && s);
  assert.equal(f.args.p_source_message_id, s.args.p_source_message_id);
  assert.notEqual(f.args.p_event_id, s.args.p_event_id);
});

test("a moved Graph alias keeps source/event identity but cannot silently overwrite the original receipt", async () => {
  let original: unknown;
  const h = intakeProcessorFixture({ rpcResult: (_name, args) => {
    if (original !== undefined) {
      assert.notDeepEqual(args.p_payload, original);
      return { data: null, error: { code: "PT409" } };
    }
    original = args.p_payload;
    return { error: null, data: { applied: true, reason: "recorded", logId: "00000000-0000-4000-8000-000000000081", eventId: args.p_event_id, sourceMessageId: args.p_source_message_id, processedAt: "2026-09-09T00:00:00Z" } };
  } });
  assert.equal((await h.process()).logStatus, "recorded");
  const moved = await h.process({ ...syntheticEmail, id: "different-graph-alias-after-move" });
  assert.equal(moved.logError, "INTAKE_LOG_CONFLICT");
  assert.equal(h.calls[0].args.p_event_id, h.calls[1].args.p_event_id);
  assert.equal(h.calls[0].args.p_source_message_id, h.calls[1].args.p_source_message_id);
});

test("provider processing and mailbox failures never enter trusted summaries or diagnostics", async () => {
  for (const mode of ["processing", "mailbox"] as const) {
    const secret = new Error("Authorization: Bearer synthetic-secret /private/customer.pdf SQL detail");
    const h = intakeProcessorFixture(mode === "processing" ? { mode: "capital", processingError: secret } : { mailboxError: secret });
    const result = await h.process();
    assert.equal(result.action, mode === "processing" ? "failed" : "skipped");
    assert.match(result.reason, /operator review required/);
    assert.doesNotMatch(JSON.stringify([result, h.calls, h.diagnostics]), /synthetic-secret|customer\.pdf|SQL detail/);
  }
});

test("already recorded receipt is validated and remains a successful processing result", async () => {
  const h = intakeProcessorFixture({ rpcResult: (_name, args) => ({ error: null, data: {
    applied: false, reason: "already_recorded", logId: "00000000-0000-4000-8000-000000000081",
    eventId: args.p_event_id, sourceMessageId: args.p_source_message_id, processedAt: "2026-09-09T00:00:00Z",
  } }) });
  assert.equal((await h.process()).logStatus, "already_recorded");
});

test("a lost response after recording reuses the exact event rather than creating a new identity", async () => {
  let calls = 0;
  const h = intakeProcessorFixture({ rpcResult: (_name, args) => {
    calls++;
    if (calls === 1) return { data: null, error: { message: "response lost" } };
    return { error: null, data: { applied: false, reason: "already_recorded", logId: "00000000-0000-4000-8000-000000000081", eventId: args.p_event_id, sourceMessageId: args.p_source_message_id, processedAt: "2026-09-09T00:00:00Z" } };
  } });
  assert.equal((await h.process()).logStatus, "unconfirmed");
  assert.equal((await h.process()).logStatus, "already_recorded");
  assert.deepEqual(h.calls[0].args, h.calls[1].args);
});

test("conflicts and malformed or mismatched receipts never claim recorded provenance", async () => {
  for (const data of [null, {}, { applied: true, reason: "conflict" }, {
    applied: true, reason: "recorded", logId: "00000000-0000-4000-8000-000000000081",
    eventId: "00000000-0000-4000-8000-000000000082", sourceMessageId: "different-source", processedAt: "2026-09-09T00:00:00Z",
  }]) {
    const h = intakeProcessorFixture({ rpcResult: () => ({ data, error: null }) });
    assert.equal((await h.process()).logStatus, "unconfirmed");
  }
  const h = intakeProcessorFixture({ logError: { code: "PT409", message: "raw SQL conflict" } });
  const conflict = await h.process();
  assert.equal(conflict.logStatus, "unconfirmed");
  assert.equal(conflict.logError, "INTAKE_LOG_CONFLICT");
});

test("overlong identity never reaches the log command, while subjects are visibly bounded", async () => {
  const invalid = intakeProcessorFixture();
  assert.equal((await invalid.process({ ...syntheticEmail, internetMessageId: "x".repeat(2049) })).logStatus, "unconfirmed");
  assert.equal(invalid.calls.length, 0);
  const valid = intakeProcessorFixture();
  assert.equal((await valid.process({ ...syntheticEmail, subject: "x".repeat(2000) })).logStatus, "recorded");
  const payload = intakeLogPayloadSchema.parse(valid.calls[0].args.p_payload);
  assert.equal(payload.subject?.length, 1024);
  assert.match(payload.subject ?? "", /\[truncated\]$/);
});
