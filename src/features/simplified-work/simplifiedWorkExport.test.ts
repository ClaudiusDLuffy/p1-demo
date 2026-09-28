import assert from "node:assert/strict";
import test from "node:test";
import type { WorkOrderReadModel } from "../work-orders/data/workOrderReadContracts";
import { simplifiedWorkOrdersCsv } from "./simplifiedWorkExport";

test("export includes list columns and capital stage without inventing invoice rows", () => {
  const csv = simplifiedWorkOrdersCsv([{
    id: "SYNTHETIC-CAPITAL", store: "TEST", city: "Example City", priority: "p2",
    status: "pending_capital_completion", functionalStatus: "Pending Capital Completion",
    isCapital: true, capitalStatus: null,
  } as WorkOrderReadModel]);
  assert.match(csv, /Capital status/);
  assert.match(csv, /SYNTHETIC-CAPITAL/);
  assert.equal(csv.split("\r\n").length, 2);
  assert.doesNotMatch(csv, /Invoice number|Amount due/);
});

test("export protects user-controlled spreadsheet cells", () => {
  const csv = simplifiedWorkOrdersCsv([{
    id: "SYNTHETIC", status: "assigned", priority: "p3", city: "=1+1",
    technicianOnJob: 'Example, "Technician"',
  } as WorkOrderReadModel]);
  assert.match(csv, /'=1\+1/);
  assert.match(csv, /"Example, ""Technician"""/);
});
