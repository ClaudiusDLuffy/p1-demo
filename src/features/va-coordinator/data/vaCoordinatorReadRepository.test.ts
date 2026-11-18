import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../../lib/errors/AppError";
import { createVaCoordinatorReadRepository } from "./vaCoordinatorReadRepository";

const time = "2026-10-23T10:00:00+00:00";
const parent = {
  id: "SYNTHETIC-WO-1", storeNumber: "SYNTHETIC-STORE", city: "Sample City", state: "TX", summary: "Synthetic freezer",
  functionalStatus: "Work in Progress", status: "wip", priority: "p2", assetMake: "Sample", assetModel: "Model",
  assetSerial: "SERIAL-1", updatedAt: time, technicianName: "Synthetic Technician",
};

test("read repository binds cursor and search inputs to the bounded global VA RPC contracts", async () => {
  const calls: unknown[][] = [];
  const repository = createVaCoordinatorReadRepository({ read: async (...args) => {
    calls.push(args);
    if (args[0] === "list_va_coordinator_work_orders_v1") return { items: [parent], nextCursor: { updatedAt: time, id: parent.id }, hasMore: true };
    if (args[0] === "get_va_coordinator_work_order_v1") return { ...parent, address: null, description: null, assetYear: null };
    return [];
  } });
  const page = await repository.loadWorkOrders("freezer", null, 25);
  assert.deepEqual(page.items[0], parent);
  assert.equal(page.totalCount, null);
  assert.equal(page.hasMore, true);
  assert.deepEqual(JSON.parse(page.nextCursor || "null"), { updatedAt: time, id: parent.id });
  assert.deepEqual(calls[0], ["list_va_coordinator_work_orders_v1", { p_search: "freezer", p_limit: 25, p_cursor: null }, undefined]);
  assert.deepEqual(await repository.loadWorkOrder(parent.id), { ...parent, address: null, description: null, assetYear: null });
  assert.equal(calls[1][0], "get_va_coordinator_work_order_v1");
});

test("read repository rejects malformed server results without surfacing raw fields", async () => {
  const repository = createVaCoordinatorReadRepository({ read: async () => ({ items: [{ ...parent, id: "" }], nextCursor: null, hasMore: false }) });
  await assert.rejects(repository.loadWorkOrders("", null, 25), error => error instanceof AppError && error.code === "INTERNAL_ERROR");
});

test("read repository rejects a detail response for a different work order", async () => {
  const repository = createVaCoordinatorReadRepository({ read: async () => ({ ...parent, id: "OTHER", address: null, description: null, assetYear: null }) });
  await assert.rejects(repository.loadWorkOrder(parent.id), error => error instanceof AppError && error.code === "INTERNAL_ERROR");
});

test("queued notes accept every origin authorized by the 0182 projection without dropping the entire queue", async () => {
  const roles = ["contractor", "manager", "dispatcher", "back_office", "va_coordinator", "system"];
  const notes = roles.map((enteredByRole, index) => ({ id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    workOrderId: parent.id, text: `Synthetic ${enteredByRole} queued note`, createdAt: time, authorName: "Synthetic author",
    enteredByRole, syncedToSevenElevenAt: null, syncedById: null, syncedByName: null, requiresSevenElevenSync: true }));
  const repository = createVaCoordinatorReadRepository({ read: async () => notes });
  assert.deepEqual((await repository.loadTechnicianNotes(parent.id, 100)).map(note => note.enteredByRole), roles);
  const invalid = createVaCoordinatorReadRepository({ read: async () => [{ ...notes[0], enteredByRole: "unknown_role" }] });
  await assert.rejects(invalid.loadTechnicianNotes(parent.id, 100), error => error instanceof AppError && error.code === "INTERNAL_ERROR");
});
