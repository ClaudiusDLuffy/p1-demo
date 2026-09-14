import { boundedReadRpc } from "../../../lib/counts/readRpc";
import { clampPageSize, type CursorPage } from "../../../lib/cursorPagination";
import { AppError } from "../../../lib/errors/AppError";
import type { WorkOrderPageParams, WorkOrderReadModel } from "./workOrderReadContracts";
import { mapWorkOrderListRow } from "./workOrderMappers";
import { parseWorkOrderReadPage, parseWorkOrderReadRow } from "./workOrderReadValidators";

export type { WorkOrderPageParams, WorkOrderTableSortColumn } from "./workOrderReadContracts";

const tableOnlyScopes = new Set<WorkOrderPageParams["scope"]>([
  // This queue has stricter part-readiness membership than the generic scope.
  "dashboard_p1_parts_to_order",
]);

function hasTableOnlyFilters(params: WorkOrderPageParams): boolean {
  return Boolean(
    params.workOrderFilter?.trim()
    || params.incidentFilter?.trim()
    || params.storeFilter?.trim()
    || params.summaryFilter?.trim()
    || params.contractorFilter?.trim()
    || params.createdDateFilter
    || params.updatedDateFilter
    || (params.slaFilter && params.slaFilter !== "all")
  );
}

function tableSortMatchesGenericSort(params: WorkOrderPageParams): boolean {
  if (!params.tableSortColumn) return true;
  const direction = params.tableSortDirection
    || (params.sort === "oldest" ? "asc" : params.sort === "priority" || params.sort === "sla_due" ? "asc" : "desc");
  const genericSort = params.sort || "newest";
  return (genericSort === "newest" && params.tableSortColumn === "created" && direction === "desc")
    || (genericSort === "oldest" && params.tableSortColumn === "created" && direction === "asc")
    || (genericSort === "priority" && params.tableSortColumn === "priority" && direction === "asc")
    || (genericSort === "sla_due" && params.tableSortColumn === "sla" && direction === "asc");
}

/** Shared with the separately owned count read; these are the existing RPC arguments. */
export function workOrderReadArgs(params: WorkOrderPageParams = {}) {
  // Preset ordering is already part of the generic cursor contract. Sending
  // those ordinary reads through table mode needlessly executes the broader
  // column-sort/filter plan and has caused hosted statement timeouts. Reserve
  // table mode for controls and queue scopes that actually require it.
  const tableMode = tableOnlyScopes.has(params.scope)
    || hasTableOnlyFilters(params)
    || !tableSortMatchesGenericSort(params);
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
  return { tableMode, args: tableArgs };
}

export type WorkOrderReadDependencies = {
  read: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  now: () => number;
};

/** One parent-read family, using the existing user-scoped and cancellable transport. */
export function createWorkOrderReadRepository(dependencies: WorkOrderReadDependencies = {
  read: boundedReadRpc,
  now: () => Date.now(),
}) {
  return {
    async loadWorkOrdersPage(params: WorkOrderPageParams = {}, signal?: AbortSignal): Promise<CursorPage<WorkOrderReadModel>> {
      const { tableMode, args } = workOrderReadArgs(params);
      const data = await dependencies.read(tableMode ? "list_work_orders_table_rows_v2" : "list_work_orders_rows_v1", args, signal);
      const page = parseWorkOrderReadPage(data);
      return { ...page, items: page.items.map(row => mapWorkOrderListRow(row, dependencies.now())) };
    },
    async loadWorkOrderById(workOrderId: string, signal?: AbortSignal): Promise<WorkOrderReadModel | null> {
      // Preserve the existing empty-id short circuit, including an aborted signal.
      if (!workOrderId) return null;
      const data = await dependencies.read("get_portal_work_order", { p_work_order_id: workOrderId }, signal);
      if (data == null) return null;
      const row = parseWorkOrderReadRow(data);
      if (row.id !== workOrderId) throw new AppError("INTERNAL_ERROR");
      return mapWorkOrderListRow(row, dependencies.now());
    },
  };
}

const production = createWorkOrderReadRepository();

export function loadWorkOrdersPage(params: WorkOrderPageParams = {}, signal?: AbortSignal): Promise<CursorPage<WorkOrderReadModel>> {
  return production.loadWorkOrdersPage(params, signal);
}

/** This exact parent read is also the existing detail/header contract; no children are fetched. */
export function loadWorkOrderById(workOrderId: string, signal?: AbortSignal): Promise<WorkOrderReadModel | null> {
  return production.loadWorkOrderById(workOrderId, signal);
}
