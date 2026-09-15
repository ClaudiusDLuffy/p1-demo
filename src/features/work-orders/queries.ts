import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  loadBillableP1Parts,
  loadWoParts,
  loadWoPartsForWorkOrder,
  loadPortalNavigationSummary,
  loadP1PartCostsForWorkOrder,
  loadWorkOrderFamily,
  loadWorkOrderDetails,
  loadWorkOrders,
  loadWorkOrdersCount,
  loadWorkOrderChildCount,
  type WorkOrderDetails,
} from "../../lib/db";
import { loadWorkOrdersPage, loadWorkOrderById } from "./data/workOrderReadRepository";
import { loadWorkOrderActivitiesPage } from "./data/activityReadRepository";
import { loadWorkOrderVisitsPage } from "./data/visitReadRepository";
import { loadWorkOrderPhotosPage } from "../photos/data/photoMetadataReadRepository";
import type { WorkOrderPageParams } from "./data/workOrderReadContracts";
import { useDirectoryActor } from "../directory/queries";
import type { DirectoryActor } from "../directory/contracts";
import { countReadPolicy, useCountQueryVisibility } from "../../lib/counts/countQueryPolicy";
import { workOrderCountFilters } from "../../lib/counts/countFilters";
import { normalizeUnknownError } from "../../lib/errors/normalizeUnknown";
import { retryWorkOrderRead } from "./workOrderQueryPolicy";
import { directoryActorScope, workOrderPagesKey, workOrderCountKey, workOrderChildCountKey,
  workOrderByIdKey, workOrderDetailsKey, workOrderFamilyKey, portalNavigationSummaryKey,
  workOrderPartsKey, p1PartCostsKey, billableP1PartsKey } from "../../lib/counts/queryKeys";
export { workOrderByIdKey, workOrderDetailsKey, workOrderFamilyKey } from "../../lib/counts/queryKeys";

export const WORK_ORDERS_KEY = ["work-orders"] as const;
export const WORK_ORDER_DETAILS_KEY = ["work-order-details"] as const;
export const WORK_ORDER_PAGES_KEY = ["work-order-pages"] as const;
export const WORK_ORDER_BY_ID_KEY = ["work-order-by-id"] as const;
export const WO_PARTS_KEY = ["wo-parts"] as const;
export const P1_PART_COSTS_KEY = ["p1-part-costs"] as const;
export const BILLABLE_P1_PARTS_KEY = ["billable-p1-parts"] as const;
export const PORTAL_NAVIGATION_SUMMARY_KEY = ["portal-navigation-summary"] as const;
export const CONTRACTOR_WORKLOAD_SUMMARY_KEY = ["contractor-workload-summary"] as const;

function useReadActor(override?: DirectoryActor | null) {
  const current = useDirectoryActor();
  return override === undefined ? current : override;
}

export function useWoPartsQuery(enabled = true) {
  return useQuery({
    queryKey: WO_PARTS_KEY,
    queryFn: loadWoParts,
    staleTime: 30_000,
    enabled,
  });
}

export function useWorkOrderPartsQuery(
  workOrderId: string | null | undefined,
  enabled = true,
) {
  const actor = useReadActor();
  const id = String(workOrderId || "");
  return useQuery({
    queryKey: workOrderPartsKey(id, directoryActorScope(actor)),
    queryFn: ({ signal }) => loadWoPartsForWorkOrder(id, signal),
    staleTime: 30_000,
    enabled: enabled && Boolean(id) && !!actor?.id && actor.active === true,
  });
}

export function useP1PartCostsQuery(
  workOrderId: string | null | undefined,
  enabled = true,
) {
  const actor = useReadActor();
  const id = String(workOrderId || "");
  return useQuery({
    queryKey: p1PartCostsKey(id, directoryActorScope(actor)),
    queryFn: ({ signal }) => loadP1PartCostsForWorkOrder(id, signal),
    staleTime: 30_000,
    enabled: enabled && Boolean(id) && !!actor?.id && actor.active === true,
  });
}

export function useBillableP1PartsQuery(
  workOrderId: string | null | undefined,
  excludeInvoiceId?: string | null,
  enabled = true,
) {
  const actor = useReadActor();
  const id = String(workOrderId || "");
  return useQuery({
    queryKey: billableP1PartsKey(id, excludeInvoiceId || null, directoryActorScope(actor)),
    queryFn: ({ signal }) => loadBillableP1Parts(id, excludeInvoiceId, signal),
    staleTime: 30_000,
    enabled: enabled && Boolean(id) && !!actor?.id && actor.active === true,
  });
}

export function usePortalNavigationSummaryQuery(enabled = true, actorOverride?: DirectoryActor | null) {
  const actor = useReadActor(actorOverride);
  const visible = useCountQueryVisibility(enabled && !!actor?.id && actor.active === true);
  return useQuery({
    queryKey: portalNavigationSummaryKey(directoryActorScope(actor)),
    queryFn: ({ signal }) => loadPortalNavigationSummary(signal),
    ...countReadPolicy,
    enabled: visible,
  });
}

export function useWorkOrdersQuery(enabled = true) {
  return useQuery({
    queryKey: WORK_ORDERS_KEY,
    queryFn: loadWorkOrders,
    staleTime: 30_000,
    enabled,
  });
}

export function useWorkOrdersPageQuery(
  params: WorkOrderPageParams,
  enabled = true,
  actorOverride?: DirectoryActor | null,
  options: { countEnabled?: boolean } = {},
) {
  const actor = useReadActor(actorOverride);
  const scope = directoryActorScope(actor);
  const query = useQuery({
    queryKey: workOrderPagesKey(scope, params),
    queryFn: ({ signal }) => loadWorkOrdersPage(params, signal),
    staleTime: 30_000,
    retry: (failureCount, error) => retryWorkOrderRead(params, failureCount, error),
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === scope ? previous : undefined,
    enabled: enabled && !!actor?.id && actor.active === true,
  });
  // Exact totals are secondary information. Starting a second full filtered
  // scan beside the row query multiplied database load during busy portal
  // opens. Preserve the exact count contract, but give the visible row read
  // priority and only start its count after those rows are usable.
  const countQuery = useWorkOrdersCountQuery(
    params,
    enabled && options.countEnabled !== false && query.isSuccess && !query.isPlaceholderData,
    actor,
  );
  const data = useMemo(() => query.data ? { ...query.data,
    totalCount: countQuery.data?.totalCount ?? null,
    aggregates: countQuery.data?.aggregates } : undefined, [query.data, countQuery.data]);
  return { ...query, countQuery, data };
}

export function useWorkOrdersCountQuery(params: WorkOrderPageParams, enabled = true, actorOverride?: DirectoryActor | null) {
  const actor = useReadActor(actorOverride);
  const filters = workOrderCountFilters(params);
  const visible = useCountQueryVisibility(enabled && !!actor?.id && actor.active === true);
  return useQuery({ queryKey: workOrderCountKey(directoryActorScope(actor), filters),
    queryFn: ({ signal }) => loadWorkOrdersCount(filters, signal), ...countReadPolicy,
    retry: (failureCount, error) => retryWorkOrderRead(filters, failureCount, error), enabled: visible });
}

export function useWorkOrderByIdQuery(workOrderId: string | null | undefined, enabled = true, actorOverride?: DirectoryActor | null) {
  const actor = useReadActor(actorOverride);
  const id = String(workOrderId || "");
  return useQuery({
    queryKey: workOrderByIdKey(id, directoryActorScope(actor)),
    queryFn: ({ signal }) => loadWorkOrderById(id, signal),
    staleTime: 30_000,
    enabled: enabled && id.length > 0 && !!actor?.id && actor.active === true,
  });
}

export function useWorkOrderFamilyQuery(workOrderId: string | null | undefined, enabled = true, actorOverride?: DirectoryActor | null) {
  const actor = useReadActor(actorOverride);
  const id = String(workOrderId || "");
  return useQuery({
    queryKey: workOrderFamilyKey(id, directoryActorScope(actor)),
    queryFn: () => loadWorkOrderFamily(id),
    staleTime: 30_000,
    enabled: enabled && id.length > 0 && !!actor?.id && actor.active === true,
  });
}

export function useWorkOrderDetailsQuery(
  workOrder: Parameters<typeof loadWorkOrderDetails>[0] | null | undefined,
  enabled = true,
  actorOverride?: DirectoryActor | null,
  options: { countEnabled?: boolean } = {},
) {
  const actor = useReadActor(actorOverride);
  const scope = directoryActorScope(actor);
  const workOrderId = String(workOrder?.id || "");
  const queryClient = useQueryClient();
  const [loadingPage, setLoadingPage] = useState<{ scope: string; id: string; section: "activities" | "photos" | "visits" } | null>(null);
  const loadingSection = loadingPage?.scope === scope && loadingPage.id === workOrderId ? loadingPage.section : null;
  const [paginationFailure, setPaginationFailure] = useState<{ scope: string; id: string; error: ReturnType<typeof normalizeUnknownError> } | null>(null);
  const appendRequest = useRef<AbortController | null>(null);
  useEffect(() => () => { appendRequest.current?.abort(); appendRequest.current = null; }, [scope, workOrderId]);
  const countVisible = useCountQueryVisibility(enabled && options.countEnabled !== false && !!actor?.id && actor.active === true && !!workOrderId);
  const activityCount = useQuery({ queryKey: workOrderChildCountKey(scope, workOrderId, "activities"),
    queryFn: ({ signal }) => loadWorkOrderChildCount(workOrderId, "activities", signal), ...countReadPolicy, enabled: countVisible });
  const photoCount = useQuery({ queryKey: workOrderChildCountKey(scope, workOrderId, "photos"),
    queryFn: ({ signal }) => loadWorkOrderChildCount(workOrderId, "photos", signal), ...countReadPolicy, enabled: countVisible });
  const visitCount = useQuery({ queryKey: workOrderChildCountKey(scope, workOrderId, "visits"),
    queryFn: ({ signal }) => loadWorkOrderChildCount(workOrderId, "visits", signal), ...countReadPolicy, enabled: countVisible });
  const query = useQuery({
    queryKey: workOrderDetailsKey(workOrderId, scope),
    queryFn: ({ signal }) => loadWorkOrderDetails(workOrder, signal),
    staleTime: 30_000,
    enabled: enabled && workOrderId.length > 0 && !!actor?.id && actor.active === true,
  });

  const appendPage = useCallback(async (section: "activities" | "photos" | "visits") => {
    const key = workOrderDetailsKey(workOrderId, scope);
    const current = queryClient.getQueryData<WorkOrderDetails>(key);
    if (!current || appendRequest.current) return;
    const metaKey = section === "activities"
      ? "activityPage"
      : section === "photos"
        ? "photoPage"
        : "visitPage";
    const pageMeta = current[metaKey];
    if (!pageMeta?.hasMore || !pageMeta.nextCursor) return;

    setLoadingPage({ scope, id: workOrderId, section });
    setPaginationFailure(null);
    const controller = new AbortController();
    appendRequest.current = controller;
    try {
      const page = section === "activities"
        ? await loadWorkOrderActivitiesPage(workOrder, pageMeta.nextCursor, 30, controller.signal)
        : section === "photos"
          ? await loadWorkOrderPhotosPage(workOrderId, pageMeta.nextCursor, 24, controller.signal)
          : await loadWorkOrderVisitsPage(workOrderId, pageMeta.nextCursor, 30, controller.signal);
      if (controller.signal.aborted) return;
      queryClient.setQueryData<WorkOrderDetails>(key, existing => {
        // A foreground/Realtime refresh may replace loaded history with its
        // first page while this continuation is in flight. Never splice a
        // later page into that new traversal or advance past its missing rows.
        if (!existing || existing[metaKey].nextCursor !== pageMeta.nextCursor) return existing;
        const seen = new Set(
          section === "photos"
            ? existing.photos
            : existing[section].map(item => item.id),
        );
        const appended = page.items.filter(item =>
          !seen.has(typeof item === "string" ? item : item.id),
        );
        const next = {
          ...existing,
          [section]: [...existing[section], ...appended],
          [metaKey]: {
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
            totalCount: existing[metaKey].totalCount,
          },
        };
        if (section === "activities") {
          next.pendingSevenElevenActivities = next.activities.filter(activity =>
            activity.requiresSevenElevenSync && !activity.syncedToSevenElevenAt,
          );
          next.pendingContractorActivities = next.activities.filter(activity =>
            activity.requiresContractorAttention && !activity.contractorAcknowledgedAt,
          );
        }
        return next;
      });
    } catch (cause: unknown) {
      if (!controller.signal.aborted) setPaginationFailure({ scope, id: workOrderId, error: normalizeUnknownError(cause) });
    } finally {
      if (appendRequest.current === controller) { appendRequest.current = null; setLoadingPage(null); }
    }
  }, [queryClient, workOrder, workOrderId, scope]);

  const data = useMemo(() => query.data ? { ...query.data,
      activityPage: { ...query.data.activityPage, totalCount: activityCount.data?.totalCount ?? null },
      photoPage: { ...query.data.photoPage, totalCount: photoCount.data?.totalCount ?? null },
      visitPage: { ...query.data.visitPage, totalCount: visitCount.data?.totalCount ?? null },
    } : undefined, [query.data, activityCount.data, photoCount.data, visitCount.data]);
  return {
    ...query,
    data,
    paginationError: paginationFailure?.scope === scope && paginationFailure.id === workOrderId ? paginationFailure.error : null,
    loadMoreActivities: () => appendPage("activities"),
    loadMorePhotos: () => appendPage("photos"),
    loadMoreVisits: () => appendPage("visits"),
    loadingActivities: loadingSection === "activities",
    loadingPhotos: loadingSection === "photos",
    loadingVisits: loadingSection === "visits",
  };
}
