import type { ActivityReadModel, ActivityReadRow } from "./activityReadContracts";

/** Mapping only: the existing RPC/RLS owner, not this mapper, decides visibility. */
export function mapActivityPageRow(row: ActivityReadRow, timeZone?: string): ActivityReadModel {
  return {
    id: row.id,
    authorId: row.author_id,
    author: row.author_name,
    createdAt: row.created_at,
    // PostgreSQL permits a null legacy timestamp; retain Date(null)'s epoch display.
    time: new Date(row.created_at === null ? 0 : row.created_at).toLocaleString("en-US", {
      ...(timeZone ? { timeZone } : {}), month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }),
    text: row.text,
    type: row.type,
    activityChannel: row.activity_channel || (row.requires_7eleven_sync ? "field_note" : row.is_staff_only
      ? "internal_note" : row.type === "system" ? "system_event" : "legacy"),
    enteredByRole: row.entered_by_role || "system",
    isStaffOverride: !!row.is_staff_override,
    isStaffOnly: !!row.is_staff_only,
    overrideForContractorId: row.override_for_contractor_id || null,
    eventKey: row.event_key || (row.type === "system" ? "system" : "note"),
    eventData: row.event_data || {},
    requiresSevenElevenSync: !!row.requires_7eleven_sync,
    syncedToSevenElevenAt: row.synced_to_7eleven_at || null,
    syncedToSevenElevenBy: row.synced_to_7eleven_by || null,
    requiresContractorAttention: !!row.requires_contractor_attention,
    contractorAcknowledgedAt: row.contractor_attention_acknowledged_at || null,
    contractorAcknowledgedBy: row.contractor_attention_acknowledged_by || null,
    workflowCycle: Number(row.workflow_cycle || 0),
  };
}

