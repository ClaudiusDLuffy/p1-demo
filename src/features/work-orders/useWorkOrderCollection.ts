"use client";

import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { DirectoryActor } from "../directory/contracts";
import { directoryActorScope, workOrderPagesKey } from "../../lib/counts/queryKeys";
import { AppError } from "../../lib/errors/AppError";
import { loadWorkOrdersPage } from "./data/workOrderReadRepository";
import type { WorkOrderPageParams } from "./data/workOrderReadContracts";
import { retryWorkOrderRead } from "./workOrderQueryPolicy";

/** User-requested cursor pages, shared by the focused list and calendar.
 * Never silently cap the collection or scan every page on opening a tab.
 */
export function useWorkOrderCollection(
  params: Omit<WorkOrderPageParams, "cursor" | "limit">,
  enabled: boolean,
  actor: DirectoryActor,
) {
  const query = useInfiniteQuery({
    queryKey: [...workOrderPagesKey(directoryActorScope(actor)), "collection", params],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const page = await loadWorkOrdersPage({ ...params, cursor: pageParam, limit: 50 }, signal);
      if (page.hasMore && (!page.nextCursor || page.nextCursor === pageParam)) {
        throw new AppError("INTERNAL_ERROR");
      }
      return page;
    },
    getNextPageParam: page => page.hasMore ? page.nextCursor : undefined,
    staleTime: 30_000,
    retry: (failureCount, error) => retryWorkOrderRead(params, failureCount, error),
    enabled: enabled && Boolean(actor.id) && actor.active === true,
  });
  const workOrders = useMemo(() => {
    const rows = query.data?.pages.flatMap(page => page.items) || [];
    return [...new Map(rows.map(row => [row.id, row])).values()];
  }, [query.data]);

  return { ...query, workOrders };
}
