import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "./errors/AppError";
import { createActivityVisitReadHarness, rawPage, record, respond } from "./activity-visit-read-test-support/harness";
import { administrativeVisitRow, visitExpected, visitParent, visitRow, visitStaff } from "./activity-visit-read-test-support/visitFixtures";

const expectedPage = (items: unknown[], nextCursor: string | null = null) => ({
  items, nextCursor, hasMore: nextCursor !== null, totalCount: null, aggregates: undefined,
});

test("visit facade first page preserves RPC arguments, exact DTO bytes and one count-independent query", async () => {
  const h = createActivityVisitReadHarness([respond(rawPage([visitRow()]))]);
  const result = await h.loadVisits(visitParent);
  const expected = expectedPage([visitExpected()]);
  assert.deepEqual(result, expected);
  assert.equal(JSON.stringify(result), JSON.stringify(expected));
  assert.deepEqual(h.calls, [{ name: "list_work_order_visits_rows_v1", args: {
    p_work_order_id: visitParent, p_limit: 30, p_cursor: null,
  }, signal: undefined }]);
  assert.equal(h.remainingPlans(), 0);
});

for (const [label, input, expected] of [
  ["minimum", 1, 1], ["default value", 30, 30], ["maximum", 100, 100], ["over maximum", 101, 100],
  ["zero", 0, 1], ["negative", -1, 1], ["fractional", 1.9, 1], ["NaN fallback", Number.NaN, 25],
  ["infinite fallback", Number.POSITIVE_INFINITY, 25],
] as const) {
  test(`visit facade preserves ${label} page limit`, async () => {
    const h = createActivityVisitReadHarness([respond(rawPage([]))]);
    assert.deepEqual(await h.loadVisits(visitParent, null, input), expectedPage([]));
    assert.equal(h.calls[0].args.p_limit, expected);
    assert.equal(h.calls.length, 1);
  });
}

test("visit facade continuation forwards opaque cursor bytes and signal without a count query", async () => {
  const cursor = "eyJjaGVja0luIjoiMjAyNi0wOS0xMFQwODowMDowMFoiLCJpZCI6IjExMTExMTExIn0";
  const nextCursor = "synthetic-next-cursor-with-unchanged_bytes";
  const controller = new AbortController();
  const h = createActivityVisitReadHarness([respond(rawPage([visitRow()], nextCursor))]);
  assert.deepEqual(await h.loadVisits(visitParent, cursor, 17, controller.signal), expectedPage([visitExpected()], nextCursor));
  assert.equal(h.calls[0].signal, controller.signal);
  assert.deepEqual(h.calls[0].args, { p_work_order_id: visitParent, p_limit: 17, p_cursor: cursor });
  assert.equal(h.calls.length, 1);
});

for (const [label, value] of [["empty page", rawPage([])], ["JSON-string page", JSON.stringify(rawPage([]))]] as const) {
  test(`visit facade preserves ${label} metadata and empty behavior`, async () => {
    const h = createActivityVisitReadHarness([respond(value)]);
    assert.deepEqual(await h.loadVisits(visitParent), expectedPage([]));
    assert.equal(h.calls.length, 1);
  });
}

test("visit facade preserves established optional count and aggregate representation", async () => {
  const h = createActivityVisitReadHarness([respond({ ...rawPage([]), totalCount: 0, aggregates: { duration: "2.5", completed: 0 } })]);
  assert.deepEqual(await h.loadVisits(visitParent), { ...expectedPage([]), totalCount: 0, aggregates: { duration: 2.5, completed: 0 } });
  assert.equal(h.calls.length, 1);
});

test("visit facade open row retains null end and closer without inventing a current-visit endpoint", async () => {
  const h = createActivityVisitReadHarness([respond(rawPage([visitRow({ check_out_at: null, checked_out_by: null })]))]);
  assert.deepEqual(await h.loadVisits(visitParent), expectedPage([visitExpected({ checkOutAt: null, closedBy: null })]));
  assert.equal(h.calls[0].name, "list_work_order_visits_rows_v1");
});

test("visit facade administrative closure remains distinct from contractor checkout", async () => {
  const h = createActivityVisitReadHarness([respond(rawPage([administrativeVisitRow()]))]);
  const result = await h.loadVisits(visitParent);
  assert.deepEqual(result, expectedPage([visitExpected({ closedBy: visitStaff, closureKind: "administrative_transfer",
    durationReviewRequired: true, administrativeClosedAt: "2026-09-10T10:00:00.000Z", administrativeClosedBy: visitStaff })]));
  assert.ok(!JSON.stringify(result).includes("Synthetic administrative"));
  assert.ok(!JSON.stringify(result).includes("administrative_transfer_operation_id"));
});

test("visit facade corrected administrative times preserve immutable observation and review classification", async () => {
  const h = createActivityVisitReadHarness([respond(rawPage([administrativeVisitRow({
    check_in_at: "2026-09-10T08:15:00.000Z", check_out_at: "2026-09-10T09:45:00.000Z",
  })]))]);
  assert.deepEqual(await h.loadVisits(visitParent), expectedPage([visitExpected({
    checkInAt: "2026-09-10T08:15:00.000Z", checkOutAt: "2026-09-10T09:45:00.000Z",
    closedBy: visitStaff, closureKind: "administrative_transfer", durationReviewRequired: true,
    administrativeClosedAt: "2026-09-10T10:00:00.000Z", administrativeClosedBy: visitStaff,
  })]));
});

test("visit facade keeps a valid historical duration beyond the correction-command limit", async () => {
  const checkout = "2026-09-14T10:00:00.000Z";
  const h = createActivityVisitReadHarness([respond(rawPage([visitRow({ check_out_at: checkout })]))]);
  assert.deepEqual(await h.loadVisits(visitParent), expectedPage([visitExpected({ checkOutAt: checkout })]));
});

test("visit facade preserves parent TEXT identity rather than normalizing external WOT labels", async () => {
  const parent = "FWKD11400001-2";
  const h = createActivityVisitReadHarness([respond(rawPage([visitRow({ work_order_id: parent })]))]);
  assert.deepEqual(await h.loadVisits(parent), expectedPage([visitExpected({ workOrderId: parent })]));
  assert.equal(h.calls[0].args.p_work_order_id, parent);
});

for (const aborted of [false, true]) {
  test(`visit facade empty parent preserves plain error before ${aborted ? "aborted" : "normal"} transport`, async () => {
    const controller = new AbortController();
    if (aborted) controller.abort();
    const h = createActivityVisitReadHarness([]);
    await assert.rejects(h.loadVisits("", null, 30, controller.signal), cause => {
      assert.ok(cause !== null && typeof cause === "object" && "message" in cause);
      assert.equal(cause.message, "A work order ID is required");
      return true;
    });
    assert.equal(h.calls.length, 0);
  });
}

test("visit facade already-aborted read prevents dispatch and preserves the abort reason", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Synthetic cancelled read", "AbortError");
  controller.abort(reason);
  const h = createActivityVisitReadHarness([]);
  await assert.rejects(h.loadVisits(visitParent, null, 30, controller.signal), cause => cause === reason);
  assert.equal(h.calls.length, 0);
});

test("visit facade in-flight signal reaches the supported transport and cancellation prevents later reads", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Synthetic transport cancellation", "AbortError");
  let ready: () => void = () => undefined;
  const dispatched = new Promise<void>(resolve => { ready = resolve; });
  const h = createActivityVisitReadHarness([call => new Promise((_resolve, reject) => {
    assert.equal(call.signal, controller.signal);
    call.signal?.addEventListener("abort", () => reject(call.signal?.reason), { once: true });
    ready();
  })]);
  const pending = h.loadVisits(visitParent, null, 30, controller.signal);
  await dispatched;
  controller.abort(reason);
  await assert.rejects(pending, cause => cause === reason);
  await assert.rejects(h.loadVisits(visitParent, "next", 30, controller.signal), cause => cause === reason);
  assert.equal(h.calls.length, 1);
});

test("visit facade abort after read response prevents returning a cancelled secondary read", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Synthetic late read abort", "AbortError");
  const h = createActivityVisitReadHarness([() => {
    controller.abort(reason);
    return { data: rawPage([visitRow()]), error: null };
  }]);
  await assert.rejects(h.loadVisits(visitParent, null, 30, controller.signal), cause => cause === reason);
  assert.equal(h.calls.length, 1);
});

for (const [databaseCode, publicCode] of [["42501", "FORBIDDEN"], ["22023", "VALIDATION_FAILED"], ["XX000", "INTERNAL_ERROR"]] as const) {
  test(`visit facade preserves safe ${publicCode} transport error without provider detail`, async () => {
    const h = createActivityVisitReadHarness([() => ({ data: null,
      error: { code: databaseCode, message: "Private synthetic SQL detail", details: "Sensitive synthetic provider detail" } })]);
    await assert.rejects(h.loadVisits(visitParent), cause => {
      assert.ok(cause instanceof AppError);
      assert.equal(cause.code, publicCode);
      assert.doesNotMatch(cause.message, /Private|Sensitive|SQL|provider/);
      return true;
    });
    assert.equal(h.calls.length, 1);
  });
}

test("visit facade repeated mapping preserves input and exact eleven-field key order", async () => {
  const row = Object.freeze(visitRow());
  const input = Object.freeze(rawPage(Object.freeze([row])));
  const before = JSON.stringify(input);
  const h = createActivityVisitReadHarness([respond(input), respond(input)]);
  const first = record(await h.loadVisits(visitParent));
  assert.deepEqual(await h.loadVisits(visitParent), first);
  assert.equal(JSON.stringify(input), before);
  assert.ok(Array.isArray(first.items));
  assert.deepEqual(Object.keys(record(first.items[0])), Object.keys(visitExpected()));
  assert.equal(h.calls.length, 2);
});
