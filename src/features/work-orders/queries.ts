import { useQuery } from "@tanstack/react-query";
import {
  loadAllProfiles,
  loadTechnicians,
  loadWoParts,
  loadWorkOrderDetails,
  loadWorkOrders,
} from "../../lib/db";

export const WORK_ORDERS_KEY = ["work-orders"] as const;
export const WORK_ORDER_DETAILS_KEY = ["work-order-details"] as const;
export const PROFILES_KEY = ["profiles"] as const;
export const TECHNICIANS_KEY = ["technicians"] as const;
export const WO_PARTS_KEY = ["wo-parts"] as const;

export const workOrderDetailsKey = (workOrderId: string) =>
  [...WORK_ORDER_DETAILS_KEY, workOrderId] as const;

export function useWoPartsQuery(enabled = true) {
  return useQuery({
    queryKey: WO_PARTS_KEY,
    queryFn: loadWoParts,
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

export function useWorkOrderDetailsQuery(
  workOrder: Parameters<typeof loadWorkOrderDetails>[0] | null | undefined,
  enabled = true,
) {
  const workOrderId = String(workOrder?.id || "");
  return useQuery({
    queryKey: workOrderDetailsKey(workOrderId),
    queryFn: () => loadWorkOrderDetails(workOrder),
    staleTime: 30_000,
    enabled: enabled && workOrderId.length > 0,
  });
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
