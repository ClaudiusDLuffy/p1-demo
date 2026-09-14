"use client";

import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCursorPagination } from "../../lib/useCursorPagination";
import { canActOnNotice, noticeEventPresentation, noticeFamilyLabel, noticeHistoryLabel, noticeOperator, noticeOutcomeGuidance, noticePresentation, noticePriorOutcomeLabel, noticeRecipientLabel,
  safeNoticeError, type FinancialNotice, type NoticeAction } from "./contracts";
import { invalidateFinancialNotices, useFinancialNoticeHistory } from "./queries";
import FinancialNoticeDialog from "./FinancialNoticeDialog";

export function noticeTime(value: string | null) { return value ? new Date(value).toLocaleString() : "Not recorded"; }
function NoticeHistory({ profile, eventId }: { profile: unknown; eventId: string }) {
  const [reset, setReset] = useState(0);
  const { position, previous, next } = useCursorPagination(`${eventId}:${reset}`);
  const query = useFinancialNoticeHistory(profile, eventId, position.cursor);
  return <section aria-label="Financial notification history">
    <h4>Event delivery and reconciliation history</h4>
    {query.isFetching && <p role="status">Loading history…</p>}
    {query.isError && <p role="alert">{safeNoticeError(query.error).message}
      <button className="btn-soft" onClick={() => { void query.refetch(); }}>Retry history</button>
      <button className="btn-soft" onClick={() => setReset(reset + 1)}>Start at newest history</button></p>}
    {query.data && !query.isError && <>
      <ol>{query.data.items.map(item => <li key={item.id} style={{ marginBottom: 10 }}>
        <strong>{noticeHistoryLabel(item)}</strong>
        {" · "}{item.kind === "attempt" ? `Attempt ${item.sequence} · ` : ""}{noticeTime(item.createdAt)}
        {item.completedAt && <> · Completed {noticeTime(item.completedAt)}</>}
        {(item.kind === "historical_note" || item.kind === "supersession") && <p>Original email outcome: {noticePresentation({
          state: item.state, attemptCount: item.sequence, code: item.code, canResend: false, canResolve: false,
        }).label}. {item.state === "unknown" ? "The recipient may already have received this email. No resend is authorized." : "No new email is authorized by this record."}</p>}
        {item.kind === "system_no_longer_required" && <p>Recorded prior delivery status: <strong>{noticePriorOutcomeLabel(item.state)}</strong>.
          {" "}A later financial change made the unstarted notice unnecessary. This classification does not claim that an email was sent.</p>}
        {noticeOutcomeGuidance(item.code) && <p>{noticeOutcomeGuidance(item.code)}</p>}
        {item.reason && <p>{item.kind === "system_no_longer_required" || item.kind === "supersession" ? "System reason:" : "Staff reason:"} {item.reason}</p>}
      </li>)}</ol>
      {query.data.items.length === 0 && <p>No attempts recorded.</p>}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn-soft" disabled={query.isFetching || position.page === 1} onClick={previous}>Previous history page</button>
        <span>Page {position.page}</span>
        <button className="btn-soft" disabled={query.isFetching || !query.data.hasMore} onClick={() => next(query.data.nextCursor)}>More history</button>
      </div>
      {!query.data.hasMore && <p>End of recorded history.</p>}
    </>}
  </section>;
}

export default function FinancialNoticeReview({ profile, delivery, latestHoldSourceEventId, onNotice }: {
  profile: unknown; delivery: FinancialNotice; latestHoldSourceEventId: string | null; onNotice: (message: string) => void;
}) {
  const operator = noticeOperator(profile);
  const client = useQueryClient();
  const [action, setAction] = useState<NoticeAction | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const historyId = useId();
  if (!operator) return null;
  const view = noticeEventPresentation(delivery, latestHoldSourceEventId);
  const familyAllowed = canActOnNotice(operator, delivery.family);
  const allowed = view.current && familyAllowed;
  const identified = Boolean(delivery.recipientLabel) || delivery.recipientKind === "missing";
  function refresh() {
    if (operator) void invalidateFinancialNotices(client, operator, delivery.invoiceId).catch(() => {
      onNotice("The latest notification view could not be refreshed. Use Refresh notifications to check its authoritative state.");
    });
  }
  return <article style={{ padding: "14px 0", borderTop: "1px solid #cbd5e1" }}>
    <h4 style={{ margin: "0 0 8px" }}>{noticeFamilyLabel[delivery.family]} · {noticeRecipientLabel[delivery.recipientKind]}</h4>
    <p>Recipient: {delivery.recipientLabel || "No eligible recipient recorded"} · Record {delivery.id.slice(0, 8)}</p>
    {!view.current && !view.supersededHold && <p>Historical event — no reconciliation action is available.</p>}
    {delivery.reviewRevision !== null && <p>Review revision {delivery.reviewRevision}</p>}
    <p><strong>{view.label}</strong> · {view.guidance}</p>
    {view.supersededHold && <>
      {delivery.supersededAt && <p>Later hold change recorded {noticeTime(delivery.supersededAt)}.</p>}
      <p>{delivery.state === "superseded" ? "Historical delivery status:" : "Original email outcome:"} <strong>{view.originalLabel}</strong>.
        {delivery.state === "unknown" ? " Delivery could not be confirmed and the recipient may already have received this email. It will not be resent."
          : delivery.state === "sent" ? " The provider-confirmed result remains recorded; a later hold change does not undo that email."
            : delivery.state === "manually_resolved" ? " The original out-of-band contact record is preserved; it is not provider-confirmed email delivery."
              : " All original delivery attempts and outcomes remain in the history."}</p>
    </>}
    <p style={{ fontSize: 12 }}>Queued {noticeTime(delivery.createdAt)} · Attempts {delivery.attemptCount}
      {delivery.lastAttemptAt && <> · Last attempt {noticeTime(delivery.lastAttemptAt)}</>}
      {delivery.completedAt && <> · Completed {noticeTime(delivery.completedAt)}</>}
    </p>
    {noticeOutcomeGuidance(delivery.code) && <p>{noticeOutcomeGuidance(delivery.code)}</p>}
    {view.actionable && delivery.current && !view.canResend && !view.canResolve && <p>Recipient or event identity needs operational review before any action.</p>}
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {allowed && identified && view.canResend && <button className="btn-soft" style={{ color: "#9f1239", borderColor: "#9f1239" }} onClick={() => setAction("resend")}>Resend with reason</button>}
      {allowed && Boolean(delivery.recipientLabel) && view.canResolve && <button className="btn-soft" onClick={() => setAction("manual_resolution")}>Record contact another way</button>}
      {familyAllowed && view.canAnnotateHistory && <button className="btn-soft" onClick={() => setAction("history_note")}>Add historical review note</button>}
      <button className="btn-soft" aria-expanded={showHistory} aria-controls={historyId} onClick={() => setShowHistory(!showHistory)}>{showHistory ? "Hide history" : "Review event history"}</button>
    </div>
    {showHistory && <div id={historyId}><NoticeHistory profile={profile} eventId={delivery.eventId} /></div>}
    {action && <FinancialNoticeDialog key={`${delivery.id}:${action}`} delivery={delivery} action={action} onClose={() => setAction(null)} onConflict={refresh}
      onCommitted={result => {
        onNotice(result.status === "queued" ? "Resend queued. Email delivery has not yet been confirmed."
          : result.status === "historical_note_recorded" ? "Historical review note recorded. The original email outcome is unchanged; no resend was queued."
            : "Contact recorded another way. Email delivery is not marked sent.");
        refresh();
      }} />}
  </article>;
}
