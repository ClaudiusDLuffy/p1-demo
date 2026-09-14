import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { CACHE_VERSION } from "../storage/readCache";
import { createMobileRepositories } from "./repositories";
import { createRpcReader } from "./rpc";
import { getNativeSupabase } from "../auth/supabase";
const repositories = () => createMobileRepositories(createRpcReader(getNativeSupabase()));
export const workOrdersKey = [CACHE_VERSION, "work-orders"] as const;
export function useWorkOrders() {
  return useInfiniteQuery({
    queryKey: workOrdersKey, initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => repositories().workOrders(pageParam, signal),
    getNextPageParam: page => page.hasMore ? page.nextCursor : undefined,
  });
}
export function useWorkOrder(id: string) {
  return useQuery({ queryKey: [CACHE_VERSION, "work-order", id],
    queryFn: ({ signal }) => repositories().workOrder(id, signal), enabled: Boolean(id) });
}
export function useActivity(id: string) {
  return useInfiniteQuery({ queryKey: [CACHE_VERSION, "activity", id], initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => repositories().activity(id, pageParam, signal),
    getNextPageParam: page => page.hasMore ? page.nextCursor : undefined, enabled: Boolean(id) });
}
export function useVisits(id: string) {
  return useInfiniteQuery({ queryKey: [CACHE_VERSION, "visits", id], initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => repositories().visits(id, pageParam, signal),
    getNextPageParam: page => page.hasMore ? page.nextCursor : undefined, enabled: Boolean(id) });
}
export function usePhotos(id: string) {
  return useInfiniteQuery({ queryKey: [CACHE_VERSION, "photos", id], initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => repositories().photos(id, pageParam, signal),
    getNextPageParam: page => page.hasMore ? page.nextCursor : undefined, enabled: Boolean(id) });
}
