"use client";

import { COUNT_FRESHNESS_DESCRIPTION } from "../../lib/counts/countContracts";

import { useDirectoryLabels } from "../directory/queries";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { CapitalWorkOrderBadge } from "../../components/ui/CapitalWorkOrderBadge";
import { Ico } from "../../components/ui/Ico";
import { T } from "../../lib/constants";
import { useState } from "react";
import {
  firstCursorPosition,
  nextCursorPosition,
  previousCursorPosition,
} from "../../lib/cursorPagination";
import { useWorkOrdersPageQuery } from "./queries";
import { resolveWorkOrderCollectionState, WorkOrderCollectionNotice } from "./WorkOrderCollectionNotice";
import WorkOrderSortControls from "./WorkOrderSortControls";
import type { WorkOrderTableSortColumn } from "../../lib/db";
import { CAPITAL_PROJECT_FILTERS, capitalProjectStage, type CapitalProjectFilter } from "./capitalProjectStage";
import type { WorkOrderReadModel } from "./data/workOrderReadContracts";

const capitalStageColors = {
  waiting: { color: "#7C2D12", background: "#FFF7ED", border: "#FDBA74" },
  submitted: { color: "#166534", background: "#F0FDF4", border: "#86EFAC" },
  authorized: { color: "#1D4ED8", background: "#EFF6FF", border: "#93C5FD" },
  ordered: { color: "#92400E", background: "#FFFBEB", border: "#FCD34D" },
  received: { color: "#0F766E", background: "#F0FDFA", border: "#5EEAD4" },
  scheduled: { color: "#6D28D9", background: "#F5F3FF", border: "#C4B5FD" },
  installed: { color: "#334155", background: "#F8FAFC", border: "#CBD5E1" },
} as const;

type CapitalProjectsProps = {
  page: string;
  isManager: boolean;
  setSelectedWO: (workOrderId: string) => void;
  setPage: (page: string) => void;
  setAiNote: (note: null) => void;
};

export default function CapitalProjects(props: CapitalProjectsProps) {
  const { page, isManager, setSelectedWO, setPage, setAiNote } = props;
  const [position, setPosition] = useState(firstCursorPosition);
  const [sortColumn, setSortColumn] = useState<WorkOrderTableSortColumn>("created");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [capitalFilter, setCapitalFilter] = useState<CapitalProjectFilter>("all");
  const updateSortColumn = (value: WorkOrderTableSortColumn) => {
    setPosition(firstCursorPosition);
    setSortColumn(value);
    setSortDirection(["created", "updated"].includes(value) ? "desc" : "asc");
  };
  const updateSortDirection = (value: "asc" | "desc") => {
    setPosition(firstCursorPosition);
    setSortDirection(value);
  };
  const capitalQuery = useWorkOrdersPageQuery({
    scope: "capital",
    status: capitalFilter,
    sort: "newest",
    tableSortColumn: sortColumn,
    tableSortDirection: sortDirection,
    limit: 24,
    cursor: position.cursor,
  }, page === "capital" && isManager);
  const capitalWOs: WorkOrderReadModel[] = capitalQuery.data?.items || [];
  const { getUser } = useDirectoryLabels(capitalWOs.map(workOrder => workOrder.contractor), page === "capital" && isManager);
  const exactCapitalCount = capitalQuery.data?.totalCount ?? "—";
  const collectionState = resolveWorkOrderCollectionState({
    itemCount: capitalWOs.length,
    isPending: capitalQuery.isPending,
    isFetching: capitalQuery.isFetching,
    isError: capitalQuery.isError,
  });
  const retryCapitalProjects = () => { void capitalQuery.refetch(); };
  return (
    <>
          {/* ═════ CAPITAL ═════ */}
          {page === "capital" && isManager && (
            <div style={{ animation: "fadeUp 0.3s" }}>
              <div className="card mobile-alert" style={{ background: T.violetSoft, border: `1px solid ${T.violet}33`, padding: "14px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 12 }}>
                <div className="mobile-alert-icon" style={{ width: 40, height: 40, borderRadius: 10, background: T.violet, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}><Ico d="M2 20h20M5 20V8l7-5 7 5v12M9 20v-4h6v4" size={20} color="#fff" /></div>
                <div className="mobile-alert-body">
                  <div title={COUNT_FRESHNESS_DESCRIPTION} style={{ fontWeight: 700, color: T.violet, fontSize: 13 }}>{exactCapitalCount} capital replacement{exactCapitalCount !== 1 ? "s" : ""}</div>
                  <div style={{ fontSize: 11, color: "#4A3C73", marginTop: 2 }}>Focused capital view — these calls also remain searchable in Work orders</div>
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "end", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
                <label style={{ display: "grid", gap: 5, minWidth: 280, maxWidth: "100%", color: T.muted, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.7 }}>
                  Capital status
                  <select aria-label="Capital status" value={capitalFilter}
                    onChange={event => { setPosition(firstCursorPosition); setCapitalFilter(event.target.value as CapitalProjectFilter); }}
                    style={{ width: "100%", minHeight: 38, borderRadius: 9, border: `1px solid ${T.border}`,
                      background: T.surface, color: T.ink, padding: "8px 34px 8px 11px", font: "inherit",
                      fontSize: 12, fontWeight: 600, textTransform: "none", letterSpacing: 0 }}>
                    {CAPITAL_PROJECT_FILTERS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
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
                  onColumnChange={updateSortColumn}
                  onDirectionChange={updateSortDirection}
                />
              </div>
              <div style={{ marginTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, color: T.muted }}>{capitalQuery.isFetching ? "Loading capital projects..." : `Page ${position.page}`}</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="btn-soft" disabled={position.page <= 1 || capitalQuery.isFetching} onClick={() => setPosition(previousCursorPosition)}>Previous</button>
                  <button type="button" className="btn-soft" disabled={!capitalQuery.data?.hasMore || capitalQuery.isFetching} onClick={() => setPosition(current => nextCursorPosition(current, capitalQuery.data?.nextCursor || null))}>Next</button>
                </div>
              </div>
              {collectionState === "error" && capitalWOs.length > 0 && (
                <WorkOrderCollectionNotice
                  state="error"
                  errorMessage="The latest capital-project refresh failed. Showing the previously loaded results."
                  onRetry={retryCapitalProjects}
                  retrying={capitalQuery.isFetching}
                  style={{ marginTop: 14, padding: "14px 16px" }}
                />
              )}
              <div className="capital-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                {capitalWOs.map((wo, i) => {
                  const stage = capitalProjectStage(wo);
                  const stageColor = capitalStageColors[stage.tone];
                  return (
                  <div key={wo.id} className="card card-hover mobile-card" onClick={() => { setSelectedWO(wo.id); setPage("work_orders"); setAiNote(null); }} style={{ padding: 22, cursor: "pointer", animation: `fadeUp 0.3s ${i * 0.06}s both` }}>
                    <div className="mobile-card-top" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: T.violet }}>{wo.id}</span>
                        <CopyWorkOrderButton value={wo.id} />
                      </span>
                      <span style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                        <CapitalWorkOrderBadge workOrder={wo} />
                      </span>
                    </div>
                    <div data-capital-stage={stage.filter} style={{ marginBottom: 12, padding: "9px 11px", borderRadius: 9,
                      border: `1px solid ${stageColor.border}`, color: stageColor.color,
                      background: stageColor.background, fontSize: 11, fontWeight: 800 }}>
                      {stage.label}
                    </div>
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
                );})}
                {capitalWOs.length === 0 && (
                  <WorkOrderCollectionNotice
                    state={collectionState}
                    loadingMessage="Loading capital projects…"
                    errorMessage="Capital projects could not be loaded. Please retry the request."
                    emptyMessage="No capital projects match the current view."
                    onRetry={retryCapitalProjects}
                    retrying={capitalQuery.isFetching}
                    className="card"
                    style={{ gridColumn: "1 / -1" }}
                  />
                )}
              </div>
            </div>
          )}


    </>
  );
}
