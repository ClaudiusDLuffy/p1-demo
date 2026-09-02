// Supabase data layer for the P1 portal.
// Maps DB rows (snake_case) → portal shape (camelCase) so existing components
// don't need to change. Keep this thin — heavy logic stays in components.

import { supabase } from "./supabase/client";
import { stateCodeFromWorkOrder, timezoneForWorkOrder } from "./billingRules";
import { collectSupabasePages } from "./paginatedQuery";
import {
  clampPageSize,
  type CursorPage,
} from "./cursorPagination";
import { computeSlaBreaches } from "./slaConfig";
import { WorkOrderSchema } from "./schemas";
import type { Invoice, WorkOrder } from "./schemas";
import type { Database, Json } from "./supabase/database.types";
import type {
  PortalRealtimeChange,
  PortalRealtimeTable,
} from "./realtimeInvalidation";
import type { WorkOrderReopenMode } from "./workOrderReopen";
import type {
  ContractorEstimate,
  ContractorEstimateAttachment,
  ContractorEstimateLine,
  ContractorEstimateLineType,
  ContractorEstimateTemplate,
  EditableContractorEstimateLine,
} from "./contractorEstimate";
import { workOrderCanEnterSevenElevenQueue } from "./workOrderView";
import { canonicalSevenElevenWorkOrderId } from "./workOrderIdentity";

// ── PROFILE / AUTH ──────────────────────────────────────────────────────────

export async function signIn(email: string, password: string): Promise<any> {
  const sb = supabase();
  const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw error;
  return data;
}

export type SignOutScope = "global" | "local" | "others";

export async function signOut(scope: SignOutScope = "local"): Promise<void> {
  const sb = supabase();
  const { error } = await sb.auth.signOut({ scope });
  if (error) throw error;
}

export async function getSession(): Promise<any> {
  const sb = supabase();
  const { data } = await sb.auth.getSession();
  return data.session;
}

export async function loadCurrentProfile(): Promise<any | null> {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const [profileResult, permissionsResult] = await Promise.all([
    sb.from("profiles").select("*").eq("id", user.id).single(),
    (sb as any)
      .from("staff_permission_grants")
      .select("permission")
      .eq("profile_id", user.id),
  ]);
  if (profileResult.error) throw profileResult.error;
  if (permissionsResult.error) throw permissionsResult.error;
  return mapProfile(profileResult.data, (permissionsResult.data || [])
    .map((grant: any) => String(grant.permission)));
}

// ── PROFILES (all users) ────────────────────────────────────────────────────

// profiles_read: staff see all, contractors see contractors
export async function loadAllProfiles(): Promise<any[]> {
  const sb = supabase();
  const [profilesResult, permissionsResult] = await Promise.all([
    sb.from("profiles").select("*").order("name"),
    (sb as any).from("staff_permission_grants").select("profile_id, permission"),
  ]);
  if (profilesResult.error) throw profilesResult.error;
  if (permissionsResult.error) throw permissionsResult.error;
  const permissionsByProfile = new Map<string, string[]>();
  for (const grant of permissionsResult.data || []) {
    const profileId = String(grant.profile_id);
    const permissions = permissionsByProfile.get(profileId) || [];
    permissions.push(String(grant.permission));
    permissionsByProfile.set(profileId, permissions);
  }
  return (profilesResult.data || []).map(profile => mapProfile(
    profile,
    permissionsByProfile.get(profile.id) || [],
  ));
}

// Contractor technicians — RLS returns all rows to staff and only authorized
// company rows to contractors. A linked portal profile is the canonical display
// identity; the table name remains the fallback for record-only legacy rows.
export async function loadTechnicians(): Promise<any[]> {
  const sb = supabase();
  const { data, error } = await sb
    .from("contractor_technicians")
    .select("*, portal_profile:profiles!contractor_technicians_profile_id_fkey(name)")
    .order("name");
  if (error) throw error;
  return (data || []).map((t: any) => {
    const portalProfile = Array.isArray(t.portal_profile)
      ? t.portal_profile[0]
      : t.portal_profile;
    return {
      id: t.id,
      contractorId: t.contractor_id,
      profileId: t.profile_id || null,
      name: portalProfile?.name || t.name,
      storedName: t.name,
      tier: t.tier,
      isActive: t.is_active,
    };
  });
}

const mapProfile = (p: any, staffPermissions: string[] = []) => ({
  id: p.id,
  name: p.name,
  initials: p.initials,
  email: p.email,
  role: p.role,
  active: p.active !== false,
  title: p.title,
  company: p.company,
  phone: p.phone,
  territory: p.territory,
  trades: p.trades || [],
  color: p.color,
  contractorTier: p.contractor_tier || null,
  dispatcherId: p.dispatcher_id || null,
  contractorOrganizationId: p.contractor_organization_id || null,
  contractorAccessLevel: p.contractor_access_level || null,
  staffPermissions,
  // Display-only NTE cap shown to this contractor in place of the real WO
  // NTE (Lindsay 2026-06-16). Falls back to 1000 if the migration hasn't
  // been applied yet, so a stale schema can't blow up logins.
  contractorNteDisplay: p.contractor_nte_display != null ? Number(p.contractor_nte_display) : 1000,
  // Per-contractor rate columns are reserved for the Phase 2 rate work —
  // the invoice form no longer reads them (rates start empty, truck = 60).
  defaultLaborRate: p.default_labor_rate ?? null,
  defaultTruckRate: p.default_truck_rate ?? null,
  defaultPartsMarkup: p.default_parts_markup ?? 0,
  isAssignable: p.is_assignable !== false,
});

// ── WORK ORDERS ─────────────────────────────────────────────────────────────

export type WorkOrderDetails = {
  activities: any[];
  photos: string[];
  visits: any[];
  latestNoteAt: string | null;
  latestContractorActivityAt: string | null;
  hasUnreadNotes: boolean;
  pendingSevenElevenActivities: any[];
  pendingSevenElevenSyncCount: number;
  hasPendingSevenElevenSync: boolean;
  pendingContractorActivities: any[];
  pendingContractorAttentionCount: number;
  hasPendingContractorAttention: boolean;
  activityPage: Omit<CursorPage<any>, "items">;
  photoPage: Omit<CursorPage<string>, "items">;
  visitPage: Omit<CursorPage<any>, "items">;
  assignmentHistory: any[];
  detailsLoaded: true;
};

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

export type PortalNavigationSummary = {
  openCount: number;
  p1UnassignedCount: number;
  capitalCount: number;
  pendingApprovalCount: number;
  historyCount: number;
  slaBreachedCount: number;
  contractorActiveCount: number;
  contractorAttentionCount: number;
  contractorInvoiceCount: number;
  staffUnreadCount: number;
  myTodoCount: number;
  readyToBillCount: number;
  staffWorkCount: number;
};

const EMPTY_PORTAL_NAVIGATION_SUMMARY: PortalNavigationSummary = {
  openCount: 0,
  p1UnassignedCount: 0,
  capitalCount: 0,
  pendingApprovalCount: 0,
  historyCount: 0,
  slaBreachedCount: 0,
  contractorActiveCount: 0,
  contractorAttentionCount: 0,
  contractorInvoiceCount: 0,
  staffUnreadCount: 0,
  myTodoCount: 0,
  readyToBillCount: 0,
  staffWorkCount: 0,
};

export type ContractorWorkloadSummary = Record<string, {
  active: number;
  capital: number;
}>;

const cursorPageFromRpc = <T>(value: unknown): CursorPage<T> => {
  const page = typeof value === "string" ? JSON.parse(value) : value;
  if (!page || typeof page !== "object" || Array.isArray(page)) {
    throw new Error("The server returned an invalid page");
  }
  const row = page as Record<string, unknown>;
  const items = Array.isArray(row.items) ? row.items as T[] : [];
  return {
    items,
    nextCursor: typeof row.nextCursor === "string" ? row.nextCursor : null,
    hasMore: Boolean(row.hasMore),
    totalCount: Number(row.totalCount || 0),
    aggregates: row.aggregates && typeof row.aggregates === "object" && !Array.isArray(row.aggregates)
      ? Object.fromEntries(Object.entries(row.aggregates as Record<string, unknown>)
        .map(([key, value]) => [key, Number(value || 0)]))
      : undefined,
  };
};

const mapAssignmentHistory = (rows: any[] = []) => rows.map(assignment => ({
  id: assignment.id,
  contractorId: assignment.contractor_id,
  nextContractorId: assignment.next_contractor_id || null,
  assignmentVersion: assignment.assignment_version,
  assignmentStartedAt: assignment.assignment_started_at || null,
  assignmentEndedAt: assignment.assignment_ended_at,
  assignmentEndedBy: assignment.assignment_ended_by || null,
  workflowSnapshot: assignment.workflow_snapshot || {},
}));

const mapEmbeddedStaffTodo = (todo: any) => todo ? ({
  id: todo.id,
  workOrderId: todo.work_order_id,
  ownerId: todo.owner_id,
  createdBy: todo.created_by,
  note: todo.note || null,
  createdAt: todo.created_at,
  updatedAt: todo.updated_at,
}) : null;

const mapWorkOrderListRow = (wo: any): WorkOrder => {
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

  WorkOrderSchema.safeParse({
    id: wo.id,
    status: wo.status,
    priority: wo.priority,
    contractor_id: wo.contractor_id,
    nte: wo.nte == null ? null : Number(wo.nte),
    created_at: wo.created_at,
    store_number: wo.store_number,
    city: wo.city,
    functional_status: wo.functional_status,
  });

  return {
    ...mapWO(wo),
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
  } as unknown as WorkOrder;
};

export async function loadWorkOrdersPage(
  params: WorkOrderPageParams = {},
): Promise<CursorPage<WorkOrder>> {
  const sb = supabase();
  const tableMode = Boolean(params.tableSortColumn)
    || params.scope === "dashboard_seven_eleven_updates"
    || params.scope === "dashboard_pending_submission"
    || params.scope === "dashboard_p1_parts_to_order"
    || params.scope === "ready_to_bill"
    || params.scope === "staff_work"
    || params.scope === "staff_work_ready";
  const rpcName = tableMode
    ? "list_work_orders_table_page"
    : "list_work_orders_page";
  const sharedArgs = {
    p_scope: params.scope || "active",
    p_search: params.search?.trim() || null,
    p_contractor_id: params.contractorId || null,
    p_priority: params.priority && params.priority !== "all" ? params.priority : null,
    p_status: params.status && params.status !== "all" ? params.status : null,
    p_state: params.state && params.state !== "all" ? params.state : null,
    p_resolution: params.resolution && params.resolution !== "all" ? params.resolution : null,
    p_from: params.from || null,
    p_to: params.to || null,
    p_needs_action: Boolean(params.needsAction),
    p_sort: params.sort || "newest",
    p_pending_first: Boolean(params.pendingFirst),
    p_limit: clampPageSize(params.limit),
    p_cursor: params.cursor || null,
    p_store_number: params.storeNumber || null,
    p_contractor_ids: params.contractorIds?.length ? params.contractorIds : null,
  };
  const tableArgs = tableMode ? {
    ...sharedArgs,
    p_sort_column: params.tableSortColumn
      || (params.sort === "priority" ? "priority" : params.sort === "sla_due" ? "sla" : "created"),
    p_sort_direction: params.tableSortDirection
      || (params.sort === "oldest" ? "asc" : params.sort === "priority" || params.sort === "sla_due" ? "asc" : "desc"),
    p_work_order_filter: params.workOrderFilter?.trim() || null,
    p_incident_filter: params.incidentFilter?.trim() || null,
    p_store_filter: params.storeFilter?.trim() || null,
    p_summary_filter: params.summaryFilter?.trim() || null,
    p_contractor_filter: params.contractorFilter?.trim() || null,
    p_created_date_filter: params.createdDateFilter || null,
    p_updated_date_filter: params.updatedDateFilter || null,
    p_sla_filter: params.slaFilter && params.slaFilter !== "all"
      ? params.slaFilter
      : null,
  } : sharedArgs;
  const { data, error } = await (sb as any).rpc(rpcName, tableArgs);
  if (error) throw error;
  const page = cursorPageFromRpc<any>(data);
  return { ...page, items: page.items.map(mapWorkOrderListRow) };
}

export async function loadPortalNavigationSummary(): Promise<PortalNavigationSummary> {
  const sb = supabase();
  const { data, error } = await (sb as any).rpc("get_portal_navigation_summary");
  if (error) throw error;
  const value = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  return Object.fromEntries(
    Object.keys(EMPTY_PORTAL_NAVIGATION_SUMMARY).map(key => [key, Number(value[key] || 0)]),
  ) as PortalNavigationSummary;
}

export async function loadContractorWorkloadSummary(): Promise<ContractorWorkloadSummary> {
  const sb = supabase();
  const { data, error } = await (sb as any).rpc("get_contractor_workload_summary");
  if (error) throw new Error(error.message);
  const raw = typeof data === "string" ? JSON.parse(data) : data;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).map(([contractorId, value]) => {
    const row = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    return [contractorId, {
      active: Number(row.active || 0),
      capital: Number(row.capital || 0),
    }];
  }));
}

export async function loadWorkOrderById(workOrderId: string): Promise<WorkOrder | null> {
  if (!workOrderId) return null;
  const sb = supabase();
  const { data, error } = await (sb as any).rpc("get_portal_work_order", {
    p_work_order_id: workOrderId,
  });
  if (error) throw error;
  return data ? mapWorkOrderListRow(data) : null;
}

export async function loadWorkOrders(): Promise<WorkOrder[]> {
  // The shared shell retains only the active operational set used by badges,
  // dashboard buckets, and mutations. Closed history is never downloaded
  // here; its screen uses loadWorkOrdersPage directly.
  const items: WorkOrder[] = [];
  let cursor: string | null = null;
  do {
    const page = await loadWorkOrdersPage({
      scope: "active",
      sort: "newest",
      limit: 100,
      cursor,
    });
    items.push(...page.items);
    cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor);
  return items;
}

const formatWorkOrderDateTime = (
  value: string | null | undefined,
  workOrder: any,
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

const mapWO = (w: any) => ({
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
  nte: parseFloat(w.nte || 0),
  nteFlagThreshold: w.nte_flag_threshold != null ? parseFloat(w.nte_flag_threshold) : 900,
  nteFlagged: !!w.nte_flagged,
  nteFlagAmount: w.nte_flag_amount != null ? parseFloat(w.nte_flag_amount) : null,
  invoiceTotal: w.invoice_total ? parseFloat(w.invoice_total) : undefined,
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
  repairQuote: w.repair_quote ? parseFloat(w.repair_quote) : null,
  installQuote: w.install_quote ? parseFloat(w.install_quote) : null,
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
  duplicatedFromWorkOrderId: w.duplicated_from_work_order_id || null,
  duplicateRootWorkOrderId: w.duplicate_root_work_order_id || null,
  duplicateSequence: w.duplicate_sequence == null
    ? null
    : Number(w.duplicate_sequence),
  externalWorkOrderId: w.duplicate_root_work_order_id || w.id,
  workflowCycle: Number(w.workflow_cycle || 0),
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
  age: ageString(w.created_at, w.dispatched_at),
});

const mapActivity = (a: any, timeZone?: string) => ({
  id: a.id,
  authorId: a.author_id,
  author: a.author_name,
  createdAt: a.created_at,
  time: new Date(a.created_at).toLocaleString("en-US", {
    ...(timeZone ? { timeZone } : {}),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }),
  text: a.text,
  type: a.type,
  activityChannel: a.activity_channel
    || (a.requires_7eleven_sync
      ? "field_note"
      : a.is_staff_only
        ? "internal_note"
        : a.type === "system"
          ? "system_event"
          : "legacy"),
  enteredByRole: a.entered_by_role || "system",
  isStaffOverride: !!a.is_staff_override,
  isStaffOnly: !!a.is_staff_only,
  overrideForContractorId: a.override_for_contractor_id || null,
  eventKey: a.event_key || (a.type === "system" ? "system" : "note"),
  eventData: a.event_data || {},
  requiresSevenElevenSync: !!a.requires_7eleven_sync,
  syncedToSevenElevenAt: a.synced_to_7eleven_at || null,
  syncedToSevenElevenBy: a.synced_to_7eleven_by || null,
  requiresContractorAttention: !!a.requires_contractor_attention,
  contractorAcknowledgedAt: a.contractor_attention_acknowledged_at || null,
  contractorAcknowledgedBy: a.contractor_attention_acknowledged_by || null,
  workflowCycle: Number(a.workflow_cycle || 0),
});

const mapVisit = (visit: any) => ({
  id: visit.id,
  workOrderId: visit.work_order_id,
  contractorId: visit.contractor_id || null,
  checkInAt: visit.check_in_at,
  checkOutAt: visit.check_out_at || null,
  createdBy: visit.checked_in_by || null,
  closedBy: visit.checked_out_by || null,
});

const pageMeta = <T>(page: CursorPage<T>): Omit<CursorPage<T>, "items"> => ({
  nextCursor: page.nextCursor,
  hasMore: page.hasMore,
  totalCount: page.totalCount,
});

export async function loadWorkOrderActivitiesPage(
  workOrder: Parameters<typeof loadWorkOrderDetails>[0],
  cursor: string | null = null,
  limit = 30,
): Promise<CursorPage<any>> {
  if (!workOrder?.id) throw new Error("A work order ID is required");
  const sb = supabase();
  const { data, error } = await (sb as any).rpc("list_work_order_activities_page", {
    p_work_order_id: workOrder.id,
    p_limit: clampPageSize(limit),
    p_cursor: cursor,
  });
  if (error) throw error;
  const page = cursorPageFromRpc<any>(data);
  const timeZone = timezoneForWorkOrder(workOrder);
  return { ...page, items: page.items.map(row => mapActivity(row, timeZone)) };
}

export async function loadWorkOrderPhotosPage(
  workOrderId: string,
  cursor: string | null = null,
  limit = 24,
): Promise<CursorPage<string>> {
  if (!workOrderId) throw new Error("A work order ID is required");
  const sb = supabase();
  const { data, error } = await (sb as any).rpc("list_work_order_photos_page", {
    p_work_order_id: workOrderId,
    p_limit: clampPageSize(limit),
    p_cursor: cursor,
  });
  if (error) throw error;
  const page = cursorPageFromRpc<any>(data);
  return {
    ...page,
    items: page.items.map(photo => photo.storage_path).filter(Boolean),
  };
}

export async function loadAllWorkOrderPhotoPaths(
  workOrderId: string,
): Promise<string[]> {
  if (!workOrderId) throw new Error("A work order ID is required");

  const paths: string[] = [];
  const seenPaths = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  do {
    const page = await loadWorkOrderPhotosPage(workOrderId, cursor, 100);
    for (const path of page.items) {
      if (!seenPaths.has(path)) {
        seenPaths.add(path);
        paths.push(path);
      }
    }

    if (!page.hasMore) break;
    if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
      throw new Error("Photo pagination returned an invalid cursor");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);

  return paths;
}

export async function loadWorkOrderVisitsPage(
  workOrderId: string,
  cursor: string | null = null,
  limit = 30,
): Promise<CursorPage<any>> {
  if (!workOrderId) throw new Error("A work order ID is required");
  const sb = supabase();
  const { data, error } = await (sb as any).rpc("list_work_order_visits_page", {
    p_work_order_id: workOrderId,
    p_limit: clampPageSize(limit),
    p_cursor: cursor,
  });
  if (error) throw error;
  const page = cursorPageFromRpc<any>(data);
  return { ...page, items: page.items.map(mapVisit) };
}

export async function loadAllWorkOrderVisits(workOrderId: string): Promise<any[]> {
  const visits: any[] = [];
  let cursor: string | null = null;
  do {
    const page = await loadWorkOrderVisitsPage(workOrderId, cursor, 100);
    visits.push(...page.items);
    cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor);
  return visits;
}

export async function loadWorkOrderDetails(workOrder: {
  id: string;
  storeTimezone?: string | null;
  storeState?: string | null;
  city?: string | null;
  addr?: string | null;
  staffNotesSeenAt?: string | null;
}): Promise<WorkOrderDetails> {
  if (!workOrder?.id) throw new Error("A work order ID is required");
  const [activityResult, photoResult, visitResult, currentWorkOrder] = await Promise.all([
    loadWorkOrderActivitiesPage(workOrder),
    loadWorkOrderPhotosPage(workOrder.id),
    loadWorkOrderVisitsPage(workOrder.id),
    loadWorkOrderById(workOrder.id),
  ]);

  const activities = activityResult.items;
  const latestNoteAt = (currentWorkOrder as any)?.latestNoteAt
    || activities.find(activity => activity.type === "note")?.createdAt
    || null;
  const sevenElevenEligible = workOrderCanEnterSevenElevenQueue(
    currentWorkOrder as any,
  );
  const pendingSevenElevenActivities = sevenElevenEligible
    ? activities.filter(activity =>
        activity.requiresSevenElevenSync && !activity.syncedToSevenElevenAt
      )
    : [];
  const pendingContractorActivities = activities.filter(activity =>
    activity.requiresContractorAttention && !activity.contractorAcknowledgedAt
  );
  const seenAt = workOrder.staffNotesSeenAt || null;

  return {
    activities,
    photos: photoResult.items,
    visits: visitResult.items,
    latestNoteAt,
    latestContractorActivityAt: (currentWorkOrder as any)?.latestContractorActivityAt
      || activities.find(
        activity => activity.enteredByRole === "contractor",
      )?.createdAt
      || null,
    hasUnreadNotes: !!latestNoteAt && (
      !seenAt || new Date(latestNoteAt).getTime() > new Date(seenAt).getTime()
    ),
    pendingSevenElevenActivities,
    pendingSevenElevenSyncCount: sevenElevenEligible ? Number(
      (currentWorkOrder as any)?.pendingSevenElevenSyncCount
      ?? pendingSevenElevenActivities.length,
    ) : 0,
    hasPendingSevenElevenSync: sevenElevenEligible && Boolean(
      (currentWorkOrder as any)?.hasPendingSevenElevenSync
      ?? pendingSevenElevenActivities.length > 0,
    ),
    pendingContractorActivities,
    pendingContractorAttentionCount: Number(
      (currentWorkOrder as any)?.pendingContractorAttentionCount
      ?? pendingContractorActivities.length,
    ),
    hasPendingContractorAttention: Boolean(
      (currentWorkOrder as any)?.hasPendingContractorAttention
      ?? pendingContractorActivities.length > 0,
    ),
    activityPage: pageMeta(activityResult),
    photoPage: pageMeta(photoResult),
    visitPage: pageMeta(visitResult),
    assignmentHistory: (currentWorkOrder as any)?.assignmentHistory || [],
    detailsLoaded: true,
  };
}

// "5h", "2d", "1w" — relative age string from a timestamp
function ageString(createdAt: string, dispatchedAt?: string): string {
  const ref = dispatchedAt || createdAt;
  if (!ref) return "—";
  const diff = Date.now() - new Date(ref).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

// ── CONTRACTOR ESTIMATES ──────────────────────────────────────────────────
// Estimates deliberately stay outside the invoice tables. The two RPCs are
// the only authenticated write boundary; direct table access is read-only.

type ContractorEstimateRow =
  Database["public"]["Tables"]["contractor_estimates"]["Row"];
type ContractorEstimateLineRow =
  Database["public"]["Tables"]["contractor_estimate_lines"]["Row"];

const mapContractorEstimateLine = (
  line: ContractorEstimateLineRow,
): ContractorEstimateLine => ({
  id: line.id,
  position: Number(line.position),
  type: line.type as ContractorEstimateLineType,
  description: line.description || "",
  qty: Number(line.qty || 0),
  rate: Number(line.rate || 0),
  amount: Number(line.amount || 0),
});

const mapContractorEstimate = (
  estimate: ContractorEstimateRow,
  lines: ContractorEstimateLine[],
  attachments: ContractorEstimateAttachment[],
): ContractorEstimate => ({
  id: estimate.id,
  quoteNum: estimate.quote_num,
  workOrderId: estimate.work_order_id,
  contractorId: estimate.contractor_id,
  contractorAssignmentVersion: Number(estimate.contractor_assignment_version),
  quoteDate: estimate.quote_date,
  validUntil: estimate.valid_until || null,
  terms: estimate.terms,
  notes: estimate.notes || null,
  state: estimate.state as ContractorEstimate["state"],
  subtotal: Number(estimate.subtotal || 0),
  salesTax: Number(estimate.sales_tax || 0),
  total: Number(estimate.total || 0),
  submittedAt: estimate.submitted_at || null,
  submittedBy: estimate.submitted_by || null,
  convertedAt: estimate.converted_at || null,
  convertedBy: estimate.converted_by || null,
  convertedInvoiceId: estimate.converted_invoice_id || null,
  createdAt: estimate.created_at,
  updatedAt: estimate.updated_at,
  lines,
  attachments,
});

export async function loadContractorEstimatesForWorkOrder(
  workOrderId: string,
): Promise<ContractorEstimate[]> {
  if (!workOrderId) return [];
  const sb = supabase();
  const { data: estimates, error: estimateError } = await sb
    .from("contractor_estimates")
    .select("*")
    .eq("work_order_id", workOrderId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  if (estimateError) throw estimateError;
  if (!estimates?.length) return [];

  const estimateIds = estimates.map(estimate => estimate.id);
  const [{ data: rawLines, error: lineError }, { data: rawAttachments, error: attachmentError }] = await Promise.all([
    sb
      .from("contractor_estimate_lines")
      .select("*")
      .in("estimate_id", estimateIds)
      .order("position", { ascending: true })
      .order("id", { ascending: true }),
    sb
      .from("contractor_estimate_attachments")
      .select("*")
      .in("estimate_id", estimateIds)
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
  ]);
  if (lineError) throw lineError;
  if (attachmentError) throw attachmentError;

  const linesByEstimate = new Map<string, ContractorEstimateLine[]>();
  for (const rawLine of rawLines || []) {
    const lines = linesByEstimate.get(rawLine.estimate_id) || [];
    lines.push(mapContractorEstimateLine(rawLine));
    linesByEstimate.set(rawLine.estimate_id, lines);
  }
  const attachmentsByEstimate = new Map<string, ContractorEstimateAttachment[]>();
  for (const attachment of rawAttachments || []) {
    const items = attachmentsByEstimate.get(attachment.estimate_id) || [];
    items.push({
      id: attachment.id,
      estimateId: attachment.estimate_id,
      originalName: attachment.original_name,
      storagePath: attachment.storage_path,
      mimeType: attachment.mime_type,
      sizeBytes: Number(attachment.size_bytes),
      uploadedBy: attachment.uploaded_by,
      createdAt: attachment.created_at,
    });
    attachmentsByEstimate.set(attachment.estimate_id, items);
  }

  return estimates.map(estimate => mapContractorEstimate(
    estimate,
    linesByEstimate.get(estimate.id) || [],
    attachmentsByEstimate.get(estimate.id) || [],
  ));
}

const ESTIMATE_ATTACHMENT_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ESTIMATE_ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;

type ContractorEstimateTemplateRow =
  Database["public"]["Tables"]["contractor_estimate_templates"]["Row"];

const mapContractorEstimateTemplate = (
  template: ContractorEstimateTemplateRow,
): ContractorEstimateTemplate => ({
  id: template.id,
  templateKey: template.template_key as ContractorEstimateTemplate["templateKey"],
  displayName: template.display_name,
  description: template.description || "",
  versionLabel: template.version_label,
  originalName: template.original_name,
  storagePath: template.storage_path,
  mimeType: template.mime_type,
  sizeBytes: Number(template.size_bytes),
  sha256: template.sha256,
  publishedAt: template.published_at,
});

export async function loadContractorEstimateTemplates(): Promise<ContractorEstimateTemplate[]> {
  const sb = supabase();
  const { data, error } = await sb
    .from("contractor_estimate_templates")
    .select("*")
    .eq("is_active", true)
    .order("display_name", { ascending: true });
  if (error) throw error;
  return (data || []).map(mapContractorEstimateTemplate);
}

export async function downloadContractorEstimateTemplate(
  template: ContractorEstimateTemplate,
): Promise<void> {
  const sb = supabase();
  const { data, error } = await sb.storage
    .from("contractor-estimate-templates")
    .download(template.storagePath);
  if (error) throw error;
  const url = URL.createObjectURL(data);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = template.originalName;
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

export async function uploadContractorEstimateAttachment(
  estimateId: string,
  file: File,
): Promise<ContractorEstimateAttachment> {
  if (!estimateId) throw new Error("Save the estimate draft before attaching a form.");
  if (!/\.xlsx$/i.test(file.name)) throw new Error("Only .xlsx equipment forms can be attached.");
  if (file.size <= 0 || file.size > ESTIMATE_ATTACHMENT_MAX_BYTES) {
    throw new Error("Equipment forms must be between 1 byte and 15 MB.");
  }
  const sb = supabase();
  const storagePath = `${estimateId}/${crypto.randomUUID()}.xlsx`;
  const { error: uploadError } = await sb.storage
    .from("contractor-estimate-attachments")
    .upload(storagePath, file, { contentType: ESTIMATE_ATTACHMENT_MIME, upsert: false });
  if (uploadError) throw uploadError;

  const { data, error } = await (sb as any).rpc("attach_contractor_estimate_file", {
    p_estimate_id: estimateId,
    p_storage_path: storagePath,
    p_original_name: file.name,
    p_mime_type: ESTIMATE_ATTACHMENT_MIME,
    p_size_bytes: file.size,
  });
  if (error) {
    await sb.storage.from("contractor-estimate-attachments").remove([storagePath]);
    throw error;
  }
  return data as ContractorEstimateAttachment;
}

export async function removeContractorEstimateAttachment(
  attachmentId: string,
): Promise<void> {
  const sb = supabase();
  const { data, error } = await (sb as any).rpc("remove_contractor_estimate_file", {
    p_attachment_id: attachmentId,
  });
  if (error) throw error;
  const storagePath = String(data?.storagePath || "");
  if (!storagePath) throw new Error("The removed equipment form had no storage path.");
  const { error: storageError } = await sb.storage
    .from("contractor-estimate-attachments")
    .remove([storagePath]);
  if (storageError) throw storageError;
}

export async function downloadContractorEstimateAttachment(
  attachment: ContractorEstimateAttachment,
): Promise<void> {
  const sb = supabase();
  const { data, error } = await sb.storage
    .from("contractor-estimate-attachments")
    .download(attachment.storagePath);
  if (error) throw error;
  const url = URL.createObjectURL(data);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = attachment.originalName;
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

export type SaveContractorEstimateInput = {
  estimateId?: string | null;
  workOrderId: string;
  quoteDate: string;
  validUntil?: string | null;
  terms: string;
  notes?: string | null;
  salesTax: number;
  lines: EditableContractorEstimateLine[];
  submit?: boolean;
  expectedUpdatedAt?: string | null;
};

export type SaveContractorEstimateResult = {
  estimateId: string;
  quoteNum: string;
  state: "draft" | "submitted";
  workOrderId: string;
  subtotal: number;
  salesTax: number;
  total: number;
  updatedAt: string;
};

export async function saveContractorEstimate(
  input: SaveContractorEstimateInput,
): Promise<SaveContractorEstimateResult> {
  const sb = supabase();
  const { data, error } = await sb.rpc("save_contractor_estimate", {
    p_estimate_id: input.estimateId || null,
    p_work_order_id: input.workOrderId,
    p_quote_date: input.quoteDate,
    p_valid_until: input.validUntil || null,
    p_terms: input.terms,
    p_notes: input.notes || null,
    p_sales_tax: input.salesTax,
    p_lines: input.lines as Json,
    p_submit: Boolean(input.submit),
    p_expected_updated_at: input.expectedUpdatedAt || null,
  });
  if (error) throw error;
  const result = data as Record<string, Json> | null;
  if (!result || typeof result.estimateId !== "string") {
    throw new Error("The server returned an invalid estimate result");
  }
  return {
    estimateId: result.estimateId,
    quoteNum: String(result.quoteNum || ""),
    state: result.state === "submitted" ? "submitted" : "draft",
    workOrderId: String(result.workOrderId || input.workOrderId),
    subtotal: Number(result.subtotal || 0),
    salesTax: Number(result.salesTax || 0),
    total: Number(result.total || 0),
    updatedAt: String(result.updatedAt || ""),
  };
}

export type ConvertContractorEstimateResult = {
  estimateId: string;
  quoteNum: string;
  invoiceId: string;
  invoiceNum: string;
  invoiceState: "draft";
  workOrderId: string;
  alreadyConverted: boolean;
};

export async function convertContractorEstimateToInvoice(
  estimateId: string,
): Promise<ConvertContractorEstimateResult> {
  const sb = supabase();
  const { data, error } = await sb.rpc(
    "convert_contractor_estimate_to_invoice",
    { p_estimate_id: estimateId },
  );
  if (error) throw error;
  const result = data as Record<string, Json> | null;
  if (!result || typeof result.invoiceId !== "string") {
    throw new Error("The server returned an invalid estimate conversion result");
  }
  return {
    estimateId: String(result.estimateId || estimateId),
    quoteNum: String(result.quoteNum || ""),
    invoiceId: result.invoiceId,
    invoiceNum: String(result.invoiceNum || ""),
    invoiceState: "draft",
    workOrderId: String(result.workOrderId || ""),
    alreadyConverted: Boolean(result.alreadyConverted),
  };
}

// ── INVOICES ────────────────────────────────────────────────────────────────

export type InvoicePageParams = {
  state?: "all" | "active" | "draft" | "submitted" | "approved" | "rejected" | "revised" | "paid";
  search?: string;
  sort?: "recent" | "invoice" | "work_order" | "contractor" | "status" | "date" | "store" | "lines" | "total";
  direction?: "asc" | "desc";
  limit?: number;
  cursor?: string | null;
  workOrderId?: string | null;
};

const mapInvoicePageRow = (invoice: any): Invoice => ({
  ...mapInvoice(invoice),
  lines: (Array.isArray(invoice.lines) ? invoice.lines : []).map(mapInvoiceLine),
  pdfIsOriginal: Boolean(invoice.pdf_is_original),
  originalPdfName: invoice.original_pdf_name || null,
  contractorName: invoice.contractor_name || null,
  sourceStaffInvoiceId: invoice.source_staff_invoice_id || null,
}) as unknown as Invoice;

export async function loadInvoicesPage(
  params: InvoicePageParams = {},
): Promise<CursorPage<Invoice>> {
  const sb = supabase();
  const { data, error } = await (sb as any).rpc("list_contractor_invoices_page", {
    p_state: params.state || "all",
    p_search: params.search?.trim() || null,
    p_sort: params.sort || "recent",
    p_direction: params.direction || "desc",
    p_limit: clampPageSize(params.limit),
    p_cursor: params.cursor || null,
    p_work_order_id: params.workOrderId || null,
  });
  if (error) throw error;
  const page = cursorPageFromRpc<any>(data);
  return { ...page, items: page.items.map(mapInvoicePageRow) };
}

export async function loadInvoiceById(invoiceId: string): Promise<Invoice | null> {
  if (!invoiceId) return null;
  const sb = supabase();
  const [invoiceResult, lineResult, uploadResult, holdResult] = await Promise.all([
    sb.from("invoices")
      .select("*")
      .eq("id", invoiceId)
      .eq("invoice_type", "contractor")
      .is("deleted_at", null)
      .maybeSingle(),
    sb.from("invoice_lines")
      .select("*")
      .eq("invoice_id", invoiceId)
      .order("position", { ascending: true })
      .order("id", { ascending: true }),
    sb.from("activities")
      .select("event_data,created_at,id")
      .eq("event_key", "invoice_uploaded")
      .is("deleted_at", null)
      .contains("event_data", { invoiceId })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle(),
    sb.from("contractor_invoice_payment_holds")
      .select("placed_at,placed_by,reason")
      .eq("invoice_id", invoiceId)
      .maybeSingle(),
  ]);
  if (invoiceResult.error) throw invoiceResult.error;
  if (lineResult.error) throw lineResult.error;
  if (uploadResult.error) throw uploadResult.error;
  if (holdResult.error) throw holdResult.error;
  if (!invoiceResult.data) return null;
  const eventData = uploadResult.data?.event_data;
  return mapInvoicePageRow({
    ...invoiceResult.data,
    lines: lineResult.data || [],
    pdf_is_original: Boolean(uploadResult.data),
    original_pdf_name: eventData && typeof eventData === "object" && !Array.isArray(eventData)
      ? eventData.fileName || null
      : null,
    payment_hold_at: holdResult.data?.placed_at || null,
    payment_hold_by: holdResult.data?.placed_by || null,
    payment_hold_reason: holdResult.data?.reason || null,
  });
}

export async function loadInvoices(): Promise<Invoice[]> {
  // Paid invoices are historical and live behind the invoice cursor list.
  // The shell keeps only workflow-active records needed for badges, review,
  // billing handoff, and work-order actions.
  const items: Invoice[] = [];
  let cursor: string | null = null;
  do {
    const page = await loadInvoicesPage({
      state: "active",
      sort: "recent",
      direction: "desc",
      limit: 100,
      cursor,
    });
    items.push(...page.items);
    cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor);
  return items;
}

const mapInvoice = (i: any) => ({
  id: i.id,
  num: i.num,
  wot: i.work_order_id,
  workOrderId: i.work_order_id,
  externalWorkOrderId: canonicalSevenElevenWorkOrderId(i.work_order_id),
  store: i.store_number,
  storeAddr: i.store_address,
  submissionKey: i.submission_key || null,
  contractor: i.contractor_id,
  invoiceType: i.invoice_type || "contractor",
  documentKind: i.document_kind || "invoice",
  sourceCapitalQuoteId: i.source_capital_quote_id || null,
  cme: i.cme,
  invoiceDate: formatDate(i.invoice_date),
  invoiceDateRaw: i.invoice_date || null,
  serviceDate: formatDate(i.service_date),
  serviceDateRaw: i.service_date || null,
  dueDate: formatDate(i.due_date),
  terms: i.terms,
  state: i.state,
  subtotal: parseFloat(i.subtotal || 0),
  salesTax: parseFloat(i.sales_tax || 0),
  taxState: i.tax_state || null,
  taxRate: i.tax_rate == null ? null : parseFloat(i.tax_rate),
  taxRateSource: i.tax_rate_source || null,
  taxRateReferenceId: i.tax_rate_reference_id || null,
  taxJurisdictionSnapshot: Array.isArray(i.tax_jurisdiction_snapshot)
    ? i.tax_jurisdiction_snapshot
    : [],
  taxRateVerifiedAt: i.tax_rate_verified_at || null,
  total: parseFloat(i.total || 0),
  territory: i.territory || null,
  pdfStoragePath: i.pdf_storage_path || null,
  qboInvoiceId: i.qbo_invoice_id || null,
  qboSyncedAt: i.qbo_synced_at || null,
  paidAt: i.paid_at || null,
  paymentHoldAt: i.payment_hold_at || null,
  paymentHoldBy: i.payment_hold_by || null,
  paymentHoldReason: i.payment_hold_reason || null,
  date: shortMonthDay(i.invoice_date),
  rejectionReason: i.rejection_reason,
  // Keep the legacy UI alias while newer callers use the explicit field.
  reason: i.rejection_reason,
  reviewRevision: Number(i.review_revision || 1),
  rejectedAt: i.rejected_at || null,
  rejectedBy: i.rejected_by || null,
  resubmittedAt: i.resubmitted_at || null,
  resubmittedBy: i.resubmitted_by || null,
  createdAt: i.created_at,
  updatedAt: i.updated_at,
});

// ── INVOICE PDF STORAGE ────────────────────────────────────────────────────
// Bucket is private; reads use sb.storage.download which authenticates via
// the user's session. Path layout: {invoice_id}/{invoice_number}.pdf.
export async function uploadInvoicePdfObject(
  invoiceId: string,
  invoiceNum: string,
  blob: Blob,
): Promise<string> {
  const sb = supabase();
  const safeInvoiceNum = String(invoiceNum || "invoice").replace(/[^a-zA-Z0-9_-]/g, "-");
  const uploadId = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const path = `${invoiceId}/${safeInvoiceNum}-${uploadId}.pdf`;
  const { error: upErr } = await sb.storage.from("invoice-pdfs").upload(path, blob, {
    contentType: "application/pdf",
    upsert: false,
  });
  if (upErr) throw upErr;
  return path;
}

export async function uploadInvoicePdf(invoiceId: string, invoiceNum: string, blob: Blob): Promise<string> {
  const sb = supabase();
  const path = await uploadInvoicePdfObject(invoiceId, invoiceNum, blob);
  const { error: rowErr } = await (sb as any).rpc(
    "attach_contractor_invoice_pdf",
    { p_invoice_id: invoiceId, p_storage_path: path },
  );
  if (rowErr) throw rowErr;
  return path;
}

export async function downloadInvoicePdfBlob(storagePath: string): Promise<Blob> {
  const sb = supabase();
  const { data, error } = await sb.storage.from("invoice-pdfs").download(storagePath);
  if (error) throw error;
  if (!data) throw new Error("Empty PDF response from storage");
  return data;
}

const mapInvoiceLine = (l: any) => ({
  id: l.id,
  position: l.position,
  type: l.type,
  desc: l.description,
  qty: parseFloat(l.qty),
  rate: parseFloat(l.rate),
  amount: parseFloat(l.amount),
  isTaxable: !!l.is_taxable,
  sourceInvoiceLineId: l.source_invoice_line_id || null,
  sourceWorkOrderPartId: l.source_work_order_part_id || null,
  sourceUnitCost: l.source_unit_cost == null
    ? null
    : parseFloat(l.source_unit_cost),
  markupPercent: l.markup_percent == null
    ? null
    : parseFloat(l.markup_percent),
});

function formatDate(d: string | null): string | null {
  if (!d) return null;
  const [y, m, day] = d.split("-");
  return `${m}/${day}/${y}`;
}
function shortMonthDay(d: string | null): string {
  if (!d) return "";
  const date = new Date(d + "T00:00:00");
  return date.toLocaleString("en-US", { month: "short", day: "numeric" });
}

// ── PHOTO STORAGE URLs ──────────────────────────────────────────────────────
// Photos in DB are storage paths. Authenticated downloads enforce storage
// RLS on every load; blob URLs are revoked when the gallery unmounts.
export async function loadPhotoBlob(path: string): Promise<Blob> {
  if (!path) throw new Error("A photo path is required");
  if (path.startsWith("data:") || path.startsWith("http")) {
    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(`Photo download failed (${response.status})`);
    }
    return response.blob();
  }

  const sb = supabase();
  const { data, error } = await sb.storage.from("photos").download(path);
  if (error) throw error;
  if (!data) throw new Error("Empty photo response from storage");
  return data;
}

export async function getPhotoUrl(path: string): Promise<string | null> {
  if (!path) return null;
  // If it's already a data: URL (legacy in-memory photo), return as-is
  if (path.startsWith("data:") || path.startsWith("http")) return path;
  return URL.createObjectURL(await loadPhotoBlob(path));
}

// ═══════════════════════════════════════════════════════════════════════════
//  MUTATION HELPERS — every do* function in Portal.tsx routes through here
// ═══════════════════════════════════════════════════════════════════════════

// Map UI camelCase → DB snake_case for work_orders updates
const WO_FIELD_MAP: Record<string, string> = {
  contractor: "contractor_id",
  functionalStatus: "functional_status",
  // Header fields editable via the staff "Edit work order" modal. (priority,
  // nte, city, category, summary, description already match their column
  // names so they pass through toDbWoPatch unchanged.)
  store: "store_number",
  addr: "address",
  lineOfService: "line_of_service",
  businessService: "business_service",
  subCategory: "sub_category",
  afm: "afm_name",
  dispatchedAt: "dispatched_at",
  startTime: "start_time",
  endTime: "end_time",
  assetMake: "asset_make",
  assetModel: "asset_model",
  assetSerial: "asset_serial",
  assetYear: "asset_year",
  repairQuote: "repair_quote",
  installQuote: "install_quote",
  capitalNotes: "capital_notes",
  capitalStatus: "capital_status",
  partNeeded: "part_needed",
  partEta: "part_eta",
  invoiceTotal: "invoice_total",
  resolutionCode: "resolution_code",
  resolutionNotes: "resolution_notes",
  isCapital: "is_capital",
  slaStartedAt: "sla_started_at",
  responseBreachAt: "response_breach_at",
  resolutionBreachAt: "resolution_breach_at",
  nteFlagThreshold: "nte_flag_threshold",
  nteFlagged: "nte_flagged",
  nteFlagAmount: "nte_flag_amount",
  closedAt: "closed_at",
  technicianOnJob: "technician_on_job",
  assignedTechnicianProfileId: "assigned_technician_profile_id",
  technicianAssignedAt: "technician_assigned_at",
  technicianAssignedBy: "technician_assigned_by",
  staffNotesSeenAt: "staff_notes_seen_at",
  storeState: "store_state",
  storeTimezone: "store_timezone",
  billingOnly: "billing_only",
  billingReadyAt: "billing_ready_at",
  billingReadyBy: "billing_ready_by",
};
function toDbWoPatch(patch: any): Record<string, any> {
  const out: any = {};
  for (const k of Object.keys(patch)) {
    out[WO_FIELD_MAP[k] || k] = patch[k];
  }
  return out;
}

export async function updateWorkOrder(id: string, patch: any): Promise<any> {
  const sb = supabase();
  const hasAfmEmail = Object.prototype.hasOwnProperty.call(patch || {}, "afmEmail");
  const afmEmail = hasAfmEmail ? String(patch.afmEmail || "").trim() : "";
  const workOrderPatch = { ...(patch || {}) };
  delete workOrderPatch.afmEmail;
  const dbPatch = toDbWoPatch(workOrderPatch);

  const query = Object.keys(dbPatch).length > 0
    ? (sb.from("work_orders") as any).update(dbPatch).eq("id", id).select().single()
    : (sb.from("work_orders") as any).select("*").eq("id", id).single();
  const { data, error } = await query;
  if (error) throw error;

  if (hasAfmEmail) {
    const contactResult = afmEmail
      ? await sb.from("work_order_afm_contacts").upsert({
          work_order_id: id,
          afm_email: afmEmail,
        })
      : await sb.from("work_order_afm_contacts").delete().eq("work_order_id", id);
    if (contactResult.error) throw contactResult.error;
  }
  return data;
}

export async function assignContractorTechnician(
  workOrderId: string,
  technicianProfileId: string | null,
): Promise<any> {
  const sb = supabase();
  const { data, error } = await sb.rpc(
    "assign_contractor_technician",
    {
      p_work_order_id: workOrderId,
      p_technician_profile_id: technicianProfileId,
    },
  );
  if (error) throw error;
  return data;
}

export async function moveWorkOrderStraightToBilling(id: string): Promise<any> {
  const sb = supabase();
  const { data, error } = await (sb as any).rpc(
    "move_work_order_straight_to_billing",
    { p_work_order_id: id },
  );
  if (error) throw error;
  return data;
}

export async function completeCapitalWork(id: string): Promise<any> {
  const sb = supabase();
  const { data, error } = await sb.rpc(
    "complete_capital_work",
    { p_work_order_id: id },
  );
  if (error) throw error;
  return data;
}

export async function closeWorkOrderWithoutInvoice(id: string): Promise<Json> {
  const sb = supabase();
  const { data, error } = await sb.rpc(
    "close_work_order_without_invoice",
    { p_work_order_id: id },
  );
  if (error) throw error;
  return data;
}

export type ReopenWorkOrderResult = {
  applied: boolean;
  reason: "reopened" | "already_open" | string;
  mode?: WorkOrderReopenMode;
  workOrderId: string;
  workOrderStatus: string;
  functionalStatus: string | null;
  closedAt: string | null;
  billingReadyAt?: string | null;
  workflowCycle: number;
};

export async function reopenWorkOrder(
  id: string,
  mode: WorkOrderReopenMode,
  reason: string,
): Promise<ReopenWorkOrderResult> {
  const sb = supabase();
  const { data, error } = await sb.rpc("reopen_work_order", {
    p_work_order_id: id,
    p_mode: mode,
    p_reason: reason,
  });
  if (error) throw error;
  return data as unknown as ReopenWorkOrderResult;
}

export async function markWorkOrderNotesSeen(
  workOrderId: string,
  latestNoteAt: string,
): Promise<void> {
  const sb = supabase();
  const { error } = await (sb.from("work_orders") as any)
    .update({ staff_notes_seen_at: latestNoteAt })
    .eq("id", workOrderId);
  if (error) throw error;
}

export async function openWorkOrderVisit(
  workOrderId: string,
  checkInAt: string,
): Promise<void> {
  const sb = supabase();
  const [{ data: authData }, { data: workOrder, error: workOrderError }] = await Promise.all([
    sb.auth.getUser(),
    sb.from("work_orders")
      .select("contractor_id")
      .eq("id", workOrderId)
      .is("deleted_at", null)
      .single(),
  ]);
  if (workOrderError) throw workOrderError;
  const { error } = await (sb as any).from("work_order_visits").insert({
    work_order_id: workOrderId,
    contractor_id: workOrder?.contractor_id || null,
    check_in_at: checkInAt,
    checked_in_by: authData.user?.id || null,
  });
  if (error) throw error;
}

export async function closeWorkOrderVisit(
  workOrderId: string,
  checkOutAt: string,
): Promise<void> {
  const sb = supabase();
  const { data: authData } = await sb.auth.getUser();
  const { data: visit, error: findError } = await (sb as any)
    .from("work_order_visits")
    .select("id")
    .eq("work_order_id", workOrderId)
    .is("check_out_at", null)
    .order("check_in_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (findError) throw findError;
  if (!visit?.id) return;
  const { error } = await (sb as any)
    .from("work_order_visits")
    .update({
      check_out_at: checkOutAt,
      checked_out_by: authData.user?.id || null,
    })
    .eq("id", visit.id)
    .is("check_out_at", null);
  if (error) throw error;
}

export async function correctWorkOrderVisit(
  visitId: string,
  checkInAt: string,
  checkOutAt: string,
  reason: string,
): Promise<any> {
  const sb = supabase();
  const { data, error } = await (sb as any).rpc("correct_work_order_visit", {
    p_visit_id: visitId,
    p_check_in_at: checkInAt,
    p_check_out_at: checkOutAt,
    p_reason: reason.trim(),
  });
  if (error) throw error;
  return data;
}

export type ActivityAuditOptions = {
  staffOverride?: boolean;
  staffOnly?: boolean;
  overrideForContractorId?: string | null;
  eventKey?: string;
  eventData?: Json;
  requiresSevenElevenSync?: boolean;
  requiresContractorAttention?: boolean;
  activityChannel?: "field_note" | "internal_note" | "contractor_message" | "system_event" | "legacy";
};

function inferActivityEventKey(text: string, type: "note" | "system" | "ai"): string {
  if (type === "ai") return "ai_note";
  const value = text.toLowerCase();
  if (/draft (saved|updated)/.test(value)) return "invoice_draft";
  if (/invoice .*uploaded|uploaded invoice/.test(value)) return "invoice_uploaded";
  if (/invoice .*submitted/.test(value)) return "invoice_submitted";
  if (/checked in|started work/.test(value)) return "check_in";
  if (/job completed|clocked out/.test(value)) return "job_completed";
  if (/work paused/.test(value)) return "job_paused";
  if (/^part added/.test(value)) return "part_added";
  if (/^part removed/.test(value)) return "part_removed";
  if (/part|tracking|return date/.test(value)) return "part_updated";
  if (/added .*photo/.test(value)) return "photo_added";
  if (/photo removed/.test(value)) return "photo_removed";
  if (/eta set/.test(value)) return "eta_updated";
  if (/technician on job/.test(value)) return "technician_updated";
  if (/^reassigned from /.test(value)) return "work_order_reassigned";
  if (/^(?:dispatched|assigned) to /.test(value)) return "work_order_assignment";
  if (/^work order unassigned by /.test(value)) return "work_order_unassigned";
  if (/dispatched|assigned|unassigned/.test(value)) return "assignment";
  if (/moved to|status|reopened|closed/.test(value)) return "status_change";
  return type === "system" ? "system" : "note";
}

export async function insertActivity(
  workOrderId: string,
  authorName: string,
  text: string,
  type: "note" | "system" | "ai" = "note",
  audit: ActivityAuditOptions = {},
): Promise<string | null> {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  const eventKey = audit.eventKey || inferActivityEventKey(text, type);
  const insert = sb
    .from("activities")
    .insert({
      work_order_id: workOrderId,
      author_id: user?.id || null,
      author_name: authorName,
      text,
      type,
      is_staff_override: !!audit.staffOverride,
      is_staff_only: !!audit.staffOnly,
      override_for_contractor_id: audit.staffOverride
        ? audit.overrideForContractorId || null
        : null,
      event_key: eventKey,
      event_data: audit.eventData || {},
      requires_7eleven_sync: !!audit.requiresSevenElevenSync,
      requires_contractor_attention: !!audit.requiresContractorAttention,
      activity_channel: audit.activityChannel || "legacy",
    });

  // Preserve the lean write-only behavior used by existing activity callers.
  // Only the automatic contractor-alert path needs the inserted identifier.
  if (!audit.requiresContractorAttention) {
    const { error } = await insert;
    if (error) throw error;
    return null;
  }

  const { data, error } = await insert.select("id").single();
  if (error) throw error;
  return data.id;
}

export async function markActivitySevenElevenSynced(
  activityId: string,
  synced: boolean,
): Promise<void> {
  const sb = supabase();
  const { error } = await sb.from("activities")
    .update({
      synced_to_7eleven_at: synced ? new Date().toISOString() : null,
      synced_to_7eleven_by: null,
    })
    .eq("id", activityId);
  if (error) throw error;
}

export async function markActivityContractorAttention(
  activityId: string,
  required: boolean,
): Promise<void> {
  const sb = supabase();
  const { error } = await sb.rpc("set_activity_contractor_attention", {
    p_activity_id: activityId,
    p_required: required,
  });
  if (error) throw error;
}

export async function acknowledgeContractorAttention(
  activityId: string,
): Promise<void> {
  const sb = supabase();
  const { error } = await sb.rpc("acknowledge_contractor_attention", {
    p_activity_id: activityId,
  });
  if (error) throw error;
}

// Soft delete — the row stays in the DB but loadWorkOrders filters it out.
// RLS allows the author to update their own row, and managers/dispatchers/
// back-office (is_staff) to update any row.
export async function deleteActivity(activityId: string): Promise<void> {
  const sb = supabase();
  const { error } = await sb.from("activities")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", activityId);
  if (error) throw error;
}

// Soft delete only — sets deleted_at + deleted_by, never hard delete.
// Related invoices / photos / activities are intentionally left intact so
// the row can be restored via SQL. Writes a system activity entry as the
// audit trail for this destructive (but recoverable) action.
export async function deleteWorkOrder(workOrderId: string, authorName: string): Promise<void> {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  const { error } = await sb.from("work_orders").update({
    deleted_at: new Date().toISOString(),
    deleted_by: user?.id || null,
  }).eq("id", workOrderId);
  if (error) throw error;
  await insertActivity(workOrderId, "System", `Work order deleted by ${authorName}.`, "system");
}

export type RejectUnassignedWorkOrderResult = {
  applied: boolean;
  reason: string;
  workOrderId: string;
  rejectedAt: string;
  rejectedBy: string;
};

export async function rejectUnassignedWorkOrder(
  workOrderId: string,
  reason: string,
): Promise<RejectUnassignedWorkOrderResult> {
  const sb = supabase();
  const { data, error } = await sb.rpc("reject_unassigned_work_order", {
    p_work_order_id: workOrderId,
    p_reason: reason,
  });
  if (error) throw error;
  return data as unknown as RejectUnassignedWorkOrderResult;
}

export type DuplicateWorkOrderForReassignmentResult = {
  applied: boolean;
  reason: string;
  sourceWorkOrderId: string;
  rootWorkOrderId: string;
  workOrderId: string;
  duplicateSequence: number;
  deliveryId: string | null;
  deliveryStatus: AssignmentTransitionDeliveryStatus | null;
};

export async function duplicateWorkOrderForReassignment(
  workOrderId: string,
): Promise<DuplicateWorkOrderForReassignmentResult> {
  const sb = supabase();
  const { data, error } = await sb.rpc(
    "duplicate_work_order_for_reassignment_notified",
    { p_source_work_order_id: workOrderId },
  );
  if (error) throw error;
  return data as unknown as DuplicateWorkOrderForReassignmentResult;
}

export type AssignmentTransitionDeliveryStatus =
  | "pending"
  | "claimed"
  | "sent"
  | "unknown"
  | "skipped";

export type WorkOrderContractorTransitionResult = {
  applied: boolean;
  reason: "assigned" | "reassigned" | "unassigned" | string;
  workOrderId: string;
  contractorId: string | null;
  assignmentVersion: number;
  status: string;
  functionalStatus: string | null;
  isCapital: boolean;
  capitalStatus: string | null;
  assignmentStartedAt: string | null;
  dispatchedAt: string | null;
  deliveryId: string | null;
  deliveryStatus: AssignmentTransitionDeliveryStatus | null;
};

export async function transitionWorkOrderContractor(
  workOrderId: string,
  newContractorId: string | null,
  expectedAssignmentVersion: number,
): Promise<WorkOrderContractorTransitionResult> {
  const sb = supabase();
  const { data, error } = await sb.rpc(
    "transition_work_order_contractor",
    {
      p_work_order_id: workOrderId,
      p_new_contractor_id: newContractorId,
      p_expected_assignment_version: expectedAssignmentVersion,
    },
  );
  if (error) throw error;
  return data as WorkOrderContractorTransitionResult;
}

export type DeclineCapitalWorkOrderResult = {
  applied: boolean;
  reason: "capital_declined" | string;
  workOrderId: string;
  status: string;
  functionalStatus: string | null;
  contractorId: string | null;
  assignmentVersion: number;
  isCapital: boolean;
  capitalStatus: string | null;
  activityId: string | null;
};

export async function declineCapitalWorkOrder(
  workOrderId: string,
  expectedAssignmentVersion: number,
): Promise<DeclineCapitalWorkOrderResult> {
  const sb = supabase();
  const { data, error } = await sb.rpc("decline_capital_work_order", {
    p_work_order_id: workOrderId,
    p_expected_assignment_version: expectedAssignmentVersion,
  });
  if (error) throw error;
  return data as DeclineCapitalWorkOrderResult;
}

// Invoice soft delete is routed through an authenticated staff-only endpoint.
// The server verifies the updated row and records an audit without allowing an
// audit failure to masquerade as a failed delete. WO status remains unchanged.
export async function deleteInvoice(invoiceId: string): Promise<void> {
  const sb = supabase();
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session expired. Sign in and try again.");
  const response = await fetch(
    `/api/contractor-invoices?id=${encodeURIComponent(invoiceId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Invoice delete failed");
  }
}

export async function deleteOwnContractorInvoice(
  invoiceId: string,
): Promise<Record<string, unknown>> {
  const sb = supabase();
  const { data, error } = await (sb as any).rpc(
    "delete_own_contractor_invoice",
    { p_invoice_id: invoiceId },
  );
  if (error) throw error;
  return (data || {}) as Record<string, unknown>;
}

export type FinishContractorInvoicingResult = {
  applied: boolean;
  reason: "completed" | "already_complete" | string;
  workOrderId: string;
  workOrderStatus: string;
  completedAt: string;
  completedBy?: string | null;
  source?: "contractor" | "staff_override" | "legacy" | string;
  invoiceCount?: number;
};

export type CompleteContractorWorkAndInvoicingResult =
  FinishContractorInvoicingResult & {
    workCompletionApplied: boolean;
    workCompletionReason?: string | null;
    completionActivityId?: string | null;
    invoicingCompletionApplied: boolean;
  };

export async function completeContractorWorkAndInvoicing(
  workOrderId: string,
  {
    completedAt,
    assetMake,
    assetModel,
    assetSerial,
    assetYear,
    resolutionCode,
    resolutionNotes,
    activityText,
  }: {
    completedAt: string;
    assetMake: string;
    assetModel: string;
    assetSerial: string;
    assetYear?: number | null;
    resolutionCode?: string | null;
    resolutionNotes?: string | null;
    activityText: string;
  },
): Promise<CompleteContractorWorkAndInvoicingResult> {
  const sb = supabase();
  const { data, error } = await (sb as any).rpc(
    "complete_contractor_work_and_invoicing",
    {
      p_work_order_id: workOrderId,
      p_completed_at: completedAt,
      p_asset_make: assetMake,
      p_asset_model: assetModel,
      p_asset_serial: assetSerial,
      p_asset_year: assetYear || null,
      p_resolution_code: resolutionCode || null,
      p_resolution_notes: resolutionNotes || null,
      p_activity_text: activityText,
    },
  );
  if (error) throw error;
  return data as CompleteContractorWorkAndInvoicingResult;
}

export async function finishContractorInvoicing(
  workOrderId: string,
): Promise<FinishContractorInvoicingResult> {
  const sb = supabase();
  const { data, error } = await (sb as any).rpc(
    "finish_contractor_invoicing",
    { p_work_order_id: workOrderId },
  );
  if (error) throw error;
  return data as FinishContractorInvoicingResult;
}

// Case-insensitive WOT lookup. The manual Create form has an in-memory
// dedup check, but the source of truth is the DB — a duplicate could
// have landed from another session since the local cache was loaded.
// Returns the canonical existing id (or null) so the caller can render
// an "open it instead?" affordance with the actual stored casing.
export async function findExistingWoId(
  wot: string
): Promise<{ id: string; deleted: boolean } | null> {
  const trimmed = (wot || "").trim();
  if (!trimmed) return null;
  const sb = supabase();
  const escaped = trimmed.replace(/[\\%_]/g, m => "\\" + m);

  // Check active first.
  const { data: active, error: activeError } = await sb
    .from("work_orders")
    .select("id")
    .ilike("id", escaped)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if (activeError) throw activeError;
  if (active) return { id: active.id, deleted: false };

  // Check soft deleted.
  const { data: deleted, error: deletedError } = await sb
    .from("work_orders")
    .select("id")
    .ilike("id", escaped)
    .not("deleted_at", "is", null)
    .limit(1)
    .maybeSingle();
  if (deletedError) throw deletedError;
  if (deleted) return { id: deleted.id, deleted: true };

  return null;
}

// Atomically generate the next FWKD work order ID via a Postgres sequence
export async function nextWorkOrderId(): Promise<{ wo: string; inc: string }> {
  const sb = supabase();
  const { data, error } = await (sb as any).rpc("next_wo_id");
  if (error) throw error;
  // Returns shape { wo: 'FWKD11400001', inc: 'INC24000001' }
  return data;
}

export async function completeWorkOrderOnce(
  workOrderId: string,
  {
    completedAt,
    assetMake,
    assetModel,
    assetSerial,
    assetYear,
    resolutionCode,
    resolutionNotes,
    activityText,
  }: {
    completedAt: string;
    assetMake: string;
    assetModel: string;
    assetSerial: string;
    assetYear?: number | null;
    resolutionCode?: string | null;
    resolutionNotes?: string | null;
    activityText: string;
  },
): Promise<{
  applied: boolean;
  reason?: string;
  activityId?: string;
  workOrderStatus?: string;
}> {
  const sb = supabase();
  const { data, error } = await sb.rpc("complete_work_order_once", {
    p_work_order_id: workOrderId,
    p_completed_at: completedAt,
    p_asset_make: assetMake,
    p_asset_model: assetModel,
    p_asset_serial: assetSerial,
    p_asset_year: assetYear || null,
    p_resolution_code: resolutionCode || null,
    p_resolution_notes: resolutionNotes || null,
    p_activity_text: activityText,
  });
  if (error) throw error;
  return (data || { applied: true }) as {
    applied: boolean;
    reason?: string;
    activityId?: string;
    workOrderStatus?: string;
  };
}

export async function insertWorkOrder(wo: any, activityText?: string, authorName?: string): Promise<WorkOrder> {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  // SLA clock starts at intake (creation), NOT at assignment. For email-
  // ingested WOs (Phase 1.5), pass slaStartedAt as the email's received-at;
  // for portal-created WOs we use now.
  const startedAt = wo.slaStartedAt ? new Date(wo.slaStartedAt) : new Date();
  const breaches = computeSlaBreaches(wo.priority, startedAt);
  // Best-effort: keep the stores table populated for the Stores/Kanban
  // context. The store_number FK was dropped (migration 0004) so a failed
  // store upsert must NOT block work-order creation — swallow any error.
  if (wo.store) {
    try {
      const [city, state] = String(wo.city || "").split(",").map((s: string) => s.trim());
      await sb.from("stores").upsert(
        { store_number: wo.store, city: city || null, state: state || null, address: wo.addr || null },
        { onConflict: "store_number", ignoreDuplicates: true },
      );
    } catch { /* store upsert is non-critical — never block WO creation */ }
  }
  const dbRow = {
    id: wo.id,
    incident_id: wo.incidentId,
    store_number: wo.store,
    city: wo.city,
    address: wo.addr,
    store_state: wo.storeState || stateCodeFromWorkOrder(wo) || null,
    store_timezone: wo.storeTimezone || timezoneForWorkOrder(wo),
    line_of_service: wo.lineOfService,
    business_service: wo.businessService,
    category: wo.category,
    sub_category: wo.subCategory,
    summary: wo.summary,
    description: wo.description,
    priority: wo.priority,
    status: wo.status,
    functional_status: wo.functionalStatus,
    contractor_id: wo.contractor || null,
    afm_name: wo.afm || null,
    afm_email: null,
    nte: wo.nte || 0,
    dispatched_at: wo.dispatchedAt || null,
    is_capital: !!wo.isCapital,
    source: wo.source || "manual",
    sla_started_at: startedAt.toISOString(),
    response_breach_at: breaches.responseBreachAt?.toISOString() ?? null,
    resolution_breach_at: breaches.resolutionBreachAt?.toISOString() ?? null,
    created_by: user?.id || null,
  };
  const { data, error } = await sb.from("work_orders").insert(dbRow).select().single();
  if (error) throw error;
  if (String(wo.afmEmail || "").trim()) {
    const { error: afmContactError } = await sb
      .from("work_order_afm_contacts")
      .upsert({
        work_order_id: wo.id,
        afm_email: String(wo.afmEmail).trim(),
      });
    if (afmContactError) throw afmContactError;
  }
  if (activityText && authorName) {
    await insertActivity(wo.id, authorName, activityText, "system");
  }
  return data as unknown as WorkOrder;
}

// Source-of-truth invoice numbering. The RPC can see the global numeric
// sequence without exposing other contractors' invoices through RLS. The
// 6500 floor and soft-deleted-number handling live in the database function.
export async function nextInvoiceNumFromDb(): Promise<string> {
  const sb = supabase();
  const { data, error } = await sb.rpc("next_contractor_invoice_num");
  if (error) throw error;
  const nextNum = String(data || "").trim();
  if (!/^\d+$/.test(nextNum)) {
    throw new Error("Invoice number allocator returned an invalid value");
  }
  return nextNum;
}

// Postgres unique-violation. We need to distinguish "number collided" from
// other errors so the caller can retry or surface a friendly message.
const isInvoiceNumCollision = (err: any): boolean => {
  if (!err) return false;
  if (err.code === "23505") return true;                            // canonical
  const msg = String(err.message || err.details || "").toLowerCase();
  return msg.includes("invoices_num_key") || (msg.includes("duplicate") && msg.includes("num"));
};

// Retry wrapper around the insert. If the user typed a specific number we
// throw with `attemptedNum` set so the UI can show "X already exists, using
// Y instead"; if it was auto-suggested we just resolve a fresh number and
// retry transparently. Bounded to a small attempt count.
async function insertInvoiceWithRetry(
  baseRow: any,
  desiredNum: string,
  userTyped: boolean,
): Promise<{ header: any; finalNum: string; collidedFrom: string | null }> {
  const sb = supabase();
  let tryNum = desiredNum;
  let collidedFrom: string | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, error } = await sb.from("invoices").insert({ ...baseRow, num: tryNum }).select().single();
    if (!error) return { header: data, finalNum: tryNum, collidedFrom };
    if (!isInvoiceNumCollision(error)) throw error;
    if (userTyped) {
      const conflict: any = new Error(
        `Invoice #${tryNum} already exists for this contractor`,
      );
      conflict.code = "INVOICE_NUM_CONFLICT";
      throw conflict;
    }
    if (attempt === 0) collidedFrom = tryNum;
    tryNum = await nextInvoiceNumFromDb();
    // Guard against the absurd "DB says next is the same one that just
    // collided" case (shouldn't happen, but if it does bump explicitly).
    if (tryNum === collidedFrom || tryNum === baseRow.num) {
      tryNum = String((parseInt(tryNum) || 6500) + 1);
    }
  }
  throw new Error("Could not allocate an unused invoice number after several attempts. Please try again.");
}

export async function insertInvoice(inv: any, lines: any[], authorName: string): Promise<Invoice> {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  // Insert header
  const calculatedSubtotal = lines.reduce((s, l) => s + (parseFloat(l.qty) || 0) * (parseFloat(l.rate) || 0), 0);
  const salesTax = parseFloat(inv.salesTax ?? inv.tax) || 0;
  const hasTotalOverride = inv.totalOverride !== undefined
    && Number.isFinite(Number(inv.totalOverride));
  const total = hasTotalOverride ? Number(inv.totalOverride) : calculatedSubtotal + salesTax;
  const subtotal = hasTotalOverride ? Math.max(total - salesTax, 0) : calculatedSubtotal;
  const todayIso = new Date().toISOString().slice(0, 10);
  // Resolve the number at insert time. If the caller passed a number, prefer
  // it (the user may have typed one); otherwise pull a fresh one from the DB
  // so we don't trust stale React-Query cache.
  const userTyped = !!inv.userTypedNum;
  const baseNum = inv.num && String(inv.num).trim()
    ? String(inv.num).trim()
    : await nextInvoiceNumFromDb();
  const requestedState = inv.state === "draft" ? "draft" : "submitted";
  if (requestedState === "submitted") {
    if (!inv.submissionKey) {
      throw new Error("Invoice submission key is missing. Close and reopen the invoice form.");
    }

    const rpcLines = lines.map((line) => ({
      type: line.type || "Other",
      description: line.desc || line.description || "",
      qty: parseFloat(line.qty) || 1,
      rate: parseFloat(line.rate) || 0,
    }));
    const { data, error } = await (sb as any).rpc(
      "submit_contractor_invoice_once",
      {
        p_submission_key: inv.submissionKey,
        p_work_order_id: inv.wot,
        p_num: baseNum,
        p_user_typed_num: userTyped,
        p_cme: inv.cme || null,
        p_store_address: inv.storeAddr || null,
        p_invoice_date: inv.invoiceDate || todayIso,
        p_service_date: inv.serviceDate || null,
        p_due_date: inv.dueDate || null,
        p_terms: inv.terms || "Net 30",
        p_sales_tax: salesTax,
        p_total_override: hasTotalOverride ? total : null,
        p_lines: rpcLines,
      },
    );
    if (error) {
      if (isInvoiceNumCollision(error)) {
        const conflict: any = new Error(
          error.message || `Invoice #${baseNum} already exists for this contractor`,
        );
        conflict.code = "INVOICE_NUM_CONFLICT";
        throw conflict;
      }
      throw error;
    }

    const header = Array.isArray(data) ? data[0] : data;
    if (!header?.id) throw new Error("Invoice submission returned no invoice");
    const finalNum = String(header.num || baseNum);
    return {
      ...header,
      num: finalNum,
      total: parseFloat(header.total ?? total),
      _collidedFrom: finalNum !== baseNum ? baseNum : null,
    } as unknown as Invoice;
  }

  const baseRow = {
    work_order_id: inv.wot,
    store_number: inv.store,
    store_address: inv.storeAddr || null,
    contractor_id: inv.contractor || null,
    cme: inv.cme || null,
    invoice_date: inv.invoiceDate || todayIso,
    service_date: inv.serviceDate || null,
    due_date: inv.dueDate || null,
    terms: inv.terms || "Net 30",
    // New submissions use the atomic RPC above. This path only persists a
    // draft, whose line rows remain editable by the assigned contractor.
    state: "draft",
    subtotal,
    sales_tax: salesTax,
    total,
    created_by: user?.id || null,
  };
  let header: any;
  let finalNum: string;
  let collidedFrom: string | null = null;
  try {
    const res = await insertInvoiceWithRetry(baseRow, baseNum, userTyped);
    header = res.header;
    finalNum = res.finalNum;
    collidedFrom = res.collidedFrom;
  } catch (e: any) {
    // Bubble a tagged error so the hook can shape the toast.
    if (isInvoiceNumCollision(e)) {
      const err: any = new Error(e.message || "Invoice number conflict");
      err.code = "INVOICE_NUM_CONFLICT";
      throw err;
    }
    throw e;
  }
  // Insert lines (1:N)
  if (lines.length > 0) {
    const lineRows = lines.map((l, i) => ({
      invoice_id: header.id,
      position: i + 1,
      type: l.type,
      description: l.desc || l.description || "",
      qty: parseFloat(l.qty) || 1,
      rate: parseFloat(l.rate) || 0,
    }));
    const { error: lErr } = await sb.from("invoice_lines").insert(lineRows);
    if (lErr) throw lErr;
  }
  // Drafts must NOT touch the parent WO — saving a draft mid-visit can't
  // advance the WO into pending_approval and can't write an audit entry that
  // claims it was submitted. Only the submit path moves the WO forward.
  await insertActivity(inv.wot, authorName, `Invoice ${finalNum} draft saved.`, "system");
  // Surface the resolved number + the collided-from number so the caller can
  // show "X already exists, using Y instead" without parsing the row again.
  return { ...header, num: finalNum, total, _collidedFrom: collidedFrom } as unknown as Invoice;
}

// Update an existing invoice's lines (full replace) + recompute totals.
// Used to resume an existing draft and either re-save or submit it. Does
// NOT touch WO status — the caller decides via updateInvoiceState whether
// this is still a draft or a real submission.
export async function updateInvoiceWithLines(
  invoiceId: string,
  patch: { num?: string; userTypedNum?: boolean; cme?: string | null; invoiceDate?: string; serviceDate?: string | null; terms?: string; storeAddr?: string | null; state?: string; salesTax?: number; totalOverride?: number },
  lines: any[],
): Promise<{ id: string; num: string; subtotal: number; salesTax: number; total: number; collidedFrom: string | null }> {
  const sb = supabase();
  const calculatedSubtotal = lines.reduce((s, l) => s + (parseFloat(l.qty) || 0) * (parseFloat(l.rate) || 0), 0);
  const salesTax = parseFloat(patch.salesTax as any) || 0;
  const hasTotalOverride = patch.totalOverride !== undefined
    && Number.isFinite(Number(patch.totalOverride));
  const total = hasTotalOverride ? Number(patch.totalOverride) : calculatedSubtotal + salesTax;
  const subtotal = hasTotalOverride ? Math.max(total - salesTax, 0) : calculatedSubtotal;
  const update: any = {
    subtotal, sales_tax: salesTax, total,
    updated_at: new Date().toISOString(),
  };
  if (patch.cme !== undefined) update.cme = patch.cme || null;
  if (patch.invoiceDate) update.invoice_date = patch.invoiceDate;
  if (patch.serviceDate !== undefined) update.service_date = patch.serviceDate || null;
  if (patch.terms) update.terms = patch.terms;
  if (patch.storeAddr !== undefined) update.store_address = patch.storeAddr || null;
  const { data: currentInvoice, error: currentInvoiceError } = await sb
    .from("invoices")
    .select("num,state")
    .eq("id", invoiceId)
    .maybeSingle();
  if (currentInvoiceError) throw currentInvoiceError;
  if (!currentInvoice) throw new Error("Invoice was not found");

  const requestedState = patch.state || currentInvoice.state;
  const deferSubmission = currentInvoice.state === "draft"
    && requestedState === "submitted";
  if (patch.state && !deferSubmission) update.state = patch.state;
  // Preserve contractor-supplied invoice numbers exactly. A conflict within
  // the same contractor is surfaced instead of silently renumbering it.
  let finalNum: string | null = patch.num != null ? String(patch.num).trim() : null;
  let collidedFrom: string | null = null;
  const userTyped = !!patch.userTypedNum;
  // Pre-flight: read the current invoice's num so we know whether the user
  // is actually changing it. If they're keeping it the same, no collision is
  // possible (it's their own row).
  const originalNum: string | null = currentInvoice.num ?? null;
  // Try the update. If num collides, regenerate and retry; otherwise leave
  // num out of the update payload and just write the rest.
  let attempts = 0;
  while (true) {
    const writeNum = finalNum != null && finalNum !== originalNum;
    const payload = writeNum ? { ...update, num: finalNum } : update;
    const { error: uErr } = await sb.from("invoices").update(payload).eq("id", invoiceId);
    if (!uErr) break;
    if (!isInvoiceNumCollision(uErr) || attempts >= 5 || finalNum == null) throw uErr;
    if (userTyped) {
      const conflict: any = new Error(
        `Invoice #${finalNum} already exists for this contractor`,
      );
      conflict.code = "INVOICE_NUM_CONFLICT";
      throw conflict;
    }
    if (attempts === 0) collidedFrom = finalNum;
    finalNum = await nextInvoiceNumFromDb();
    if (finalNum === collidedFrom) finalNum = String((parseInt(finalNum) || 6500) + 1);
    attempts++;
  }
  // Replace lines: simpler + safer than diffing while editing a draft. The
  // table has on-delete-cascade so this is a single round trip per side.
  const { error: dErr } = await sb.from("invoice_lines").delete().eq("invoice_id", invoiceId);
  if (dErr) throw dErr;
  if (lines.length > 0) {
    const rows = lines.map((l, i) => ({
      invoice_id: invoiceId,
      position: i + 1,
      type: l.type,
      description: l.desc || l.description || "",
      qty: parseFloat(l.qty) || 1,
      rate: parseFloat(l.rate) || 0,
    }));
    const { error: lErr } = await sb.from("invoice_lines").insert(rows);
    if (lErr) throw lErr;
  }
  if (deferSubmission) {
    const { error: submitError } = await sb
      .from("invoices")
      .update({ state: "submitted" })
      .eq("id", invoiceId)
      .eq("state", "draft");
    if (submitError) throw submitError;
  }
  return { id: invoiceId, num: (finalNum ?? originalNum ?? "") as string, subtotal, salesTax, total, collidedFrom };
}

export async function correctContractorInvoiceTotal(
  invoiceId: string,
  total: number,
  reason?: string,
): Promise<any> {
  const sb = supabase();
  const { data, error } = await (sb as any).rpc(
    "correct_contractor_invoice_total",
    {
      p_invoice_id: invoiceId,
      p_total: total,
      p_reason: reason?.trim() || null,
    },
  );
  if (error) throw error;
  return data;
}

export type ContractorInvoiceReviewResult = {
  invoiceId: string;
  invoiceNum: string;
  invoiceState: "submitted" | "approved" | "rejected" | "revised" | "paid";
  workOrderId: string;
  workOrderStatus: "pending_invoice" | "pending_approval" | "closed" | null;
  reviewRevision: number;
  rejectionReason?: string | null;
  total?: number;
  pdfStoragePath?: string | null;
};

export type BatchContractorInvoiceReviewResult = {
  action: "approve" | "reject";
  count: number;
  invoiceIds: string[];
  results: ContractorInvoiceReviewResult[];
};

export async function reviewContractorInvoice(
  invoiceId: string,
  action: "approve" | "reject",
  reason?: string | null,
): Promise<ContractorInvoiceReviewResult> {
  const sb = supabase();
  const { data, error } = await (sb as any).rpc(
    "review_contractor_invoice",
    {
      p_invoice_id: invoiceId,
      p_action: action,
      p_reason: reason?.trim() || null,
    },
  );
  if (error) throw error;
  return data as ContractorInvoiceReviewResult;
}

export async function reviewContractorInvoices(
  invoiceIds: string[],
  action: "approve" | "reject",
  reason?: string | null,
): Promise<BatchContractorInvoiceReviewResult> {
  const sb = supabase();
  const { data, error } = await (sb as any).rpc(
    "review_contractor_invoices",
    {
      p_invoice_ids: invoiceIds,
      p_action: action,
      p_reason: reason?.trim() || null,
    },
  );
  if (error) throw error;
  return data as BatchContractorInvoiceReviewResult;
}

export async function resubmitRejectedContractorInvoice(
  invoiceId: string,
  patch: {
    cme?: string | null;
    storeAddr?: string | null;
    invoiceDate?: string | null;
    serviceDate?: string | null;
    terms?: string | null;
    salesTax?: number | null;
    totalOverride?: number | null;
    pdfStoragePath?: string | null;
  },
  lines: any[],
): Promise<ContractorInvoiceReviewResult> {
  const sb = supabase();
  const rpcLines = lines.map(line => ({
    type: line.type || "Other",
    description: line.desc || line.description || "",
    qty: parseFloat(line.qty) || 1,
    rate: parseFloat(line.rate) || 0,
  }));
  const { data, error } = await (sb as any).rpc(
    "resubmit_rejected_contractor_invoice",
    {
      p_invoice_id: invoiceId,
      p_cme: patch.cme || null,
      p_store_address: patch.storeAddr || null,
      p_invoice_date: patch.invoiceDate || null,
      p_service_date: patch.serviceDate || null,
      p_terms: patch.terms || "Net 30",
      p_sales_tax: patch.salesTax ?? 0,
      p_total_override: patch.totalOverride ?? null,
      p_lines: rpcLines,
      p_pdf_storage_path: patch.pdfStoragePath || null,
    },
  );
  if (error) throw error;
  return data as ContractorInvoiceReviewResult;
}

export async function retractContractorInvoiceRejection(
  invoiceId: string,
): Promise<ContractorInvoiceReviewResult> {
  const sb = supabase();
  const { data, error } = await (sb as any).rpc(
    "retract_contractor_invoice_rejection",
    { p_invoice_id: invoiceId },
  );
  if (error) throw error;
  return data as ContractorInvoiceReviewResult;
}

// Patch an invoice's state (and optionally paid_at). Used by the Owner
// approve / mark-paid actions that carry a WO from pending_approval → closed.
export async function updateInvoiceState(invoiceId: string, state: string, extra: Record<string, any> = {}): Promise<void> {
  const sb = supabase();
  const { error } = await sb.from("invoices").update({ state: state as any, ...extra }).eq("id", invoiceId);
  if (error) throw error;
}

export async function insertWorkReport(
  report: any,
  authorName?: string,
  audit: ActivityAuditOptions = {},
): Promise<{ success: boolean; error?: unknown }> {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  const { error } = await sb.from("work_reports").insert({
    work_order_id: report.workOrderId,
    contractor_id: user?.id || null,
    technician_name: report.technicianName || null,
    arrival_time: report.arrivalTime || null,
    departure_time: report.departureTime || null,
    work_performed: report.workPerformed || null,
    parts_used: report.partsUsed || [],
    resolution_code: report.resolutionCode || null,
    resolution_notes: report.resolutionNotes || null,
  });
  if (error) return { success: false, error };
  if (authorName) {
    try {
      await insertActivity(
        report.workOrderId,
        authorName,
        `Work report submitted${report.technicianName ? ` for ${report.technicianName}` : ""}.`,
        "note",
        audit,
      );
    } catch (activityError) {
      return { success: false, error: activityError };
    }
  }
  return { success: true };
}

// ── WO PARTS ───────────────────────────────────────────────────────────────
// Structured parts-tracking list per WO. Loaded once and grouped client-side
// like invoice_lines, so the WORK_ORDERS_KEY cache stays the single source.
const mapWoPart = (p: any) => ({
  id: p.id,
  workOrderId: p.work_order_id,
  description: p.description,
  partNumber: p.part_number || "",
  qty: p.qty != null ? Number(p.qty) : 1,
  status: p.status as "ordered" | "backordered" | "shipped" | "received",
  trackingNumber: p.tracking_number || "",
  expectedReturnDate: p.expected_return_date || null,
  notes: p.notes || "",
  orderingResponsibility: p.ordering_responsibility || "contractor",
  p1OrderStatus: p.p1_order_status || null,
  p1RequestedAt: p.p1_requested_at || null,
  p1RequestedBy: p.p1_requested_by || null,
  p1ResolvedAt: p.p1_resolved_at || null,
  p1ResolvedBy: p.p1_resolved_by || null,
  createdAt: p.created_at,
  updatedAt: p.updated_at,
});

export async function loadWoParts(): Promise<any[]> {
  const sb = supabase();
  const rows = await collectSupabasePages<any>((from, to) => (sb as any)
    .from("wo_parts")
    .select("*")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(from, to));
  return rows.map(mapWoPart);
}

export async function loadWoPartsForWorkOrder(workOrderId: string): Promise<any[]> {
  if (!workOrderId) return [];
  const sb = supabase();
  const { data, error } = await (sb as any)
    .from("wo_parts")
    .select("*")
    .eq("work_order_id", workOrderId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;
  return (data || []).map(mapWoPart);
}

export async function insertWoPart(part: {
  workOrderId: string;
  description: string;
  partNumber?: string;
  qty?: number;
  status?: "ordered" | "backordered" | "shipped" | "received";
  trackingNumber?: string;
  expectedReturnDate?: string | null;
}): Promise<any> {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  const { data, error } = await (sb as any).from("wo_parts").insert({
    work_order_id: part.workOrderId,
    description: part.description,
    part_number: part.partNumber || null,
    qty: part.qty != null ? part.qty : 1,
    status: part.status || "ordered",
    tracking_number: part.trackingNumber || null,
    expected_return_date: part.expectedReturnDate || null,
    created_by: user?.id || null,
  }).select().single();
  if (error) throw error;
  return mapWoPart(data);
}

export async function updateWoPart(
  id: string,
  patch: {
    description?: string;
    partNumber?: string | null;
    qty?: number;
    status?: "ordered" | "backordered" | "shipped" | "received";
    trackingNumber?: string | null;
    expectedReturnDate?: string | null;
  }
): Promise<any> {
  const sb = supabase();
  const dbPatch: any = { updated_at: new Date().toISOString() };
  if (patch.description !== undefined) dbPatch.description = patch.description;
  if (patch.partNumber !== undefined) dbPatch.part_number = patch.partNumber || null;
  if (patch.qty !== undefined) dbPatch.qty = patch.qty;
  if (patch.status !== undefined) dbPatch.status = patch.status;
  if (patch.trackingNumber !== undefined) dbPatch.tracking_number = patch.trackingNumber || null;
  if (patch.expectedReturnDate !== undefined) dbPatch.expected_return_date = patch.expectedReturnDate || null;
  const { data, error } = await ((sb as any).from("wo_parts") as any).update(dbPatch).eq("id", id).select().single();
  if (error) throw error;
  return mapWoPart(data);
}

export async function deleteWoPart(id: string): Promise<void> {
  const sb = supabase();
  const { error } = await (sb as any).from("wo_parts").delete().eq("id", id);
  if (error) throw error;
}

export async function requestP1PartOrder(id: string): Promise<any> {
  const sb = supabase();
  const { data, error } = await (sb as any)
    .rpc("request_p1_part_order", { p_part_id: id });
  if (error) throw error;
  return mapWoPart(data);
}

export async function setP1PartOrderStatus(
  id: string,
  status: "requested" | "ordered" | "received" | "cancelled",
): Promise<any> {
  const sb = supabase();
  const { data, error } = await (sb as any)
    .rpc("set_p1_part_order_status", {
      p_part_id: id,
      p_status: status,
    });
  if (error) throw error;
  return mapWoPart(data);
}

export async function loadP1PartCostsForWorkOrder(
  workOrderId: string,
): Promise<any[]> {
  if (!workOrderId) return [];
  const sb = supabase();
  const { data, error } = await (sb as any).rpc(
    "list_p1_part_costs_for_work_order",
    { p_work_order_id: workOrderId },
  );
  if (error) throw error;
  return (data || []).map((row: any) => ({
    partId: row.part_id,
    unitCost: Number(row.unit_cost),
    updatedAt: row.updated_at || null,
    updatedBy: row.updated_by || null,
  }));
}

export async function loadBillableP1Parts(
  workOrderId: string,
  excludeInvoiceId?: string | null,
): Promise<any[]> {
  if (!workOrderId) return [];
  const sb = supabase();
  const { data, error } = await (sb as any).rpc("list_billable_p1_parts", {
    p_work_order_id: workOrderId,
    p_exclude_invoice_id: excludeInvoiceId || null,
  });
  if (error) throw error;
  return (data || []).map((row: any) => ({
    partId: row.part_id,
    workOrderId: row.work_order_id,
    description: row.description,
    partNumber: row.part_number || "",
    qty: Number(row.qty || 1),
    p1OrderStatus: row.p1_order_status,
    unitCost: Number(row.unit_cost),
    markedUpUnitRate: Number(row.marked_up_unit_rate),
  }));
}

export async function setP1PartOrderStatusWithCost(
  id: string,
  status: "requested" | "ordered" | "received" | "cancelled",
  unitCost?: number | null,
): Promise<any> {
  const sb = supabase();
  const { data, error } = await (sb as any).rpc(
    "set_p1_part_order_status_with_cost",
    {
      p_part_id: id,
      p_status: status,
      p_unit_cost: unitCost == null ? null : unitCost,
    },
  );
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  return {
    ...mapWoPart(result?.part || result),
    p1UnitCost: result?.unitCost == null ? null : Number(result.unitCost),
  };
}

export async function loadWorkReports(
  workOrderId: string
): Promise<any[]> {
  const sb = supabase();
  const { data, error } = await sb
    .from("work_reports")
    .select("*")
    .eq("work_order_id", workOrderId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

// ── PHOTO STORAGE ─────────────────────────────────────────────────────────
export async function uploadPhotos(
  workOrderId: string,
  files: FileList | File[],
  authorName: string,
  audit: ActivityAuditOptions = {},
): Promise<string[]> {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  const uploaded: string[] = [];
  const arr = Array.from(files);
  for (const file of arr) {
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const filename = `${Date.now()}_${crypto.randomUUID()}`;
    const path = `wo/${workOrderId}/${filename}.${ext}`;
    const { error: upErr } = await sb.storage.from("photos").upload(path, file, { contentType: file.type, upsert: false });
    if (upErr) throw upErr;
    const { error: rowErr } = await sb.from("photos").insert({
      work_order_id: workOrderId,
      storage_path: path,
      uploader_id: user?.id || null,
      uploader_name: authorName,
    });
    if (rowErr) throw rowErr;
    uploaded.push(path);
  }
  if (uploaded.length > 0) {
    await insertActivity(workOrderId, authorName, `Added ${uploaded.length} photo${uploaded.length > 1 ? "s" : ""}.`, "note", audit);
  }
  return uploaded;
}

export async function removePhoto(workOrderId: string, storagePath: string): Promise<{ success: boolean; error?: unknown }> {
  const sb = supabase();
  // Delete the row (RLS allows uploader or staff)
  const { data: deletedRows, error: dbError } = await sb
    .from("photos")
    .delete()
    .eq("work_order_id", workOrderId)
    .eq("storage_path", storagePath)
    .select("id");
  if (dbError) return { success: false, error: dbError };
  if (!deletedRows || deletedRows.length === 0) {
    return { success: false, error: new Error("Only the uploader or a staff member can delete this image") };
  }
  // Delete the file from storage
  const { error: storageError } = await sb.storage.from("photos").remove([storagePath]);
  if (storageError) return { success: false, error: storageError };
  return { success: true };
}

// ── REALTIME SUBSCRIPTION ──────────────────────────────────────────────────
// Returns an unsubscribe function. The table-aware payload lets callers
// invalidate only the data affected by a change instead of reloading the
// entire portal for every row event.
export function subscribeToChanges(
  onChange: (change: PortalRealtimeChange) => void,
): () => void {
  const sb = supabase();
  const handleChange = (table: PortalRealtimeTable) => (payload: any) => {
    onChange({
      table,
      eventType: payload.eventType,
      new: payload.new || {},
      old: payload.old || {},
    });
  };
  const channel = sb
    .channel("portal-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "work_orders" }, handleChange("work_orders"))
    .on("postgres_changes", { event: "*", schema: "public", table: "activities" }, handleChange("activities"))
    .on("postgres_changes", { event: "*", schema: "public", table: "invoices" }, handleChange("invoices"))
    .on("postgres_changes", { event: "*", schema: "public", table: "contractor_estimates" }, handleChange("contractor_estimates"))
    .on("postgres_changes", { event: "*", schema: "public", table: "photos" }, handleChange("photos"))
    .on("postgres_changes", { event: "*", schema: "public", table: "wo_parts" }, handleChange("wo_parts"))
    .on("postgres_changes", { event: "*", schema: "public", table: "work_order_visits" }, handleChange("work_order_visits"))
    .on("postgres_changes", { event: "*", schema: "public", table: "work_order_technician_assignments" }, handleChange("work_order_technician_assignments"))
    .on("postgres_changes", { event: "*", schema: "public", table: "staff_work_order_todos" }, handleChange("staff_work_order_todos"))
    .on("postgres_changes", { event: "*", schema: "public", table: "staff_work_order_notification_reads" }, handleChange("staff_work_order_notification_reads"))
    .subscribe();
  return () => { sb.removeChannel(channel); };
}
