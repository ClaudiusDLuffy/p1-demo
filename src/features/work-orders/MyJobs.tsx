"use client";
// @ts-nocheck

import { Badge } from "../../components/ui/Badge";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { SlaBadge } from "../../components/SlaBadge";
import { T, PRIORITY, STATUS } from "../../lib/constants";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { reportClientFailure } from "../../lib/clientDiagnostics";
import { useCursorPagination } from "../../lib/useCursorPagination";
import { useWorkOrdersPageQuery } from "./queries";

export default function MyJobs(props: any) {
  const { page, isManager, myWOs, currentUser, slaLabel, setSelectedWO, setPage, setAiNote, woParts = [] } = props;
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const {
    position,
    previous: previousPage,
    next: nextPage,
  } = useCursorPagination(deferredSearch);
  const contractorId = currentUser?.contractorAccountId || currentUser?.id || null;
  const enabled = page === "my_jobs" && !isManager && Boolean(contractorId);
  const jobsQuery = useWorkOrdersPageQuery({ scope: "active", contractorId, search: deferredSearch, sort: "priority", limit: 25, cursor: position.cursor }, enabled);
  const activeCountQuery = useWorkOrdersPageQuery({ scope: "active", contractorId, sort: "newest", limit: 1 }, enabled);
  const pendingCountQuery = useWorkOrdersPageQuery({ scope: "active", contractorId, status: "pending_invoice", sort: "newest", limit: 1 }, enabled);
  const capitalCountQuery = useWorkOrdersPageQuery({ scope: "capital", contractorId, sort: "newest", limit: 1 }, enabled);
  const visibleJobs: any[] = (jobsQuery.data?.items || (enabled ? [] : myWOs)) as any[];
  const jobsError = jobsQuery.error instanceof Error
    ? jobsQuery.error.message
    : jobsQuery.error
      ? String(jobsQuery.error)
      : null;
  useEffect(() => {
    if (!jobsError) return;
    void reportClientFailure({
      source: "my-jobs-query",
      message: jobsError,
      portalView: "my_jobs",
    });
  }, [jobsError]);
  const retryJobs = () => {
    void Promise.all([
      jobsQuery.refetch(),
      activeCountQuery.refetch(),
      pendingCountQuery.refetch(),
      capitalCountQuery.refetch(),
    ]);
  };
  const jobCounts = {
    active: activeCountQuery.data?.totalCount || 0,
    pendingInvoice: pendingCountQuery.data?.totalCount || 0,
    capital: capitalCountQuery.data?.totalCount || 0,
  };
  // Per-WO parts summary for the parts-status badge. Only counted when there
  // are structured wo_parts rows for the WO — legacy part_needed scalars get
  // their own card on detail view, not a badge here.
  const partsByWO = useMemo(() => {
    const map: Record<string, { total: number; received: number }> = {};
    for (const p of woParts) {
      const m = (map[p.workOrderId] ||= { total: 0, received: 0 });
      m.total += 1;
      if (p.status === "received") m.received += 1;
    }
    return map;
  }, [woParts]);
  return (
    <>
          {/* ═════ MY JOBS (contractor) ═════ */}
          {page === "my_jobs" && !isManager && (
            <div style={{ animation: "fadeUp 0.3s" }}>
              <div className="stats-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 24 }}>
                {[
                  { l: "Active", v: jobCounts.active, c: T.accent, bg: T.accentSoft },
                  { l: "Pending inv.", v: jobCounts.pendingInvoice, c: T.violet, bg: T.violetSoft },
                  { l: "Capital", v: jobCounts.capital, c: T.warn, bg: T.warnSoft },
                ].map((s, i) => (
                  <div key={i} className="card" style={{ background: s.bg, padding: "20px 22px" }}>
                    <div style={{ fontSize: 11, color: s.c, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>{s.l}</div>
                    <div className="display stat-value" style={{ fontSize: 30, fontWeight: 500, color: s.c, letterSpacing: -0.6 }}>{s.v}</div>
                  </div>
                ))}
              </div>
              <input
                type="search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                aria-label="Search my jobs"
                placeholder="Search WO#, store, address, keyword..."
                style={{ width: "100%", marginBottom: 18, padding: "11px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink }}
              />
              {jobsQuery.isLoading && (
                <div className="card" style={{ padding: "28px 20px", color: T.muted, textAlign: "center" }}>
                  Loading work orders...
                </div>
              )}
              {jobsQuery.isError && (
                <div className="card" role="alert" style={{ padding: "24px 20px", textAlign: "center" }}>
                  <div style={{ color: T.ink, fontWeight: 700, marginBottom: 6 }}>Work orders could not load</div>
                  <div style={{ color: T.muted, fontSize: 12, marginBottom: 14 }}>
                    Your work orders are still saved. Retry the secure connection to load them.
                  </div>
                  <button type="button" className="btn-soft" onClick={retryJobs} disabled={jobsQuery.isFetching}>
                    {jobsQuery.isFetching ? "Retrying..." : "Retry"}
                  </button>
                </div>
              )}
              {!jobsQuery.isLoading && !jobsQuery.isError && visibleJobs.length === 0 && (
                <div className="card" style={{ padding: "28px 20px", color: T.muted, textAlign: "center" }}>
                  No matching work orders.
                </div>
              )}
              {visibleJobs.map((wo, i) => {
                const sla = slaLabel(wo);
                const hasNewSla = !!(wo.responseBreachAt || wo.resolutionBreachAt);
                const partsSummary = Number(wo.partsTotal || 0) > 0
                  ? {
                      total: Number(wo.partsTotal || 0),
                      received: Number(wo.partsReceived || 0),
                    }
                  : partsByWO[wo.id];
                const location = (wo.addr || wo.city || "").trim();
                const storeLocation = [wo.store ? `Store #${wo.store}` : null, location || null]
                  .filter(Boolean)
                  .join(" · ") || wo.id;
                return (
                  <div key={wo.id} className="card card-hover" onClick={() => { setSelectedWO(wo.id); setPage("wo_detail"); setAiNote(null); }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", marginBottom: 10, cursor: "pointer", animation: `fadeUp 0.3s ${i * 0.04}s both`, gap: 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                        <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: T.accent }}>{wo.id}</span>
                        <CopyWorkOrderButton value={wo.id} />
                        <Badge conf={PRIORITY[wo.priority]} small />
                        {hasNewSla
                          ? <SlaBadge responseBreachAt={wo.responseBreachAt} resolutionBreachAt={wo.resolutionBreachAt} responseMetAt={wo.startTimeRaw} size="sm" />
                          : sla && <span style={{ fontSize: 10, fontWeight: 700, color: sla.color, background: sla.bg, padding: "2px 8px", borderRadius: 10 }}>{sla.text}</span>}
                        {partsSummary && partsSummary.total > 0 && (
                          <span style={{ fontSize: 10, fontWeight: 700, color: partsSummary.received === partsSummary.total ? "#065F46" : "#92400E", background: partsSummary.received === partsSummary.total ? "#D1FAE5" : "#FEF3C7", padding: "2px 8px", borderRadius: 10, letterSpacing: 0.3 }}>
                            {partsSummary.total} part{partsSummary.total !== 1 ? "s" : ""} · {partsSummary.received} received
                          </span>
                        )}
                        {Number(wo.pendingContractorAttentionCount || 0) > 0 && (
                          <span
                            title="Staff requested contractor attention"
                            style={{ fontSize: 10, fontWeight: 800, color: "#166534", background: "#DCFCE7", border: "1px solid #22C55E66", padding: "2px 8px", borderRadius: 10 }}
                          >
                            {wo.pendingContractorAttentionCount} need{wo.pendingContractorAttentionCount === 1 ? "s" : ""} attention
                          </span>
                        )}
                      </div>
                      <div title={storeLocation} style={{ fontSize: 14, fontWeight: 600, color: T.ink, marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{storeLocation}</div>
                      <div style={{ fontSize: 12, color: T.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{wo.summary || "—"}</div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <Badge conf={STATUS[wo.status]} small />
                      <div style={{ fontSize: 10, color: T.subtle, marginTop: 4 }}>{wo.age}</div>
                    </div>
                  </div>
                );
              })}
              <div style={{ marginTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, color: T.muted }}>
                  {jobsQuery.isError
                    ? "Work orders unavailable"
                    : jobsQuery.isFetching
                      ? "Loading jobs..."
                      : `${jobsQuery.data?.totalCount || 0} jobs · page ${position.page}`}
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="btn-soft" disabled={position.page <= 1 || jobsQuery.isFetching} onClick={previousPage}>Previous</button>
                  <button type="button" className="btn-soft" disabled={!jobsQuery.data?.hasMore || jobsQuery.isFetching} onClick={() => nextPage(jobsQuery.data?.nextCursor || null)}>Next</button>
                </div>
              </div>
            </div>
          )}


    </>
  );
}
