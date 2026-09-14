"use client";

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { isPortalVisible } from "../../lib/realtime/browserVisibility";
import { readCurrentDispatch, readDispatchHistory, readUnresolvedDispatch } from "./api";
import { dispatchOperator, operatorScope, type DispatchFilter, type DispatchOperator } from "./contracts";

export const receivingDispatchKeys = {
  scope: (operator: DispatchOperator) => ["receiving-dispatch", ...operatorScope(operator)] as const,
  current: (operator: DispatchOperator, workOrderId: string, assignmentVersion: number) =>
    [...receivingDispatchKeys.scope(operator), "current", workOrderId, assignmentVersion] as const,
  unresolved: (operator: DispatchOperator, state: DispatchFilter, search: string, cursor: string | null) =>
    [...receivingDispatchKeys.scope(operator), "unresolved", state, search, cursor] as const,
  history: (operator: DispatchOperator, deliveryId: string, cursor: string | null) =>
    [...receivingDispatchKeys.scope(operator), "history", deliveryId, cursor] as const,
};
const deniedKey = ["receiving-dispatch", "unavailable"] as const;
export function useCurrentDispatch(profile: unknown, workOrderId: string, assignmentVersion: number) {
  const operator = dispatchOperator(profile);
  return useQuery({
    queryKey: operator ? receivingDispatchKeys.current(operator, workOrderId, assignmentVersion) : deniedKey,
    queryFn: ({ signal }) => readCurrentDispatch(workOrderId, assignmentVersion, signal),
    enabled: Boolean(operator && workOrderId && Number.isSafeInteger(assignmentVersion) && assignmentVersion >= 0),
    staleTime: 15_000, retry: false,
    refetchInterval: query => query.state.data?.delivery && ["pending", "claimed", "sending", "failed"].includes(query.state.data.delivery.state) ? 30_000 : false,
    refetchIntervalInBackground: false,
  });
}
export function useUnresolvedDispatch(profile: unknown, state: DispatchFilter, search: string, cursor: string | null) {
  const operator = dispatchOperator(profile);
  return useQuery({
    queryKey: operator ? receivingDispatchKeys.unresolved(operator, state, search, cursor) : deniedKey,
    queryFn: ({ signal }) => readUnresolvedDispatch(state, search, cursor, signal),
    enabled: Boolean(operator), staleTime: 15_000, retry: false,
    refetchInterval: 30_000, refetchIntervalInBackground: false,
  });
}
export function useDispatchHistory(profile: unknown, deliveryId: string, cursor: string | null, enabled: boolean) {
  const operator = dispatchOperator(profile);
  return useQuery({
    queryKey: operator ? receivingDispatchKeys.history(operator, deliveryId, cursor) : deniedKey,
    queryFn: ({ signal }) => readDispatchHistory(deliveryId, cursor, signal),
    enabled: Boolean(operator && deliveryId && enabled), staleTime: 15_000, retry: false,
  });
}
export async function invalidateDispatch(client: QueryClient, operator: DispatchOperator, workOrderId: string, assignmentVersion: number) {
  const refetchType = isPortalVisible() ? "active" : "none";
  await Promise.all([
    client.invalidateQueries({ queryKey: receivingDispatchKeys.current(operator, workOrderId, assignmentVersion), refetchType }, { cancelRefetch: false }),
    client.invalidateQueries({ queryKey: [...receivingDispatchKeys.scope(operator), "unresolved"], refetchType }, { cancelRefetch: false }),
    client.invalidateQueries({ queryKey: [...receivingDispatchKeys.scope(operator), "history"], refetchType }, { cancelRefetch: false }),
  ]);
}
