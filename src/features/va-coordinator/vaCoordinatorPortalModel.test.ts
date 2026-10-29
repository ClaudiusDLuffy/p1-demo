import assert from "node:assert/strict";
import test from "node:test";
import { mapVaCoordinatorDetailsToPortalModel, mapVaCoordinatorWorkOrderToPortalModel } from "./vaCoordinatorPortalModel";
import type { VaCoordinatorAttachment, VaCoordinatorNote, VaCoordinatorWorkOrderDetail } from "./contracts";

const workOrder: VaCoordinatorWorkOrderDetail = {
  id: "SYNTHETIC-WO-1",
  storeNumber: "1001",
  city: "Synthetic City",
  state: "TX",
  summary: "Synthetic freezer issue",
  functionalStatus: "Work in Progress",
  status: "wip",
  priority: "p2",
  assetMake: "Synthetic Make",
  assetModel: "Synthetic Model",
  assetSerial: "SYN-123",
  updatedAt: "2026-10-27T10:00:00Z",
  technicianName: "Synthetic Technician",
  address: "100 Synthetic Street",
  description: "Synthetic equipment description",
  assetYear: 2024,
};

test("shared list adapter retains only the allowlisted VA work-order details", () => {
  const result = mapVaCoordinatorWorkOrderToPortalModel(workOrder);
  assert.equal(result.id, workOrder.id);
  assert.equal(result.assetMake, workOrder.assetMake);
  assert.equal(result.assetModel, workOrder.assetModel);
  assert.equal(result.assetSerial, workOrder.assetSerial);
  assert.equal(result.technicianOnJob, workOrder.technicianName);
  assert.equal(result.contractor, null, "the shared detail view receives no contractor identity");
  assert.deepEqual(result.assignmentHistory, [], "the detail view receives no assignment history");
  for (const forbidden of ["contractorId", "invoice", "billing", "nte", "internalNotes"]) {
    assert.equal(forbidden in result, false, `${forbidden} must not enter the shared VA view model`);
  }
});

test("shared detail adapter exposes only technician notes and private-photo paths", () => {
  const notes: VaCoordinatorNote[] = [{
    id: "11111111-1111-4111-8111-111111111111",
    workOrderId: workOrder.id,
    text: "Synthetic field update",
    createdAt: "2026-10-27T10:00:00Z",
    authorName: "Synthetic Technician",
    enteredByRole: "contractor",
    syncedToSevenElevenAt: null,
    syncedById: null,
    syncedByName: null,
    requiresSevenElevenSync: true,
  }];
  const attachments: VaCoordinatorAttachment[] = [{
    id: "22222222-2222-4222-8222-222222222222",
    workOrderId: workOrder.id,
    storagePath: `wo/${workOrder.id}/synthetic.png`,
    caption: "Synthetic equipment photo",
    createdAt: "2026-10-27T10:00:00Z",
    uploaderName: "Synthetic Technician",
  }];

  const result = mapVaCoordinatorDetailsToPortalModel(notes, attachments);
  assert.deepEqual(result.photos, [attachments[0].storagePath]);
  assert.equal(result.activities.length, 1);
  assert.equal(result.activities[0].text, notes[0].text);
  assert.equal(result.activities[0].requiresSevenElevenSync, true);
  assert.equal(result.activities[0].enteredByRole, "contractor");
  assert.equal(result.activities[0].syncedToSevenElevenByName, null);
  assert.deepEqual(result.visits, []);
  assert.deepEqual(result.assignmentHistory, []);
  assert.equal(result.pendingSevenElevenSyncCount, 1);
});

test("VA-authored queued updates preserve individual role attribution in the portal view", () => {
  const note: VaCoordinatorNote = {
    id: "33333333-3333-4333-8333-333333333333",
    workOrderId: workOrder.id,
    text: "Synthetic VA update",
    createdAt: "2026-10-27T10:00:00Z",
    authorName: "Synthetic VA Coordinator",
    enteredByRole: "va_coordinator",
    syncedToSevenElevenAt: null,
    syncedById: null,
    syncedByName: null,
    requiresSevenElevenSync: true,
  };
  const result = mapVaCoordinatorDetailsToPortalModel([note], []);
  assert.equal(result.activities[0].author, "Synthetic VA Coordinator");
  assert.equal(result.activities[0].enteredByRole, "va_coordinator");
});
