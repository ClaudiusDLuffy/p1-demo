"use client";

import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCursorPagination } from "../../lib/useCursorPagination";
import { dispatchOperator, dispatchOutcomeGuidance, dispatchPresentation, safeDispatchError, type DispatchAction, type DispatchDelivery } from "./contracts";
import { invalidateDispatch, useDispatchHistory } from "./queries";
import DispatchReconciliationDialog from "./DispatchReconciliationDialog";

export function dispatchTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}

function AttemptHistory({ profile, deliveryId }: { profile: unknown; deliveryId: string }) {
  const [reset, setReset] = useState(0);
  const { position, previous, next } = useCursorPagination(`${deliveryId}:${reset}`);
  const history = useDispatchHistory(profile, deliveryId, position.cursor, true);
  return <section aria-label="Dispatch attempt history">
    <h4>Delivery and reconciliation history</h4>
    {history.isFetching && <p role="status">Loading history…</p>}
    {history.isError && <p role="alert">{safeDispatchError(history.error).message} <button onClick={() => { void history.refetch(); }}>Retry history</button>
      <button onClick={() => setReset(reset + 1)}>Start at newest history</button></p>}
    {history.data && !history.isError && <>
      <ol>{history.data.items.map(item => <li key={item.id}>
        <strong>{item.kind === "resend" ? "Explicit resend queued" : item.kind === "manual_resolution" ? "Contacted another way"
          : dispatchPresentation({ state: item.state, attemptCount: item.sequence, code: item.code, canResend: false, canResolve: false }).label}</strong>
        {" · "}{item.kind === "attempt" ? `Attempt ${item.sequence} · ` : ""}{dispatchTime(item.createdAt)}
        {item.completedAt && <> · Completed {dispatchTime(item.completedAt)}</>}
        {dispatchOutcomeGuidance(item.code) && <p>{dispatchOutcomeGuidance(item.code)}</p>}
        {item.reason && <p>Staff reason: {item.reason}</p>}
      </li>)}</ol>
      {history.data.items.length === 0 && <p>No attempts recorded.</p>}
      <div style={{ display: "flex", gap: 10 }}>
        <button disabled={history.isFetching || position.page === 1} onClick={previous}>Previous history page</button>
        <span>Page {position.page}</span>
        <button disabled={history.isFetching || !history.data.hasMore} onClick={() => next(history.data.nextCursor)}>More history</button>
      </div>
      {!history.data.hasMore && <p>End of recorded history.</p>}
    </>}
  </section>;
}

export default function DispatchDeliveryReview({ profile, delivery, onNotice }: {
  profile: unknown; delivery: DispatchDelivery; onNotice?: (message: string) => void;
}) {
  const operator = dispatchOperator(profile);
  const client = useQueryClient();
  const [action, setAction] = useState<DispatchAction | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [notice, setNotice] = useState("");
  const historyId = useId();
  if (!operator) return null;
  const presentation = dispatchPresentation(delivery);
  function refresh() {
    if (operator) void invalidateDispatch(client, operator, delivery.workOrderId, delivery.assignmentVersion);
  }
  return <div>
    <p><strong>{presentation.label}</strong> · {presentation.guidance}</p>
    <p style={{ fontSize: 12 }}>Queued {dispatchTime(delivery.createdAt)} · Attempts {delivery.attemptCount}
      {delivery.lastAttemptAt && <> · Last attempt {dispatchTime(delivery.lastAttemptAt)}</>}
      {delivery.completedAt && <> · {delivery.state === "sent" ? "Accepted" : "Completed"} {dispatchTime(delivery.completedAt)}</>}
    </p>
    {presentation.actionable && <p>Staff review required.</p>}
    {dispatchOutcomeGuidance(delivery.code) && <p>{dispatchOutcomeGuidance(delivery.code)}</p>}
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {presentation.canResend && <button className="btn-soft" style={{ color: "#9f1239", border: "1px solid #9f1239" }}
        onClick={() => { setNotice(""); setAction("resend"); }}>Resend with reason</button>}
      {presentation.canResolve && <button className="btn-soft" onClick={() => { setNotice(""); setAction("manual_resolution"); }}>Record contact another way</button>}
      <button className="btn-soft" aria-expanded={showHistory} aria-controls={historyId} onClick={() => setShowHistory(!showHistory)}>
        {showHistory ? "Hide history" : "Review history"}
      </button>
    </div>
    {notice && <p role="status">{notice}</p>}
    {showHistory && <div id={historyId}><AttemptHistory profile={profile} deliveryId={delivery.id} /></div>}
    {action && <DispatchReconciliationDialog key={`${delivery.id}:${action}`} delivery={delivery} action={action}
      onClose={() => setAction(null)} onConflict={refresh}
      onCommitted={result => {
        const message = result.status === "queued" ? "Resend queued. Delivery has not yet been confirmed." : "Contact recorded another way. Email delivery is not marked sent.";
        if (onNotice) onNotice(`${delivery.workOrderId}: ${message}`); else setNotice(message);
        refresh();
      }} />}
  </div>;
}
