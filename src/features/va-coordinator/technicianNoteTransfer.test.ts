import assert from "node:assert/strict";
import test from "node:test";
import { createTechnicianNoteTransferAttempt, canTransferTechnicianNote } from "./technicianNoteTransfer";
import type { VaCoordinatorNote } from "./contracts";

const note: VaCoordinatorNote = {
  id: "11111111-1111-4111-8111-111111111111", workOrderId: "SYNTHETIC-WO-1",
  text: "Synthetic technician update", createdAt: "2026-10-23T10:00:00Z",
  authorName: "Synthetic Technician", syncedToSevenElevenAt: null, syncedById: null, syncedByName: null,
  requiresSevenElevenSync: true,
};

test("transfer command requires a transferable note and explicit operator confirmation", () => {
  assert.equal(canTransferTechnicianNote(note), true);
  assert.throws(() => createTechnicianNoteTransferAttempt(note, false), /Confirm/);
  assert.throws(() => createTechnicianNoteTransferAttempt({ ...note, syncedToSevenElevenAt: note.createdAt }, true), /eligible/);
  assert.throws(() => createTechnicianNoteTransferAttempt({ ...note, requiresSevenElevenSync: false }, true), /eligible/);
});

test("transfer command delegates actor attribution to the authenticated existing sync RPC", async () => {
  let call: unknown[] | undefined;
  const command = createTechnicianNoteTransferAttempt(note, true);
  await command(async (...args) => { call = args; return { data: null, error: null }; });
  assert.deepEqual(call, ["mark_work_order_activity_synced_v1", { p_activity_id: note.id, p_synced: true }]);
});

test("transfer command maps authorization failures to safe scope guidance", async () => {
  const command = createTechnicianNoteTransferAttempt(note, true);
  await assert.rejects(command(async () => ({ data: null, error: { code: "42501", message: "synthetic-private-detail" } })),
    error => error instanceof Error && error.message === "This work order is no longer available for VA review.");
});
