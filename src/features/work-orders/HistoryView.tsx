"use client";
// @ts-nocheck

import { T } from "../../lib/constants";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { Sel } from "../../components/ui/Sel";
import { DatePickerField } from "../../components/ui/DateTimePicker";
import { useDeferredValue, useState } from "react";
import { useCursorPagination } from "../../lib/useCursorPagination";
import { useWorkOrdersPageQuery } from "./queries";
import WorkOrderSortControls from "./WorkOrderSortControls";
import type { WorkOrderTableSortColumn } from "../../lib/db";

export default function HistoryView(props: any) {
  const { page, isManager, canReopen, onRequestReopen, selectedWO, histFrom, setHistFrom, histTo, setHistTo, histSearch, setHistSearch, histContractor, setHistContractor, histReso, setHistReso, invoices, closedWOs, contractorsOnly, setSelectedWO, setAiNote, getUser, fmt } = props;
  const deferredSearch = useDeferredValue(histSearch || "");
  const [sortColumn, setSortColumn] = useState<WorkOrderTableSortColumn>("closed");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const pageSize = 24;
  const cursorSignature = JSON.stringify({
    search: deferredSearch.trim(),
    histContractor,
    histReso,
    histFrom,
    histTo,
    sortColumn,
    sortDirection,
  });
  const {
    position: effectiveCursor,
    previous: previousPage,
    next: nextPage,
  } = useCursorPagination(cursorSignature);
  const historyPageQuery = useWorkOrdersPageQuery({
    scope: "history",
    search: deferredSearch,
    contractorId: histContractor !== "all" ? histContractor : null,
    resolution: histReso,
    from: histFrom || undefined,
    to: histTo || undefined,
    sort: "newest",
    tableSortColumn: sortColumn,
    tableSortDirection: sortDirection,
    limit: pageSize,
    cursor: effectiveCursor.cursor,
  }, page === "history" && !selectedWO);

  const fallbackClosedWOs = (closedWOs || []).filter((w: any) => {
    const search = (histSearch || "").toLowerCase();
    const closedAt = w.closedAt ? new Date(w.closedAt) : null;
    if (search && !String(w.id || "").toLowerCase().includes(search)
      && !String(w.store || "").toLowerCase().includes(search)
      && !String(w.summary || "").toLowerCase().includes(search)) return false;
    if (histContractor !== "all" && w.contractor !== histContractor) return false;
    if (histReso !== "all" && (w.resolutionCode || "unknown") !== histReso) return false;
    if (histFrom && closedAt && closedAt < new Date(`${histFrom}T00:00:00`)) return false;
    if (histTo && closedAt && closedAt > new Date(`${histTo}T23:59:59`)) return false;
    return true;
  });
  const filteredClosedWOs = historyPageQuery.data?.items || fallbackClosedWOs;

  // Multi-invoice safe: sum every non-draft, non-rejected invoice on the WO.
  // The legacy work_orders.invoice_total column (w.invoiceTotal) was the
  // "most recently submitted invoice's total" — wrong shape for multi-invoice,
  // so the dynamic sum is the source of truth here.
  const sumInvoicesFor = (woId: string) => (invoices ?? [])
    .filter((i: any) => i.wot === woId && i.state !== "draft" && i.state !== "rejected")
    .reduce((s: number, i: any) => s + (i.total || 0), 0);

  const invTotalFor = (woId: string) => {
    const row = filteredClosedWOs.find((workOrder: any) => workOrder.id === woId);
    return row?.historyInvoiceTotal ?? sumInvoicesFor(woId);
  };
  const totalClosedValue = historyPageQuery.data?.aggregates?.invoiceTotal
    ?? filteredClosedWOs.reduce((sum: number, w: any) => sum + invTotalFor(w.id), 0);
  const totalCount = historyPageQuery.data?.totalCount ?? filteredClosedWOs.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  if (page !== "history" || selectedWO) return null;

  const stateOf = (w: any) => {
    const city = String(w.city || "");
    const parts = city.split(",");
    return parts.length > 1 ? parts[1].trim() : "";
  };

  return (
    <>
      <section style={{ padding: 24, display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <h1 className="display" style={{ fontSize: 28, color: T.ink, margin: 0 }}>History</h1>
            <div style={{ fontSize: 13, color: T.muted, marginTop: 6 }}>
              {totalCount} closed work order{totalCount === 1 ? "" : "s"} - {fmt(totalClosedValue)}
            </div>
          </div>
          <div className="filter-bar" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              value={histSearch}
              onChange={(e: any) => setHistSearch(e.target.value)}
              placeholder="Search history..."
              style={{ minWidth: 220, padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink }}
            />
            {isManager && (
              <Sel value={histContractor} onChange={(e: any) => setHistContractor(e.target.value)} style={{ width: 220, padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink }}>
                <option value="all">All contractors</option>
                {contractorsOnly.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Sel>
            )}
            <Sel value={histReso} onChange={(e: any) => setHistReso(e.target.value)} style={{ width: 170, padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink }}>
              <option value="all">All resolutions</option>
              <option value="Repaired">Repaired</option>
              <option value="Temporary fix">Temporary fix</option>
              <option value="Awaiting parts">Awaiting parts</option>
              <option value="unknown">Unknown</option>
            </Sel>
            <div className="filter-date-field" style={{ width: 150, minWidth: 150 }}>
              <DatePickerField value={histFrom} onChange={setHistFrom} placeholder="From date" />
            </div>
            <div className="filter-date-field" style={{ width: 150, minWidth: 150 }}>
              <DatePickerField value={histTo} onChange={setHistTo} placeholder="To date" />
            </div>
            <WorkOrderSortControls
              column={sortColumn}
              direction={sortDirection}
              options={[
                { value: "closed", label: "Date closed" },
                { value: "work_order", label: "Work order" },
                { value: "priority", label: "Priority" },
                { value: "store", label: "Store" },
                { value: "summary", label: "Summary" },
                { value: "contractor", label: "Contractor" },
              ]}
              onColumnChange={value => {
                setSortColumn(value);
                setSortDirection(value === "closed" ? "desc" : "asc");
              }}
              onDirectionChange={setSortDirection}
            />
          </div>
        </div>

        <div className="desktop-only-table">
          {filteredClosedWOs.length === 0 ? (
            <div className="card" style={{ padding: 28, color: T.muted, textAlign: "center" }}>
              No closed work orders match the current filters.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12 }}>
              {filteredClosedWOs.map((w: any) => {
                const woTotal = invTotalFor(w.id);
                const woInvCount = w.historyInvoiceCount ?? (invoices ?? []).filter((i: any) => i.wot === w.id && i.state !== "draft" && i.state !== "rejected").length;
                return (
                  <div
                    key={w.id}
                    onClick={() => { setSelectedWO(w.id); setAiNote(null); }}
                    onKeyDown={(event: any) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedWO(w.id);
                        setAiNote(null);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    className="card"
                    style={{ padding: 16, textAlign: "left", border: `1px solid ${T.border}`, background: T.surface, cursor: "pointer" }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <div className="mono" style={{ fontSize: 12, color: T.accent, fontWeight: 700 }}>{w.id}</div>
                          <CopyWorkOrderButton value={w.id} />
                        </div>
                        <div style={{ fontSize: 15, color: T.ink, fontWeight: 700, marginTop: 4 }}>{w.summary || "Closed work order"}</div>
                      </div>
                      <span style={{ fontSize: 11, color: T.success, background: T.successSoft, borderRadius: 999, padding: "4px 8px", fontWeight: 700 }}>Closed</span>
                    </div>
                    <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 12, color: T.muted }}>
                      <div>Store <strong style={{ color: T.ink }}>{w.store || "-"}</strong></div>
                      <div>Contractor <strong style={{ color: T.ink }}>{w.contractor ? (getUser(w.contractor)?.name || "Unknown") : "Unassigned"}</strong></div>
                      <div>Closed <strong style={{ color: T.ink }}>{w.closedAt ? new Date(w.closedAt).toLocaleDateString() : "-"}</strong></div>
                      <div>Total <strong style={{ color: T.ink }}>{fmt(woTotal)}</strong>{woInvCount > 1 ? <span style={{ color: T.subtle, fontWeight: 400 }}> · {woInvCount} invoices</span> : null}</div>
                    </div>
                    {canReopen && (
                      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.borderSoft}` }}>
                        <button
                          type="button"
                          className="btn-soft"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onRequestReopen?.(w);
                          }}
                          onKeyDown={(event) => event.stopPropagation()}
                        >Reopen</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="mobile-only-cards responsive-card-grid">
          {filteredClosedWOs.map((w: any) => (
            <div
              key={w.id}
              onClick={() => {
                setSelectedWO(w.id);
                setAiNote(null);
              }}
              style={{
                background: "#fff",
                borderRadius: 12,
                border: `1px solid ${T.borderSoft}`,
                padding: "14px 16px",
                marginBottom: 10,
                cursor: "pointer",
                boxShadow: "0 1px 3px rgba(31,30,28,0.06)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 5, fontFamily: "monospace", fontSize: 11, fontWeight: 600, color: T.accent }}>
                  {w.id}
                  <CopyWorkOrderButton value={w.id} />
                </span>
                <span style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 700, color: T.ink }}>{fmt(invTotalFor(w.id))}</span>
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.ink, marginBottom: 4 }}>
                {w.store ? `Store #${w.store}` : w.id}
                {stateOf(w)
                  ? <span style={{ fontWeight: 400, color: T.muted, fontSize: 12, marginLeft: 6 }}>{stateOf(w)}</span>
                  : null}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 8, borderTop: `1px solid ${T.borderSoft}`, fontSize: 11, color: T.muted }}>
                <span>
                  {w.contractor
                    ? getUser(w.contractor)?.name || "Unknown"
                    : "Unassigned"}
                </span>
                <span>
                  {w.closedAt
                    ? new Date(w.closedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                    : "No close date"}
                </span>
              </div>
              {w.resolutionCode && (
                <div style={{ marginTop: 6, fontSize: 11, color: T.muted }}>
                  {w.resolutionCode}
                </div>
              )}
              {canReopen && (
                <button
                  type="button"
                  className="btn-soft"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onRequestReopen?.(w);
                  }}
                  style={{ width: "100%", marginTop: 10 }}
                >Reopen work order</button>
              )}
            </div>
          ))}
          {filteredClosedWOs.length === 0 && (
            <div style={{ textAlign: "center", padding: "40px 20px", color: T.subtle, fontSize: 13 }}>
              No closed work orders match the current filters.
            </div>
          )}
        </div>
        {totalCount > 0 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: T.muted }}>
              Page {effectiveCursor.page} of {totalPages}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn-soft"
                disabled={effectiveCursor.page <= 1 || historyPageQuery.isFetching}
                onClick={previousPage}
              >Previous</button>
              <button
                type="button"
                className="btn-soft"
                disabled={!historyPageQuery.data?.hasMore || historyPageQuery.isFetching}
                onClick={() => nextPage(historyPageQuery.data?.nextCursor || null)}
              >Next</button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
