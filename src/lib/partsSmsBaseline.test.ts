import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { legacyPartsSmsRoute, syntheticSmsSid } from "./parts-sms-test-support/legacyRouteHarness";

test("parts baseline executes the frozen first-party pre-cutover route", () => {
  const route = readFileSync(new URL("./parts-sms-test-support/legacy-route.fixture", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../../supabase/migrations/0065_p1_parts_procurement.sql", import.meta.url), "utf8");
  assert.match(route, /claim_p1_parts_alert_delivery/);
  assert.doesNotMatch(route, /AbortController|AbortSignal|setTimeout/);
  assert.match(migration, /unique \(recipient_id, local_date\)/);
  assert.match(migration, /interval '15 minutes'/);
});

test("parts baseline provider accept then connection loss becomes reclaimable failed and duplicates", async () => {
  const h = legacyPartsSmsRoute();
  h.providerMode("accepted_then_lost");
  for (let run = 0; run < 2; run++) assert.equal((await h.request()).status, 207);
  assert.equal(h.accepted.length, 2);
  assert.deepEqual(h.accepted[0], h.accepted[1]);
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.deliveries[0].attemptCount, 2);
  assert.equal(h.deliveries[0].status, "failed");
  assert.equal(h.deliveries[0].providerMessageId, null);
  assert.ok(h.rpcCalls.every(call => !/send_started|attempt|unknown/.test(call.name)));
});

test("parts baseline accepted SID then database completion loss becomes failed and is resent", async () => {
  const h = legacyPartsSmsRoute();
  h.failNextSentCompletion();
  assert.equal((await h.request()).status, 207);
  assert.equal(h.deliveries[0].status, "failed");
  assert.equal(h.deliveries[0].providerMessageId, null);
  assert.equal(h.accepted.length, 1);
  assert.equal((await h.request()).status, 200);
  assert.equal(h.accepted.length, 2);
  assert.equal(h.deliveries[0].status, "sent");
});

test("parts baseline hanging provider has no cancellation or timeout and leaves claimed indefinitely", async () => {
  const h = legacyPartsSmsRoute();
  h.providerMode("hanging");
  let settled = false;
  const pending = h.request().then(response => { settled = true; return response; });
  try {
    for (let turn = 0; turn < 3; turn++) await nextTurn();
    assert.equal(h.providerRequests.length, 1);
    assert.equal(h.providerRequests[0].signal, undefined);
    assert.equal(settled, false);
    assert.equal(h.deliveries[0].status, "claimed");
  } finally {
    h.releaseProvider();
    await pending;
  }
});

for (const mode of ["missing_sid", "malformed_json"] as const) {
  test(`parts baseline ${mode} success body is incorrectly treated as sent`, async () => {
    const h = legacyPartsSmsRoute();
    h.providerMode(mode);
    const response = await h.request();
    assert.equal(response.status, 200);
    assert.equal(h.deliveries[0].status, "sent");
    assert.equal(h.deliveries[0].providerMessageId, null);
    assert.equal((await response.json()).status, "sent");
  });
}

test("parts baseline accepted queued SID is exposed and called sent without handset evidence", async () => {
  const h = legacyPartsSmsRoute();
  const response = await h.request();
  const body = await response.json();
  assert.equal(body.status, "sent");
  assert.equal(body.results[0].providerMessageId, syntheticSmsSid);
  assert.equal(h.deliveries[0].providerMessageId, syntheticSmsSid);
});

test("parts baseline per-day sent ledger suppresses same and changed signatures, next day sends", async () => {
  const h = legacyPartsSmsRoute();
  await h.request();
  await h.request();
  const originalSignature = h.deliveries[0].signature;
  h.rows.wo_parts[0].updated_at = "2026-09-09T19:00:00+00:00";
  await h.request();
  assert.equal(h.accepted.length, 1);
  assert.equal(h.deliveries[0].signature, originalSignature);
  h.setNow("2026-09-10T22:00:00Z");
  await h.request();
  assert.equal(h.accepted.length, 2);
  assert.equal(h.deliveries.length, 2);
  assert.notEqual(h.deliveries[1].signature, originalSignature);
});

test("parts baseline failed changed signature rewrites the original row instead of preserving history", async () => {
  const h = legacyPartsSmsRoute();
  h.providerMode("accepted_then_lost");
  await h.request();
  const originalSignature = h.deliveries[0].signature;
  h.rows.wo_parts[0].updated_at = "2026-09-09T19:00:00+00:00";
  await h.request();
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.deliveries[0].attemptCount, 2);
  assert.notEqual(h.deliveries[0].signature, originalSignature);
});

test("parts baseline signature is SHA-256 over sorted id:timestamp strings", async () => {
  const h = legacyPartsSmsRoute();
  const second = { ...h.rows.wo_parts[0], id: "77000000-0000-4000-8000-000000000002", updated_at: null, p1_requested_at: "2026-09-09T15:00:00+00:00" };
  h.rows.wo_parts.unshift(second);
  await h.request();
  const canonical = h.rows.wo_parts.map(part => `${part.id}:${part.updated_at || part.p1_requested_at || ""}`).sort().join("|");
  assert.equal(h.deliveries[0].signature, createHash("sha256").update(canonical).digest("hex"));
});

test("parts baseline preserves exact message and dashboard link", async () => {
  const h = legacyPartsSmsRoute();
  await h.request();
  assert.equal(h.accepted[0].body, "P1 parts alert: 1 part request across 1 work order.\nWOT-SYNTHETIC-1\nhttps://portal.example.invalid/?view=dashboard");
});

test("parts baseline keeps eight work-order previews and 1500-character ceiling", async () => {
  const h = legacyPartsSmsRoute();
  const part = h.rows.wo_parts[0];
  h.rows.wo_parts = Array.from({ length: 10 }, (_, index) => ({ ...part, id: `synthetic-part-${index}`, work_order_id: `WOT-SYNTHETIC-${index}` }));
  await h.request();
  assert.match(h.accepted[0].body, /10 part requests across 10 work orders/);
  assert.match(h.accepted[0].body, /WOT-SYNTHETIC-7 \+2 more/);
  assert.doesNotMatch(h.accepted[0].body, /WOT-SYNTHETIC-8/);
  const long = legacyPartsSmsRoute();
  long.env.NEXT_PUBLIC_APP_URL = `https://example.invalid/${"a".repeat(2000)}`;
  await long.request();
  assert.equal(long.accepted[0].body.length, 1500);
});

test("parts baseline only requested P1 parts on open noncapital undeleted work orders qualify", async () => {
  const h = legacyPartsSmsRoute();
  const valid = h.rows.wo_parts[0];
  h.rows.wo_parts.push(
    { ...valid, id: "other-owner", ordering_responsibility: "contractor" },
    { ...valid, id: "ordered", p1_order_status: "ordered" },
    ...["closed", "capital", "pending_capital_completion"].map(status => ({ ...valid, id: status, work_orders: { status, deleted_at: null } })),
    { ...valid, id: "deleted", work_orders: { status: "awaiting_parts", deleted_at: "2026-09-09T00:00:00Z" } },
  );
  assert.equal((await (await h.request()).json()).parts, 1);
});

test("parts baseline inactive configured recipient is excluded but profile state is not revalidated", async () => {
  const h = legacyPartsSmsRoute();
  h.rows.p1_parts_alert_recipients.push({ id: "inactive-recipient", active: false, phone_e164: "+12025550125", created_at: "2026-01-01" });
  await h.request();
  assert.equal(h.accepted.length, 1);
  assert.equal(h.rpcCalls[0].args.p_recipient_id, h.rows.p1_parts_alert_recipients[0].id);
  assert.equal(h.rpcCalls.some(call => /profile|recipient.*valid/.test(call.name)), false);
});

test("parts baseline partial recipients keep independent results but ambiguous one remains retryable", async () => {
  const h = legacyPartsSmsRoute();
  h.rows.p1_parts_alert_recipients.push(
    { id: "recipient-2", active: true, phone_e164: "+12025550125", created_at: "2026-01-02" },
    { id: "recipient-3", active: true, phone_e164: "+12025550126", created_at: "2026-01-03" },
  );
  h.providerModes("accepted", "rejected", "accepted_then_lost");
  const response = await h.request();
  assert.equal(response.status, 207);
  assert.deepEqual(h.deliveries.map(row => row.status), ["sent", "failed", "failed"]);
  assert.equal(h.accepted.length, 2);
});

test("parts baseline disabled, missing cutoff, before cutoff and no parts never claim", async () => {
  for (const scenario of ["disabled", "missing_cutoff", "before_cutoff", "empty"] as const) {
    const h = legacyPartsSmsRoute();
    if (scenario === "disabled") h.rows.p1_parts_alert_settings[0].enabled = false;
    if (scenario === "missing_cutoff") h.rows.p1_parts_alert_settings[0].cutoff_time = null;
    if (scenario === "before_cutoff") h.setNow("2026-09-09T20:59:00Z");
    if (scenario === "empty") h.rows.wo_parts = [];
    assert.equal((await h.request()).status, 200);
    assert.equal(h.accepted.length, 0);
    assert.equal(h.deliveries.length, 0);
  }
});

test("parts baseline exact cutoff sends; service force bypasses time but never disabled settings", async () => {
  const at = legacyPartsSmsRoute();
  at.setNow("2026-09-09T21:00:00Z");
  await at.request();
  assert.equal(at.accepted.length, 1);
  const force = legacyPartsSmsRoute();
  force.setNow("2026-09-09T18:00:00Z");
  await force.request({ force: true });
  assert.equal(force.accepted.length, 1);
  const disabled = legacyPartsSmsRoute();
  disabled.rows.p1_parts_alert_settings[0].enabled = false;
  await disabled.request({ force: true });
  assert.equal(disabled.accepted.length, 0);
});

test("parts baseline uses local date, not UTC date, and no historical catch-up", async () => {
  const h = legacyPartsSmsRoute();
  h.setNow("2026-09-10T02:00:00Z");
  await h.request();
  assert.equal(h.deliveries[0].localDate, "2026-09-09");
  h.setNow("2026-09-12T22:00:00Z");
  await h.request();
  assert.deepEqual(h.deliveries.map(row => row.localDate), ["2026-09-09", "2026-09-12"]);
});

test("parts baseline GET and POST enforce exact cron credential before database/provider IO", async () => {
  for (const method of ["GET", "POST"] as const) {
    for (const secret of [null, "synthetic-wrong", "synthetic-cron-token-extra"]) {
      const h = legacyPartsSmsRoute();
      assert.equal((await h.request({ method, secret })).status, 401);
      assert.equal(h.rpcCalls.length, 0);
      assert.equal(h.providerRequests.length, 0);
    }
  }
});

test("parts baseline missing provider config fails before any claim; no recipient returns conflict", async () => {
  const noConfig = legacyPartsSmsRoute();
  delete noConfig.env.TWILIO_AUTH_TOKEN;
  assert.equal((await noConfig.request()).status, 500);
  assert.equal(noConfig.deliveries.length, 0);
  const noRecipient = legacyPartsSmsRoute();
  noRecipient.rows.p1_parts_alert_recipients = [];
  assert.equal((await noRecipient.request()).status, 409);
  assert.equal(noRecipient.deliveries.length, 0);
});
