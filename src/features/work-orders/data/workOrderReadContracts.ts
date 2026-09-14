/** The existing read API parameters; db.ts keeps forwarding these unchanged. */
export type WorkOrderTableSortColumn = "work_order" | "status" | "priority"
  | "incident" | "store" | "summary" | "contractor" | "technician"
  | "created" | "updated" | "closed" | "sla";

export type WorkOrderPageParams = {
  scope?: "active" | "operations" | "operations_all" | "history" | "capital" | "ready_to_bill" | "all"
    | "staff_work" | "staff_work_unread" | "staff_work_todo" | "staff_work_ready"
    | "dashboard_unassigned" | "dashboard_pending_submission"
    | "dashboard_pending_approval" | "dashboard_awaiting_parts"
    | "dashboard_seven_eleven_updates" | "dashboard_p1_parts_to_order"
    | "dashboard_pending_capital_completion";
  search?: string;
  contractorId?: string | null;
  contractorIds?: string[] | null;
  priority?: string;
  status?: string;
  state?: string;
  resolution?: string;
  from?: string;
  to?: string;
  needsAction?: boolean;
  sort?: "sla_due" | "newest" | "oldest" | "priority";
  pendingFirst?: boolean;
  limit?: number;
  cursor?: string | null;
  storeNumber?: string | null;
  tableSortColumn?: WorkOrderTableSortColumn;
  tableSortDirection?: "asc" | "desc";
  workOrderFilter?: string;
  incidentFilter?: string;
  storeFilter?: string;
  summaryFilter?: string;
  contractorFilter?: string;
  createdDateFilter?: string;
  updatedDateFilter?: string;
  slaFilter?: "all" | "overdue";
};

export type WorkOrderReadStatus = "unassigned" | "assigned" | "wip" | "parts" | "capital"
  | "pending_capital_completion" | "completed" | "pending_invoice" | "pending_approval"
  | "pending_payment" | "closed";
export type WorkOrderReadPriority = "p1" | "p2" | "p3" | "p4" | "p5";
export type WorkOrderReadFunctionalStatus = "New" | "Dispatched" | "Work in Progress"
  | "Pending Capital Approval" | "Pending Capital Completion" | "Awaiting Parts" | "Completed" | "Cancelled";
export type WorkOrderReadCapitalStatus = "Pending approval" | "Approved - work authorized" | "Equipment ordered"
  | "Equipment received" | "Installation scheduled" | "Installed";
export type WorkOrderReadCompletionSource = "contractor" | "staff_override" | "legacy";
export type WorkOrderReadDecimal = number | string;
export type WorkOrderReadJson = null | boolean | number | string | WorkOrderReadJson[]
  | { [key: string]: WorkOrderReadJson };

export type WorkOrderAssignmentReadRow = {
  id: string;
  contractor_id: string;
  next_contractor_id?: string | null;
  assignment_version: number;
  assignment_started_at?: string | null;
  assignment_ended_at: string;
  assignment_ended_by?: string | null;
  workflow_snapshot?: WorkOrderReadJson;
};
export type WorkOrderStaffTodoReadRow = {
  id: string;
  work_order_id: string;
  owner_id: string;
  created_by: string;
  note?: string | null;
  created_at: string;
  updated_at: string;
};
export type WorkOrderIncidentReuse = {
  incidentId: string;
  relatedWorkOrderIds: string[];
  crossesState: boolean;
};

type OptionalTextFields = "incident_id" | "store_number" | "city" | "address" | "store_state"
  | "store_timezone" | "store_county" | "store_postal_code" | "line_of_service" | "business_service"
  | "category" | "sub_category" | "summary" | "description" | "contractor_id" | "afm_name" | "afm_email"
  | "eta" | "dispatched_at" | "start_time" | "end_time" | "asset_make" | "asset_model" | "asset_serial"
  | "capital_notes" | "resolution_code" | "resolution_notes" | "part_needed" | "part_eta" | "source"
  | "billing_ready_at" | "billing_ready_by" | "contractor_assignment_started_at"
  | "duplicated_from_work_order_id" | "duplicate_root_work_order_id" | "contractor_invoicing_completed_at"
  | "contractor_invoicing_completed_by" | "staff_notes_seen_at" | "technician_on_job"
  | "assigned_technician_profile_id" | "technician_assigned_at" | "technician_assigned_by"
  | "created_at" | "updated_at" | "closed_at" | "sla_started_at" | "response_breach_at" | "resolution_breach_at"
  | "latest_note_at" | "latest_contractor_activity_at" | "billing_invoice_id" | "staff_read_through_at";
type OptionalDecimalFields = "nte" | "nte_flag_threshold" | "nte_flag_amount" | "invoice_total"
  | "repair_quote" | "install_quote" | "history_invoice_total";
type OptionalIntegerFields = "asset_year" | "contractor_assignment_version" | "duplicate_sequence" | "workflow_cycle"
  | "lifecycle_version" | "contractor_invoicing_assignment_version" | "contractor_invoicing_workflow_cycle"
  | "pending_7eleven_sync_count" | "pending_contractor_attention_count" | "history_invoice_count"
  | "parts_total" | "parts_received";
type OptionalBooleanFields = "nte_flagged" | "is_capital" | "billing_only" | "assignment_transfer_pending_visit";

/** Only fields consumed by the read mapper survive the fixed broad RPC result. */
export type WorkOrderReadRow = {
  id: string;
  status: WorkOrderReadStatus;
  priority: WorkOrderReadPriority;
  functional_status?: WorkOrderReadFunctionalStatus | null;
  capital_status?: WorkOrderReadCapitalStatus | null;
  contractor_invoicing_completion_source?: WorkOrderReadCompletionSource | null;
  assignment_history?: WorkOrderAssignmentReadRow[] | null;
  staff_todo?: WorkOrderStaffTodoReadRow | null;
  incident_reuse?: WorkOrderIncidentReuse | null;
} & Partial<Record<OptionalTextFields, string | null>>
  & Partial<Record<OptionalDecimalFields, WorkOrderReadDecimal | null>>
  & Partial<Record<OptionalIntegerFields, number | null>>
  & Partial<Record<OptionalBooleanFields, boolean | null>>;

export type WorkOrderAssignmentReadModel = {
  id: string;
  contractorId: string;
  nextContractorId: string | null;
  assignmentVersion: number;
  assignmentStartedAt: string | null;
  assignmentEndedAt: string;
  assignmentEndedBy: string | null;
  workflowSnapshot: WorkOrderReadJson;
};
export type WorkOrderStaffTodoReadModel = {
  id: string;
  workOrderId: string;
  ownerId: string;
  createdBy: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};
type DirectTextOutputs = "incidentId" | "store" | "city" | "addr" | "lineOfService" | "businessService"
  | "category" | "subCategory" | "summary" | "description" | "contractor" | "afm" | "afmEmail"
  | "eta" | "dispatchedAt" | "assetMake" | "assetModel" | "assetSerial" | "partNeeded" | "partEta" | "source"
  | "technicianOnJob" | "createdAt" | "updatedAt" | "closedAt" | "slaStartedAt" | "responseBreachAt" | "resolutionBreachAt";
type NullableTextOutputs = "storeState" | "storeTimezone" | "storeCounty" | "storePostalCode"
  | "startTime" | "startTimeRaw" | "endTime" | "endTimeRaw" | "capitalNotes" | "resolutionCode" | "resolutionNotes"
  | "billingReadyAt" | "billingReadyBy" | "contractorAssignmentStartedAt" | "duplicatedFromWorkOrderId"
  | "duplicateRootWorkOrderId" | "contractorInvoicingCompletedAt" | "contractorInvoicingCompletedBy"
  | "staffNotesSeenAt" | "assignedTechnicianProfileId" | "technicianAssignedAt" | "technicianAssignedBy"
  | "latestNoteAt" | "latestContractorActivityAt" | "billingInvoiceId" | "staffReadThroughAt";

/** Actual existing camel-case output, distinct from the historical raw WorkOrder schema type. */
export type WorkOrderReadModel = {
  id: string;
  externalWorkOrderId: string;
  status: WorkOrderReadStatus;
  priority: WorkOrderReadPriority;
  functionalStatus: WorkOrderReadFunctionalStatus | null | undefined;
  capitalStatus: WorkOrderReadCapitalStatus | null | undefined;
  isCapital: boolean | null | undefined;
  nte: number;
  nteFlagThreshold: number;
  nteFlagged: boolean;
  nteFlagAmount: number | null;
  invoiceTotal: number | undefined;
  assetYear: number | null;
  repairQuote: number | null;
  installQuote: number | null;
  billingOnly: boolean;
  contractorAssignmentVersion: number;
  assignmentTransferPendingVisit: boolean;
  duplicateSequence: number | null;
  workflowCycle: number;
  lifecycleVersion: number | null;
  contractorInvoicingAssignmentVersion: number | null;
  contractorInvoicingWorkflowCycle: number | null;
  contractorInvoicingCompletionSource: WorkOrderReadCompletionSource | null;
  age: string;
  incidentReuse: WorkOrderIncidentReuse | null;
  assignmentHistory: WorkOrderAssignmentReadModel[];
  activities: never[];
  hasUnreadNotes: boolean;
  pendingSevenElevenActivities: never[];
  pendingSevenElevenSyncCount: number;
  hasPendingSevenElevenSync: boolean;
  pendingContractorActivities: never[];
  pendingContractorAttentionCount: number;
  hasPendingContractorAttention: boolean;
  historyInvoiceTotal: number;
  historyInvoiceCount: number;
  partsTotal: number;
  partsReceived: number;
  staffTodo: WorkOrderStaffTodoReadModel | null;
  visits: never[];
  photos: never[];
  detailsLoaded: false;
} & Record<DirectTextOutputs, string | null | undefined> & Record<NullableTextOutputs, string | null>;
