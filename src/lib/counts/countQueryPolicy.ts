"use client";

import { usePortalVisibility } from "../realtime/browserVisibility";

// Informational totals are exact when fetched, not action authorization. Thirty
// seconds matches existing row freshness; event routing can invalidate sooner.
export const COUNT_STALE_TIME_MS = 30_000;
export const countReadPolicy = {
  staleTime: COUNT_STALE_TIME_MS,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

export function useCountQueryVisibility(enabled: boolean): boolean {
  return usePortalVisibility() && enabled;
}
