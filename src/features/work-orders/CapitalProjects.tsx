"use client";
// @ts-nocheck

import { Badge } from "../../components/ui/Badge";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { CapitalWorkOrderBadge } from "../../components/ui/CapitalWorkOrderBadge";
import { Ico } from "../../components/ui/Ico";
import { T } from "../../lib/constants";
import { useEffect, useState } from "react";
import {
  firstCursorPosition,
  nextCursorPosition,
  previousCursorPosition,
} from "../../lib/cursorPagination";
import { useWorkOrdersPageQuery } from "./queries";
import WorkOrderSortControls from "./WorkOrderSortControls";
import type { WorkOrderTableSortColumn } from "../../lib/db";

export default function CapitalProjects(props: any) {
  const { page, isManager, capitalCount, setSelectedWO, setPage, setAiNote, getUser } = props;
  const [position, setPosition] = useState(firstCursorPosition);
  const [sortColumn, setSortColumn] = useState<WorkOrderTableSortColumn>("created");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  useEffect(() => setPosition(firstCursorPosition), [sortColumn, sortDirection]);
  const capitalQuery = useWorkOrdersPageQuery({
    scope: "capital",
    sort: "newest",
    tableSortColumn: sortColumn,
    tableSortDirection: sortDirection,
    limit: 24,
    cursor: position.cursor,
  }, page === "capital" && isManager);
  const capitalWOs: any[] = (capitalQuery.data?.items || []) as any[];
  const exactCapitalCount = capitalQuery.data?.totalCount ?? capitalCount;
  return (
    <>
          {/* ═════ CAPITAL ═════ */}
          {page === "capital" && isManager && (
            <div style={{ animation: "fadeUp 0.3s" }}>
              <div className="card mobile-alert" style={{ background: T.violetSoft, border: `1px solid ${T.violet}33`, padding: "14px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 12 }}>
                <div className="mobile-alert-icon" style={{ width: 40, height: 40, borderRadius: 10, background: T.violet, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}><Ico d="M2 20h20M5 20V8l7-5 7 5v12M9 20v-4h6v4" size={20} color="#fff" /></div>
                <div className="mobile-alert-body">
                  <div style={{ fontWeight: 700, color: T.violet, fontSize: 13 }}>{exactCapitalCount} capital replacement{exactCapitalCount !== 1 ? "s" : ""}</div>
                  <div style={{ fontSize: 11, color: "#4A3C73", marginTop: 2 }}>Focused capital view — these calls also remain searchable in Work orders</div>
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
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
                    { value: "contractor", label: "Contractor" },
                    { value: "updated", label: "Last updated" },
                  ]}
                  onColumnChange={value => {
                    setSortColumn(value);
                    setSortDirection(["created", "updated"].includes(value) ? "desc" : "asc");
                  }}
                  onDirectionChange={setSortDirection}
                />
              </div>
              <div style={{ marginTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, color: T.muted }}>{capitalQuery.isFetching ? "Loading capital projects..." : `Page ${position.page}`}</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="btn-soft" disabled={position.page <= 1 || capitalQuery.isFetching} onClick={() => setPosition(previousCursorPosition)}>Previous</button>
                  <button type="button" className="btn-soft" disabled={!capitalQuery.data?.hasMore || capitalQuery.isFetching} onClick={() => setPosition(current => nextCursorPosition(current, capitalQuery.data?.nextCursor || null))}>Next</button>
                </div>
              </div>
              <div className="capital-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                {capitalWOs.map((wo, i) => (
                  <div key={wo.id} className="card card-hover mobile-card" onClick={() => { setSelectedWO(wo.id); setPage("work_orders"); setAiNote(null); }} style={{ padding: 22, cursor: "pointer", animation: `fadeUp 0.3s ${i * 0.06}s both` }}>
                    <div className="mobile-card-top" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: T.violet }}>{wo.id}</span>
                        <CopyWorkOrderButton value={wo.id} />
                      </span>
                      <span style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                        <CapitalWorkOrderBadge workOrder={wo} />
                        {wo.capitalStatus && <Badge conf={{ label: wo.capitalStatus, color: T.violet, bg: T.violetSoft, ring: "#D4C9E8" }} />}
                      </span>
                    </div>
                    {wo.status === "pending_capital_completion" && (
                      <div style={{ marginBottom: 9 }}>
                        <Badge conf={{ label: "Pending capital completion", color: T.danger, bg: T.dangerSoft, ring: "#EBC3BC" }} />
                      </div>
                    )}
                    <div style={{ fontSize: 15, fontWeight: 600, color: T.ink, marginBottom: 4 }}>{[wo.store ? `Store #${wo.store}` : null, wo.city || null].filter(Boolean).join(" · ") || wo.id}</div>
                    <div style={{ fontSize: 12, color: T.muted, marginBottom: 14, lineHeight: 1.5 }}>{wo.summary || "—"}</div>
                    <div style={{ paddingTop: 12, borderTop: `1px solid ${T.borderSoft}` }}>
                      <div>
                        <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 3 }}>Equipment</div>
                        <div style={{ fontSize: 12, fontWeight: 500 }}>{wo.partNeeded || "TBD"}</div>
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: T.subtle, marginTop: 10 }}>Contractor: {getUser(wo.contractor)?.name || "Unassigned"}</div>
                  </div>
                ))}
              </div>
            </div>
          )}


    </>
  );
}
