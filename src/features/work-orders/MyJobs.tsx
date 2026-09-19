"use client";
// @ts-nocheck

import { normalizeUnknownError } from "../../lib/errors/normalizeUnknown";
import { COUNT_FRESHNESS_DESCRIPTION } from "../../lib/counts/countContracts";
import { Badge } from "../../components/ui/Badge";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { CapitalWorkOrderBadge } from "../../components/ui/CapitalWorkOrderBadge";
import { SlaBadge } from "../../components/SlaBadge";
import { T, PRIORITY, STATUS } from "../../lib/constants";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  reportClientDiagnostic,
  reportClientFailure,
} from "../../lib/clientDiagnostics";
import { CONTRACTOR_ACTIVE_WORK_ORDER_SORT } from "../../lib/workOrderView";
import { useCursorPagination } from "../../lib/useCursorPagination";
import { useWorkOrdersPageQuery, useWorkOrdersCountQuery } from "./queries";
import { resolveWorkOrderCollectionState, WorkOrderCollectionNotice } from "./WorkOrderCollectionNotice";
import WorkOrderSortControls from "./WorkOrderSortControls";
import type { WorkOrderTableSortColumn } from "../../lib/db";

export default function MyJobs(props: any) {
  const { page, isManager, myWOs, currentUser, slaLabel, setSelectedWO, setPage, setAiNote, woParts = [] } = props;
  const [search, setSearch] = useState("");
  const [sortColumn, setSortColumn] = useState<WorkOrderTableSortColumn>("created");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const deferredSearch = useDeferredValue(search.trim());
  const {
    position,
    previous: previousPage,
    next: nextPage,
  } = useCursorPagination(JSON.stringify({ search: deferredSearch, sortColumn, sortDirection }));
  const contractorId = currentUser?.contractorAccountId || currentUser?.id || null;
  const enabled = page === "my_jobs" && !isManager && Boolean(contractorId);
  const jobsQuery = useWorkOrdersPageQuery({ scope: "active", contractorId, search: deferredSearch, sort: CONTRACTOR_ACTIVE_WORK_ORDER_SORT, tableSortColumn: sortColumn, tableSortDirection: sortDirection, limit: 25, cursor: position.cursor }, enabled, undefined, { countEnabled: false });
  // Badge counts are exact but deliberately sequenced behind the visible page
  // and each other. Four simultaneous scans from every My Jobs open were able
  // to exhaust the database statement deadline under normal concurrency.
  const activeCountQuery = useWorkOrdersCountQuery({ scope: "active", contractorId }, enabled && jobsQuery.isSuccess && !jobsQuery.isPlaceholderData);
  const pendingCountQuery = useWorkOrdersCountQuery({ scope: "active", contractorId, status: "pending_invoice" }, enabled && activeCountQuery.isSuccess);
  const capitalCountQuery = useWorkOrdersCountQuery({ scope: "capital", contractorId }, enabled && pendingCountQuery.isSuccess);
  const visibleJobs: any[] = (jobsQuery.data?.items || (enabled ? [] : myWOs)) as any[];
  const resultDiagnosticRef = useRef<string | null>(null);
  const jobsFailure = jobsQuery.error ? normalizeUnknownError(jobsQuery.error) : null;
  const jobsError = jobsFailure?.message || "";
  const jobsErrorCode = jobsFailure?.code;
  useEffect(() => {
    if (!jobsError) return;
    void reportClientFailure({
      source: "my-jobs-query",
      code: jobsErrorCode,
      message: jobsError,
      portalView: "my_jobs",
    });
  }, [jobsError, jobsErrorCode]);
  useEffect(() => {
    if (
      !enabled
      || deferredSearch !== ""
      || position.page !== 1
      || !jobsQuery.isSuccess
      || jobsQuery.isFetching
    ) return;

    const itemCount = jobsQuery.data?.items.length || 0;
    const totalCount = jobsQuery.data?.totalCount ?? null;
    const hasMore = jobsQuery.data?.hasMore === true;
    const signature = [contractorId, itemCount, totalCount, hasMore].join(":");
    if (resultDiagnosticRef.current === signature) return;
    resultDiagnosticRef.current = signature;

    void reportClientDiagnostic({
      level: itemCount === 0 ? "warning" : "info",
      source: "my-jobs-result",
      message: itemCount === 0
        ? "My Jobs first page returned no work orders"
        : "My Jobs first page loaded",
      portalView: "my_jobs",
      details: {
        scope: "active",
        page: position.page,
        itemCount,
        ...(totalCount !== null ? { totalCount } : {}),
        hasMore,
        contractorScopeResolved: Boolean(contractorId),
      },
    });
  }, [
    contractorId,
    deferredSearch,
    enabled,
    jobsQuery.data,
    jobsQuery.isFetching,
    jobsQuery.isSuccess,
    position.page,
  ]);
  const retryJobs = () => {
    void (async () => {
      await jobsQuery.refetch();
      await activeCountQuery.refetch();
      await pendingCountQuery.refetch();
      await capitalCountQuery.refetch();
    })();
  };
  const collectionState = resolveWorkOrderCollectionState({
    itemCount: visibleJobs.length,
    isPending: enabled && jobsQuery.isPending,
    isFetching: enabled && jobsQuery.isFetching,
    isError: jobsQuery.isError || !contractorId,
  });
  const jobsErrorMessage = contractorId
    ? "Your work orders are still saved. Retry the secure connection to load them."
    : "Your contractor account could not be resolved. Refresh the page or contact P1 support.";
  const jobCounts = {
    active: activeCountQuery.data?.totalCount ?? "—",
    pendingInvoice: pendingCountQuery.data?.totalCount ?? "—",
    capital: capitalCountQuery.data?.totalCount ?? "—",
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
                    <div title={COUNT_FRESHNESS_DESCRIPTION} className="display stat-value" style={{ fontSize: 30, fontWeight: 500, color: s.c, letterSpacing: -0.6 }}>{s.v}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 18, flexWrap: "wrap" }}>
                <input
                  type="search"
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  aria-label="Search my jobs"
                  placeholder="Search WO#, store, address, keyword..."
                  style={{ flex: "1 1 300px", minWidth: 220, padding: "11px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink }}
                />
                <WorkOrderSortControls
                  column={sortColumn}
                  direction={sortDirection}
                  options={[
                    { value: "created", label: "Date received" },
                    { value: "work_order", label: "Work order" },
                    { value: "status", label: "Status" },
                    { value: "priority", label: "Priority" },
                    { value: "store", label: "Store" },
                    { value: "summary", label: "Summary" },
                    { value: "updated", label: "Last updated" },
                    { value: "sla", label: "SLA due" },
                  ]}
                  onColumnChange={value => {
                    setSortColumn(value);
                    setSortDirection(["created", "updated", "sla"].includes(value) ? "desc" : "asc");
                  }}
                  onDirectionChange={setSortDirection}
                />
              </div>
              {collectionState === "error" && visibleJobs.length > 0 && (
                <WorkOrderCollectionNotice
                  state="error"
                  errorMessage="The latest work-order refresh failed. Showing the previously loaded results."
                  onRetry={retryJobs}
                  retrying={jobsQuery.isFetching}
                  style={{ marginBottom: 14, padding: "14px 16px" }}
                />
              )}
              {visibleJobs.length === 0 && (
                <WorkOrderCollectionNotice
                  state={collectionState}
                  loadingMessage="Loading your work orders…"
                  errorMessage={jobsErrorMessage}
                  emptyMessage={search ? "No work orders match your search." : "No active work orders are assigned to your account."}
                  onRetry={contractorId ? retryJobs : undefined}
                  retrying={jobsQuery.isFetching}
                  className="card"
                  style={{ marginBottom: 14 }}
                />
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
                      <div style={{ display: "flex", justifyContent: "flex-end", gap: 5, flexWrap: "wrap" }}>
                        <Badge conf={STATUS[wo.status]} small />
                        <CapitalWorkOrderBadge workOrder={wo} small />
                      </div>
                      <div style={{ fontSize: 10, color: T.subtle, marginTop: 4 }}>{wo.age}</div>
                    </div>
                  </div>
                );
              })}
              <div style={{ marginTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span title={COUNT_FRESHNESS_DESCRIPTION} style={{ fontSize: 11, color: T.muted }}>
                  {jobsQuery.isError
                    ? "Work orders unavailable"
                    : jobsQuery.isFetching
                      ? "Loading jobs..."
                      : `${jobsQuery.data?.totalCount ?? "—"} jobs · page ${position.page}`}
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
