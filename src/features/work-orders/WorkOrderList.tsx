"use client";
// @ts-nocheck

import { useEffect, useMemo, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Sel } from "../../components/ui/Sel";
import { BtnSpinnerDark } from "../../components/ui/BtnSpinner";
import { NewNotesDot } from "../../components/ui/NewNotesDot";
import { SevenElevenSyncBadge } from "../../components/ui/SevenElevenSyncBadge";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { SlaBadge } from "../../components/SlaBadge";
import { T, PRIORITY, STATUS } from "../../lib/constants";
import { stateCodeFromWorkOrder } from "../../lib/billingRules";
import {
  getSlaAgingStyle,
  getWorkOrderDateMeta,
  prioritizePendingSevenElevenUpdates,
  sortWorkOrders,
  workOrderNeedsAction,
  type WorkOrderSortKey,
} from "../../lib/workOrderView";

export default function WorkOrderList(props: any) {
  const {
    page,
    selectedWO,
    search,
    setSearch,
    isManager,
    filterC,
    setFilterC,
    contractorsOnly,
    filterP,
    setFilterP,
    filterStatus,
    setFilterStatus,
    filteredWOs,
    slaLabel,
    setSelectedWO,
    setAiNote,
    setPage,
    getUser,
  } = props;

  const [listPage, setListPage] = useState(1);
  const [sortBy, setSortBy] = useState<WorkOrderSortKey>(isManager ? "sla_due" : "newest");
  const [viewMode, setViewMode] = useState<"recent" | "needs_action">("recent");
  const [filterState, setFilterState] = useState("all");
  const [hideClosed, setHideClosed] = useState(true);
  const [pagingBusy, setPagingBusy] = useState<"prev" | "next" | null>(null);
  const pageSize = 10;

  const stateFilteredWOs = useMemo(
    () => filterState === "all"
      ? filteredWOs
      : filteredWOs.filter((workOrder: Record<string, unknown>) =>
          stateCodeFromWorkOrder(workOrder) === filterState
        ),
    [filteredWOs, filterState],
  );

  const tableWOs = useMemo(() => {
    const sorted = sortWorkOrders(
      stateFilteredWOs.filter((w: any) =>
        !["capital", "pending_capital_completion"].includes(w.status)
        && (!isManager || !hideClosed || w.status !== "closed")
        && (viewMode !== "needs_action" || workOrderNeedsAction(w, isManager)),
      ),
      sortBy,
    );

    return isManager
      ? prioritizePendingSevenElevenUpdates(sorted)
      : sorted;
  }, [stateFilteredWOs, hideClosed, isManager, sortBy, viewMode]);
  const hiddenClosedCount = isManager && hideClosed
    ? stateFilteredWOs.filter((w: any) => w.status === "closed").length
    : 0;

  const totalPages = Math.max(1, Math.ceil(tableWOs.length / pageSize));
  const safePage = Math.min(listPage, totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const paginatedWOs = tableWOs.slice(startIndex, startIndex + pageSize);
  const showingStart = tableWOs.length === 0 ? 0 : startIndex + 1;
  const showingEnd = Math.min(startIndex + pageSize, tableWOs.length);

  useEffect(() => {
    setListPage(1);
  }, [search, filterC, filterP, filterStatus, filterState, sortBy, hideClosed, viewMode]);

  useEffect(() => {
    setListPage((prev) => Math.min(prev, totalPages));
  }, [totalPages]);

  const goToPage = (direction: "prev" | "next") => {
    setPagingBusy(direction);
    setListPage((prev) => direction === "prev"
      ? Math.max(1, prev - 1)
      : Math.min(totalPages, prev + 1));
    window.setTimeout(() => setPagingBusy(null), 260);
  };

  const renderPaginationControls = () => tableWOs.length > 0 && (
    <div
      className="work-order-pagination"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
        margin: "0 0 14px",
      }}
    >
      <div style={{ fontSize: 12, color: T.muted }}>
        Showing <span style={{ color: T.ink, fontWeight: 700 }}>{showingStart}-{showingEnd}</span> of <span style={{ color: T.ink, fontWeight: 700 }}>{tableWOs.length}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={(e: any) => {
            e.currentTarget.blur();
            goToPage("prev");
          }}
          disabled={safePage <= 1 || !!pagingBusy}
          className="btn-soft"
          style={{ padding: "8px 12px", minHeight: 36, minWidth: 92, fontSize: 12, background: T.surface, color: T.ink, opacity: safePage <= 1 ? 0.45 : 1, cursor: safePage <= 1 || pagingBusy ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          {pagingBusy === "prev" ? <><BtnSpinnerDark />Loading</> : "Previous"}
        </button>
        <span style={{ fontSize: 12, color: T.muted, minWidth: 72, textAlign: "center" }}>
          Page {safePage} of {totalPages}
        </span>
        <button
          type="button"
          onClick={(e: any) => {
            e.currentTarget.blur();
            goToPage("next");
          }}
          disabled={safePage >= totalPages || !!pagingBusy}
          className="btn-soft"
          style={{ padding: "8px 12px", minHeight: 36, minWidth: 92, fontSize: 12, background: T.surface, color: T.ink, opacity: safePage >= totalPages ? 0.45 : 1, cursor: safePage >= totalPages || pagingBusy ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          {pagingBusy === "next" ? <><BtnSpinnerDark />Loading</> : "Next"}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {page === "work_orders" && !selectedWO && (
        <div style={{ animation: "fadeUp 0.3s" }}>
          <div className="filter-bar" style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
            <div
              role="group"
              aria-label="Work order view"
              style={{ display: "inline-flex", padding: 3, border: `1px solid ${T.border}`, borderRadius: 8, background: T.surfaceSoft }}
            >
              {([
                ["recent", "Recent"],
                ["needs_action", "Needs action"],
              ] as const).map(([value, label]) => {
                const active = viewMode === value;
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setViewMode(value)}
                    style={{
                      minHeight: 34,
                      padding: "7px 12px",
                      border: 0,
                      borderRadius: 6,
                      background: active ? T.surface : "transparent",
                      color: active ? T.ink : T.muted,
                      boxShadow: active ? "0 1px 2px rgba(31,30,28,0.12)" : "none",
                      fontFamily: "inherit",
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <input
              value={search}
              onChange={(e: any) => setSearch(e.target.value)}
              placeholder="Search WO#, INC#, store, keyword..."
              style={{ padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, width: 300, fontFamily: "inherit", background: T.surface }}
            />
            {isManager && (
              <Sel value={filterC} onChange={(e: any) => setFilterC(e.target.value)} style={{ width: 220, padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit", background: T.surface }}>
                <option value="all">All contractors</option>
                {contractorsOnly.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </Sel>
            )}
            <Sel
              value={filterStatus}
              onChange={(e: { target: { value: string } }) => setFilterStatus(e.target.value)}
              aria-label="Filter unassigned work orders"
              style={{ width: 170, padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit", background: T.surface }}
            >
              <option value="all">All work orders</option>
              <option value="unassigned">Unassigned only</option>
            </Sel>
            <Sel
              value={filterState}
              onChange={(e: { target: { value: string } }) => setFilterState(e.target.value)}
              aria-label="Filter work orders by state"
              style={{ width: 180, padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit", background: T.surface }}
            >
              <option value="all">All states</option>
              <option value="VA">Virginia</option>
              <option value="TX">Texas</option>
              <option value="FL">Florida</option>
            </Sel>
            <Sel value={filterP} onChange={(e: any) => setFilterP(e.target.value)} style={{ width: 180, padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit", background: T.surface }}>
              <option value="all">All priorities</option>
              {Object.entries(PRIORITY).map(([k, v]: any) => <option key={k} value={k}>{v.label}</option>)}
            </Sel>
            <Sel value={sortBy} onChange={(e: any) => setSortBy(e.target.value as WorkOrderSortKey)} style={{ width: 190, padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit", background: T.surface }}>
              <option value="sla_due">SLA due soonest</option>
              <option value="newest">Newest to oldest</option>
              <option value="oldest">Oldest to newest</option>
              <option value="priority">Priority</option>
            </Sel>
            {isManager && (
              <label style={{ display: "inline-flex", alignItems: "center", gap: 8, minHeight: 40, padding: "8px 12px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                <input
                  type="checkbox"
                  checked={hideClosed}
                  onChange={(event) => setHideClosed(event.target.checked)}
                  style={{ width: 15, height: 15, accentColor: T.accent, cursor: "inherit" }}
                />
                Hide closed calls{hiddenClosedCount > 0 ? ` (${hiddenClosedCount})` : ""}
              </label>
            )}
            {(filterC !== "all" || filterP !== "all" || filterStatus !== "all" || filterState !== "all" || search || viewMode !== "recent") && (
              <button onClick={() => { setFilterC("all"); setFilterP("all"); setFilterStatus("all"); setFilterState("all"); setSearch(""); setViewMode("recent"); }} style={{ fontSize: 12, color: T.muted, background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
                Clear
              </button>
            )}
          </div>

          <div className="desktop-only-table">
            <div className="card table-scroll" style={{ overflowX: "auto", overflowY: "hidden" }}>
              <table style={{ width: "100%", minWidth: 980, borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: T.surfaceSoft }}>
                    {["WO#", "Status", "Priority", "INC#", "Store", "Summary", "Contractor", "Dates", "SLA due"].map(h => (
                      <th key={h} style={{ textAlign: "left", padding: "10px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, borderBottom: `1px solid ${T.borderSoft}`, whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {paginatedWOs.map((wo: any, i: number) => {
                    const sla = slaLabel(wo);
                    const hasNewSla = !!(wo.responseBreachAt || wo.resolutionBreachAt);
                    const dates = getWorkOrderDateMeta(wo);
                    const aging = getSlaAgingStyle(wo);
                    return (
                      <tr key={wo.id} onClick={() => { setSelectedWO(wo.id); setAiNote(null); }} style={{ cursor: "pointer", borderBottom: `1px solid ${T.borderSoft}`, animation: `fadeUp 0.3s ${i * 0.02}s both` }}>
                        <td className="mono" style={{ padding: "10px", fontWeight: 600, fontSize: 11, color: T.accent }}>
                          <span style={{ display: "grid", justifyItems: "start", gap: 5 }}>
                            <span style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
                              {wo.id}
                              <CopyWorkOrderButton value={wo.id} />
                              {isManager && <NewNotesDot show={wo.hasUnreadNotes} />}
                            </span>
                            {isManager && <SevenElevenSyncBadge count={wo.pendingSevenElevenSyncCount} />}
                          </span>
                        </td>
                        <td style={{ padding: "10px" }}><Badge conf={STATUS[wo.status]} small /></td>
                        <td style={{ padding: "10px" }}><Badge conf={PRIORITY[wo.priority]} small /></td>
                        <td className="mono" style={{ padding: "10px", fontSize: 11, color: T.subtle }}>
                          <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            {wo.incidentId || "-"}
                            {isManager && wo.incidentReuse && (
                              <span
                                title={`Also used by ${wo.incidentReuse.relatedWorkOrderIds.join(", ")}`}
                                style={{ fontFamily: "inherit", fontSize: 9, fontWeight: 800, color: T.warn, background: T.warnSoft, border: `1px solid ${T.warn}44`, borderRadius: 6, padding: "3px 5px", whiteSpace: "nowrap" }}
                              >
                                Reused INC
                              </span>
                            )}
                          </span>
                        </td>
                        <td style={{ padding: "10px", fontWeight: 600 }}>{wo.store ? `#${wo.store}` : "-"}</td>
                        <td style={{ padding: "10px", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: T.inkSoft }}>{wo.summary || "-"}</td>
                        <td style={{ padding: "10px", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: T.muted }}>{wo.contractor ? getUser(wo.contractor)?.name : "-"}</td>
                        <td style={{ padding: "10px", color: T.muted, fontSize: 11, minWidth: 140 }}>
                          <div>Created: {dates.created}</div>
                          <div style={{ marginTop: 3 }}>Updated: {dates.updated}</div>
                        </td>
                        <td style={{ padding: "10px" }}>
                          <div style={{ display: "grid", gap: 4, minWidth: 130 }}>
                            <span style={{ fontSize: 11, color: T.muted }}>{dates.slaDue}</span>
                            <span style={{ fontSize: 10, fontWeight: 700, color: aging.color, background: aging.bg, border: `1px solid ${aging.ring}66`, padding: "2px 8px", borderRadius: 10, width: "fit-content" }}>{aging.label}</span>
                            {hasNewSla
                              ? <SlaBadge responseBreachAt={wo.responseBreachAt} resolutionBreachAt={wo.resolutionBreachAt} responseMetAt={wo.startTimeRaw} size="sm" />
                              : (sla ? <span style={{ fontSize: 10, fontWeight: 700, color: sla.color, background: sla.bg, padding: "2px 8px", borderRadius: 10, width: "fit-content" }}>{sla.text}</span> : null)}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mobile-only-cards responsive-card-grid">
            {paginatedWOs.map((wo: any, i: number) => {
              const sla = slaLabel(wo);
              const hasNewSla = !!(wo.responseBreachAt || wo.resolutionBreachAt);
              const dates = getWorkOrderDateMeta(wo);
              const aging = getSlaAgingStyle(wo);

              return (
                <div
                  className="mobile-card"
                  key={wo.id}
                  onClick={() => {
                    setSelectedWO(wo.id);
                    setAiNote(null);
                    setPage("work_orders");
                  }}
                  style={{
                    background: "#fff",
                    borderRadius: 12,
                    border: `1px solid ${aging.ring || T.borderSoft}`,
                    padding: "14px 16px",
                    marginBottom: 10,
                    cursor: "pointer",
                    boxShadow: "0 1px 3px rgba(31,30,28,0.06)",
                    animation: `fadeUp 0.3s ${i * 0.02}s both`,
                  }}
                >
                  <div className="mobile-card-top" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "monospace", fontSize: 11, fontWeight: 600, color: T.accent }}>
                      {wo.id}
                      <CopyWorkOrderButton value={wo.id} />
                      {isManager && <NewNotesDot show={wo.hasUnreadNotes} />}
                      {isManager && <SevenElevenSyncBadge count={wo.pendingSevenElevenSyncCount} />}
                    </span>
                    <div className="mobile-card-badges" style={{ display: "flex", gap: 6 }}>
                      <Badge conf={PRIORITY[wo.priority]} small />
                      <Badge conf={STATUS[wo.status]} small />
                    </div>
                  </div>
                  <div className="mobile-card-title" style={{ fontSize: 14, fontWeight: 600, color: T.ink, marginBottom: 4 }}>
                    {wo.store ? `Store #${wo.store}` : wo.id}
                    {wo.city ? <span style={{ fontWeight: 400, color: T.muted, fontSize: 12 }}> · {wo.city}</span> : null}
                  </div>
                  {isManager && wo.incidentReuse && (
                    <div style={{ marginBottom: 6 }}>
                      <span
                        title={`Incident also used by ${wo.incidentReuse.relatedWorkOrderIds.join(", ")}`}
                        style={{ display: "inline-flex", fontFamily: "inherit", fontSize: 9, fontWeight: 800, color: T.warn, background: T.warnSoft, border: `1px solid ${T.warn}44`, borderRadius: 6, padding: "3px 5px", whiteSpace: "nowrap" }}
                      >
                        Reused INC
                      </span>
                    </div>
                  )}
                  <div className="mobile-card-summary" style={{ fontSize: 12, color: T.muted, marginBottom: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {wo.summary || "No summary"}
                  </div>
                  <div style={{ display: "grid", gap: 3, marginBottom: 8, fontSize: 10, color: T.subtle }}>
                    <div>Created <span style={{ color: T.muted, fontWeight: 600 }}>{dates.created}</span></div>
                    <div>Updated <span style={{ color: T.muted, fontWeight: 600 }}>{dates.updated}</span></div>
                    <div style={{ color: aging.color, background: aging.bg, border: `1px solid ${aging.ring}66`, borderRadius: 8, padding: "3px 6px", fontWeight: 700 }}>
                      SLA due {dates.slaDue}
                    </div>
                  </div>
                  <div className="mobile-card-footer" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 8, borderTop: `1px solid ${T.borderSoft}`, fontSize: 11 }}>
                    <span style={{ color: T.muted }}>
                      {wo.contractor ? getUser(wo.contractor)?.name || "Assigned" : "Unassigned"}
                    </span>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      {hasNewSla
                        ? <SlaBadge responseBreachAt={wo.responseBreachAt} resolutionBreachAt={wo.resolutionBreachAt} responseMetAt={wo.startTimeRaw} size="sm" />
                        : sla
                          ? <span style={{ fontSize: 10, fontWeight: 700, color: sla.color, background: sla.bg, padding: "2px 8px", borderRadius: 10 }}>{sla.text}</span>
                          : null}
                    </div>
                  </div>
                </div>
              );
            })}
            {paginatedWOs.length === 0 && (
              <div className="responsive-grid-empty" style={{ textAlign: "center", padding: "40px 20px", color: T.subtle, fontSize: 13 }}>
                No work orders match your filters
              </div>
            )}
          </div>

          {renderPaginationControls()}
        </div>
      )}
    </>
  );
}
