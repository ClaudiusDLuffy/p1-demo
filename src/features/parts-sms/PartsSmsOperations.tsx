"use client";

import { useEffect, useState } from "react";
import { useCursorPagination } from "../../lib/useCursorPagination";
import { partsSmsCount, partsSmsFilterSchema, partsSmsOperator, partsSmsRecurrenceRun, partsSmsTime, type PartsSmsDelivery, type PartsSmsFilter, type PartsSmsPage } from "./contracts";
import { usePartsSmsHealth, usePartsSmsQueue } from "./queries";
import PartsSmsReview from "./PartsSmsReview";

export default function PartsSmsOperations({ profile }: { profile: unknown }) {
  const operator = partsSmsOperator(profile);
  const [state, setState] = useState<PartsSmsFilter>("all");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [pageEpoch, setPageEpoch] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reviewPage, setReviewPage] = useState<PartsSmsPage<PartsSmsDelivery> | null>(null);
  useEffect(() => { const timeout = setTimeout(() => setSearch(searchDraft.trim()), 300); return () => clearTimeout(timeout); }, [searchDraft]);
  const pagination = useCursorPagination(`parts-sms:${operator?.id || ""}:${state}:${search}:${pageEpoch}`);
  const health = usePartsSmsHealth(profile);
  const queue = usePartsSmsQueue(profile, state, search, pagination.position.cursor, !dialogOpen);
  // Preserve the reviewed row and entered dialog reason if a refetch resolves
  // or supersedes the event while staff are confirming an action.
  const page = dialogOpen && reviewPage ? reviewPage : queue.data;
  if (!operator) return null;
  return <section className="card" aria-label="Parts SMS delivery operations" style={{ padding: 16, marginTop: 12 }}>
    <h3>Parts SMS delivery</h3>
    <p>The worker checks the local cutoff every three minutes. One automatic daily provider-accepted alert per recipient; explicit resends may duplicate delivery. Unknown delivery requires review.</p>
    {health.isPending && <p role="status">Loading worker health…</p>}
    {health.isError && <p role="alert">Worker health could not be confirmed. <button type="button" onClick={() => { void health.refetch(); }}>Retry health</button></p>}
    {health.data && <div>
      <div>Alerts {health.data.enabled ? "enabled" : "disabled"} · {health.data.timezone} · Cutoff {health.data.cutoffTime || "not configured"}</div>
      <div>Last run: {partsSmsTime(health.data.lastStartedAt)} · Last completion: {partsSmsTime(health.data.lastCompletedAt)}</div>
      <div>Last successful run: {partsSmsTime(health.data.lastSuccessfulAt)}</div>
      {health.data.lastResultCode && health.data.lastResultCode !== "RUN_COMPLETE" && <p role="alert">The last run did not complete successfully. Review worker configuration and delivery outcomes.</p>}
      {health.data.stale && <p role="alert">Worker heartbeat is missing or older than two expected intervals. Operations must check the owned schedule.</p>}
      {health.data.currentRunIncomplete && <p role="alert">A worker run has not recorded completion. Check its lease and outcome before assuming alerts ran.</p>}
      {partsSmsRecurrenceRun(health.data.lastRunRecurrenceQueued, health.data.lastRunRecurrenceBlocked) && <p>{partsSmsRecurrenceRun(health.data.lastRunRecurrenceQueued, health.data.lastRunRecurrenceBlocked)}</p>}
      {health.data.sourceRecurrenceCount > 0 && <p role="alert">Automatic source recurrence blocked for review: {partsSmsCount(health.data.sourceRecurrenceCount)}. Safety checks prevented a new SMS; review the affected historical alerts below.</p>}
      <p>Unresolved: {partsSmsCount(health.data.unknownCount)} · Phone/config unavailable: {partsSmsCount(health.data.notDeliverableCount)} · Stale provider status: {partsSmsCount(health.data.staleStatusCount)} · Expired claims: {partsSmsCount(health.data.expiredClaimCount)}</p>
      {health.data.oldestPendingAt && <p>Oldest pending alert: {partsSmsTime(health.data.oldestPendingAt)}</p>}
    </div>}
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end", margin: "12px 0" }}>
      <label>Delivery view <select value={state} disabled={dialogOpen} onChange={event => { const selected = partsSmsFilterSchema.safeParse(event.target.value); if (selected.success) setState(selected.data); }}>
        <option value="all">Needs attention</option><option value="unknown">Delivery unresolved</option>
        <option value="not_deliverable">Phone unavailable</option><option value="failed">Delivery failed</option><option value="history">Historical and current alerts</option>
      </select></label>
      <label>Search staff label <input value={searchDraft} maxLength={100} disabled={dialogOpen} onChange={event => setSearchDraft(event.target.value)} /></label>
      <button type="button" className="btn-soft" disabled={dialogOpen || queue.isFetching || health.isFetching} onClick={() => { void queue.refetch(); void health.refetch(); }}>Refresh delivery</button>
    </div>
    {notice && <p role="status">{notice}</p>}
    {queue.isPending && <p role="status">Loading alerts…</p>}
    {queue.isError && <p role="alert">Could not load alerts. Refresh the list or <button type="button" onClick={() => setPageEpoch(value => value + 1)}>Start at newest alerts</button>.</p>}
    {page && <>
      {page.items.length === 0 && <p>No alerts match this view.</p>}
      {page.items.map(delivery => <article key={delivery.id} style={{ padding: 12, borderTop: "1px solid #cbd5e1" }}>
        <h4>{delivery.recipientName || "Configured staff recipient"} · {delivery.localDate}</h4>
        <PartsSmsReview profile={profile} delivery={delivery} onDialogChange={open => { setReviewPage(open ? queue.data || null : null); setDialogOpen(open); }} onCommitted={result => setNotice(result.status === "queued"
          ? "Resend queued. SMS delivery has not yet been confirmed."
          : "Contact recorded another way. SMS delivery is not marked sent or delivered.")} />
      </article>)}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button type="button" className="btn-soft" disabled={dialogOpen || pagination.position.page <= 1 || queue.isFetching} onClick={pagination.previous}>Previous alerts</button>
        <button type="button" className="btn-soft" disabled={dialogOpen || !page.hasMore || queue.isFetching} onClick={() => pagination.next(page.nextCursor)}>More alerts</button>
      </div>
      <p>{queue.isFetching ? "Refreshing alerts…" : page.hasMore ? "More alerts are available." : "End of alerts."}</p>
    </>}
  </section>;
}
