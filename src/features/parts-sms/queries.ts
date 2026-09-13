"use client";

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { isPortalVisible, usePortalVisibility } from "../../lib/realtime/browserVisibility";
import { readPartsSmsHealth, readPartsSmsHistory, readPartsSmsQueue } from "./api";
import { partsSmsOperator, partsSmsScope, type PartsSmsFilter, type PartsSmsOperator } from "./contracts";

export const partsSmsKeys = {
  scope: (operator: PartsSmsOperator) => ["parts-sms", ...partsSmsScope(operator)] as const,
  health: (operator: PartsSmsOperator) => [...partsSmsKeys.scope(operator), "health"] as const,
  queue: (operator: PartsSmsOperator, state: PartsSmsFilter, search: string, cursor: string | null) => [...partsSmsKeys.scope(operator), "queue", state, search, cursor] as const,
  history: (operator: PartsSmsOperator, id: string, cursor: string | null) => [...partsSmsKeys.scope(operator), "history", id, cursor] as const,
};
const denied = ["parts-sms", "unavailable"] as const;
export function usePartsSmsHealth(profile: unknown) {
  const visible = usePortalVisibility();
  const operator = partsSmsOperator(profile);
  return useQuery({ queryKey: operator ? partsSmsKeys.health(operator) : denied,
    queryFn: ({ signal }) => readPartsSmsHealth(signal), enabled: Boolean(operator) && visible,
    staleTime: 15_000, retry: false, refetchInterval: 30_000, refetchIntervalInBackground: false });
}
export function usePartsSmsQueue(profile: unknown, state: PartsSmsFilter, search: string, cursor: string | null, polling = true) {
  const operator = partsSmsOperator(profile);
  return useQuery({ queryKey: operator ? partsSmsKeys.queue(operator, state, search, cursor) : denied,
    queryFn: ({ signal }) => readPartsSmsQueue(state, search, cursor, signal), enabled: Boolean(operator),
    staleTime: 15_000, retry: false, refetchInterval: polling ? 30_000 : false, refetchOnWindowFocus: false, refetchIntervalInBackground: false });
}
export function usePartsSmsHistory(profile: unknown, id: string, cursor: string | null, enabled: boolean) {
  const operator = partsSmsOperator(profile);
  return useQuery({ queryKey: operator ? partsSmsKeys.history(operator, id, cursor) : denied,
    queryFn: ({ signal }) => readPartsSmsHistory(id, cursor, signal), enabled: Boolean(operator && id && enabled), staleTime: 15_000, retry: false });
}
export async function invalidatePartsSms(client: QueryClient, operator: PartsSmsOperator) {
  const refetchType = isPortalVisible() ? "active" : "none";
  await Promise.all([client.invalidateQueries({ queryKey: partsSmsKeys.health(operator), refetchType }, { cancelRefetch: false }),
    client.invalidateQueries({ queryKey: [...partsSmsKeys.scope(operator), "queue"], refetchType }, { cancelRefetch: false }),
    client.invalidateQueries({ queryKey: [...partsSmsKeys.scope(operator), "history"], refetchType }, { cancelRefetch: false })]);
}
