"use client";

import { useDeferredValue, useState } from "react";

import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { PRIORITY, STATUS, T } from "../../lib/constants";
import {
  type DashboardBucketId,
  type DashboardInvoice,
  type DashboardPart,
  type DashboardWorkOrder,
} from "./workBuckets";
import { useCursorBuckets } from "../../lib/useCursorPagination";
import { useWorkOrdersPageQuery } from "../work-orders/queries";

const BUCKET_COLORS: Record<DashboardBucketId, string> = {
  pending_submission: "#B8478A",
  pending_approval: T.accent,
  awaiting_parts: T.warn,
  seven_eleven_updates: "#2563EB",
  unassigned: T.danger,
  p1_parts_to_order: T.violet,
  pending_capital_completion: "#5B4B8A",
};

const DASHBOARD_PAGE_KEYS = [
  "unassigned",
  "pending_submission",
  "pending_approval",
  "awaiting_parts",
  "seven_eleven_updates",
  "p1_parts_to_order",
  "pending_capital_completion",
] as const;

export default function DashboardWorkBuckets({
  search,
  setSearch,
  getUser,
  onOpenWorkOrder,
  onViewAll,
}: {
  workOrders: DashboardWorkOrder[];
  invoices: DashboardInvoice[];
  parts: DashboardPart[];
  search: string;
  setSearch: (value: string) => void;
  getUser?: (id: string) => { company?: string | null; name?: string | null } | null;
  onOpenWorkOrder: (workOrderId: string) => void;
  onViewAll: () => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    pending_submission: true,
    pending_approval: true,
    awaiting_parts: false,
    seven_eleven_updates: true,
    unassigned: true,
    p1_parts_to_order: true,
    pending_capital_completion: true,
  });
  const deferredSearch = useDeferredValue(search.trim());
  const {
    positions,
    previous: previousBucketPage,
    next: nextBucketPage,
  } = useCursorBuckets(deferredSearch, DASHBOARD_PAGE_KEYS);
  const unassignedQuery = useWorkOrdersPageQuery({ scope: "dashboard_unassigned", search: deferredSearch, sort: "priority", limit: 25, cursor: positions.unassigned.cursor });
  const submissionQuery = useWorkOrdersPageQuery({ scope: "dashboard_pending_submission", search: deferredSearch, sort: "priority", limit: 25, cursor: positions.pending_submission.cursor });
  const approvalQuery = useWorkOrdersPageQuery({ scope: "dashboard_pending_approval", search: deferredSearch, sort: "priority", limit: 25, cursor: positions.pending_approval.cursor });
  const partsQuery = useWorkOrdersPageQuery({ scope: "dashboard_awaiting_parts", search: deferredSearch, sort: "priority", limit: 25, cursor: positions.awaiting_parts.cursor });
  const sevenElevenQuery = useWorkOrdersPageQuery({ scope: "dashboard_seven_eleven_updates", search: deferredSearch, sort: "priority", limit: 25, cursor: positions.seven_eleven_updates.cursor });
  const p1PartsQuery = useWorkOrdersPageQuery({ scope: "dashboard_p1_parts_to_order", search: deferredSearch, sort: "priority", limit: 25, cursor: positions.p1_parts_to_order.cursor });
  const capitalQuery = useWorkOrdersPageQuery({ scope: "dashboard_pending_capital_completion", search: deferredSearch, sort: "priority", limit: 25, cursor: positions.pending_capital_completion.cursor });
  const buckets = [
    { id: "unassigned", label: "Unassigned", description: "New calls that still need a contractor assignment.", query: unassignedQuery },
    { id: "pending_submission", label: "Pending 7-Eleven submission", description: "Contractor review is complete; P1 billing still needs to be prepared or submitted.", query: submissionQuery },
    { id: "pending_approval", label: "Pending approvals", description: "Submitted, revised, or rejected contractor invoices still need a staff decision or correction.", query: approvalQuery },
    { id: "awaiting_parts", label: "Awaiting parts", description: "Jobs paused for parts, kept separate from P1 procurement requests.", query: partsQuery },
    { id: "seven_eleven_updates", label: "Needing 7-Eleven updates", description: "Activity exists that has not yet been copied into the 7-Eleven portal.", query: sevenElevenQuery },
    { id: "p1_parts_to_order", label: "Parts P1 needs to order", description: "Contractor requests waiting for P1 purchasing action.", query: p1PartsQuery },
    { id: "pending_capital_completion", label: "Pending capital completion", description: "Capital quotes sent to 7-Eleven with equipment work still in progress.", query: capitalQuery },
  ] as const;

  return (
    <section aria-label="Operational work queues">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 850, color: T.ink }}>Operational queues</div>
          <div style={{ marginTop: 4, fontSize: 11, color: T.muted, lineHeight: 1.5 }}>
            Work the outcome buckets below. Assigned and In Progress remain available under Work orders without competing for dashboard space.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "1 1 320px", justifyContent: "flex-end", flexWrap: "wrap" }}>
          <input
            type="search"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search WO#, store, keyword…"
            aria-label="Search dashboard work queues"
            style={{ width: 280, maxWidth: "100%", minHeight: 38, padding: "9px 12px", borderRadius: 9, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontFamily: "inherit", fontSize: 12 }}
          />
          <button type="button" className="btn-soft" onClick={onViewAll}>All work orders</button>
        </div>
      </div>

      <div className="dashboard-bucket-grid" style={{ display: "grid", gap: 12 }}>
        {buckets.map(bucket => {
          const visibleRows = (bucket.query.data?.items || []) as DashboardWorkOrder[];
          const isExpanded = expanded[bucket.id] !== false;
          const color = BUCKET_COLORS[bucket.id];
          const position = positions[bucket.id];
          return (
            <article key={bucket.id} className="card" style={{ overflow: "hidden" }}>
              <button
                type="button"
                aria-expanded={isExpanded}
                aria-controls={`dashboard-bucket-${bucket.id}`}
                onClick={() => setExpanded(current => ({ ...current, [bucket.id]: !isExpanded }))}
                style={{ width: "100%", border: 0, background: T.surface, padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <span aria-hidden="true" style={{ color, fontSize: 18, transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>›</span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", color: T.ink, fontSize: 13, fontWeight: 800 }}>{bucket.label}</span>
                    <span style={{ display: "block", color: T.subtle, fontSize: 10, marginTop: 3, overflowWrap: "anywhere" }}>{bucket.description}</span>
                  </span>
                </span>
                <span style={{ flex: "0 0 auto", minWidth: 28, height: 24, padding: "0 8px", borderRadius: 999, background: `${color}18`, color, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 850 }}>
                  {bucket.query.data?.totalCount || 0}
                </span>
              </button>

              {isExpanded && (
                <div id={`dashboard-bucket-${bucket.id}`} style={{ borderTop: `1px solid ${T.borderSoft}` }}>
                  {visibleRows.map((workOrder, index) => {
                    const priority = PRIORITY[workOrder.priority as keyof typeof PRIORITY];
                    const status = STATUS[workOrder.status as keyof typeof STATUS];
                    const contractor = workOrder.contractor ? getUser?.(workOrder.contractor) : null;
                    return (
                      <button
                        key={workOrder.id}
                        type="button"
                        onClick={() => onOpenWorkOrder(workOrder.id)}
                        style={{ width: "100%", border: 0, borderBottom: index === visibleRows.length - 1 ? 0 : `1px solid ${T.borderSoft}`, background: T.surface, padding: "12px 16px", display: "grid", gridTemplateColumns: "minmax(130px, .7fr) minmax(220px, 2fr) minmax(130px, .8fr) auto", alignItems: "center", gap: 12, textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}
                      >
                        <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: T.accent, fontSize: 11, fontWeight: 750 }}>
                          {workOrder.id}
                          <span onClick={event => event.stopPropagation()}><CopyWorkOrderButton value={workOrder.id} /></span>
                        </span>
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: "block", color: T.ink, fontSize: 12, fontWeight: 650, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                            Store #{workOrder.store || "-"} · {workOrder.summary || workOrder.description || "No summary"}
                          </span>
                          <span style={{ display: "block", color: T.subtle, fontSize: 10, marginTop: 3 }}>
                            {contractor?.company || contractor?.name || "Unassigned"}
                          </span>
                        </span>
                        <span style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                          {priority && <span style={{ padding: "3px 7px", borderRadius: 999, color: priority.color, background: priority.bg, fontSize: 9, fontWeight: 800 }}>{priority.short}</span>}
                          {status && <span style={{ padding: "3px 7px", borderRadius: 999, color: status.color, background: status.bg, fontSize: 9, fontWeight: 800 }}>{status.label}</span>}
                        </span>
                        <span style={{ display: "flex", justifyContent: "flex-end", gap: 5, flexWrap: "wrap" }}>
                          {workOrder.hasUnreadNotes && <span title="New contractor activity for this login" style={{ padding: "3px 7px", borderRadius: 999, color: "#1D4ED8", background: "#DBEAFE", fontSize: 9, fontWeight: 800 }}>Unread</span>}
                          {workOrder.hasPendingSevenElevenSync && <span title="Not yet copied to the 7-Eleven portal" style={{ padding: "3px 7px", borderRadius: 999, color: "#1D4ED8", background: "#EFF6FF", fontSize: 9, fontWeight: 800 }}>7-Eleven update</span>}
                        </span>
                      </button>
                    );
                  })}
                  {visibleRows.length === 0 && (
                    <div style={{ padding: "18px 16px", color: T.subtle, fontSize: 11, textAlign: "center" }}>
                      {search ? "No matching work orders in this queue." : "Nothing is waiting in this queue."}
                    </div>
                  )}
                  <div style={{ padding: "9px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, background: T.surfaceSoft, fontSize: 10, color: T.subtle }}>
                    <span>{bucket.query.isFetching ? "Loading..." : `Page ${position.page}`}</span>
                    <span style={{ display: "flex", gap: 7 }}>
                      <button type="button" className="btn-soft" disabled={position.page <= 1 || bucket.query.isFetching} onClick={() => previousBucketPage(bucket.id)} style={{ padding: "5px 8px", fontSize: 9 }}>Previous</button>
                      <button type="button" className="btn-soft" disabled={!bucket.query.data?.hasMore || bucket.query.isFetching} onClick={() => nextBucketPage(bucket.id, bucket.query.data?.nextCursor || null)} style={{ padding: "5px 8px", fontSize: 9 }}>Next</button>
                    </span>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>

      <div className="card" style={{ marginTop: 12, padding: "11px 14px", background: T.surfaceSoft, color: T.muted, fontSize: 10, lineHeight: 1.5 }}>
        <strong style={{ color: T.ink }}>Unread</strong> means new contractor activity for your login. <strong style={{ color: T.ink }}>Needs 7-Eleven update</strong> means a specific activity still has to be copied to 7-Eleven. They can overlap, but they are not the same state.
      </div>
    </section>
  );
}
