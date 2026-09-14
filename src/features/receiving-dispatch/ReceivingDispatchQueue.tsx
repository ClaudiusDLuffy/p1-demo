"use client";

import { useEffect, useId, useState } from "react";
import { useCursorPagination } from "../../lib/useCursorPagination";
import { dispatchOperator, dispatchPresentation, safeDispatchError, type DispatchFilter } from "./contracts";
import { useUnresolvedDispatch } from "./queries";
import DispatchDeliveryReview, { dispatchTime } from "./DispatchDeliveryReview";

export default function ReceivingDispatchQueue({ profile, onOpenWorkOrder }: {
  profile: unknown; onOpenWorkOrder: (workOrderId: string) => void;
}) {
  const id = useId();
  const [state, setState] = useState<DispatchFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [reset, setReset] = useState(0);
  const operator = dispatchOperator(profile);
  const { position, previous, next } = useCursorPagination(JSON.stringify([operator?.id, state, search, reset]));
  const query = useUnresolvedDispatch(profile, state, search, position.cursor);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);
  if (!operator) return null;
  return <section aria-labelledby={`${id}-title`} style={{ border: "1px solid #cbd5e1", borderRadius: 12, padding: 20, marginBottom: 20 }}>
    <h2 id={`${id}-title`}>Dispatch follow-up</h2>
    <p>Current contractor assignments needing staff review. Scheduled retries stay with the delivery worker.</p>
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
      <label htmlFor={`${id}-state`}>Delivery state <select id={`${id}-state`} value={state}
        onChange={event => { const value = event.target.value; if (value === "all" || value === "unknown" || value === "not_deliverable" || value === "failed") { setState(value); setReviewId(null); } }}>
        <option value="all">All requiring review</option><option value="unknown">Delivery unresolved</option>
        <option value="not_deliverable">Email unavailable</option><option value="failed">Delivery failed</option>
      </select></label>
      <label htmlFor={`${id}-search`}>Work-order ID <input id={`${id}-search`} type="search" maxLength={100} value={searchInput}
        onChange={event => { setSearchInput(event.target.value); setReviewId(null); }} /></label>
      <button disabled={query.isFetching} onClick={() => { void query.refetch(); }}>Refresh follow-up</button>
    </div>
    {query.isFetching && <p role="status">Loading dispatch follow-up…</p>}
    {notice && <p role="status">{notice}</p>}
    {query.isError && <p role="alert">{safeDispatchError(query.error).message} <button onClick={() => { void query.refetch(); }}>Retry list</button>
      <button onClick={() => { setReviewId(null); setReset(reset + 1); }}>Start at newest dispatches</button></p>}
    {query.data && !query.isError && <>
      {query.data.items.length === 0 && <p>No current dispatches require review for these filters.</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>{query.data.items.map(delivery => <li key={delivery.id} style={{ borderTop: "1px solid #e2e8f0", padding: "12px 0" }}>
        <button className="btn-soft" onClick={() => onOpenWorkOrder(delivery.workOrderId)}>Open {delivery.workOrderId}</button>
        {" · "}<strong>{dispatchPresentation(delivery).label}</strong>{" · "}{dispatchTime(delivery.createdAt)}
        <button className="btn-soft" aria-expanded={reviewId === delivery.id}
          onClick={() => setReviewId(reviewId === delivery.id ? null : delivery.id)}>{reviewId === delivery.id ? "Close review" : "Review dispatch"}</button>
        {reviewId === delivery.id && <DispatchDeliveryReview key={delivery.id} profile={profile} delivery={delivery} onNotice={setNotice} />}
      </li>)}</ul>
      <div style={{ display: "flex", gap: 10 }}>
        <button disabled={query.isFetching || position.page === 1} onClick={() => { setReviewId(null); previous(); }}>Previous page</button>
        <span>Page {position.page}</span>
        <button disabled={query.isFetching || !query.data.hasMore} onClick={() => { setReviewId(null); next(query.data.nextCursor); }}>More dispatches</button>
      </div>
      {!query.data.hasMore && <p>End of current results. Refresh to see newly unresolved deliveries.</p>}
    </>}
  </section>;
}
