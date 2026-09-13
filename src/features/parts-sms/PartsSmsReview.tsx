"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCursorPagination } from "../../lib/useCursorPagination";
import PartsSmsDialog from "./PartsSmsDialog";
import { invalidatePartsSms, usePartsSmsHistory } from "./queries";
import { partsSmsOperator, partsSmsPresentation, partsSmsTime, type PartsSmsAction, type PartsSmsActionResult, type PartsSmsDelivery } from "./contracts";

export default function PartsSmsReview({ profile, delivery, onCommitted, onDialogChange }: {
  profile: unknown; delivery: PartsSmsDelivery; onCommitted: (result: PartsSmsActionResult) => void; onDialogChange?: (open: boolean) => void;
}) {
  const operator = partsSmsOperator(profile);
  const client = useQueryClient();
  const [action, setAction] = useState<PartsSmsAction | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const pagination = useCursorPagination(`parts-sms-history:${operator?.id || ""}:${delivery.id}`);
  const history = usePartsSmsHistory(profile, delivery.id, pagination.position.cursor, historyOpen);
  const view = partsSmsPresentation(delivery);
  if (!operator) return null;
  const refresh = () => { void invalidatePartsSms(client, operator).catch(() => undefined); };
  const chooseAction = (next: PartsSmsAction | null) => { setAction(next); onDialogChange?.(next !== null); };
  return <div style={{ marginTop: 8 }}>
    <strong>{view.label}</strong>{!delivery.current && <span> · Historical alert — no resend</span>}
    {view.originNote && <p>{view.originNote}{delivery.recurrenceGeneration != null && <> · Source generation {delivery.recurrenceGeneration}</>}</p>}
    <p style={{ margin: "6px 0" }}>{view.guidance}</p>
    {delivery.statusCheckStale && <p role="alert">Provider status checks are stale or exhausted. Operations should review the provider evidence. This does not authorize another SMS.</p>}
    <div>{delivery.legacy ? "Tracking record" : "Queued"}: {partsSmsTime(delivery.createdAt)} · Attempts: {delivery.attemptCount}</div>
    {delivery.lastAttemptAt && <div>Last attempt: {partsSmsTime(delivery.lastAttemptAt)}</div>}
    {delivery.completedAt && <div>Outcome recorded: {partsSmsTime(delivery.completedAt)}</div>}
    {delivery.nextAttemptAt && delivery.state === "failed" && <div>Next known-unsent retry: {partsSmsTime(delivery.nextAttemptAt)}</div>}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
      <button type="button" className="btn-soft" onClick={() => setHistoryOpen(value => !value)} aria-expanded={historyOpen}>{historyOpen ? "Hide history" : "View history"}</button>
      {view.canResend && <button type="button" className="btn-soft" style={{ color: "#9f1239" }} onClick={() => chooseAction("resend")}>Resend with reason</button>}
      {view.canResolve && <button type="button" className="btn-soft" onClick={() => chooseAction("manual_resolution")}>Record contacted another way</button>}
    </div>
    {historyOpen && <section aria-label="Parts SMS attempt history" style={{ marginTop: 12 }}>
      {history.isPending && <p role="status">Loading history…</p>}
      {history.isError && <p role="alert">Could not load history. <button type="button" onClick={() => { void history.refetch(); }}>Retry history</button></p>}
      {history.data && <><ol>{history.data.items.map(item => <li key={item.id}>
        {item.kind === "source_recurrence" ? "System queued source recurrence" : item.kind === "resend" ? "Staff requested resend" : item.kind === "manual_resolution" ? "Contacted another way" : item.kind === "provider_status" ? "Provider status check" : `Attempt ${item.sequence}`} · {item.state === "manually_resolved" ? "Out-of-band resolution" : item.state.replace(/_/g, " ")}
        {item.providerState && <> · Provider: {item.providerState}</>} · {partsSmsTime(item.createdAt)}
        {item.completedAt && <> · Outcome: {partsSmsTime(item.completedAt)}</>}
        {item.reason && <p>{item.kind === "source_recurrence" ? "System reason" : "Staff reason"}: {item.reason}</p>}
      </li>)}</ol>{history.data.items.length === 0 && <p>No recorded attempts.</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="btn-soft" disabled={pagination.position.page <= 1 || history.isFetching} onClick={pagination.previous}>Previous history</button>
        <button type="button" className="btn-soft" disabled={!history.data.hasMore || history.isFetching} onClick={() => pagination.next(history.data.nextCursor)}>More history</button>
      </div>{!history.data.hasMore && <p>End of history.</p>}</>}
    </section>}
    {action && <PartsSmsDialog delivery={delivery} action={action} onClose={() => chooseAction(null)} onConflict={refresh}
      onCommitted={result => { onCommitted(result); refresh(); }} />}
  </div>;
}
