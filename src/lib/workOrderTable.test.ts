import assert from "node:assert/strict";
import test from "node:test";
import {
  filterAndSortWorkOrderTable,
  hasWorkOrderColumnFilters,
  nextWorkOrderTableSort,
} from "./workOrderTable";

const rows = [
  { id: "WOT2", status: "parts", priority: "p3", incidentId: "INC2", store: "20", summary: "Ice maker", contractor: "c2", createdAt: "2026-08-25T10:00:00Z" },
  { id: "WOT10", status: "assigned", priority: "p1", incidentId: "INC1", store: "10", summary: "Vault door", contractor: "c1", createdAt: "2026-08-26T10:00:00Z" },
];

test("column headers toggle direction and new date columns start newest-first", () => {
  assert.deepEqual(
    nextWorkOrderTableSort({ column: "priority", direction: "asc" }, "priority"),
    { column: "priority", direction: "desc" },
  );
  assert.deepEqual(
    nextWorkOrderTableSort({ column: "priority", direction: "asc" }, "created"),
    { column: "created", direction: "desc" },
  );
});

test("fallback table filtering and sorting matches the server contract", () => {
  assert.deepEqual(
    filterAndSortWorkOrderTable(
      rows,
      { contractor: "north", status: "assigned" },
      { column: "created", direction: "desc" },
      id => id === "c1" ? "North Service" : "South Service",
    ).map(row => row.id),
    ["WOT10"],
  );
  assert.deepEqual(
    filterAndSortWorkOrderTable(rows, {}, { column: "priority", direction: "asc" })
      .map(row => row.id),
    ["WOT10", "WOT2"],
  );
});

test("column-filter reset detection ignores all-valued selects", () => {
  assert.equal(hasWorkOrderColumnFilters({ status: "all", priority: "all" }), false);
  assert.equal(hasWorkOrderColumnFilters({ store: "32777" }), true);
});
