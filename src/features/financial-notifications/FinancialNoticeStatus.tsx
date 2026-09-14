"use client";

import { useState } from "react";
import { useCursorPagination } from "../../lib/useCursorPagination";
import { noticeOperator, safeNoticeError } from "./contracts";
import { useFinancialNoticeStatus } from "./queries";
import FinancialNoticeReview from "./FinancialNoticeReview";

export default function FinancialNoticeStatus({ profile, invoiceId, invoiceVersion, reviewRevision }: {
  profile: unknown; invoiceId: string; invoiceVersion: number | null; reviewRevision: number;
}) {
  const [reset, setReset] = useState(0);
  const [notice, setNotice] = useState("");
  const { position, previous, next } = useCursorPagination(JSON.stringify([invoiceId, invoiceVersion, reviewRevision, reset]));
  const query = useFinancialNoticeStatus(profile, invoiceId, invoiceVersion, reviewRevision, position.cursor);
  if (!noticeOperator(profile)) return null;
  return <section aria-label="Invoice notification delivery" style={{ padding: 18, marginBottom: 18, maxWidth: 860, border: "1px solid #cbd5e1", borderRadius: 12 }}>
    <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
      <h3>Invoice notification delivery</h3>
      <button className="btn-soft" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>Refresh notifications</button>
    </div>
    <p>Invoice review and payment actions are separate from email delivery. Each recipient has its own tracked outcome.</p>
    <p>Only the latest effective hold change owns a current hold notification. Earlier hold notices remain here as history and cannot be resent.</p>
    {notice && <p role="status">{notice}</p>}
    {query.isFetching && <p role="status">Loading invoice notifications…</p>}
    {query.isError && <p role="alert">{safeNoticeError(query.error).message}
      <button className="btn-soft" onClick={() => setReset(reset + 1)}>Start at newest notifications</button></p>}
    {query.data && !query.isError && <>
      {query.data.items.length === 0 && <p>No tracked notification events are available for this invoice and your permissions.</p>}
      {query.data.items.map(delivery => <FinancialNoticeReview key={delivery.id} profile={profile} delivery={delivery}
        latestHoldSourceEventId={query.data.latestHoldSourceEventId} onNotice={setNotice} />)}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
        <button className="btn-soft" disabled={query.isFetching || position.page === 1} onClick={previous}>Previous notification page</button>
        <span>Page {position.page}</span>
        <button className="btn-soft" disabled={query.isFetching || !query.data.hasMore} onClick={() => next(query.data.nextCursor)}>More notifications</button>
      </div>
      {!query.data.hasMore && <p>End of recorded notification events.</p>}
    </>}
  </section>;
}
