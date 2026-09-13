import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  canonicalPartsSmsSignature, composePartsSmsMessage, evaluatePartsSmsWindow,
  isPartsSmsSourceEligible, PARTS_SMS_MESSAGE_MAX_CHARACTERS,
  PARTS_SMS_WORK_ORDER_PREVIEW_LIMIT, partsSmsZonedClock,
} from "./partsSmsPolicy";
import { legacyPartsSmsRoute } from "./parts-sms-test-support/legacyRouteHarness";

const settings = { enabled: true, timezone: "America/New_York", cutoffTime: "17:00" };

test("parts SMS pure policy remains browser-safe with named existing limits", () => {
  const source = readFileSync(new URL("./partsSmsPolicy.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^import\s/m);
  assert.doesNotMatch(source, /process\.env|TWILIO_|supabase|fetch\(/);
  assert.equal(PARTS_SMS_MESSAGE_MAX_CHARACTERS, 1500);
  assert.equal(PARTS_SMS_WORK_ORDER_PREVIEW_LIMIT, 8);
});

test("parts SMS message preserves singular wording, work-order reference and optional link", () => {
  assert.equal(composePartsSmsMessage({ partCount: 1, workOrderCount: 1, previewWorkOrderIds: ["WOT-SYNTHETIC-1"], portalUrl: "" }),
    "P1 parts alert: 1 part request across 1 work order.\nWOT-SYNTHETIC-1");
});

test("parts SMS message pluralizes counts, caps preview to eight and preserves overflow", () => {
  const body = composePartsSmsMessage({ partCount: 12, workOrderCount: 10,
    previewWorkOrderIds: Array.from({ length: 10 }, (_, index) => `WOT-SYNTHETIC-${index + 1}`), portalUrl: "https://portal.example.invalid/?view=dashboard" });
  assert.match(body, /^P1 parts alert: 12 part requests across 10 work orders\./);
  assert.match(body, /WOT-SYNTHETIC-8 \+2 more/);
  assert.doesNotMatch(body, /WOT-SYNTHETIC-9/);
  assert.match(body, /\nhttps:\/\/portal\.example\.invalid\/\?view=dashboard$/);
});

test("parts SMS message exact 1500-character truncation matches legacy behavior", () => {
  const body = composePartsSmsMessage({ partCount: 1, workOrderCount: 1,
    previewWorkOrderIds: ["WOT-SYNTHETIC-1"], portalUrl: `https://example.invalid/${"x".repeat(2000)}` });
  assert.equal(body.length, 1500);
  assert.equal(body.slice(-10), "xxxxxxxxxx");
});

test("parts SMS composer has byte-for-byte legacy route parity for representative cardinalities", async () => {
  for (const count of [1, 2, 8, 9, 25]) {
    const h = legacyPartsSmsRoute();
    const first = h.rows.wo_parts[0];
    const ids = Array.from({ length: count }, (_, index) => `WOT-SYNTHETIC-${index + 1}`);
    h.rows.wo_parts = ids.map((workOrderId, index) => ({ ...first, id: `synthetic-part-${index}`, work_order_id: workOrderId }));
    await h.request();
    assert.equal(h.accepted[0].body, composePartsSmsMessage({ partCount: count, workOrderCount: count,
      previewWorkOrderIds: ids, portalUrl: "https://portal.example.invalid/?view=dashboard" }));
  }
});

for (const [date, status] of [
  ["2026-09-09T20:59:59Z", "before_cutoff"],
  ["2026-09-09T21:00:00Z", "eligible"],
  ["2026-09-09T21:00:59Z", "eligible"],
  ["2026-09-09T23:59:59Z", "eligible"],
] as const) {
  test(`parts SMS cutoff ${date} is ${status}`, () => {
    assert.equal(evaluatePartsSmsWindow(new Date(date), settings).status, status);
  });
}

test("parts SMS disabled and missing cutoff preserve no-send behavior", () => {
  const date = new Date("2026-09-09T23:00:00Z");
  assert.equal(evaluatePartsSmsWindow(date, { ...settings, enabled: false }).status, "disabled");
  assert.equal(evaluatePartsSmsWindow(date, { ...settings, cutoffTime: null }).status, "disabled");
});

test("parts SMS uses configured local date when UTC date differs", () => {
  assert.deepEqual(partsSmsZonedClock(new Date("2026-09-10T02:00:00Z"), "America/New_York"), { date: "2026-09-09", time: "22:00" });
  assert.deepEqual(partsSmsZonedClock(new Date("2026-09-09T18:00:00Z"), "Asia/Manila"), { date: "2026-09-10", time: "02:00" });
});

test("parts SMS midnight starts a new local date without inheriting the prior cutoff", () => {
  assert.deepEqual(evaluatePartsSmsWindow(new Date("2026-09-10T04:00:00Z"), settings), { date: "2026-09-10", time: "00:00", status: "before_cutoff" });
});

test("parts SMS spring-forward missing cutoff becomes eligible at the next actual local minute", () => {
  const spring = { ...settings, cutoffTime: "02:30" };
  assert.deepEqual(evaluatePartsSmsWindow(new Date("2026-03-08T06:59:00Z"), spring), { date: "2026-03-08", time: "01:59", status: "before_cutoff" });
  assert.deepEqual(evaluatePartsSmsWindow(new Date("2026-03-08T07:00:00Z"), spring), { date: "2026-03-08", time: "03:00", status: "eligible" });
});

test("parts SMS fall-back repeated local hour has the same local event date/minute", () => {
  const first = evaluatePartsSmsWindow(new Date("2026-11-01T05:30:00Z"), { ...settings, cutoffTime: "01:30" });
  const repeated = evaluatePartsSmsWindow(new Date("2026-11-01T06:30:00Z"), { ...settings, cutoffTime: "01:30" });
  assert.deepEqual(first, repeated);
  assert.equal(first.status, "eligible");
});

test("parts SMS original daily ledger suppresses a second send in the DST repeated hour", async () => {
  const h = legacyPartsSmsRoute();
  h.rows.p1_parts_alert_settings[0].cutoff_time = "01:30:00";
  h.setNow("2026-11-01T05:30:00Z");
  await h.request();
  h.setNow("2026-11-01T06:30:00Z");
  await h.request();
  assert.equal(h.accepted.length, 1);
  assert.equal(h.deliveries[0].localDate, "2026-11-01");
});

test("parts SMS delayed same-day run remains eligible with no prior-day catch-up", () => {
  assert.deepEqual(evaluatePartsSmsWindow(new Date("2026-09-13T03:59:00Z"), settings), { date: "2026-09-12", time: "23:59", status: "eligible" });
});

test("parts SMS timezone and cutoff edits apply to current evaluation without historical rewriting", () => {
  const now = new Date("2026-09-10T01:00:00Z");
  assert.equal(evaluatePartsSmsWindow(now, settings).date, "2026-09-09");
  assert.equal(evaluatePartsSmsWindow(now, { ...settings, timezone: "Asia/Manila" }).date, "2026-09-10");
  assert.equal(evaluatePartsSmsWindow(now, { ...settings, cutoffTime: "22:00" }).status, "before_cutoff");
});

test("parts SMS invalid timezone throws rather than quietly evaluating another timezone", () => {
  assert.throws(() => partsSmsZonedClock(new Date("2026-09-09T00:00:00Z"), "Invalid/Synthetic"), RangeError);
});

test("parts SMS canonical signature is ordering-independent and does not mutate source", () => {
  const parts = [
    { id: "part-b", updated_at: "2026-09-09T15:00:00+00:00" },
    { id: "part-a", updated_at: "2026-09-09T16:00:00+00:00" },
  ];
  const original = JSON.stringify(parts);
  const canonical = canonicalPartsSmsSignature(parts);
  assert.equal(canonical, canonicalPartsSmsSignature([...parts].reverse()));
  assert.equal(JSON.stringify(parts), original);
  assert.equal(canonical, "part-a:2026-09-09T16:00:00+00:00|part-b:2026-09-09T15:00:00+00:00");
  assert.match(createHash("sha256").update(canonical).digest("hex"), /^[0-9a-f]{64}$/);
});

test("parts SMS signature uses updated timestamp, requested fallback, then empty legacy fallback", () => {
  assert.equal(canonicalPartsSmsSignature([
    { id: "a", updated_at: "updated", p1_requested_at: "requested" },
    { id: "b", updated_at: null, p1_requested_at: "requested" },
    { id: "c", updated_at: "", p1_requested_at: null },
  ]), "a:updated|b:requested|c:");
});

test("parts SMS source addition/removal/timestamp mutation change signature but input order does not", () => {
  const a = { id: "part-a", updated_at: "2026-09-09T15:00:00+00:00" };
  const b = { id: "part-b", updated_at: a.updated_at };
  const initial = canonicalPartsSmsSignature([a]);
  assert.notEqual(initial, canonicalPartsSmsSignature([a, b]));
  assert.notEqual(initial, canonicalPartsSmsSignature([{ ...a, updated_at: "2026-09-09T16:00:00+00:00" }]));
  assert.notEqual(initial, canonicalPartsSmsSignature([]));
  assert.equal(canonicalPartsSmsSignature([a, b]), canonicalPartsSmsSignature([b, a]));
});

test("parts SMS signature does not add volatile or unrelated fields absent from original policy", () => {
  const original = { id: "part-a", updated_at: "2026-09-09T15:00:00+00:00", description: "Synthetic original", qty: 1 };
  const unrelated = { ...original, fetchedAt: "2026-09-10", technicianDisplayName: "Synthetic changed display" };
  assert.equal(canonicalPartsSmsSignature([original]), canonicalPartsSmsSignature([unrelated]));
  const quantityChangedAuthoritatively = { ...original, qty: 2, updated_at: "2026-09-09T16:00:00+00:00" };
  assert.notEqual(canonicalPartsSmsSignature([original]), canonicalPartsSmsSignature([quantityChangedAuthoritatively]));
});

test("parts SMS source policy preserves requested P1 eligibility and exact work-order exclusions", () => {
  const part = { ordering_responsibility: "p1", p1_order_status: "requested", work_orders: { status: "awaiting_parts", deleted_at: null } };
  assert.equal(isPartsSmsSourceEligible(part), true);
  for (const status of ["closed", "capital", "pending_capital_completion"]) assert.equal(isPartsSmsSourceEligible({ ...part, work_orders: { ...part.work_orders, status } }), false);
  for (const p1_order_status of ["ordered", "received", "cancelled", null]) assert.equal(isPartsSmsSourceEligible({ ...part, p1_order_status }), false);
  assert.equal(isPartsSmsSourceEligible({ ...part, ordering_responsibility: "contractor" }), false);
  assert.equal(isPartsSmsSourceEligible({ ...part, work_orders: { ...part.work_orders, deleted_at: "2026-09-09" } }), false);
});
