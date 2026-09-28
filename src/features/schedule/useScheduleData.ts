"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DirectoryActor } from "../directory/contracts";
import { directoryActorScope, workOrderPagesKey } from "../../lib/counts/queryKeys";
import { queryRetry } from "../../lib/errors/retryPolicy";
import { scheduleReadRepository } from "./scheduleReadRepository";
import { type ScheduleFilters, type ScheduleRange } from "./scheduleQueryModel";

export function useScheduleData(filters: ScheduleFilters, range: ScheduleRange, page: number, pendingOpen: boolean, active: boolean, actor: DirectoryActor) {
  const [debounced, setDebounced] = useState(filters.search);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(filters.search), 300);
    return () => clearTimeout(timer);
  }, [filters.search]);
  const enabled = active && Boolean(actor.id) && actor.active === true && filters.search === debounced;
  const key = [...workOrderPagesKey(directoryActorScope(actor)), "schedule", filters];
  const options = { enabled, staleTime: 30_000, retry: queryRetry };
  const calendar = useQuery({ ...options,
    queryKey: [...key, "calendar", range],
    queryFn: ({ signal }) => scheduleReadRepository.calendar({ ...filters, kind: "calendar", range }, signal),
  });
  const unscheduled = useQuery({ ...options,
    queryKey: [...key, "unscheduled-count"],
    queryFn: ({ signal }) => scheduleReadRepository.count({ ...filters, kind: "unscheduled" }, signal),
  });
  const progress = useQuery({ ...options,
    queryKey: [...key, "progress-count"],
    queryFn: ({ signal }) => scheduleReadRepository.count({ ...filters, kind: "progress" }, signal),
  });
  const pending = useQuery({ ...options, enabled: enabled && pendingOpen,
    queryKey: [...key, "unscheduled", page],
    queryFn: ({ signal }) => scheduleReadRepository.unscheduled({ ...filters, kind: "unscheduled" }, page, signal),
  });
  return { calendar, unscheduled, progress, pending };
}
