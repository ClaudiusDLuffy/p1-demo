/** Public parent/location argument retained by the db.ts activity-page facade. */
export type ActivityReadWorkOrder = {
  id: string;
  storeTimezone?: string | null;
  storeState?: string | null;
  city?: string | null;
  addr?: string | null;
  staffNotesSeenAt?: string | null;
} | null | undefined;

export type ActivityChannel = "field_note" | "internal_note" | "contractor_message" | "system_event" | "legacy";
export type ActivityEnteredByRole = "manager" | "dispatcher" | "back_office" | "contractor" | "system";
export type ActivityReadJson = string | number | boolean | null | ActivityReadJson[] | { [key: string]: ActivityReadJson };

/** Validated, minimal raw facts. Parent/assignment fields stay private. */
export type ActivityReadRow = {
  id: string;
  work_order_id: string;
  author_id: string | null;
  author_name: string;
  created_at: string | null;
  text: string;
  type: string | null;
  activity_channel: ActivityChannel;
  entered_by_role: ActivityEnteredByRole;
  is_staff_override: boolean;
  is_staff_only: boolean;
  override_for_contractor_id: string | null;
  event_key: string;
  event_data: ActivityReadJson;
  requires_7eleven_sync: boolean;
  synced_to_7eleven_at: string | null;
  synced_to_7eleven_by: string | null;
  requires_contractor_attention: boolean;
  contractor_attention_acknowledged_at: string | null;
  contractor_attention_acknowledged_by: string | null;
  workflow_cycle: number;
  contractor_assignment_version: number;
  deleted_at: null;
};

/** Exact existing 21-field activity DTO; no raw parent/cycle privacy facts added. */
export type ActivityReadModel = {
  id: string;
  authorId: string | null;
  author: string;
  createdAt: string | null;
  time: string;
  text: string;
  type: string | null;
  activityChannel: ActivityChannel;
  enteredByRole: ActivityEnteredByRole;
  isStaffOverride: boolean;
  isStaffOnly: boolean;
  overrideForContractorId: string | null;
  eventKey: string;
  eventData: ActivityReadJson;
  requiresSevenElevenSync: boolean;
  syncedToSevenElevenAt: string | null;
  syncedToSevenElevenBy: string | null;
  requiresContractorAttention: boolean;
  contractorAcknowledgedAt: string | null;
  contractorAcknowledgedBy: string | null;
  workflowCycle: number;
};

export type ActivityReadDependencies = {
  read: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
};

