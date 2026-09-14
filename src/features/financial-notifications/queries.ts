"use client";

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { isPortalVisible } from "../../lib/realtime/browserVisibility";
import { readFinancialNoticeHistory, readFinancialNoticeStatus, readUnresolvedFinancialNotices } from "./api";
import { noticeOperator, noticeScope, type NoticeFamilyFilter, type NoticeOperator, type NoticeStateFilter } from "./contracts";

export const financialNoticeKeys = {
  scope: (operator: NoticeOperator) => ["financial-notifications", ...noticeScope(operator)] as const,
  status: (operator: NoticeOperator, invoiceId: string, invoiceVersion: number | null, reviewRevision: number, cursor: string | null) =>
    [...financialNoticeKeys.scope(operator), "status", invoiceId, invoiceVersion, reviewRevision, cursor] as const,
  unresolved: (operator: NoticeOperator, family: NoticeFamilyFilter, state: NoticeStateFilter, search: string, cursor: string | null) =>
    [...financialNoticeKeys.scope(operator), "unresolved", family, state, search, cursor] as const,
  history: (operator: NoticeOperator, eventId: string, cursor: string | null) => [...financialNoticeKeys.scope(operator), "history", eventId, cursor] as const,
};
const unavailable = ["financial-notifications", "unavailable"] as const;
export function useFinancialNoticeStatus(profile: unknown, invoiceId: string, invoiceVersion: number | null, reviewRevision: number, cursor: string | null) {
  const operator = noticeOperator(profile);
  return useQuery({ queryKey: operator ? financialNoticeKeys.status(operator, invoiceId, invoiceVersion, reviewRevision, cursor) : unavailable,
    queryFn: ({ signal }) => readFinancialNoticeStatus(invoiceId, cursor, signal), enabled: Boolean(operator && invoiceId),
    staleTime: 15_000, retry: false, refetchInterval: 30_000, refetchIntervalInBackground: false });
}
export function useFinancialNoticeQueue(profile: unknown, family: NoticeFamilyFilter, state: NoticeStateFilter, search: string, cursor: string | null) {
  const operator = noticeOperator(profile);
  return useQuery({ queryKey: operator ? financialNoticeKeys.unresolved(operator, family, state, search, cursor) : unavailable,
    queryFn: ({ signal }) => readUnresolvedFinancialNotices(family, state, search, cursor, signal), enabled: Boolean(operator),
    staleTime: 15_000, retry: false, refetchInterval: 30_000, refetchIntervalInBackground: false });
}
export function useFinancialNoticeHistory(profile: unknown, eventId: string, cursor: string | null) {
  const operator = noticeOperator(profile);
  return useQuery({ queryKey: operator ? financialNoticeKeys.history(operator, eventId, cursor) : unavailable,
    queryFn: ({ signal }) => readFinancialNoticeHistory(eventId, cursor, signal), enabled: Boolean(operator && eventId), staleTime: 15_000, retry: false });
}
export async function invalidateFinancialNotices(client: QueryClient, operator: NoticeOperator, invoiceId: string) {
  const refetchType = isPortalVisible() ? "active" : "none";
  await Promise.all([
    client.invalidateQueries({ queryKey: [...financialNoticeKeys.scope(operator), "status", invoiceId], refetchType }, { cancelRefetch: false }),
    client.invalidateQueries({ queryKey: [...financialNoticeKeys.scope(operator), "unresolved"], refetchType }, { cancelRefetch: false }),
    client.invalidateQueries({ queryKey: [...financialNoticeKeys.scope(operator), "history"], refetchType }, { cancelRefetch: false }),
  ]);
}
