import { supabase } from "../../lib/supabase/client";
import { FINANCIAL_NOTICE_PAGE_SIZE, FinancialNoticeError, noticeActionResultSchema, noticeActionSchema, noticeHistorySchema, noticeOperationSchema,
  noticeSchema, parseNoticeCursor, parseNoticePage, parseNoticeStatus, safeNoticeError, type NoticeAction,
  type NoticeFamilyFilter, type NoticeOperation, type NoticeStateFilter } from "./contracts";

export async function readFinancialNoticeStatus(invoiceId: string, cursor: string | null, signal: AbortSignal) {
  const { data, error } = await supabase().rpc("get_financial_notification_status_v1", {
    p_invoice_id: invoiceId, p_cursor: parseNoticeCursor(cursor), p_limit: FINANCIAL_NOTICE_PAGE_SIZE,
  }).abortSignal(signal);
  if (error) throw safeNoticeError(error);
  const result = parseNoticeStatus(data);
  if (result.items.some(item => item.invoiceId !== invoiceId)) throw new FinancialNoticeError("RESULT_UNCONFIRMED");
  return result;
}
export async function readUnresolvedFinancialNotices(family: NoticeFamilyFilter, state: NoticeStateFilter, search: string, cursor: string | null, signal: AbortSignal) {
  const { data, error } = await supabase().rpc("list_financial_notification_unresolved_v1", {
    p_family: family === "all" ? null : family, p_state: state === "all" ? null : state, p_search: search,
    p_cursor: parseNoticeCursor(cursor), p_limit: FINANCIAL_NOTICE_PAGE_SIZE,
  }).abortSignal(signal);
  if (error) throw safeNoticeError(error);
  const page = parseNoticePage(data, noticeSchema);
  if (page.items.some(item => !item.current || item.supersededBySourceEventId !== null)) throw new FinancialNoticeError("DELIVERY_INTEGRITY_REVIEW");
  return page;
}
export async function readFinancialNoticeHistory(eventId: string, cursor: string | null, signal: AbortSignal) {
  const { data, error } = await supabase().rpc("get_financial_notification_history_v1", {
    p_event_id: eventId, p_cursor: parseNoticeCursor(cursor), p_limit: FINANCIAL_NOTICE_PAGE_SIZE,
  }).abortSignal(signal);
  if (error) throw safeNoticeError(error);
  return parseNoticePage(data, noticeHistorySchema);
}
export async function reconcileFinancialNotice(action: NoticeAction, input: NoticeOperation) {
  const parsedAction = noticeActionSchema.safeParse(action);
  if (!parsedAction.success) throw new FinancialNoticeError("VALIDATION_FAILED");
  const parsed = noticeOperationSchema.safeParse(input);
  if (!parsed.success) throw new FinancialNoticeError(input && typeof input.reason === "string" && input.reason.trim() ? "VALIDATION_FAILED" : "REASON_REQUIRED");
  const operation = parsed.data;
  try {
    const command = { resend: "request_financial_notification_resend_v1", manual_resolution: "resolve_financial_notification_out_of_band_v1",
      history_note: "annotate_financial_notification_history_v1" } as const;
    const statuses = { resend: "queued", manual_resolution: "manually_resolved", history_note: "historical_note_recorded" } as const;
    const { data, error } = await supabase().rpc(command[parsedAction.data], {
      p_event_id: operation.eventId, p_delivery_id: operation.deliveryId, p_operation_id: operation.operationId, p_reason: operation.reason,
    });
    if (error) throw error;
    const result = noticeActionResultSchema.safeParse(data);
    if (!result.success || result.data.eventId !== operation.eventId || result.data.operationId !== operation.operationId
      || result.data.status !== statuses[parsedAction.data]
      || (parsedAction.data !== "resend" && (result.data.deliveryId !== operation.deliveryId || result.data.deliveryCount !== 0))) throw new FinancialNoticeError("RESULT_UNCONFIRMED");
    return result.data;
  } catch (cause) { throw safeNoticeError(cause); }
}
