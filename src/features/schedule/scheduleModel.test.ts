import assert from "node:assert/strict";
import test from "node:test";
import type { WorkOrderReadModel } from "../work-orders/data/workOrderReadContracts";
import {
  addMonths,
  addDays,
  monthDateKeys,
  pendingScheduleWork,
  scheduleItemsFor,
  weekDateKeys,
} from "./scheduleModel";

const workOrder = (overrides: Partial<WorkOrderReadModel>): WorkOrderReadModel => ({
  id: "WOT-SYNTHETIC",
  externalWorkOrderId: "WOT-SYNTHETIC",
  status: "assigned",
  priority: "p3",
  functionalStatus: "Dispatched",
  contractor: "00000000-0000-4000-8000-000000000001",
  contractorAssignmentVersion: 1,
  workflowCycle: 0,
  lifecycleVersion: 0,
  storeTimezone: "America/Chicago",
  eta: null,
  detailsLoaded: false,
  ...overrides,
} as WorkOrderReadModel);

test("calendar date navigation preserves bounded month and week grids", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(monthDateKeys("2026-09-15").length, 42);
  assert.deepEqual(weekDateKeys("2026-09-23"), [
    "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24",
    "2026-09-25", "2026-09-26", "2026-09-27",
  ]);
});

test("schedule items render an ETA in the work order store timezone", () => {
  const items = scheduleItemsFor([workOrder({ eta: "2026-09-23T14:30:00.000Z" })]);
  assert.equal(items.length, 1);
  assert.equal(items[0].date, "2026-09-23");
  assert.equal(items[0].time, "09:30");
  assert.equal(items[0].timeZone, "America/Chicago");
});

test("pending schedule only includes assigned dispatch work without an ETA", () => {
  const pending = pendingScheduleWork([
    workOrder({ id: "WOT-PENDING" }),
    workOrder({ id: "WOT-SCHEDULED", eta: "2026-09-23T14:30:00.000Z" }),
    workOrder({ id: "WOT-ACTIVE", status: "wip", functionalStatus: "Work in Progress" }),
  ]);
  assert.deepEqual(pending.map(item => item.id), ["WOT-PENDING"]);
});

test("simultaneous ETAs remain distinct and invalid timestamps are excluded", () => {
  const items = scheduleItemsFor([
    workOrder({ id: "SYNTHETIC-FIRST", eta: "2026-09-23T14:30:00Z" }),
    workOrder({ id: "SYNTHETIC-SECOND", eta: "2026-09-23T14:30:00Z" }),
    workOrder({ id: "SYNTHETIC-INVALID", eta: "invalid" }),
  ]);
  assert.deepEqual(items.map(item => item.id), ["SYNTHETIC-FIRST", "SYNTHETIC-SECOND"]);
  assert.equal(items[0].time, items[1].time);
});

test("leap days and year/week boundaries remain valid calendar dates", () => {
  assert.equal(addMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.deepEqual(weekDateKeys("2027-01-01"), ["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"]);
});

test("midnight and repeated DST hour use store time without dropping simultaneous jobs", () => {
  const midnight = scheduleItemsFor([workOrder({ eta: "2026-09-23T03:00:00Z" })]);
  assert.equal(midnight[0].date, "2026-09-22");
  assert.equal(midnight[0].time, "22:00");
  const repeated = scheduleItemsFor([
    workOrder({ id: "before", eta: "2026-11-01T06:30:00Z" }),
    workOrder({ id: "after", eta: "2026-11-01T07:30:00Z" }),
  ]);
  assert.equal(repeated.length, 2);
  assert.deepEqual(repeated.map(item => item.time), ["01:30", "01:30"]);
});

test("pending excludes unassigned, completed, closed and receiving-transfer work", () => {
  assert.deepEqual(pendingScheduleWork([
    workOrder({ contractor: null }),
    workOrder({ status: "completed", functionalStatus: "Completed" }),
    workOrder({ status: "closed", functionalStatus: "Completed" }),
    workOrder({ assignmentTransferPendingVisit: true, status: "wip", functionalStatus: "Work in Progress" }),
  ]), []);
});
