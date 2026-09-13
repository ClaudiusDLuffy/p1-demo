export const ACTIVITY_PARENT = "SYNTHETIC-ACTIVITY-PARENT-003-2";
export const ACTIVITY_ID = "a7600000-0000-4000-8000-000000000001";
export const ACTIVITY_AUTHOR = "a7600000-0000-4000-8000-000000000002";
export const activityFixture = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ACTIVITY_ID, work_order_id: ACTIVITY_PARENT, author_id: ACTIVITY_AUTHOR, author_name: "Synthetic author",
  created_at: "2026-09-05T12:00:00Z", text: "Synthetic activity only", type: "note",
  activity_channel: "contractor_message", entered_by_role: "contractor", is_staff_override: false, is_staff_only: false,
  override_for_contractor_id: null, event_key: "note", event_data: { second: 2, first: "synthetic" },
  requires_7eleven_sync: false, synced_to_7eleven_at: null, synced_to_7eleven_by: null,
  requires_contractor_attention: false, contractor_attention_acknowledged_at: null,
  contractor_attention_acknowledged_by: null, workflow_cycle: 3, contractor_assignment_version: 7,
  deleted_at: null, ...patch,
});

/** Independently fixed public fixture: never calls the production mapper. */
export const expectedActivity = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ACTIVITY_ID, authorId: ACTIVITY_AUTHOR, author: "Synthetic author", createdAt: "2026-09-05T12:00:00Z",
  time: "Sep 5, 8:00 AM", text: "Synthetic activity only", type: "note", activityChannel: "contractor_message",
  enteredByRole: "contractor", isStaffOverride: false, isStaffOnly: false, overrideForContractorId: null,
  eventKey: "note", eventData: { second: 2, first: "synthetic" }, requiresSevenElevenSync: false,
  syncedToSevenElevenAt: null, syncedToSevenElevenBy: null, requiresContractorAttention: false,
  contractorAcknowledgedAt: null, contractorAcknowledgedBy: null, workflowCycle: 3, ...patch,
});

