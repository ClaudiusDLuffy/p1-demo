import assert from "node:assert/strict";
import test from "node:test";
import { createWorkOrderReadRepository } from "../features/work-orders/data/workOrderReadRepository";
import { createWorkOrderReadHarness, rawPage, record, respond } from "./work-order-read-test-support/harness";

const id = "FWKD-SYNTHETIC-READ-17";
const row = () => ({ id, status: "assigned", priority: "p3", created_at: "2026-09-12T00:00:00.000Z",
  store_timezone: "America/New_York" });
const defaults = {
  p_scope: "active", p_search: null, p_contractor_id: null, p_priority: null, p_status: null,
  p_state: null, p_resolution: null, p_from: null, p_to: null, p_needs_action: false,
  p_sort: "newest", p_pending_first: false, p_limit: 25, p_cursor: null,
  p_store_number: null, p_contractor_ids: null,
};

test("work-order public page defaults use one row-only RPC and preserve empty envelope bytes", async () => {
  const harness = createWorkOrderReadHarness([respond(rawPage([]))]);
  const result = await harness.loadPage();
  assert.deepEqual(harness.calls.map(call => ({ name: call.name, args: call.args })), [
    { name: "list_work_orders_rows_v1", args: defaults },
  ]);
  assert.deepEqual(result, { items: [], nextCursor: null, hasMore: false, totalCount: null, aggregates: undefined });
  assert.equal(JSON.stringify(result), '{"items":[],"nextCursor":null,"hasMore":false,"totalCount":null}');
});

test("work-order public page forwards every shared filter without changing order or count lifecycle", async () => {
  const harness = createWorkOrderReadHarness([respond(rawPage([], "opaque-original-cursor"))]);
  const company = "00000000-0000-4000-8000-000000000001";
  const companies = [company, "00000000-0000-4000-8000-000000000002"];
  const signal = new AbortController().signal;
  await harness.loadPage({ scope: "history", search: "  synthetic needle  ", contractorId: company,
    contractorIds: companies, priority: "p2", status: "closed", state: "FL", resolution: "Repaired",
    from: "2026-09-01", to: "2026-09-12", needsAction: true, sort: "oldest", pendingFirst: true,
    limit: 17, cursor: "opaque-original-cursor", storeNumber: "0042" }, signal);
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].signal, signal);
  assert.deepEqual(harness.calls[0].args, { p_scope: "history", p_search: "synthetic needle",
    p_contractor_id: company, p_priority: "p2", p_status: "closed", p_state: "FL", p_resolution: "Repaired",
    p_from: "2026-09-01", p_to: "2026-09-12", p_needs_action: true, p_sort: "oldest",
    p_pending_first: true, p_limit: 17, p_cursor: "opaque-original-cursor", p_store_number: "0042",
    p_contractor_ids: companies });
});

test("work-order all and empty filters preserve null/default argument semantics", async () => {
  const harness = createWorkOrderReadHarness([respond(rawPage([]))]);
  await harness.loadPage({ search: "   ", contractorId: "", contractorIds: [], priority: "all",
    status: "all", state: "all", resolution: "all", from: "", to: "", cursor: "", storeNumber: "" });
  assert.deepEqual(harness.calls[0].args, defaults);
});

for (const [limit, expected] of [[undefined, 25], [0, 1], [-9, 1], [1, 1], [100, 100], [101, 100],
  [27.9, 27], [Infinity, 25], [NaN, 25]] as const) {
  test(`work-order public page preserves limit ${String(limit)} -> ${expected}`, async () => {
    const harness = createWorkOrderReadHarness([respond(rawPage([]))]);
    await harness.loadPage({ limit });
    assert.deepEqual(harness.calls[0].args, { ...defaults, p_limit: expected });
  });
}

for (const scope of ["dashboard_p1_parts_to_order"]) {
  test(`work-order implicit table scope ${scope} keeps the v2 read contract`, async () => {
    const harness = createWorkOrderReadHarness([respond(rawPage([]))]);
    await harness.loadPage({ scope });
    assert.equal(harness.calls[0].name, "list_work_orders_table_rows_v2");
    assert.deepEqual(harness.calls[0].args, { ...defaults, p_scope: scope, p_sort_column: "created",
      p_sort_direction: "desc", p_work_order_filter: null, p_incident_filter: null, p_store_filter: null,
      p_summary_filter: null, p_contractor_filter: null, p_created_date_filter: null,
      p_updated_date_filter: null, p_sla_filter: null });
  });
}

for (const scope of ["dashboard_seven_eleven_updates", "dashboard_pending_submission",
  "ready_to_bill", "staff_work", "staff_work_ready"]) {
  test(`work-order ${scope} preset uses the equivalent generic cursor read`, async () => {
    const harness = createWorkOrderReadHarness([respond(rawPage([]))]);
    await harness.loadPage({ scope });
    assert.equal(harness.calls[0].name, "list_work_orders_rows_v1");
    assert.deepEqual(harness.calls[0].args, { ...defaults, p_scope: scope });
  });
}

for (const [sort, tableSortColumn, tableSortDirection] of [
  ["newest", "created", "desc"],
  ["oldest", "created", "asc"],
  ["priority", "priority", "asc"],
  ["sla_due", "sla", "asc"],
] as const) {
  test(`work-order ${sort} preset uses the generic cursor read`, async () => {
    const harness = createWorkOrderReadHarness([respond(rawPage([]))]);
    await harness.loadPage({ sort, tableSortColumn, tableSortDirection });
    assert.equal(harness.calls[0].name, "list_work_orders_rows_v1");
    assert.deepEqual(harness.calls[0].args, { ...defaults, p_sort: sort });
  });
}

test("work-order custom table ordering and table-only filtering retain table v2", async () => {
  const custom = createWorkOrderReadHarness([respond(rawPage([]))]);
  await custom.loadPage({ sort: "sla_due", tableSortColumn: "created", tableSortDirection: "desc" });
  assert.equal(custom.calls[0].name, "list_work_orders_table_rows_v2");

  const filtered = createWorkOrderReadHarness([respond(rawPage([]))]);
  await filtered.loadPage({ sort: "sla_due", tableSortColumn: "sla", tableSortDirection: "asc",
    summaryFilter: "compressor" });
  assert.equal(filtered.calls[0].name, "list_work_orders_table_rows_v2");
});

for (const column of ["work_order", "status", "priority", "incident", "store", "summary", "contractor",
  "technician", "created", "updated", "closed", "sla"]) {
  test(`work-order public table forwards ${column} and every column filter`, async () => {
    const harness = createWorkOrderReadHarness([respond(rawPage([]))]);
    await harness.loadPage({ tableSortColumn: column, tableSortDirection: "asc", workOrderFilter: "  WO  ",
      incidentFilter: "  INC  ", storeFilter: "  42  ", summaryFilter: "  synthetic repair  ",
      contractorFilter: "  fixture company  ", createdDateFilter: "2026-09-01",
      updatedDateFilter: "2026-09-12", slaFilter: "overdue" });
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0].name, "list_work_orders_table_rows_v2");
    assert.deepEqual(harness.calls[0].args, { ...defaults, p_sort_column: column, p_sort_direction: "asc",
      p_work_order_filter: "WO", p_incident_filter: "INC", p_store_filter: "42",
      p_summary_filter: "synthetic repair", p_contractor_filter: "fixture company",
      p_created_date_filter: "2026-09-01", p_updated_date_filter: "2026-09-12", p_sla_filter: "overdue" });
  });
}

test("work-order exact/header is one unchanged TEXT identity RPC with no broad fallback", async () => {
  const harness = createWorkOrderReadHarness([respond(row())]);
  const signal = new AbortController().signal;
  const result = record(await harness.loadExact(id, signal));
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.calls[0], { name: "get_portal_work_order", args: { p_work_order_id: id }, signal });
  assert.equal(result.id, id);
  assert.equal(result.externalWorkOrderId, id);
  assert.equal(result.detailsLoaded, false);
  assert.deepEqual(result.activities, []);
  assert.deepEqual(result.photos, []);
  assert.deepEqual(result.visits, []);
});

test("work-order empty exact identity returns null before request or cancellation", async () => {
  const harness = createWorkOrderReadHarness([]);
  const controller = new AbortController(); controller.abort();
  assert.equal(await harness.loadExact("", controller.signal), null);
  assert.equal(harness.calls.length, 0);
});

test("work-order inaccessible or missing exact/header stays null without a fallback query", async () => {
  const harness = createWorkOrderReadHarness([respond(null)]);
  assert.equal(await harness.loadExact("inaccessible-synthetic-parent"), null);
  assert.equal(harness.calls.length, 1);
});

test("work-order mapped minimal header keeps the complete established serialized DTO", async () => {
  const harness = createWorkOrderReadHarness([respond(row())]);
  const actual = await harness.loadExact(id);
  // Independent literal; never produced by the production mapper under test.
  const expected = { id, storeState: null, storeTimezone: "America/New_York", storeCounty: null,
    storePostalCode: null, priority: "p3", status: "assigned", nte: 0, nteFlagThreshold: 900,
    nteFlagged: false, nteFlagAmount: null, startTime: null, startTimeRaw: null, endTime: null,
    endTimeRaw: null, assetYear: null, repairQuote: null, installQuote: null, capitalNotes: null,
    resolutionCode: null, resolutionNotes: null, billingOnly: false, billingReadyAt: null,
    billingReadyBy: null, contractorAssignmentStartedAt: null, contractorAssignmentVersion: 0,
    assignmentTransferPendingVisit: false, duplicatedFromWorkOrderId: null, duplicateRootWorkOrderId: null,
    duplicateSequence: null, externalWorkOrderId: id, workflowCycle: 0, lifecycleVersion: null,
    contractorInvoicingCompletedAt: null, contractorInvoicingCompletedBy: null,
    contractorInvoicingAssignmentVersion: null, contractorInvoicingWorkflowCycle: null,
    contractorInvoicingCompletionSource: null, staffNotesSeenAt: null, assignedTechnicianProfileId: null,
    technicianAssignedAt: null, technicianAssignedBy: null, createdAt: "2026-09-12T00:00:00.000Z", age: "8h",
    incidentReuse: null, assignmentHistory: [], activities: [], latestNoteAt: null,
    latestContractorActivityAt: null, hasUnreadNotes: false, pendingSevenElevenActivities: [],
    pendingSevenElevenSyncCount: 0, hasPendingSevenElevenSync: false, pendingContractorActivities: [],
    pendingContractorAttentionCount: 0, hasPendingContractorAttention: false, historyInvoiceTotal: 0,
    historyInvoiceCount: 0, billingInvoiceId: null, partsTotal: 0, partsReceived: 0, staffTodo: null,
    staffReadThroughAt: null, visits: [], photos: [], detailsLoaded: false };
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  const result = record(actual);
  assert.ok(Object.hasOwn(result, "invoiceTotal"));
  assert.equal(result.invoiceTotal, undefined);
  assert.ok(Object.hasOwn(result, "summary"));
  assert.equal(result.summary, undefined);
});

test("work-order valid JSON-string page retains opaque cursor and row ordering", async () => {
  const first = { ...row(), id: "FWKD-Z" }, second = { ...row(), id: "FWKD-A" };
  const harness = createWorkOrderReadHarness([respond(JSON.stringify(rawPage([first, second], "opaque+/=cursor")))]);
  const page = record(await harness.loadPage({ limit: 2 }));
  assert.equal(page.nextCursor, "opaque+/=cursor");
  assert.equal(page.hasMore, true);
  assert.ok(Array.isArray(page.items));
  assert.deepEqual(page.items.map(item => record(item).id), ["FWKD-Z", "FWKD-A"]);
  assert.equal(harness.calls.length, 1);
});

test("work-order embedded incident and assignment snapshot preserve established object order and bytes", async () => {
  const incident = { crossesState: true, incidentId: "INC-SYNTHETIC-42", relatedWorkOrderIds: ["FWKD-RELATED-2", "FWKD-RELATED-1"] };
  const snapshot = { technician_on_job: "Synthetic technician", nested: { z: 7, a: ["second", "first"] }, status: "parts" };
  const raw = { ...row(), incident_reuse: incident, assignment_history: [{
    id: "00000000-0000-4000-8000-000000000011", contractor_id: "00000000-0000-4000-8000-000000000012",
    next_contractor_id: "00000000-0000-4000-8000-000000000013", assignment_version: 2,
    assignment_started_at: "2026-09-01T00:00:00.000Z", assignment_ended_at: "2026-09-11T00:00:00.000Z",
    assignment_ended_by: "00000000-0000-4000-8000-000000000014", workflow_snapshot: snapshot,
  }] };
  const before = JSON.stringify(raw);
  const harness = createWorkOrderReadHarness([respond(raw)]);
  const result = record(await harness.loadExact(id));
  assert.equal(JSON.stringify(result.incidentReuse), '{"crossesState":true,"incidentId":"INC-SYNTHETIC-42","relatedWorkOrderIds":["FWKD-RELATED-2","FWKD-RELATED-1"]}');
  assert.ok(Array.isArray(result.assignmentHistory));
  assert.equal(JSON.stringify(record(result.assignmentHistory[0]).workflowSnapshot),
    '{"technician_on_job":"Synthetic technician","nested":{"z":7,"a":["second","first"]},"status":"parts"}');
  assert.deepEqual(result.assignmentHistory, [{ id: "00000000-0000-4000-8000-000000000011",
    contractorId: "00000000-0000-4000-8000-000000000012", nextContractorId: "00000000-0000-4000-8000-000000000013",
    assignmentVersion: 2, assignmentStartedAt: "2026-09-01T00:00:00.000Z",
    assignmentEndedAt: "2026-09-11T00:00:00.000Z", assignmentEndedBy: "00000000-0000-4000-8000-000000000014",
    workflowSnapshot: snapshot }]);
  assert.equal(JSON.stringify(raw), before);
});

for (const mode of ["page", "exact"] as const) {
  test(`work-order ${mode} forwards the identical request signal and prevents already aborted transport`, async () => {
    const controller = new AbortController(); controller.abort();
    const harness = createWorkOrderReadHarness([]);
    await assert.rejects(mode === "page" ? harness.loadPage({}, controller.signal) : harness.loadExact(id, controller.signal),
      error => error instanceof DOMException && error.name === "AbortError");
    assert.equal(harness.calls.length, 0);
  });
  test(`work-order ${mode} cancellation during supported transport rejects without later work`, async () => {
    const controller = new AbortController();
    const harness = createWorkOrderReadHarness([call => new Promise((_resolve, reject) => {
      assert.equal(call.signal, controller.signal);
      call.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })]);
    const pending = mode === "page" ? harness.loadPage({}, controller.signal) : harness.loadExact(id, controller.signal);
    await new Promise<void>(done => setImmediate(done));
    controller.abort();
    await assert.rejects(pending, error => error instanceof DOMException && error.name === "AbortError");
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.remainingPlans(), 0);
  });
}

for (const [code, expected] of [["42501", "FORBIDDEN"], ["22023", "VALIDATION_FAILED"],
  ["57014", "TIMEOUT"], ["XX000", "INTERNAL_ERROR"]]) {
  test(`work-order read preserves normalized ${code} error and redacts provider text`, async () => {
    const harness = createWorkOrderReadHarness([() => ({ data: null, error: {
      code, message: "SYNTHETIC_PRIVATE_PROVIDER_DETAIL", details: "SYNTHETIC_SQL_DETAIL", hint: "SYNTHETIC_HINT",
    } })]);
    await assert.rejects(harness.loadPage({ cursor: "original-cursor" }), error => {
      const failure = record(error);
      assert.equal(failure.code, expected);
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE|SYNTHETIC_SQL|SYNTHETIC_HINT/);
      return true;
    });
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0].args.p_cursor, "original-cursor");
  });
}

test("work-order direct repository has typed independent ports and maps once per returned row", async () => {
  const signal = new AbortController().signal;
  const calls: { name: string; args: Record<string, unknown>; signal?: AbortSignal }[] = [];
  let clocks = 0;
  const repository = createWorkOrderReadRepository({
    read: async (name, args, requestSignal) => {
      calls.push({ name, args, signal: requestSignal });
      return rawPage([{ ...row(), id: "FWKD-ONE" }, { ...row(), id: "FWKD-TWO" }]);
    },
    now: () => { clocks++; return Date.parse("2026-09-12T08:00:00.000Z"); },
  });
  const result = await repository.loadWorkOrdersPage({ limit: 2 }, signal);
  assert.deepEqual(calls, [{ name: "list_work_orders_rows_v1", args: { ...defaults, p_limit: 2 }, signal }]);
  assert.equal(clocks, 2);
  assert.deepEqual(result.items.map(item => [item.id, item.age]), [["FWKD-ONE", "8h"], ["FWKD-TWO", "8h"]]);
});

for (const [label, raw] of [
  ["false", false], ["number", 0], ["array", []], ["missing id", { ...row(), id: undefined }],
  ["different parent", { ...row(), id: "FWKD-DIFFERENT-PARENT" }], ["unknown status", { ...row(), status: "unknown" }],
  ["unknown functional status", { ...row(), functional_status: "not-an-fsm-status" }],
  ["string count", { ...row(), history_invoice_count: "2" }], ["negative count", { ...row(), parts_total: -1 }],
  ["fractional version", { ...row(), contractor_assignment_version: 1.5 }],
  ["string boolean", { ...row(), assignment_transfer_pending_visit: "false" }],
  ["invalid date", { ...row(), created_at: "not-a-date" }],
  ["invalid UUID", { ...row(), contractor_id: "not-a-uuid" }],
  ["invalid decimal", { ...row(), nte: "12provider" }],
] as const) {
  test(`work-order real exact/header rejects malformed ${label} without fallback`, async () => {
    const harness = createWorkOrderReadHarness([respond(raw)]);
    await assert.rejects(harness.loadExact(id), error => {
      const failure = record(error);
      assert.equal(failure.code, "INTERNAL_ERROR");
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /provider|FWKD-DIFFERENT|not-a-date|not-a-uuid/);
      return true;
    });
    assert.equal(harness.calls.length, 1);
  });
}

test("work-order public page accepts exactly the established 100-row maximum", async () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ ...row(), id: `FWKD-BOUND-${index}` }));
  const harness = createWorkOrderReadHarness([respond(rawPage(rows))]);
  const result = record(await harness.loadPage({ limit: 100 }));
  assert.ok(Array.isArray(result.items));
  assert.equal(result.items.length, 100);
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].args.p_limit, 100);
});

test("work-order public page rejects an impossible 101-row result without collecting or retrying", async () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({ ...row(), id: `FWKD-BOUND-${index}` }));
  const harness = createWorkOrderReadHarness([respond(rawPage(rows))]);
  await assert.rejects(harness.loadPage({ limit: 100 }), error => record(error).code === "INTERNAL_ERROR");
  assert.equal(harness.calls.length, 1);
});

for (const [label, raw] of [
  ["null envelope", null], ["array envelope", []], ["missing rows", { hasMore: false, nextCursor: null }],
  ["nonarray rows", { items: {}, hasMore: false, nextCursor: null }],
  ["invalid JSON", "{"], ["duplicate parent", rawPage([row(), row()])],
  ["one invalid row", rawPage([row(), { ...row(), id: "FWKD-BAD", priority: "urgent" }])],
  ["null row", rawPage([row(), null])], ["string Boolean", { ...rawPage([]), hasMore: "false" }],
  ["missing cursor", { items: [], hasMore: false }], ["numeric cursor", { ...rawPage([]), nextCursor: 12 }],
  ["negative count", { ...rawPage([]), totalCount: -1 }],
] as const) {
  test(`work-order real page rejects malformed ${label} as one whole result`, async () => {
    const harness = createWorkOrderReadHarness([respond(raw)]);
    await assert.rejects(harness.loadPage(), error => record(error).code === "INTERNAL_ERROR");
    assert.equal(harness.calls.length, 1);
  });
}
