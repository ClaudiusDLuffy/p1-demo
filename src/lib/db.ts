// Supabase data layer for the P1 portal.
// Maps DB rows (snake_case) → portal shape (camelCase) so existing components
// don't need to change. Keep this thin — heavy logic stays in components.

import { apiFetch } from "./errors/apiFetch";
import { normalizeUnknownError } from "./errors/normalizeUnknown";
import { AppError } from "./errors/AppError";
import { parseExactCount, type ExactCountResult } from "./counts/countContracts";
import { boundedReadRpc } from "./counts/readRpc";
import { loadWorkOrdersPage as readWorkOrdersPage, loadWorkOrderById as readWorkOrderById,
  workOrderReadArgs } from "../features/work-orders/data/workOrderReadRepository";
import type { WorkOrderPageParams } from "../features/work-orders/data/workOrderReadContracts";
import { loadWorkOrderActivitiesPage as readWorkOrderActivitiesPage } from "../features/work-orders/data/activityReadRepository";
import { loadWorkOrderVisitsPage as readWorkOrderVisitsPage } from "../features/work-orders/data/visitReadRepository";
import { loadWorkOrderPhotosPage as readWorkOrderPhotosPage } from "../features/photos/data/photoMetadataReadRepository";
import { loadPhotoBlob as readPhotoBlob, getPhotoUrl as readPhotoUrl } from "../features/photos/browserPhotoStorageAdapter";
import type { mapActivityPageRow as mapActivity } from "../features/work-orders/data/activityMappers";
import type { mapVisit } from "../features/work-orders/data/visitMappers";
export type { WorkOrderPageParams, WorkOrderTableSortColumn } from "../features/work-orders/data/workOrderReadContracts";
export { workOrderReadArgs };
import { parseNavigationSummaryV2 } from "./counts/navigationSummary";
import { parseInvoiceSummary, invoiceSummaryForLegacyUi, invoiceDocumentForLegacyUi } from "../features/invoices/invoiceReadContracts";
import { readInvoiceSummary, readInvoiceDocument } from "../features/invoices/invoiceReads";
import { supabase } from "./supabase/client";
import { cancelUnattachedUpload, createWorkOrderPhotoPorts, deleteBoundObject, uploadBoundAttachment } from "./privateObjectClient";
import { createPhotoUploadController } from "../features/photos/photoUploadController";
import { createContractorInvoiceCommands, safeContractorInvoiceError } from "./contractorInvoiceCommands";
import { contractorInvoiceDraftCommand, compatibleContractorInvoiceResult } from "./contractorInvoiceDraftAdapter";
import type { ContractorInvoiceContext } from "./contractorInvoiceCommandContracts";
import { createLifecycleCommands, safeLifecycleError } from "./workOrderLifecycleCommands";
import { safeVisitCorrectionError } from "./visitCorrection";
import { createAssignmentCommands, AssignmentCommandError } from "./workOrderAssignmentCommands";
import { reviewInvoiceWithNotification, reviewInvoicesWithNotification, retractInvoiceWithNotification } from "./financialNotificationCommands";
import type { FinancialReviewResult, FinancialBatchReviewResult } from "./financialNotificationCommandContracts";
import type { AssignmentContext } from "./workOrderAssignmentContracts";
import { manualWorkOrderSchema } from "./workOrderCreationCommand";
export type { RejectUnassignedWorkOrderResult, DuplicateWorkOrderForReassignmentResult,
  AssignmentTransitionDeliveryStatus, WorkOrderContractorTransitionResult } from "./workOrderAssignmentContracts";
import { lifecycleContextSchema, lifecycleRpcContext, type LifecycleContext } from "./workOrderLifecycleContracts";
import { stateCodeFromWorkOrder, timezoneForWorkOrder } from "./billingRules";
import { collectSupabasePages } from "./paginatedQuery";
import {
  clampPageSize,
  type CursorPage,
} from "./cursorPagination";
import { computeSlaBreaches } from "./slaConfig";
import { WorkOrderSchema } from "./schemas";
import type { WorkOrder } from "./schemas";
import type { Database, Json } from "./supabase/database.types";
import { createPortalRealtimeSubscription } from "./realtime/realtimeSubscription";
import type { NormalizedRealtimeEvent } from "./realtime/realtimeEvent";
import type { WorkOrderReopenMode } from "./workOrderReopen";
import {
  completedReturnCommandSchema,
  completedReturnResultSchema,
  type CompletedReturnCommand,
  type CompletedReturnResult,
} from "./completedWorkOrderReturn";
import type {
  ContractorEstimate,
  ContractorEstimateAttachment,
  ContractorEstimateLine,
  ContractorEstimateLineType,
  ContractorEstimateTemplate,
  EditableContractorEstimateLine,
} from "./contractorEstimate";
import { workOrderCanEnterSevenElevenQueue } from "./workOrderView";
import {
  normalizeExactPortalWorkOrderId,
} from "./workOrderIdentity";

// ── PROFILE / AUTH ──────────────────────────────────────────────────────────

export async function signIn(email: string, password: string): Promise<any> {
  const sb = supabase();
  const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw normalizeUnknownError(error);
  return data;
}

export type SignOutScope = "global" | "local" | "others";

export async function signOut(scope: SignOutScope = "local"): Promise<void> {
  const sb = supabase();
  const { error } = await sb.auth.signOut({ scope });
  if (error) throw normalizeUnknownError(error);
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
  if (profileResult.error) throw normalizeUnknownError(profileResult.error);
  if (permissionsResult.error) throw normalizeUnknownError(permissionsResult.error);
  return mapProfile(profileResult.data, (permissionsResult.data || [])
    .map((grant: any) => String(grant.permission)));
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
    totalCount: typeof row.totalCount === "number" && Number.isSafeInteger(row.totalCount) && row.totalCount >= 0 ? row.totalCount : null,
    aggregates: row.aggregates && typeof row.aggregates === "object" && !Array.isArray(row.aggregates)
      ? Object.fromEntries(Object.entries(row.aggregates as Record<string, unknown>)
        .map(([key, value]) => [key, Number(value || 0)]))
      : undefined,
  };
};

export async function loadWorkOrdersPage(
  params: WorkOrderPageParams = {}, signal?: AbortSignal,
): Promise<CursorPage<WorkOrder>> {
  // Compatibility type bridge only: the old declaration names the raw schema,
  // while callers receive the validated camel-case read model. No raw row cast.
  return await readWorkOrdersPage(params, signal) as unknown as CursorPage<WorkOrder>;
}

export async function loadWorkOrdersCount(params: WorkOrderPageParams = {}, signal?: AbortSignal): Promise<ExactCountResult> {
  const { tableMode, args } = workOrderReadArgs(params);
  const filters: Record<string, unknown> = { ...args };
  delete filters.p_limit;
  delete filters.p_cursor;
  return parseExactCount(await boundedReadRpc(tableMode ? "count_work_orders_table_v2" : "count_work_orders_v1", filters, signal));
}

export async function loadPortalNavigationSummary(signal?: AbortSignal): Promise<Partial<PortalNavigationSummary>> {
  const data = await boundedReadRpc("get_portal_navigation_summary_v2", {}, signal);
  const { metrics } = parseNavigationSummaryV2(data);
  // Retain the established UI metric vocabulary, without zero-filling fields
  // that this role-specific contract did not request or calculate.
  if (Object.keys(metrics).some(key => !Object.hasOwn(EMPTY_PORTAL_NAVIGATION_SUMMARY, key))) {
    throw new AppError("INTERNAL_ERROR");
  }
  return metrics;
}

export async function loadWorkOrderById(workOrderId: string, signal?: AbortSignal): Promise<WorkOrder | null> {
  // Preserve the historical facade type without adding raw-schema fields to the DTO.
  return await readWorkOrderById(workOrderId, signal) as unknown as WorkOrder | null;
}

export async function loadWorkOrderFamily(workOrderId: string): Promise<WorkOrder[]> {
  const reference = normalizeExactPortalWorkOrderId(workOrderId);
  if (!reference) return [];

  const sb = supabase();
  let candidatesQuery = sb
    .from("work_orders")
    .select("id, duplicate_sequence")
    .is("deleted_at", null);

  // Canonical 7-Eleven references can own one or more clean portal copies.
  // The value has already passed the strict WOT regex, so it is safe to use in
  // PostgREST's OR expression. RLS still scopes every candidate to the caller.
  const isRoot = !reference.includes("-");
  candidatesQuery = isRoot
    ? candidatesQuery.or(
        `id.eq.${reference},duplicate_root_work_order_id.eq.${reference}`,
      )
    : candidatesQuery.eq("id", reference);

  const { data, error } = await candidatesQuery
    .order("duplicate_sequence", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false });
  if (error) throw normalizeUnknownError(error);

  const hydrated = await Promise.all(
    (data || []).map(candidate => loadWorkOrderById(candidate.id)),
  );
  return hydrated.filter((workOrder): workOrder is WorkOrder => Boolean(workOrder));
}

/** @deprecated Compatibility collector only; interactive reads must use loadWorkOrdersPage. */
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

const pageMeta = <T>(page: CursorPage<T>): Omit<CursorPage<T>, "items"> => ({
  nextCursor: page.nextCursor,
  hasMore: page.hasMore,
  totalCount: page.totalCount,
});

export async function loadWorkOrderActivitiesPage(
  workOrder: Parameters<typeof loadWorkOrderDetails>[0],
  cursor: string | null = null,
  limit = 30,
  signal?: AbortSignal,
): Promise<CursorPage<ReturnType<typeof mapActivity>>> {
  return readWorkOrderActivitiesPage(workOrder, cursor, limit, signal);
}

export async function loadWorkOrderPhotosPage(
  workOrderId: string,
  cursor: string | null = null,
  limit = 24,
  signal?: AbortSignal,
): Promise<CursorPage<string>> {
  return readWorkOrderPhotosPage(workOrderId, cursor, limit, signal);
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
  signal?: AbortSignal,
): Promise<CursorPage<ReturnType<typeof mapVisit>>> {
  return readWorkOrderVisitsPage(workOrderId, cursor, limit, signal);
}

export async function loadAllWorkOrderVisits(workOrderId: string, signal?: AbortSignal): Promise<ReturnType<typeof mapVisit>[]> {
  const visits: ReturnType<typeof mapVisit>[] = [];
  let cursor: string | null = null;
  do {
    const page = await loadWorkOrderVisitsPage(workOrderId, cursor, 100, signal);
    visits.push(...page.items);
    cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor);
  return visits;
}

export async function loadWorkOrderChildCount(workOrderId: string, section: "activities" | "photos" | "visits", signal?: AbortSignal): Promise<ExactCountResult> {
  const names = { activities: "count_work_order_activities_v1", photos: "count_work_order_photos_v1", visits: "count_work_order_visits_v1" } as const;
  return parseExactCount(await boundedReadRpc(names[section], { p_work_order_id: workOrderId }, signal));
}

export async function loadWorkOrderDetails(workOrder: {
  id: string;
  storeTimezone?: string | null;
  storeState?: string | null;
  city?: string | null;
  addr?: string | null;
  staffNotesSeenAt?: string | null;
} | null | undefined, signal?: AbortSignal): Promise<WorkOrderDetails> {
  if (!workOrder?.id) throw new Error("A work order ID is required");
  const [activityResult, photoResult, visitResult, currentWorkOrder] = await Promise.all([
    loadWorkOrderActivitiesPage(workOrder, null, 30, signal),
    loadWorkOrderPhotosPage(workOrder.id, null, 24, signal),
    loadWorkOrderVisitsPage(workOrder.id, null, 30, signal),
    loadWorkOrderById(workOrder.id, signal),
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
  if (estimateError) throw normalizeUnknownError(estimateError);
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
  if (lineError) throw normalizeUnknownError(lineError);
  if (attachmentError) throw normalizeUnknownError(attachmentError);

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
  if (error) throw normalizeUnknownError(error);
  return (data || []).map(mapContractorEstimateTemplate);
}

export async function downloadContractorEstimateTemplate(
  template: ContractorEstimateTemplate,
): Promise<void> {
  const sb = supabase();
  const { data, error } = await sb.storage
    .from("contractor-estimate-templates")
    .download(template.storagePath);
  if (error) throw normalizeUnknownError(error);
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
  const intent = await uploadBoundAttachment(estimateId, "estimate_attachment", file, file.name);
  if (!intent.attachmentId) throw new Error("The equipment form receipt could not be confirmed. Retry the same file.");
  const { data, error } = await supabase().from("contractor_estimate_attachments")
    .select("id,estimate_id,original_name,storage_path,mime_type,size_bytes,uploaded_by,created_at")
    .eq("id", intent.attachmentId).single();
  if (error || !data) throw new Error("The equipment form was saved but could not be refreshed. Retry the same file.");
  return { id: data.id, estimateId: data.estimate_id, originalName: data.original_name,
    storagePath: data.storage_path, mimeType: data.mime_type, sizeBytes: Number(data.size_bytes),
    uploadedBy: data.uploaded_by, createdAt: data.created_at };
}

export async function removeContractorEstimateAttachment(
  attachmentId: string,
): Promise<void> {
  await deleteBoundObject("estimate_attachment", attachmentId);
}

export async function downloadContractorEstimateAttachment(
  attachment: ContractorEstimateAttachment,
): Promise<void> {
  const sb = supabase();
  const { data, error } = await sb.storage
    .from("contractor-estimate-attachments")
    .download(attachment.storagePath);
  if (error) throw normalizeUnknownError(error);
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
  if (error) throw normalizeUnknownError(error);
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
  if (error) throw normalizeUnknownError(error);
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


export async function loadInvoicesPage(
  params: InvoicePageParams = {},
  signal?: AbortSignal,
) {
  const data = await boundedReadRpc("list_contractor_invoices_rows_v2", {
    p_state: params.state || "all",
    p_search: params.search?.trim() || null,
    p_sort: params.sort || "recent",
    p_direction: params.direction || "desc",
    p_limit: clampPageSize(params.limit),
    p_cursor: params.cursor || null,
    p_work_order_id: params.workOrderId || null,
  }, signal);
  const page = cursorPageFromRpc<unknown>(data);
  return { ...page, items: page.items.map(item => invoiceSummaryForLegacyUi(parseInvoiceSummary(item))) };
}

export async function loadInvoicesCount(params: InvoicePageParams = {}, signal?: AbortSignal): Promise<ExactCountResult> {
  return parseExactCount(await boundedReadRpc("count_contractor_invoices_v1", {
    p_state: params.state || "all", p_search: params.search?.trim() || null,
    p_work_order_id: params.workOrderId || null,
  }, signal));
}

export async function loadInvoiceSummaryById(invoiceId: string, signal?: AbortSignal) {
  if (!invoiceId) return null;
  const summary = await readInvoiceSummary(invoiceId, signal);
  return summary ? invoiceSummaryForLegacyUi(summary) : null;
}

/** Compatibility for explicit converted-invoice editor callers only. Ordinary
 * invoice details use loadInvoiceSummaryById and one bounded line page. */
export async function loadInvoiceById(invoiceId: string) {
  if (!invoiceId) return null;
  const document = await readInvoiceDocument(invoiceId, "edit", new AbortController().signal);
  return document ? invoiceDocumentForLegacyUi(document) : null;
}

export async function loadInvoices() {
  // Paid invoices are historical and live behind the invoice cursor list.
  // The shell keeps only workflow-active records needed for badges, review,
  // billing handoff, and work-order actions.
  const items: Awaited<ReturnType<typeof loadInvoicesPage>>["items"] = [];
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


// ── INVOICE PDF STORAGE ────────────────────────────────────────────────────
// Bucket is private; reads use sb.storage.download which authenticates via
// the user's session. Object identity is reserved and validated by the server.
export async function uploadInvoicePdfObject(
  invoiceId: string,
  invoiceNum: string,
  blob: Blob,
  purpose: "invoice_original" | "invoice_generated" = "invoice_original",
): Promise<string> {
  const displayName = blob instanceof File ? blob.name : `${String(invoiceNum || "invoice").slice(0, 240)}.pdf`;
  return (await uploadBoundAttachment(invoiceId, purpose, blob, displayName)).objectPath;
}

export async function uploadInvoicePdf(invoiceId: string, invoiceNum: string, blob: Blob,
  purpose: "invoice_original" | "invoice_generated" = "invoice_original"): Promise<string> {
  const sb = supabase();
  const displayName = blob instanceof File ? blob.name : `${String(invoiceNum || "invoice").slice(0, 240)}.pdf`;
  const intent = await uploadBoundAttachment(invoiceId, purpose, blob, displayName);
  const path = intent.objectPath;
  const { error: rowErr } = await sb.rpc(
    "attach_contractor_invoice_pdf",
    { p_invoice_id: invoiceId, p_storage_path: path },
  );
  if (rowErr) {
    // The guarded cancellation locks/rechecks the invoice. If attach committed
    // but its response was lost, attached_at prevents removing its source PDF.
    const recovered = await cancelUnattachedUpload(intent).catch(() => null);
    if (recovered?.status === "finalized") {
      // Finalized can also mean a retained historical attachment. It is not
      // proof that this invoice still points to this upload after replacement.
      const current = await sb.from("invoices").select("pdf_storage_path").eq("id", invoiceId).maybeSingle();
      if (!current.error && current.data?.pdf_storage_path === path) return path;
    }
    throw new Error("The PDF attachment could not be confirmed. Its upload remains tracked for safe recovery. Reload the page and select the file again, or regenerate the PDF.");
  }
  return path;
}

export async function downloadInvoicePdfBlob(storagePath: string): Promise<Blob> {
  const sb = supabase();
  const { data, error } = await sb.storage.from("invoice-pdfs").download(storagePath);
  if (error) throw normalizeUnknownError(error);
  if (!data) throw new Error("Empty PDF response from storage");
  return data;
}


// ── PHOTO STORAGE URLs ──────────────────────────────────────────────────────
// Photos in DB are storage paths. Authenticated downloads enforce storage
// RLS on every load; blob URLs are revoked when the gallery unmounts.
export async function loadPhotoBlob(path: string): Promise<Blob> {
  return readPhotoBlob(path);
}

export async function getPhotoUrl(path: string): Promise<string | null> {
  return readPhotoUrl(path);
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
  if (error) throw normalizeUnknownError(error);

  if (hasAfmEmail) {
    const contactResult = afmEmail
      ? await sb.from("work_order_afm_contacts").upsert({
          work_order_id: id,
          afm_email: afmEmail,
        })
      : await sb.from("work_order_afm_contacts").delete().eq("work_order_id", id);
    if (contactResult.error) throw normalizeUnknownError(contactResult.error);
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
  if (error) throw normalizeUnknownError(error);
  return data;
}

export async function moveWorkOrderStraightToBilling(id: string): Promise<any> {
  const sb = supabase();
  const { data, error } = await (sb as any).rpc(
    "move_work_order_straight_to_billing",
    { p_work_order_id: id },
  );
  if (error) throw normalizeUnknownError(error);
  return data;
}

export async function completeCapitalWork(id: string): Promise<any> {
  const sb = supabase();
  const { data, error } = await sb.rpc(
    "complete_capital_work",
    { p_work_order_id: id },
  );
  if (error) throw normalizeUnknownError(error);
  return data;
}

export async function resumeCapitalWork(id: string): Promise<any> {
  const sb = supabase();
  const { data, error } = await sb.rpc(
    "resume_capital_work",
    { p_work_order_id: id },
  );
  if (error) throw normalizeUnknownError(error);
  return data;
}

export async function closeWorkOrderWithoutInvoice(
  id: string,
  expectedWorkflowCycle: number,
  expectedContractorAssignmentVersion: number,
  expectedUpdatedAt: string,
): Promise<Json> {
  const sb = supabase();
  const { data, error } = await sb.rpc(
    "close_work_order_without_invoice",
    {
      p_work_order_id: id,
      p_expected_workflow_cycle: expectedWorkflowCycle,
      p_expected_contractor_assignment_version: expectedContractorAssignmentVersion,
      p_expected_updated_at: expectedUpdatedAt,
    },
  );
  if (error) throw normalizeUnknownError(error);
  return data;
}

export type CloseReopenedFollowUpResult = {
  applied: boolean;
  reason: "closed_without_additional_billing" | "already_closed" | string;
  workOrderId: string;
  workOrderStatus: string;
  functionalStatus: string | null;
  closedAt: string | null;
  workflowCycle: number;
  priorInvoiceCount?: number;
  visitsClosed: number;
};

export async function closeReopenedWorkOrderWithoutAdditionalBilling(
  id: string,
  expectedWorkflowCycle: number,
  expectedContractorAssignmentVersion: number,
  expectedUpdatedAt: string,
  reason: string,
): Promise<CloseReopenedFollowUpResult> {
  const sb = supabase();
  const { data, error } = await sb.rpc(
    "close_reopened_work_order_without_additional_billing",
    {
      p_work_order_id: id,
      p_expected_workflow_cycle: expectedWorkflowCycle,
      p_expected_contractor_assignment_version:
        expectedContractorAssignmentVersion,
      p_expected_updated_at: expectedUpdatedAt,
      p_reason: reason,
    },
  );
  if (error) throw normalizeUnknownError(error);
  return data as unknown as CloseReopenedFollowUpResult;
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
  if (error) throw normalizeUnknownError(error);
  return data as unknown as ReopenWorkOrderResult;
}

export async function returnCompletedWorkOrderToField(
  input: CompletedReturnCommand,
): Promise<CompletedReturnResult> {
  const command = completedReturnCommandSchema.parse(input);
  const sb = supabase();
  const { data, error } = await sb.rpc("return_completed_work_order_to_field_v1", {
    p_work_order_id: command.workOrderId,
    p_expected_assignment_version: command.expectedAssignmentVersion,
    p_expected_workflow_cycle: command.expectedWorkflowCycle,
    p_expected_lifecycle_version: command.expectedLifecycleVersion,
    p_operation_id: command.operationId,
    p_reason: command.reason,
  });
  if (error) throw normalizeUnknownError(error);
  const result = completedReturnResultSchema.parse(data);
  if (result.workOrderId !== command.workOrderId
      || result.operationId !== command.operationId
      || result.assignmentVersion !== command.expectedAssignmentVersion
      || result.workflowCycle !== command.expectedWorkflowCycle + 1) {
    throw new Error("The return-to-field response did not match the requested work order version.");
  }
  return result;
}

export async function markWorkOrderNotesSeen(
  workOrderId: string,
  latestNoteAt: string,
): Promise<void> {
  const sb = supabase();
  const { error } = await (sb.from("work_orders") as any)
    .update({ staff_notes_seen_at: latestNoteAt })
    .eq("id", workOrderId);
  if (error) throw normalizeUnknownError(error);
}

/** @deprecated Raw visit writes are denied after 0123; use startWorkOrderVisit. */
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
  if (workOrderError) throw normalizeUnknownError(workOrderError);
  const { error } = await (sb as any).from("work_order_visits").insert({
    work_order_id: workOrderId,
    contractor_id: workOrder?.contractor_id || null,
    check_in_at: checkInAt,
    checked_in_by: authData.user?.id || null,
  });
  if (error) throw normalizeUnknownError(error);
}

/** @deprecated Use the atomic pause/completion command after 0123. */
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
  if (findError) throw normalizeUnknownError(findError);
  if (!visit?.id) return;
  const { error } = await (sb as any)
    .from("work_order_visits")
    .update({
      check_out_at: checkOutAt,
      checked_out_by: authData.user?.id || null,
    })
    .eq("id", visit.id)
    .is("check_out_at", null);
  if (error) throw normalizeUnknownError(error);
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
  if (error) throw safeVisitCorrectionError(error);
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
  if (/^part added/.test(value)) return "part_added";
  if (/^part removed/.test(value)) return "part_removed";
  if (/part|tracking|return date/.test(value)) return "part_updated";
  if (/added .*photo/.test(value)) return "photo_added";
  if (/photo removed/.test(value)) return "photo_removed";
  if (/technician on job/.test(value)) return "technician_updated";
  // Assignment command identities are never inferred from caller prose.
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
    if (error) throw normalizeUnknownError(error);
    return null;
  }

  const { data, error } = await insert.select("id").single();
  if (error) throw normalizeUnknownError(error);
  return data.id;
}

export async function markActivitySevenElevenSynced(
  activityId: string,
  synced: boolean,
): Promise<void> {
  const sb = supabase();
  const { error } = await sb.rpc("mark_work_order_activity_synced_v1", {
    p_activity_id: activityId, p_synced: synced,
  });
  if (error) throw safeLifecycleError(error);
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
  if (error) throw normalizeUnknownError(error);
}

export async function acknowledgeContractorAttention(
  activityId: string,
): Promise<void> {
  const sb = supabase();
  const { error } = await sb.rpc("acknowledge_contractor_attention", {
    p_activity_id: activityId,
  });
  if (error) throw normalizeUnknownError(error);
}

// Soft delete — the row stays in the DB but loadWorkOrders filters it out.
// RLS allows the author to update their own row, and managers/dispatchers/
// back-office (is_staff) to update any row.
export async function deleteActivity(activityId: string): Promise<void> {
  const sb = supabase();
  const { error } = await sb.from("activities")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", activityId);
  if (error) throw normalizeUnknownError(error);
}

// The old destructive export fails closed: removal requires the reasoned,
// versioned rejection command. Never restore a raw-write compatibility path.
export async function deleteWorkOrder(workOrderId: string, authorName: string): Promise<void> {
  void workOrderId;
  void authorName;
  throw new AssignmentCommandError("22023", "Use Reject work order with a reason. Only untouched, unassigned work can be removed.");
}

function assignmentCommands() {
  const sb = supabase();
  return createAssignmentCommands((name, args) => sb.rpc(name, args));
}

export async function rejectUnassignedWorkOrder(
  workOrderId: string,
  reason: string,
  context: AssignmentContext,
) {
  return assignmentCommands().reject({ ...context, workOrderId }, reason);
}

export async function duplicateWorkOrderForReassignment(
  workOrderId: string,
  context: AssignmentContext,
) {
  return assignmentCommands().duplicate({ ...context, workOrderId });
}

export async function transitionWorkOrderContractor(
  workOrderId: string,
  newContractorId: string | null,
  expectedAssignmentVersion: number,
  context: AssignmentContext,
) {
  return assignmentCommands().transition({ ...context, workOrderId, expectedAssignmentVersion }, newContractorId);
}

export async function administrativelyCloseVisitAndTransfer(
  context: AssignmentContext, contractorId: string | null, reason: string, confirmed: boolean,
) {
  return assignmentCommands().administrativeTransfer(context, { contractorId, reason, confirmed });
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
  if (error) throw normalizeUnknownError(error);
  return data as DeclineCapitalWorkOrderResult;
}

// Invoice soft delete is routed through an authenticated staff-only endpoint.
// The server verifies the updated row and records an audit without allowing an
// audit failure to masquerade as a failed delete. WO status remains unchanged.
export async function deleteInvoice(invoiceId: string, command: {
  operationId: string; expectedInvoiceVersion: number | null;
  expectedAssignmentVersion: number | null; expectedWorkflowCycle: number | null;
}): Promise<void> {
  const sb = supabase();
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session expired. Sign in and try again.");
  const response = await apiFetch(
    `/api/contractor-invoices?id=${encodeURIComponent(invoiceId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Invoice delete failed");
  }
}

export async function deleteOwnContractorInvoice(invoiceId: string, inputContext: ContractorInvoiceContext) {
  if (inputContext.invoiceId !== invoiceId) throw safeContractorInvoiceError({ code: "PT409" });
  return contractorInvoiceCommands().deleteOwn(inputContext);
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

/** @deprecated Unused unversioned RPC is private after 0123; current UI uses versioned field completion and separate invoicing confirmation. */
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
  if (error) throw normalizeUnknownError(error);
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
  if (error) throw normalizeUnknownError(error);
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
  if (activeError) throw normalizeUnknownError(activeError);
  if (active) return { id: active.id, deleted: false };

  // Check soft deleted.
  const { data: deleted, error: deletedError } = await sb
    .from("work_orders")
    .select("id")
    .ilike("id", escaped)
    .not("deleted_at", "is", null)
    .limit(1)
    .maybeSingle();
  if (deletedError) throw normalizeUnknownError(deletedError);
  if (deleted) return { id: deleted.id, deleted: true };

  return null;
}

// Atomically generate the next FWKD work order ID via a Postgres sequence
export async function nextWorkOrderId(): Promise<{ wo: string; inc: string }> {
  const sb = supabase();
  const { data, error } = await (sb as any).rpc("next_wo_id");
  if (error) throw normalizeUnknownError(error);
  // Returns shape { wo: 'FWKD11400001', inc: 'INC24000001' }
  return data;
}

const lifecycleCommands = createLifecycleCommands((name, args) => supabase().rpc(name, args));
export const setWorkOrderEta = lifecycleCommands.setEta;
export const startWorkOrderVisit = lifecycleCommands.start;
export const pauseWorkOrderForParts = lifecycleCommands.pause;

export async function flagWorkOrderCapital(context: LifecycleContext): Promise<void> {
  const args = lifecycleRpcContext(lifecycleContextSchema.parse(context));
  const { error } = await supabase().rpc("flag_work_order_capital_v1", {
    p_work_order_id: args.p_work_order_id,
    p_expected_assignment_version: args.p_expected_assignment_version,
    p_expected_workflow_cycle: args.p_expected_workflow_cycle,
    p_expected_lifecycle_version: args.p_expected_lifecycle_version,
  });
  if (error) throw safeLifecycleError(error);
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
    context,
  }: {
    completedAt: string;
    assetMake: string;
    assetModel: string;
    assetSerial: string;
    assetYear?: number | null;
    resolutionCode?: string | null;
    resolutionNotes?: string | null;
    activityText: string;
    context: LifecycleContext;
  },
): Promise<{
  applied: boolean;
  reason?: string;
  activityId?: string;
  workOrderStatus?: string;
}> {
  // Keep the old exported name and presentation-text argument. Authoritative
  // event identity and persisted wording are now owned by the database.
  void activityText;
  return lifecycleCommands.complete({
    ...context, workOrderId, completedAt, assetMake, assetModel, assetSerial,
    assetYear: assetYear ?? null,
    resolutionCode: resolutionCode || null, resolutionNotes: resolutionNotes || null,
  });
}

export async function insertWorkOrder(input: unknown, activityText: string | undefined, authorName: string | undefined,
  operationId: string, intakeStartedAt: string): Promise<WorkOrder> {
  const wo = manualWorkOrderSchema.parse(input);
  const sb = supabase();
  // SLA clock starts at intake (creation), NOT at assignment. For email-
  // ingested WOs (Phase 1.5), pass slaStartedAt as the email's received-at;
  // for portal-created WOs we use now.
  const startedAt = new Date(intakeStartedAt);
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
  };
  const result = await assignmentCommands().create(operationId, dbRow);
  const { data, error } = await sb.from("work_orders").select().eq("id", result.workOrderId).single();
  if (error) throw normalizeUnknownError(error);
  if (String(wo.afmEmail || "").trim()) {
    const { error: afmContactError } = await sb
      .from("work_order_afm_contacts")
      .upsert({
        work_order_id: wo.id,
        afm_email: String(wo.afmEmail).trim(),
      });
    if (afmContactError) throw normalizeUnknownError(afmContactError);
  }
  if (result.applied && activityText && authorName) {
    await insertActivity(wo.id, authorName, activityText, "system");
  }
  return WorkOrderSchema.parse(data);
}

// Source-of-truth invoice numbering. The RPC can see the global numeric
// sequence without exposing other contractors' invoices through RLS. The
// 6500 floor and soft-deleted-number handling live in the database function.
export async function nextInvoiceNumFromDb(): Promise<string> {
  const sb = supabase();
  const { data, error } = await sb.rpc("next_contractor_invoice_num");
  if (error) throw normalizeUnknownError(error);
  const nextNum = String(data || "").trim();
  if (!/^\d+$/.test(nextNum)) {
    throw new Error("Invoice number allocator returned an invalid value");
  }
  return nextNum;
}

// Browser financial writes use one versioned, idempotent command.
// Existing exports remain compatibility facades for the invoice hook.
function contractorInvoiceCommands() {
  const sb = supabase();
  return createContractorInvoiceCommands((name, args) => sb.rpc(name, args));
}

export async function insertInvoice(inv: unknown, lines: unknown[], authorName: string) {
  void authorName; // Caller display identity is never an authoritative RPC input.
  try {
    const command = contractorInvoiceDraftCommand(inv, lines, null);
    const result = await contractorInvoiceCommands().save(command.intent, command.context, command.payload);
    return compatibleContractorInvoiceResult(result, command.payload.num);
  } catch (error) { throw safeContractorInvoiceError(error); }
}

export async function updateInvoiceWithLines(invoiceId: string, patch: unknown, lines: unknown[]) {
  try {
    const command = contractorInvoiceDraftCommand(patch, lines, invoiceId);
    const result = await contractorInvoiceCommands().save(command.intent, command.context, command.payload);
    return compatibleContractorInvoiceResult(result, command.payload.num);
  } catch (error) { throw safeContractorInvoiceError(error); }
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
  if (error) throw normalizeUnknownError(error);
  return data;
}

export type ContractorInvoiceReviewResult = FinancialReviewResult;
export type BatchContractorInvoiceReviewResult = FinancialBatchReviewResult;

export async function reviewContractorInvoice(
  invoiceId: string,
  action: "approve" | "reject",
  reason?: string | null,
  expectedRevision?: number,
): Promise<ContractorInvoiceReviewResult> {
  return reviewInvoiceWithNotification(invoiceId, action, reason, expectedRevision);
}

export async function reviewContractorInvoices(
  invoiceIds: string[],
  action: "approve" | "reject",
  reason?: string | null,
  expectedRevisions?: Record<string, number>,
): Promise<BatchContractorInvoiceReviewResult> {
  return reviewInvoicesWithNotification(invoiceIds, action, reason, expectedRevisions);
}

export async function resubmitRejectedContractorInvoice(invoiceId: string, patch: unknown, lines: unknown[]) {
  try {
    const command = contractorInvoiceDraftCommand(patch, lines, invoiceId);
    const result = await contractorInvoiceCommands().save("revise", command.context, command.payload);
    return compatibleContractorInvoiceResult(result, command.payload.num);
  } catch (error) { throw safeContractorInvoiceError(error); }
}

export async function retractContractorInvoiceRejection(
  invoiceId: string,
  expectedRevision?: number,
): Promise<ContractorInvoiceReviewResult> {
  return retractInvoiceWithNotification(invoiceId, expectedRevision);
}

// Compatibility export for retired callers. Review and revision-bound handoff
// commands, not arbitrary state patches, own financial transitions.
export async function updateInvoiceState(invoiceId: string, state: string, extra: Record<string, unknown> = {}): Promise<void> {
  void invoiceId;
  void state;
  void extra;
  throw new Error("Use the guarded invoice review or contractor-bill handoff workflow.");
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

export async function loadWoPartsForWorkOrder(workOrderId: string, signal?: AbortSignal): Promise<any[]> {
  if (!workOrderId) return [];
  signal?.throwIfAborted();
  const sb = supabase();
  let query = (sb as any)
    .from("wo_parts")
    .select("*")
    .eq("work_order_id", workOrderId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  signal?.throwIfAborted();
  if (error) throw normalizeUnknownError(error);
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
  if (error) throw normalizeUnknownError(error);
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
  if (error) throw normalizeUnknownError(error);
  return mapWoPart(data);
}

export async function deleteWoPart(id: string): Promise<void> {
  const sb = supabase();
  const { error } = await (sb as any).from("wo_parts").delete().eq("id", id);
  if (error) throw normalizeUnknownError(error);
}

export async function requestP1PartOrder(id: string): Promise<any> {
  const sb = supabase();
  const { data, error } = await (sb as any)
    .rpc("request_p1_part_order", { p_part_id: id });
  if (error) throw normalizeUnknownError(error);
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
  if (error) throw normalizeUnknownError(error);
  return mapWoPart(data);
}

export async function loadP1PartCostsForWorkOrder(
  workOrderId: string,
  signal?: AbortSignal,
): Promise<any[]> {
  if (!workOrderId) return [];
  signal?.throwIfAborted();
  const sb = supabase();
  let query = (sb as any).rpc(
    "list_p1_part_costs_for_work_order",
    { p_work_order_id: workOrderId },
  );
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  signal?.throwIfAborted();
  if (error) throw normalizeUnknownError(error);
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
  signal?: AbortSignal,
): Promise<any[]> {
  if (!workOrderId) return [];
  signal?.throwIfAborted();
  const sb = supabase();
  let query = (sb as any).rpc("list_billable_p1_parts", {
    p_work_order_id: workOrderId,
    p_exclude_invoice_id: excludeInvoiceId || null,
  });
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  signal?.throwIfAborted();
  if (error) throw normalizeUnknownError(error);
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
  if (error) throw normalizeUnknownError(error);
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
  if (error) throw normalizeUnknownError(error);
  return data || [];
}

// ── PHOTO STORAGE ─────────────────────────────────────────────────────────
const compatibilityPhotoControllers = new Map<string, ReturnType<typeof createPhotoUploadController<import("./privateObjectContracts").UploadIntent>>>();
const knownPhotoIds = new Map<string, string>();
export async function uploadPhotos(
  workOrderId: string,
  files: FileList | File[],
  authorName: string,
  audit: ActivityAuditOptions = {},
): Promise<string[]> {
  // Compatibility signature retained; actor and evidence are command-owned.
  void authorName; void audit;
  const { data, error } = await supabase().from("work_orders")
    .select("contractor_assignment_version,workflow_cycle").eq("id", workOrderId).single();
  if (error || !data) throw new Error("Photo access could not be confirmed.");
  let controller = compatibilityPhotoControllers.get(workOrderId);
  const unfinished = controller?.snapshot().some(item => !["confirmed", "cancelled"].includes(item.status));
  if (!controller || !unfinished) {
    controller = createPhotoUploadController(createWorkOrderPhotoPorts(workOrderId,
      data.contractor_assignment_version, data.workflow_cycle));
    compatibilityPhotoControllers.set(workOrderId, controller);
  }
  const result = unfinished ? await controller.retry() : await controller.start(Array.from(files));
  const confirmed = result.flatMap(item => item.status === "confirmed" && item.storagePath ? [item.storagePath] : []);
  if (!confirmed.length) throw new Error("Photos were not confirmed. Retry or cancel the pending uploads.");
  return confirmed;
}

export async function removePhoto(workOrderId: string, storagePath: string): Promise<{ success: boolean; error?: unknown }> {
  try {
    const key = `${workOrderId}:${storagePath}`;
    let id = knownPhotoIds.get(key);
    if (!id) {
      // Read-only adapter for the existing path-shaped gallery API. Mutation
      // requests carry only a metadata ID, never a caller-supplied object path.
      const { data, error } = await supabase().from("photos").select("id")
        .eq("work_order_id", workOrderId).eq("storage_path", storagePath).single();
      if (error || !data) throw new Error("Photo access could not be confirmed. Refresh the work order.");
      id = data.id; knownPhotoIds.set(key, id);
    }
    await deleteBoundObject("photo", id);
    return { success: true };
  } catch (error: unknown) { return { success: false, error }; }
}

// ── REALTIME SUBSCRIPTION ──────────────────────────────────────────────────
// Returns an unsubscribe function. The table-aware payload lets callers
// invalidate only the data affected by a change instead of reloading the
// entire portal for every row event.
export function subscribeToChanges(
  onChange: (change: NormalizedRealtimeEvent) => void,
): () => void {
  // Compatibility export; the application hook is the sole subscription owner.
  return createPortalRealtimeSubscription(supabase(), { event: onChange });
}
