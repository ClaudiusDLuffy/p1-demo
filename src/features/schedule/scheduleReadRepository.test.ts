import assert from "node:assert/strict";
import test from "node:test";
import { createScheduleReadRepository, ScheduleCapacityError } from "./scheduleReadRepository";
import { readScheduleRows, SCHEDULE_COLUMNS, type ScheduleReadRequest } from "./scheduleReadTransport";
import { scheduleSearchExpression, scheduleUtcEnvelope, visibleScheduleRange, validateScheduleRead, type ScheduleRead } from "./scheduleQueryModel";

const filters: ScheduleRead = { kind: "calendar", range: { from: "2026-09-01", to: "2026-10-01" },
  search: "", status: "all", priority: "all", contractorId: null, technicianId: null, technicianName: null };
const row = (id: string, eta = "2026-09-10T15:00:00Z", zone = "America/Chicago") => ({
  id, eta, status: "assigned", functional_status: "Dispatched", priority: "p3", store_timezone: zone,
});

test("calendar range covers adjacent month cells, week/year boundaries and day", () => {
  assert.deepEqual(visibleScheduleRange("2026-09-15", "month"), { from: "2026-08-31", to: "2026-10-12" });
  assert.deepEqual(visibleScheduleRange("2027-01-01", "week"), { from: "2026-12-28", to: "2027-01-04" });
  assert.deepEqual(visibleScheduleRange("2028-02-29", "day"), { from: "2028-02-29", to: "2028-03-01" });
});
test("query validates date windows, identities and bounded search", () => {
  for (const input of [{ range: undefined }, { range: { from: "2026-10-01", to: "2026-09-01" } },
    { range: { from: "2026-01-01", to: "2026-12-31" } }, { search: "x".repeat(201) }, { contractorId: "bad" }]) {
    assert.throws(() => validateScheduleRead({ ...filters, ...input }));
  }
});
test("ETA envelope covers extreme offsets and search cannot change OR structure", () => {
  assert.deepEqual(scheduleUtcEnvelope({ from: "2026-09-01", to: "2026-09-02" }), {
    from: "2026-08-31T00:00:00Z", to: "2026-09-03T00:00:00Z",
  });
  assert.equal(scheduleSearchExpression('A,B"_%*'), 'id.ilike."%A,B\\"\\_\\%\\*%",store_number.ilike."%A,B\\"\\_\\%\\*%",city.ilike."%A,B\\"\\_\\%\\*%"');
});
test("calendar automatically fetches older jobs beyond first 100 without truncating", async () => {
  const calls: ScheduleReadRequest[] = [];
  const repository = createScheduleReadRepository(async request => {
    calls.push(request);
    return calls.length === 1 ? { rows: Array.from({ length: 100 }, (_, i) => row(`WO-${String(i).padStart(3, "0")}`)), count: 101 }
      : { rows: [row("WO-100")], count: 1 };
  });
  assert.equal((await repository.calendar(filters)).length, 101);
  assert.equal(calls[1].afterId, "WO-099");
  assert.deepEqual(calls[0].filters.range, filters.range);
});
test("membership uses local store dates, not UTC or browser dates", async () => {
  const repository = createScheduleReadRepository(async () => ({ count: 4, rows: [
    row("west", "2026-09-02T05:00:00Z", "America/Los_Angeles"),
    row("east", "2026-08-31T11:00:00Z", "Pacific/Kiritimati"),
    row("before", "2026-09-01T03:00:00Z", "America/Chicago"),
    row("after", "2026-09-02T15:00:00Z", "America/Chicago"),
  ] }));
  assert.deepEqual((await repository.calendar({ ...filters, range: { from: "2026-09-01", to: "2026-09-02" } })).map(event => event.id), ["east", "west"]);
});
test("failed continuation never returns a partial calendar", async () => {
  let calls = 0;
  const repository = createScheduleReadRepository(async () => {
    if (calls++) throw new Error("read failed");
    return { count: 101, rows: Array.from({ length: 100 }, (_, i) => row(`WO-${String(i).padStart(3, "0")}`)) };
  });
  await assert.rejects(repository.calendar(filters), /read failed/);
});
test("over-capacity range asks to narrow filters, never silently truncates", async () => {
  const repository = createScheduleReadRepository(async () => ({ count: 2001, rows: [row("WO")] }));
  await assert.rejects(repository.calendar(filters), ScheduleCapacityError);
});
test("cancelled query cannot publish rows or count", async () => {
  const controller = new AbortController();
  const repository = createScheduleReadRepository(async () => { controller.abort(); return { count: 1, rows: [row("WO")] }; });
  await assert.rejects(repository.calendar(filters, controller.signal), { name: "AbortError" });
});
test("unscheduled is server-paged and uses exact total, not loaded length", async () => {
  const calls: ScheduleReadRequest[] = [];
  const repository = createScheduleReadRepository(async request => { calls.push(request); return { count: 67, rows: [row("WO")] }; });
  const page = await repository.unscheduled({ ...filters, kind: "unscheduled", range: undefined }, 2);
  assert.equal(page.total, 67);
  assert.equal(calls[0].offset, 6);
  assert.equal(calls[0].limit, 3);
  assert.equal(await repository.count({ ...filters, kind: "progress" }), 67);
  assert.equal(calls[1].countOnly, true);
});
test("malformed and duplicate rows or unavailable counts fail closed", async () => {
  for (const result of [{ count: null, rows: [] }, { count: 2, rows: [row("WO"), row("WO")] }, { count: 1, rows: [{ id: "WO" }] }]) {
    await assert.rejects(createScheduleReadRepository(async () => result).calendar(filters));
  }
});

function transportHarness() {
  const calls: [string, unknown[]][] = [];
  const builder: object = new Proxy({}, { get(_target, method) {
    if (method === "then") return Promise.resolve({ data: [], count: 0, error: null }).then.bind(Promise.resolve({ data: [], count: 0, error: null }));
    return (...args: unknown[]) => { calls.push([String(method), args]); return builder; };
  } });
  return { calls, client: (() => builder) as Parameters<typeof readScheduleRows>[2] };
}
test("transport queries narrow operational columns with ETA bounds, role scope and cancellation", async () => {
  const { calls, client } = transportHarness();
  const signal = new AbortController().signal;
  const contractorId = "10000000-0000-4000-8000-000000000001";
  await readScheduleRows({ filters: { ...filters, contractorId, priority: "p1" }, limit: 100 }, signal, client);
  assert.ok(calls.some(([name, args]) => name === "from" && args[0] === "work_orders"));
  assert.ok(calls.some(([name, args]) => name === "eq" && args[0] === "contractor_id" && args[1] === contractorId));
  assert.ok(calls.some(([name, args]) => name === "gte" && args[0] === "eta"));
  assert.ok(calls.some(([name, args]) => name === "lt" && args[0] === "eta"));
  assert.ok(calls.some(([name, args]) => name === "abortSignal" && args[0] === signal));
  assert.doesNotMatch(SCHEDULE_COLUMNS, /nte|invoice|email|notes|history|\*/);
});
test("unscheduled query mirrors ETA action eligibility without date filters", async () => {
  const { calls, client } = transportHarness();
  await readScheduleRows({ filters: { ...filters, kind: "unscheduled" }, countOnly: true }, undefined, client);
  assert.ok(calls.some(([name, args]) => name === "is" && args[0] === "eta" && args[1] === null));
  assert.ok(calls.some(([name, args]) => name === "eq" && args[0] === "status" && args[1] === "assigned"));
  assert.ok(calls.some(([name, args]) => name === "in" && args[0] === "functional_status"));
  assert.equal(calls.some(([name]) => name === "gte" || name === "lt"), false);
});
