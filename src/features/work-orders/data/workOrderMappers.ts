import { timezoneForWorkOrder } from "../../../lib/billingRules";
import { workOrderCanEnterSevenElevenQueue } from "../../../lib/workOrderView";
import type { WorkOrderReadRow, WorkOrderReadModel, WorkOrderAssignmentReadRow, WorkOrderAssignmentReadModel,
  WorkOrderStaffTodoReadRow, WorkOrderStaffTodoReadModel } from "./workOrderReadContracts";

// The supplied clock preserves the legacy per-row age calculation without an ambient clock.
const mapAssignmentHistory = (rows: WorkOrderAssignmentReadRow[] = []): WorkOrderAssignmentReadModel[] => rows.map(assignment => ({
  id: assignment.id,
  contractorId: assignment.contractor_id,
  nextContractorId: assignment.next_contractor_id || null,
  assignmentVersion: assignment.assignment_version,
  assignmentStartedAt: assignment.assignment_started_at || null,
  assignmentEndedAt: assignment.assignment_ended_at,
  assignmentEndedBy: assignment.assignment_ended_by || null,
  workflowSnapshot: assignment.workflow_snapshot || {},
}));

const mapEmbeddedStaffTodo = (todo: WorkOrderStaffTodoReadRow | null | undefined): WorkOrderStaffTodoReadModel | null => todo ? ({
  id: todo.id,
  workOrderId: todo.work_order_id,
  ownerId: todo.owner_id,
  createdBy: todo.created_by,
  note: todo.note || null,
  createdAt: todo.created_at,
  updatedAt: todo.updated_at,
}) : null;

export const mapWorkOrderListRow = (wo: WorkOrderReadRow, nowMs: number): WorkOrderReadModel => {
  const latestNoteAt = wo.latest_note_at || null;
  const seenAt = wo.staff_notes_seen_at || null;
  const sevenElevenEligible = workOrderCanEnterSevenElevenQueue({
    status: wo.status,
    functional_status: wo.functional_status,
  });
  const pendingSevenElevenSyncCount = sevenElevenEligible
    ? Number(wo.pending_7eleven_sync_count || 0)
    : 0;
  const pendingContractorAttentionCount = Number(wo.pending_contractor_attention_count || 0);
  const assignmentRows = Array.isArray(wo.assignment_history)
    ? wo.assignment_history
    : [];
  return {
    ...mapWorkOrderHeader(wo, nowMs),
    incidentReuse: wo.incident_reuse || null,
    assignmentHistory: mapAssignmentHistory(assignmentRows),
    activities: [],
    latestNoteAt,
    latestContractorActivityAt: wo.latest_contractor_activity_at || null,
    hasUnreadNotes: !!latestNoteAt && (
      !seenAt || new Date(latestNoteAt).getTime() > new Date(seenAt).getTime()
    ),
    pendingSevenElevenActivities: [],
    pendingSevenElevenSyncCount,
    hasPendingSevenElevenSync: pendingSevenElevenSyncCount > 0,
    pendingContractorActivities: [],
    pendingContractorAttentionCount,
    hasPendingContractorAttention: pendingContractorAttentionCount > 0,
    historyInvoiceTotal: Number(wo.history_invoice_total || 0),
    historyInvoiceCount: Number(wo.history_invoice_count || 0),
    billingInvoiceId: wo.billing_invoice_id || null,
    partsTotal: Number(wo.parts_total || 0),
    partsReceived: Number(wo.parts_received || 0),
    staffTodo: mapEmbeddedStaffTodo(wo.staff_todo),
    staffReadThroughAt: wo.staff_read_through_at || null,
    visits: [],
    photos: [],
    detailsLoaded: false,
  };
};

const formatWorkOrderDateTime = (
  value: string | null | undefined,
  workOrder: WorkOrderReadRow,
) => {
  if (!value) return null;
  return new Date(value).toLocaleString("en-US", {
    timeZone: timezoneForWorkOrder({
      storeTimezone: workOrder.store_timezone,
      storeState: workOrder.store_state,
      city: workOrder.city,
      address: workOrder.address,
    }),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

const mapWorkOrderHeader = (w: WorkOrderReadRow, nowMs: number) => ({
  id: w.id,
  incidentId: w.incident_id,
  store: w.store_number,
  city: w.city,
  addr: w.address,
  storeState: w.store_state || null,
  storeTimezone: w.store_timezone || null,
  storeCounty: w.store_county || null,
  storePostalCode: w.store_postal_code || null,
  lineOfService: w.line_of_service,
  businessService: w.business_service,
  category: w.category,
  subCategory: w.sub_category,
  summary: w.summary,
  description: w.description,
  priority: w.priority,
  status: w.status,
  functionalStatus: w.functional_status,
  contractor: w.contractor_id,
  afm: w.afm_name,
  afmEmail: w.afm_email,
  nte: parseFloat(String(w.nte || 0)),
  nteFlagThreshold: w.nte_flag_threshold != null ? parseFloat(String(w.nte_flag_threshold)) : 900,
  nteFlagged: !!w.nte_flagged,
  nteFlagAmount: w.nte_flag_amount != null ? parseFloat(String(w.nte_flag_amount)) : null,
  invoiceTotal: w.invoice_total ? parseFloat(String(w.invoice_total)) : undefined,
  eta: w.eta,
  dispatchedAt: w.dispatched_at,
  startTime: formatWorkOrderDateTime(w.start_time, w),
  startTimeRaw: w.start_time || null,
  endTime: formatWorkOrderDateTime(w.end_time, w),
  endTimeRaw: w.end_time || null,
  assetMake: w.asset_make,
  assetModel: w.asset_model,
  assetSerial: w.asset_serial,
  assetYear: w.asset_year || null,
  repairQuote: w.repair_quote ? parseFloat(String(w.repair_quote)) : null,
  installQuote: w.install_quote ? parseFloat(String(w.install_quote)) : null,
  capitalNotes: w.capital_notes || null,
  isCapital: w.is_capital,
  capitalStatus: w.capital_status,
  resolutionCode: w.resolution_code || null,
  resolutionNotes: w.resolution_notes || null,
  partNeeded: w.part_needed,
  partEta: w.part_eta,
  source: w.source,
  billingOnly: !!w.billing_only,
  billingReadyAt: w.billing_ready_at || null,
  billingReadyBy: w.billing_ready_by || null,
  contractorAssignmentStartedAt: w.contractor_assignment_started_at || null,
  contractorAssignmentVersion: Number(w.contractor_assignment_version || 0),
  assignmentTransferPendingVisit: w.assignment_transfer_pending_visit === true,
  duplicatedFromWorkOrderId: w.duplicated_from_work_order_id || null,
  duplicateRootWorkOrderId: w.duplicate_root_work_order_id || null,
  duplicateSequence: w.duplicate_sequence == null
    ? null
    : Number(w.duplicate_sequence),
  externalWorkOrderId: w.duplicate_root_work_order_id || w.id,
  workflowCycle: Number(w.workflow_cycle || 0),
  lifecycleVersion: w.lifecycle_version == null ? null : Number(w.lifecycle_version),
  contractorInvoicingCompletedAt: w.contractor_invoicing_completed_at || null,
  contractorInvoicingCompletedBy: w.contractor_invoicing_completed_by || null,
  contractorInvoicingAssignmentVersion:
    w.contractor_invoicing_assignment_version == null
      ? null
      : Number(w.contractor_invoicing_assignment_version),
  contractorInvoicingWorkflowCycle:
    w.contractor_invoicing_workflow_cycle == null
      ? null
      : Number(w.contractor_invoicing_workflow_cycle),
  contractorInvoicingCompletionSource:
    w.contractor_invoicing_completion_source || null,
  staffNotesSeenAt: w.staff_notes_seen_at || null,
  technicianOnJob: w.technician_on_job,
  assignedTechnicianProfileId: w.assigned_technician_profile_id || null,
  technicianAssignedAt: w.technician_assigned_at || null,
  technicianAssignedBy: w.technician_assigned_by || null,
  createdAt: w.created_at,
  updatedAt: w.updated_at,
  closedAt: w.closed_at,
  slaStartedAt: w.sla_started_at,
  responseBreachAt: w.response_breach_at,
  resolutionBreachAt: w.resolution_breach_at,
  age: ageString(w.created_at, w.dispatched_at, nowMs),
});

function ageString(createdAt: string | null | undefined, dispatchedAt: string | null | undefined, nowMs: number): string {
  const ref = dispatchedAt || createdAt;
  if (!ref) return "—";
  const diff = nowMs - new Date(ref).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}
