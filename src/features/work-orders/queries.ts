import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  loadAllProfiles,
  loadContractorWorkloadSummary,
  loadTechnicians,
  loadWoParts,
  loadWoPartsForWorkOrder,
  loadPortalNavigationSummary,
  loadWorkOrderActivitiesPage,
  loadWorkOrderById,
  loadWorkOrderDetails,
  loadWorkOrderPhotosPage,
  loadWorkOrdersPage,
  loadWorkOrderVisitsPage,
  loadWorkOrders,
  type WorkOrderPageParams,
} from "../../lib/db";

export const WORK_ORDERS_KEY = ["work-orders"] as const;
export const WORK_ORDER_DETAILS_KEY = ["work-order-details"] as const;
export const WORK_ORDER_PAGES_KEY = ["work-order-pages"] as const;
export const WORK_ORDER_BY_ID_KEY = ["work-order-by-id"] as const;
export const PROFILES_KEY = ["profiles"] as const;
export const TECHNICIANS_KEY = ["technicians"] as const;
export const WO_PARTS_KEY = ["wo-parts"] as const;
export const PORTAL_NAVIGATION_SUMMARY_KEY = ["portal-navigation-summary"] as const;
export const CONTRACTOR_WORKLOAD_SUMMARY_KEY = ["contractor-workload-summary"] as const;

export const workOrderDetailsKey = (workOrderId: string) =>
  [...WORK_ORDER_DETAILS_KEY, workOrderId] as const;

export const workOrderByIdKey = (workOrderId: string) =>
  [...WORK_ORDER_BY_ID_KEY, workOrderId] as const;

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
  const id = String(workOrderId || "");
  return useQuery({
    queryKey: [...WO_PARTS_KEY, id],
    queryFn: () => loadWoPartsForWorkOrder(id),
    staleTime: 30_000,
    enabled: enabled && Boolean(id),
  });
}

export function usePortalNavigationSummaryQuery(enabled = true) {
  return useQuery({
    queryKey: PORTAL_NAVIGATION_SUMMARY_KEY,
    queryFn: loadPortalNavigationSummary,
    staleTime: 30_000,
    enabled,
  });
}

export function useContractorWorkloadSummaryQuery(enabled = true) {
  return useQuery({
    queryKey: CONTRACTOR_WORKLOAD_SUMMARY_KEY,
    queryFn: loadContractorWorkloadSummary,
    staleTime: 30_000,
    enabled,
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
) {
  return useQuery({
    queryKey: [...WORK_ORDER_PAGES_KEY, params],
    queryFn: () => loadWorkOrdersPage(params),
    staleTime: 30_000,
    placeholderData: previous => previous,
    enabled,
  });
}

export function useWorkOrderByIdQuery(workOrderId: string | null | undefined, enabled = true) {
  const id = String(workOrderId || "");
  return useQuery({
    queryKey: workOrderByIdKey(id),
    queryFn: () => loadWorkOrderById(id),
    staleTime: 30_000,
    enabled: enabled && id.length > 0,
  });
}

export function useWorkOrderDetailsQuery(
  workOrder: Parameters<typeof loadWorkOrderDetails>[0] | null | undefined,
  enabled = true,
) {
  const workOrderId = String(workOrder?.id || "");
  const queryClient = useQueryClient();
  const [loadingSection, setLoadingSection] = useState<"activities" | "photos" | "visits" | null>(null);
  const query = useQuery({
    queryKey: workOrderDetailsKey(workOrderId),
    queryFn: () => loadWorkOrderDetails(workOrder),
    staleTime: 30_000,
    enabled: enabled && workOrderId.length > 0,
  });

  const appendPage = useCallback(async (section: "activities" | "photos" | "visits") => {
    const key = workOrderDetailsKey(workOrderId);
    const current = queryClient.getQueryData<any>(key);
    if (!current || loadingSection) return;
    const metaKey = section === "activities"
      ? "activityPage"
      : section === "photos"
        ? "photoPage"
        : "visitPage";
    const pageMeta = current[metaKey];
    if (!pageMeta?.hasMore || !pageMeta.nextCursor) return;

    setLoadingSection(section);
    try {
      const page = section === "activities"
        ? await loadWorkOrderActivitiesPage(workOrder, pageMeta.nextCursor)
        : section === "photos"
          ? await loadWorkOrderPhotosPage(workOrderId, pageMeta.nextCursor)
          : await loadWorkOrderVisitsPage(workOrderId, pageMeta.nextCursor);
      queryClient.setQueryData<any>(key, (existing: any) => {
        if (!existing) return existing;
        const seen = new Set(
          section === "photos"
            ? existing.photos
            : existing[section].map((item: any) => item.id),
        );
        const appended = page.items.filter((item: any) =>
          !seen.has(section === "photos" ? item : item.id),
        );
        const next = {
          ...existing,
          [section]: [...existing[section], ...appended],
          [metaKey]: {
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
            totalCount: page.totalCount,
          },
        };
        if (section === "activities") {
          next.pendingSevenElevenActivities = next.activities.filter((activity: any) =>
            activity.requiresSevenElevenSync && !activity.syncedToSevenElevenAt,
          );
          next.pendingContractorActivities = next.activities.filter((activity: any) =>
            activity.requiresContractorAttention && !activity.contractorAcknowledgedAt,
          );
        }
        return next;
      });
    } finally {
      setLoadingSection(null);
    }
  }, [loadingSection, queryClient, workOrder, workOrderId]);

  return {
    ...query,
    loadMoreActivities: () => appendPage("activities"),
    loadMorePhotos: () => appendPage("photos"),
    loadMoreVisits: () => appendPage("visits"),
    loadingActivities: loadingSection === "activities",
    loadingPhotos: loadingSection === "photos",
    loadingVisits: loadingSection === "visits",
  };
}

export function useProfilesQuery(enabled = true) {
  return useQuery({
    queryKey: PROFILES_KEY,
    queryFn: loadAllProfiles,
    staleTime: 60_000,
    enabled,
  });
}

export function useTechniciansQuery(enabled = true) {
  return useQuery({
    queryKey: TECHNICIANS_KEY,
    queryFn: loadTechnicians,
    staleTime: 60_000,
    enabled,
  });
}
