import assert from "node:assert/strict";
import test from "node:test";
import { mapWorkOrderListRow } from "../features/work-orders/data/workOrderMappers";
import { parseWorkOrderReadPage, parseWorkOrderReadRow } from "../features/work-orders/data/workOrderReadValidators";
import type { WorkOrderReadModel, WorkOrderReadRow } from "../features/work-orders/data/workOrderReadContracts";

const nowMs = Date.parse("2026-09-12T08:00:00.000Z");
const actor = "00000000-0000-4000-8000-000000000001";
const anotherActor = "00000000-0000-4000-8000-000000000002";
const base = (): WorkOrderReadRow => ({ id: "FWKD-SYNTHETIC-42", status: "assigned", priority: "p3" });
const mapped = (input: unknown) => mapWorkOrderListRow(parseWorkOrderReadRow(input), nowMs);

test("work-order minimal mapper retains every existing default and omitted-field byte contract", () => {
  const expected: WorkOrderReadModel = {
    id: "FWKD-SYNTHETIC-42", incidentId: undefined, store: undefined, city: undefined, addr: undefined,
    storeState: null, storeTimezone: null, storeCounty: null, storePostalCode: null,
    lineOfService: undefined, businessService: undefined, category: undefined, subCategory: undefined,
    summary: undefined, description: undefined, priority: "p3", status: "assigned", functionalStatus: undefined,
    contractor: undefined, afm: undefined, afmEmail: undefined, nte: 0, nteFlagThreshold: 900,
    nteFlagged: false, nteFlagAmount: null, invoiceTotal: undefined, eta: undefined, dispatchedAt: undefined,
    startTime: null, startTimeRaw: null, endTime: null, endTimeRaw: null,
    assetMake: undefined, assetModel: undefined, assetSerial: undefined, assetYear: null,
    repairQuote: null, installQuote: null, capitalNotes: null, isCapital: undefined, capitalStatus: undefined,
    resolutionCode: null, resolutionNotes: null, partNeeded: undefined, partEta: undefined, source: undefined,
    billingOnly: false, billingReadyAt: null, billingReadyBy: null, contractorAssignmentStartedAt: null,
    contractorAssignmentVersion: 0, assignmentTransferPendingVisit: false, duplicatedFromWorkOrderId: null,
    duplicateRootWorkOrderId: null, duplicateSequence: null, externalWorkOrderId: "FWKD-SYNTHETIC-42",
    workflowCycle: 0, lifecycleVersion: null, contractorInvoicingCompletedAt: null, contractorInvoicingCompletedBy: null,
    contractorInvoicingAssignmentVersion: null, contractorInvoicingWorkflowCycle: null,
    contractorInvoicingCompletionSource: null, staffNotesSeenAt: null, technicianOnJob: undefined,
    assignedTechnicianProfileId: null, technicianAssignedAt: null, technicianAssignedBy: null,
    createdAt: undefined, updatedAt: undefined, closedAt: undefined, slaStartedAt: undefined,
    responseBreachAt: undefined, resolutionBreachAt: undefined, age: "—", incidentReuse: null,
    assignmentHistory: [], activities: [], latestNoteAt: null, latestContractorActivityAt: null,
    hasUnreadNotes: false, pendingSevenElevenActivities: [], pendingSevenElevenSyncCount: 0,
    hasPendingSevenElevenSync: false, pendingContractorActivities: [], pendingContractorAttentionCount: 0,
    hasPendingContractorAttention: false, historyInvoiceTotal: 0, historyInvoiceCount: 0,
    billingInvoiceId: null, partsTotal: 0, partsReceived: 0, staffTodo: null, staffReadThroughAt: null,
    visits: [], photos: [], detailsLoaded: false,
  };
  const actual = mapped(base());
  assert.deepEqual(actual, expected);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
});

test("work-order mapper preserves explicit nulls separately from omitted direct fields", () => {
  const result = mapped({ ...base(), created_at: null, updated_at: null, summary: null, city: null,
    is_capital: null, functional_status: null, capital_status: null, contractor_id: null, eta: null });
  assert.equal(result.createdAt, null); assert.equal(result.summary, null); assert.equal(result.city, null);
  assert.equal(result.isCapital, null); assert.equal(result.functionalStatus, null); assert.equal(result.age, "—");
  assert.ok(JSON.stringify(result).includes('"createdAt":null'));
});

test("work-order null monetary facts and zero versions keep the existing distinct defaults", () => {
  const result = mapped({ ...base(), nte: null, nte_flag_threshold: null, nte_flag_amount: null,
    invoice_total: null, repair_quote: null, install_quote: null, asset_year: 0,
    contractor_assignment_version: 0, workflow_cycle: 0, lifecycle_version: 0,
    contractor_invoicing_assignment_version: 0, contractor_invoicing_workflow_cycle: 0 });
  assert.equal(result.nte, 0); assert.equal(result.nteFlagThreshold, 900); assert.equal(result.nteFlagAmount, null);
  assert.equal(result.invoiceTotal, undefined); assert.equal(result.repairQuote, null); assert.equal(result.installQuote, null);
  assert.equal(result.assetYear, null); assert.equal(result.contractorAssignmentVersion, 0); assert.equal(result.workflowCycle, 0);
  assert.equal(result.lifecycleVersion, 0); assert.equal(result.contractorInvoicingAssignmentVersion, 0);
  assert.equal(result.contractorInvoicingWorkflowCycle, 0);
});

for (const [value, invoice, quote] of [[0, undefined, null], ["0", 0, 0], ["0.00", 0, 0], ["-1.25", -1.25, -1.25], [12.5, 12.5, 12.5]] as const) {
  test(`work-order monetary representation ${JSON.stringify(value)} retains existing truthiness semantics`, () => {
    const result = mapped({ ...base(), nte: value, nte_flag_threshold: value, nte_flag_amount: value,
      invoice_total: value, repair_quote: value, install_quote: value });
    assert.equal(result.invoiceTotal, invoice); assert.equal(result.repairQuote, quote); assert.equal(result.installQuote, quote);
    assert.equal(result.nte, Number(value)); assert.equal(result.nteFlagThreshold, Number(value)); assert.equal(result.nteFlagAmount, Number(value));
  });
}

test("work-order mapper keeps relational/root/display identities and all assignment versions distinct", () => {
  const result = mapped({ ...base(), id: "WOT900001-2", duplicate_root_work_order_id: "WOT900001",
    duplicated_from_work_order_id: "WOT900001-1", duplicate_sequence: 2, summary: "Store 42 HVAC Repair",
    contractor_id: actor, contractor_assignment_version: 7, workflow_cycle: 3, lifecycle_version: 11,
    assigned_technician_profile_id: anotherActor, assignment_transfer_pending_visit: true,
    contractor_invoicing_assignment_version: 7, contractor_invoicing_workflow_cycle: 3,
    contractor_invoicing_completion_source: "legacy" });
  assert.equal(result.id, "WOT900001-2"); assert.equal(result.externalWorkOrderId, "WOT900001");
  assert.equal(result.summary, "Store 42 HVAC Repair"); assert.equal(result.contractor, actor);
  assert.equal(result.contractorAssignmentVersion, 7); assert.equal(result.workflowCycle, 3); assert.equal(result.lifecycleVersion, 11);
  assert.equal(result.assignedTechnicianProfileId, anotherActor); assert.equal(result.assignmentTransferPendingVisit, true);
  assert.equal(result.contractorInvoicingAssignmentVersion, 7); assert.equal(result.contractorInvoicingWorkflowCycle, 3);
});

test("work-order mapper preserves stored deadlines, raw timestamps and location display without changing timezone policy", () => {
  const result = mapped({ ...base(), store_state: "NY", store_timezone: "America/New_York",
    start_time: "2026-09-12T01:00:00.000Z", end_time: "2026-09-12T03:15:00.000Z",
    sla_started_at: "2026-09-11T16:00:00.000Z", response_breach_at: "2026-09-12T01:00:00.000Z",
    resolution_breach_at: "2026-09-13T07:00:00.000Z", eta: "2026-09-12T17:00:00Z", part_eta: "2026-09-15" });
  assert.equal(result.startTime, "Sep 11, 9:00 PM"); assert.equal(result.endTime, "Sep 11, 11:15 PM");
  assert.equal(result.startTimeRaw, "2026-09-12T01:00:00.000Z"); assert.equal(result.endTimeRaw, "2026-09-12T03:15:00.000Z");
  assert.equal(result.slaStartedAt, "2026-09-11T16:00:00.000Z"); assert.equal(result.responseBreachAt, "2026-09-12T01:00:00.000Z");
  assert.equal(result.resolutionBreachAt, "2026-09-13T07:00:00.000Z"); assert.equal(result.eta, "2026-09-12T17:00:00Z");
  assert.equal(result.partEta, "2026-09-15");
});

for (const [minutes, expected] of [[-1, "-1m"], [0, "0m"], [59, "59m"], [60, "1h"], [1440, "1d"], [20160, "2w"]] as const) {
  test(`work-order age uses the injected clock at ${minutes} minutes without new rounding`, () => {
    const timestamp = new Date(nowMs - minutes * 60000).toISOString();
    assert.equal(mapped({ ...base(), created_at: timestamp }).age, expected);
    assert.equal(mapped({ ...base(), created_at: "2020-01-01", dispatched_at: timestamp }).age, expected);
  });
}

test("work-order embedded snapshots preserve original JSON order, do not mutate inputs and map deterministically", () => {
  const incident = { crossesState: true, relatedWorkOrderIds: ["WOT900002", "WOT900003"], incidentId: "INC-42" };
  const snapshot = { z: [null, { later: "value", earlier: 0 }], a: { second: true, first: false } };
  const input = { ...base(), incident_reuse: incident, assignment_history: [{ id: actor, contractor_id: anotherActor,
    assignment_version: 5, assignment_ended_at: "2026-09-11T00:00:00Z", workflow_snapshot: snapshot }],
    staff_todo: { id: actor, work_order_id: "FWKD-SYNTHETIC-42", owner_id: actor, created_by: anotherActor,
      note: "Synthetic follow-up", created_at: "2026-09-10T00:00:00Z", updated_at: "2026-09-11T00:00:00Z" } };
  const original = JSON.stringify(input);
  Object.freeze(input); Object.freeze(incident); Object.freeze(snapshot);
  const first = mapped(input), second = mapped(input);
  assert.equal(JSON.stringify(first), JSON.stringify(second)); assert.equal(JSON.stringify(input), original);
  assert.equal(JSON.stringify(first.incidentReuse), '{"crossesState":true,"relatedWorkOrderIds":["WOT900002","WOT900003"],"incidentId":"INC-42"}');
  assert.equal(JSON.stringify(first.assignmentHistory[0].workflowSnapshot), '{"z":[null,{"later":"value","earlier":0}],"a":{"second":true,"first":false}}');
  assert.deepEqual(first.staffTodo, { id: actor, workOrderId: "FWKD-SYNTHETIC-42", ownerId: actor,
    createdBy: anotherActor, note: "Synthetic follow-up", createdAt: "2026-09-10T00:00:00Z", updatedAt: "2026-09-11T00:00:00Z" });
});

for (const [snapshot, expected] of [[false, {}], [null, {}], [0, {}], ["", {}], ["legacy", "legacy"], [true, true], [[1, "two"], [1, "two"]]] as const) {
  test(`work-order JSONB snapshot ${JSON.stringify(snapshot)} preserves the legacy truthy fallback`, () => {
    const result = mapped({ ...base(), assignment_history: [{ id: actor, contractor_id: anotherActor,
      assignment_version: 0, assignment_ended_at: "2026-09-11T00:00:00Z", workflow_snapshot: snapshot }] });
    assert.deepEqual(result.assignmentHistory[0].workflowSnapshot, expected);
  });
}

for (const status of ["closed", "capital", "pending_capital_completion", "completed"] as const) {
  test(`work-order ${status} mapper preserves stored queue flags and capital state`, () => {
    const result = mapped({ ...base(), status, functional_status: "Completed", is_capital: true,
      capital_status: "Equipment ordered", pending_7eleven_sync_count: 2, pending_contractor_attention_count: 1 });
    assert.equal(result.pendingSevenElevenSyncCount, 2); assert.equal(result.hasPendingSevenElevenSync, true);
    assert.equal(result.pendingContractorAttentionCount, 1); assert.equal(result.hasPendingContractorAttention, true);
    assert.equal(result.isCapital, true); assert.equal(result.capitalStatus, "Equipment ordered");
  });
}

test("work-order notification timestamps retain current unread comparisons", () => {
  const source = { ...base(), latest_note_at: "2026-09-12T00:00:00Z" };
  assert.equal(mapped(source).hasUnreadNotes, true);
  assert.equal(mapped({ ...source, staff_notes_seen_at: "2026-09-12T00:00:00Z" }).hasUnreadNotes, false);
  assert.equal(mapped({ ...source, staff_notes_seen_at: "2026-09-11T23:59:59Z" }).hasUnreadNotes, true);
});

const malformedRows: [string, unknown][] = [
  ["null", null], ["array", []], ["missing id", { status: "assigned", priority: "p3" }],
  ["empty id", { ...base(), id: "" }], ["unknown status", { ...base(), status: "invented" }],
  ["unknown priority", { ...base(), priority: "p9" }], ["unknown functional state", { ...base(), functional_status: "invented" }],
  ["unknown capital state", { ...base(), capital_status: "invented" }], ["string boolean", { ...base(), billing_only: "false" }],
  ["malformed money", { ...base(), nte: "12x" }], ["infinite money", { ...base(), nte: Infinity }],
  ["NaN money", { ...base(), invoice_total: NaN }], ["fractional version", { ...base(), lifecycle_version: 1.5 }],
  ["negative lifecycle version", { ...base(), lifecycle_version: -1 }], ["unsafe version", { ...base(), lifecycle_version: Number.MAX_SAFE_INTEGER + 1 }],
  ["string version", { ...base(), contractor_assignment_version: "1" }], ["bad date", { ...base(), created_at: "not-a-date" }],
  ["bad owner", { ...base(), contractor_id: "not-a-uuid" }], ["fractional count", { ...base(), parts_total: 1.2 }],
  ["malformed ETA", { ...base(), eta: "Awaiting supplier" }], ["malformed part date", { ...base(), part_eta: "2026-02-30" }],
  ["negative count", { ...base(), pending_7eleven_sync_count: -1 }],
  ["bad incident envelope", { ...base(), incident_reuse: { incidentId: "INC", relatedWorkOrderIds: "wrong", crossesState: true } }],
  ["bad todo", { ...base(), staff_todo: { id: actor } }],
  ["foreign todo", { ...base(), staff_todo: { id: actor, work_order_id: "FOREIGN-SYNTHETIC", owner_id: actor,
    created_by: actor, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" } }],
];
for (const [name, value] of malformedRows) {
  test(`work-order row validator rejects ${name} with a safe typed error`, () => {
    assert.throws(() => parseWorkOrderReadRow(value), error => error instanceof Error && error.name === "AppError"
      && "code" in error && error.code === "INTERNAL_ERROR" && !error.message.includes("not-a-uuid"));
  });
}

test("work-order row validator strips unused fixed RPC fields without changing mapped public output", () => {
  const parsed = parseWorkOrderReadRow({ ...base(), unrelated_provider_field: "synthetic-private", created_by: actor });
  assert.ok(!("unrelated_provider_field" in parsed)); assert.ok(!("created_by" in parsed));
  assert.equal(JSON.stringify(mapWorkOrderListRow(parsed, nowMs)), JSON.stringify(mapped(base())));
});

test("work-order page validator preserves opaque cursor and count-independent envelope", () => {
  const raw = { items: [base()], nextCursor: "opaque-exact-filter-bound-cursor", hasMore: true };
  const page = parseWorkOrderReadPage(JSON.stringify(raw));
  assert.equal(page.nextCursor, raw.nextCursor); assert.equal(page.hasMore, true); assert.equal(page.totalCount, null);
  assert.equal(page.aggregates, undefined); assert.deepEqual(page.items, [base()]);
});

test("work-order page validator accepts the established 100-row maximum without truncation", () => {
  const items = Array.from({ length: 100 }, (_, index) => ({ ...base(), id: `SYNTHETIC-${index}` }));
  const page = parseWorkOrderReadPage({ items, nextCursor: null, hasMore: false });
  assert.equal(page.items.length, 100); assert.deepEqual(page.items.map(row => row.id), items.map(row => row.id));
});

for (const [name, value] of [
  ["null", null], ["invalid JSON", "{"], ["missing items", { hasMore: false, nextCursor: null }],
  ["string flag", { items: [], hasMore: "false", nextCursor: null }],
  ["non-string cursor", { items: [], hasMore: false, nextCursor: 5 }],
  ["continuation without cursor", { items: [base()], hasMore: true, nextCursor: null }],
  ["terminal page with cursor", { items: [base()], hasMore: false, nextCursor: "opaque-cursor" }],
  ["empty cursor text", { items: [base()], hasMore: true, nextCursor: "" }],
  ["duplicate identities", { items: [base(), base()], hasMore: false, nextCursor: null }],
  ["malformed row", { items: [base(), null], hasMore: false, nextCursor: null }],
  ["invalid total", { items: [], hasMore: false, nextCursor: null, totalCount: -1 }],
  ["over-cap page", { items: Array.from({ length: 101 }, (_, index) => ({ ...base(), id: `SYNTHETIC-${index}` })), hasMore: false, nextCursor: null }],
] as const) {
  test(`work-order page validator rejects ${name} without returning partial rows`, () => {
    assert.throws(() => parseWorkOrderReadPage(value), error => error instanceof Error && error.name === "AppError");
  });
}
