import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "./errors/AppError";
import { createWorkOrderDetailReadHarness, rawPage, record, respond, type ReadPlan } from "./activity-visit-read-test-support/harness";
import { ACTIVITY_PARENT, activityFixture, expectedActivity } from "./activity-visit-read-test-support/activity-fixtures";
import { administrativeVisitRow, visitExpected, visitStaff } from "./activity-visit-read-test-support/visitFixtures";
import { photoFixture } from "./photo-metadata-read-test-support/fixtures";

const parent = { id: ACTIVITY_PARENT, storeTimezone: "America/New_York", staffNotesSeenAt: "2026-09-04T12:00:00Z" };
const header = () => ({ id: ACTIVITY_PARENT, status: "assigned", priority: "p3",
  created_at: "2026-09-01T12:00:00Z", latest_note_at: "2026-09-06T12:00:00Z",
  latest_contractor_activity_at: "2026-09-06T11:00:00Z", pending_7eleven_sync_count: 3,
  pending_contractor_attention_count: 2 });
const activity = () => activityFixture({ activity_channel: "field_note", requires_7eleven_sync: true,
  requires_contractor_attention: true });
const mappedActivity = () => expectedActivity({ activityChannel: "field_note", requiresSevenElevenSync: true,
  requiresContractorAttention: true });
const visit = () => administrativeVisitRow({ work_order_id: ACTIVITY_PARENT });
const mappedVisit = () => visitExpected({ workOrderId: ACTIVITY_PARENT, closedBy: visitStaff,
  closureKind: "administrative_transfer", durationReviewRequired: true,
  administrativeClosedAt: "2026-09-10T10:00:00.000Z", administrativeClosedBy: visitStaff });
const plans = (): ReadPlan[] => [
  respond(rawPage([activity()], "opaque-activity-continuation")),
  respond(rawPage([photoFixture({ work_order_id: ACTIVITY_PARENT,
    storage_path: "wo/SYNTHETIC-ACTIVITY-PARENT-003-2/synthetic.jpg" })], "opaque-photo-continuation")),
  respond(rawPage([visit()], "opaque-visit-continuation")),
  respond(header()),
];

test("composite detail executes four original bounded owners with exact arguments and one shared signal", async () => {
  const controller = new AbortController();
  const harness = createWorkOrderDetailReadHarness(plans());
  const result = await harness.loadDetails(parent, controller.signal);
  assert.deepEqual(harness.calls, [
    { name: "list_work_order_activities_rows_v1", args: { p_work_order_id: ACTIVITY_PARENT, p_limit: 30, p_cursor: null }, signal: controller.signal },
    { name: "list_work_order_photos_rows_v1", args: { p_work_order_id: ACTIVITY_PARENT, p_limit: 24, p_cursor: null }, signal: controller.signal },
    { name: "list_work_order_visits_rows_v1", args: { p_work_order_id: ACTIVITY_PARENT, p_limit: 30, p_cursor: null }, signal: controller.signal },
    { name: "get_portal_work_order", args: { p_work_order_id: ACTIVITY_PARENT }, signal: controller.signal },
  ]);
  const expected = {
    activities: [mappedActivity()], photos: ["wo/SYNTHETIC-ACTIVITY-PARENT-003-2/synthetic.jpg"], visits: [mappedVisit()],
    latestNoteAt: "2026-09-06T12:00:00Z", latestContractorActivityAt: "2026-09-06T11:00:00Z", hasUnreadNotes: true,
    pendingSevenElevenActivities: [mappedActivity()], pendingSevenElevenSyncCount: 3, hasPendingSevenElevenSync: true,
    pendingContractorActivities: [mappedActivity()], pendingContractorAttentionCount: 2, hasPendingContractorAttention: true,
    activityPage: { nextCursor: "opaque-activity-continuation", hasMore: true, totalCount: null },
    photoPage: { nextCursor: "opaque-photo-continuation", hasMore: true, totalCount: null },
    visitPage: { nextCursor: "opaque-visit-continuation", hasMore: true, totalCount: null },
    assignmentHistory: [], detailsLoaded: true,
  };
  assert.deepEqual(result, expected);
  assert.equal(JSON.stringify(result), JSON.stringify(expected));
  assert.equal(harness.remainingPlans(), 0);
});

test("composite detail retains empty child and missing-header behavior without an all-page fallback", async () => {
  const harness = createWorkOrderDetailReadHarness([respond(rawPage([])), respond(rawPage([])), respond(rawPage([])), respond(null)]);
  const result = await harness.loadDetails(parent);
  assert.deepEqual(result, {
    activities: [], photos: [], visits: [], latestNoteAt: null, latestContractorActivityAt: null, hasUnreadNotes: false,
    pendingSevenElevenActivities: [], pendingSevenElevenSyncCount: 0, hasPendingSevenElevenSync: false,
    pendingContractorActivities: [], pendingContractorAttentionCount: 0, hasPendingContractorAttention: false,
    activityPage: { nextCursor: null, hasMore: false, totalCount: null },
    photoPage: { nextCursor: null, hasMore: false, totalCount: null },
    visitPage: { nextCursor: null, hasMore: false, totalCount: null }, assignmentHistory: [], detailsLoaded: true,
  });
  assert.equal(harness.calls.length, 4);
});

test("composite detail retains the first activity fallback and missing-header 7-Eleven classification", async () => {
  const entries = plans();
  entries[3] = respond(null);
  const harness = createWorkOrderDetailReadHarness(entries);
  const result = record(await harness.loadDetails(parent));
  assert.equal(result.latestNoteAt, "2026-09-05T12:00:00Z");
  assert.equal(result.latestContractorActivityAt, "2026-09-05T12:00:00Z");
  assert.equal(result.hasUnreadNotes, true);
  assert.deepEqual(result.pendingSevenElevenActivities, []);
  assert.equal(result.pendingSevenElevenSyncCount, 0);
  assert.equal(result.hasPendingSevenElevenSync, false);
  assert.deepEqual(result.pendingContractorActivities, [mappedActivity()]);
  assert.equal(result.pendingContractorAttentionCount, 1);
  assert.equal(result.hasPendingContractorAttention, true);
  assert.equal(harness.calls.length, 4);
});

for (const workOrder of [null, undefined, { id: "" }]) {
  test(`composite detail missing parent ${JSON.stringify(workOrder)} keeps its original error and zero dispatch`, async () => {
    const harness = createWorkOrderDetailReadHarness([]);
    await assert.rejects(harness.loadDetails(workOrder), { message: "A work order ID is required" });
    assert.equal(harness.calls.length, 0);
  });
}

test("composite detail cancellation before dispatch prevents all four requests", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Synthetic detail cancellation", "AbortError");
  controller.abort(reason);
  const harness = createWorkOrderDetailReadHarness([]);
  await assert.rejects(harness.loadDetails(parent, controller.signal), cause => cause === reason);
  assert.equal(harness.calls.length, 0);
});

for (const index of [0, 2]) {
  test(`composite detail ${index === 0 ? "activity" : "visit"} read failure remains safely rejected without another request`, async () => {
    const entries = plans();
    entries[index] = () => ({ data: null, error: { code: "42501", message: "Synthetic private provider detail" } });
    const harness = createWorkOrderDetailReadHarness(entries);
    await assert.rejects(harness.loadDetails(parent), cause => {
      assert.ok(cause instanceof AppError);
      assert.equal(cause.code, "FORBIDDEN");
      assert.doesNotMatch(cause.message, /Synthetic|provider|detail/);
      return true;
    });
    assert.equal(harness.calls.length, 4);
    assert.equal(harness.remainingPlans(), 0);
  });
}
