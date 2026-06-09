import { useQuery } from "@tanstack/react-query";
import { loadWorkOrders, loadAllProfiles, loadTechnicians } from "../../lib/db";

export const WORK_ORDERS_KEY = ["work-orders"] as const;
export const PROFILES_KEY = ["profiles"] as const;
export const TECHNICIANS_KEY = ["technicians"] as const;

export function useWorkOrdersQuery(enabled = true) {
  return useQuery({
    queryKey: WORK_ORDERS_KEY,
    queryFn: loadWorkOrders,
    staleTime: 30_000,
    enabled,
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
