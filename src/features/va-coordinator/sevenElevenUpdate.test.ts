import assert from "node:assert/strict";
import test from "node:test";
import { createVaCoordinatorUpdateRepository } from "./data/vaCoordinatorUpdateRepository";
import { VA_COORDINATOR_UPDATE_MAX_LENGTH } from "./contracts";
import { prepareVaCoordinatorSevenElevenUpdate } from "./sevenElevenUpdate";

const expectedUpdate = {
  id: "11111111-1111-4111-8111-111111111111",
  workOrderId: "SYNTHETIC-WO-1",
  text: "Synthetic VA update",
  createdAt: "2026-10-30T10:00:00+00:00",
  authorName: "Synthetic VA Coordinator",
  enteredByRole: "va_coordinator",
  syncedToSevenElevenAt: null,
  syncedById: null,
  syncedByName: null,
  requiresSevenElevenSync: true,
};

test("VA update business validation trims, bounds, and binds the work order", () => {
  assert.deepEqual(prepareVaCoordinatorSevenElevenUpdate("SYNTHETIC-WO-1", "  Synthetic VA update  "), {
    p_work_order_id: "SYNTHETIC-WO-1",
    p_text: "Synthetic VA update",
  });
  assert.throws(() => prepareVaCoordinatorSevenElevenUpdate("", "note"), /Reopen the work order/);
  assert.throws(() => prepareVaCoordinatorSevenElevenUpdate("SYNTHETIC-WO-1", "  "), /Enter an update/);
  assert.throws(() => prepareVaCoordinatorSevenElevenUpdate("SYNTHETIC-WO-1", "x".repeat(VA_COORDINATOR_UPDATE_MAX_LENGTH + 1)), /4,000/);
});

test("update repository calls only the queue RPC and verifies the attributed pending response", async () => {
  const calls: unknown[][] = [];
  const repository = createVaCoordinatorUpdateRepository({
    rpc: async (...args) => {
      calls.push(args);
      return { data: expectedUpdate, error: null };
    },
  });
  const result = await repository.post("SYNTHETIC-WO-1", " Synthetic VA update ");
  assert.equal(result.enteredByRole, "va_coordinator");
  assert.equal(result.requiresSevenElevenSync, true);
  assert.equal(result.syncedToSevenElevenAt, null);
  assert.deepEqual(calls, [["post_va_coordinator_seven_eleven_update_v1", {
    p_work_order_id: "SYNTHETIC-WO-1",
    p_text: "Synthetic VA update",
  }]]);
});

test("update repository rejects mismatched or externally-synced results", async () => {
  const validRpc = createVaCoordinatorUpdateRepository({
    rpc: async () => ({ data: { ...expectedUpdate, workOrderId: "OTHER-WO" }, error: null }),
  });
  await assert.rejects(validRpc.post("SYNTHETIC-WO-1", "Synthetic VA update"), /could not be verified/);
  const sentRpc = createVaCoordinatorUpdateRepository({
    rpc: async () => ({ data: { ...expectedUpdate, syncedToSevenElevenAt: expectedUpdate.createdAt }, error: null }),
  });
  await assert.rejects(sentRpc.post("SYNTHETIC-WO-1", "Synthetic VA update"), /could not be verified/);
});
