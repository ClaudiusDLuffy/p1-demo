"use client";

import { useEffect, useId, useState } from "react";
import { useCursorPagination } from "../../lib/useCursorPagination";
import { canReviewNotices, noticeFamilyLabel, noticeFamilySchema, noticeOperator, noticePresentation, noticeRecipientLabel,
  safeNoticeError, type NoticeFamilyFilter, type NoticeStateFilter } from "./contracts";
import { useFinancialNoticeQueue } from "./queries";
import { noticeTime } from "./FinancialNoticeReview";

export default function FinancialNoticeQueue({ profile, onOpenInvoice }: { profile: unknown; onOpenInvoice: (invoiceId: string) => void }) {
  const id = useId();
  const [family, setFamily] = useState<NoticeFamilyFilter>("all");
  const [state, setState] = useState<NoticeStateFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [reset, setReset] = useState(0);
  const operator = noticeOperator(profile);
  const { position, previous, next } = useCursorPagination(JSON.stringify([operator?.id, family, state, search, reset]));
  const query = useFinancialNoticeQueue(profile, family, state, search, position.cursor);
  useEffect(() => { const timer = setTimeout(() => setSearch(searchInput.trim()), 300); return () => clearTimeout(timer); }, [searchInput]);
  if (!operator) return null;
  return <section aria-labelledby={`${id}-title`} style={{ padding: 18, marginBottom: 18, border: "1px solid #cbd5e1", borderRadius: 12 }}>
    <h2 id={`${id}-title`}>Invoice notification follow-up</h2>
    <p>Current delivery outcomes requiring staff review. Older hold changes are excluded; their original outcomes remain in invoice history. Open the invoice to inspect the intended recipient and reconcile safely.</p>
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
      <label htmlFor={`${id}-family`}>Notification <select id={`${id}-family`} value={family} onChange={event => {
        if (event.target.value === "all") setFamily("all"); else { const parsed = noticeFamilySchema.safeParse(event.target.value); if (parsed.success) setFamily(parsed.data); }
      }}><option value="all">All permitted events</option>
        {noticeFamilySchema.options.filter(value => canReviewNotices(operator) || value.startsWith("payment_hold_")).map(value => <option key={value} value={value}>{noticeFamilyLabel[value]}</option>)}
      </select></label>
      <label htmlFor={`${id}-state`}>Delivery state <select id={`${id}-state`} value={state} onChange={event => {
        const value = event.target.value; if (value === "all" || value === "unknown" || value === "not_deliverable" || value === "failed") setState(value);
      }}><option value="all">All requiring review</option><option value="unknown">Delivery unresolved</option><option value="not_deliverable">Email unavailable</option><option value="failed">Delivery failed</option></select></label>
      <label htmlFor={`${id}-search`}>Invoice or work-order reference <input id={`${id}-search`} type="search" maxLength={100} value={searchInput} onChange={event => setSearchInput(event.target.value)} /></label>
      <button className="btn-soft" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>Refresh follow-up</button>
    </div>
    {query.isFetching && <p role="status">Loading invoice follow-up…</p>}
    {query.isError && <p role="alert">{safeNoticeError(query.error).message}
      <button className="btn-soft" onClick={() => { void query.refetch(); }}>Retry list</button>
      <button className="btn-soft" onClick={() => setReset(reset + 1)}>Start at newest results</button></p>}
    {query.data && !query.isError && <>
      {query.data.items.length === 0 && <p>No invoice notifications require review for these filters.</p>}
      <ul style={{ padding: 0, listStyle: "none" }}>{query.data.items.map(delivery => <li key={delivery.id} style={{ borderTop: "1px solid #e2e8f0", padding: "12px 0" }}>
        <strong>{noticeFamilyLabel[delivery.family]} · {noticePresentation(delivery).label}</strong>
        <p>{noticeRecipientLabel[delivery.recipientKind]} · {delivery.workOrderId || "Standalone invoice"} · Record {delivery.id.slice(0, 8)} · {noticeTime(delivery.createdAt)}</p>
        {delivery.state === "unknown" && <p>The recipient may already have received the email.</p>}
        <button className="btn-soft" onClick={() => onOpenInvoice(delivery.invoiceId)}>Open invoice to review</button>
      </li>)}</ul>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn-soft" disabled={query.isFetching || position.page === 1} onClick={previous}>Previous page</button>
        <span>Page {position.page}</span>
        <button className="btn-soft" disabled={query.isFetching || !query.data.hasMore} onClick={() => next(query.data.nextCursor)}>More invoice notices</button>
      </div>
      {!query.data.hasMore && <p>End of current results. Refresh to see newly unresolved events.</p>}
    </>}
  </section>;
}
