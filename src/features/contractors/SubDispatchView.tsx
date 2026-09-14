"use client";
// @ts-nocheck

import { COUNT_FRESHNESS_DESCRIPTION } from "../../lib/counts/countContracts";

import { useDeferredValue, useMemo, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { BtnSpinnerDark } from "../../components/ui/BtnSpinner";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { CapitalWorkOrderBadge } from "../../components/ui/CapitalWorkOrderBadge";
import { DirectorySelect } from "../directory/DirectorySelect";
import { useDirectoryLabels } from "../directory/queries";
import { loadDirectorySelection } from "../directory/api";
import { safeErrorMessage } from "../../lib/errors/normalizeUnknown";
import { T, STATUS } from "../../lib/constants";
import { CONTRACTOR_ACTIVE_WORK_ORDER_SORT } from "../../lib/workOrderView";
import { useCursorPagination } from "../../lib/useCursorPagination";
import { useWorkOrdersPageQuery } from "../work-orders/queries";
import type { WorkOrderTableSortColumn } from "../../lib/db";

export default function SubDispatchView(props: any) {
  const {
    page,
    currentUser,
    setSelectedWO,
    setPage,
    setAiNote,
    doAssign,
    doReassign,
    doSetTechnician,
    doAssignPortalTechnician,
    loadingStates = {},
  } = props;
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [savingWo, setSavingWo] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sortColumn, setSortColumn] = useState<WorkOrderTableSortColumn>("created");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const companyMode = !!currentUser?.canManageTeam;
  const contractorAccountId = currentUser?.contractorAccountId || currentUser?.id;

  const deferredSearch = useDeferredValue(search.trim());
  const paginationSignature = JSON.stringify({
    search: deferredSearch,
    actorId: currentUser?.id,
    contractorId: contractorAccountId,
    sortColumn,
    sortDirection,
  });
  const {
    position,
    previous: previousPage,
    next: nextPage,
  } = useCursorPagination(paginationSignature);
  const teamWorkOrdersQuery = useWorkOrdersPageQuery({
    scope: "active",
    search: deferredSearch,
    // The existing database work-order scope is canonical-account based.
    // A directory page must never define the work-order authorization set.
    contractorId: contractorAccountId,
    sort: CONTRACTOR_ACTIVE_WORK_ORDER_SORT,
    tableSortColumn: sortColumn,
    tableSortDirection: sortDirection,
    limit: 25,
    cursor: position.cursor,
  }, page === "team_dispatch" && currentUser?.role === "contractor");
  const myTeamWOs = useMemo(
    // The legacy page adapter returns UI-shaped records, despite its database
    // row annotation. Check that boundary rather than asserting a full row.
    () => (teamWorkOrdersQuery.data?.items || []).filter((value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && "contractor" in value
      && value.contractor === contractorAccountId),
    [contractorAccountId, teamWorkOrdersQuery.data?.items],
  );
  const labels = useDirectoryLabels(myTeamWOs.map(workOrder =>
    "contractor" in workOrder && typeof workOrder.contractor === "string" ? workOrder.contractor : null), page === "team_dispatch");

  const hasTeamAccess = companyMode || currentUser?.contractorTier === "mr_freeze";
  if (page !== "team_dispatch" || currentUser?.role !== "contractor" || !hasTeamAccess) {
    return null;
  }

  const headers = companyMode
    ? [
        { key: "work_order", label: "WO" },
        { key: "store", label: "Store" },
        { key: "status", label: "Status" },
        { key: "technician", label: "Technician on job" },
        { key: null, label: "Update technician" },
      ]
    : [
        { key: "work_order", label: "WO" },
        { key: "store", label: "Store" },
        { key: "status", label: "Status" },
        { key: "contractor", label: "Assigned technician" },
        { key: null, label: "Assign / Reassign" },
      ];

  const chooseSort = (column: WorkOrderTableSortColumn) => {
    if (sortColumn === column) {
      setSortDirection(direction => direction === "asc" ? "desc" : "asc");
      return;
    }
    setSortColumn(column);
    setSortDirection("asc");
  };

  return (
    <div style={{ animation: "fadeUp 0.25s" }}>
      {companyMode && (
        <div style={{ marginBottom: 14, color: T.muted, fontSize: 12 }}>
          {currentUser.contractorOrganizationName || currentUser.company || "Company"}
          {" · Search team members when assigning a technician"}
        </div>
      )}
      <input
        type="search"
        value={search}
        onChange={event => setSearch(event.target.value)}
        placeholder="Search team work orders"
        aria-label="Search team work orders"
        style={{ width: "100%", maxWidth: 420, marginBottom: 14, minHeight: 40, padding: "9px 11px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink }}
      />
      {saveError && <div role="alert" style={{ color: T.danger, marginBottom: 10 }}>{saveError}</div>}
      {teamWorkOrdersQuery.isError && <div role="alert" style={{ color: T.danger, marginBottom: 10 }}>
        {safeErrorMessage(teamWorkOrdersQuery.error)}{" "}
        <button type="button" onClick={() => void teamWorkOrdersQuery.refetch()}>Retry team work</button>
      </div>}
      <div className="card" style={{ overflow: "hidden" }}>
        <div className="table-scroll" style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
            <thead>
              <tr style={{ background: T.surfaceSoft }}>
                {headers.map(header => (
                  <th
                    key={header.label}
                    aria-sort={header.key && sortColumn === header.key ? (sortDirection === "asc" ? "ascending" : "descending") : undefined}
                    style={{ textAlign: "left", padding: header.key ? 0 : "12px 16px", fontSize: 10, color: T.subtle, textTransform: "uppercase", letterSpacing: 0.8 }}
                  >
                    {header.key ? (
                      <button
                        type="button"
                        onClick={() => chooseSort(header.key as WorkOrderTableSortColumn)}
                        style={{ width: "100%", padding: "12px 16px", border: 0, background: "transparent", color: "inherit", textAlign: "left", cursor: "pointer", font: "inherit", textTransform: "inherit", letterSpacing: "inherit" }}
                      >
                        {header.label}{sortColumn === header.key ? (sortDirection === "asc" ? " ↑" : " ↓") : ""}
                      </button>
                    ) : header.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {myTeamWOs.map((workOrder: any) => {
                const currentTarget = workOrder.assignedTechnicianProfileId
                  || (workOrder.technicianOnJob ? `snapshot:${workOrder.id}` : "");
                const targetKey = `${currentUser.id}:${contractorAccountId}:${workOrder.id}`;
                const target = targets[targetKey] ?? (companyMode ? currentTarget : workOrder.contractor || "");
                const assigned = companyMode
                  ? workOrder.technicianOnJob || "Not set"
                  : labels.getUser(workOrder.contractor)?.name || workOrder.technicianOnJob || "Unassigned";
                const actionKey = workOrder.contractor ? `reassign_${workOrder.id}` : `assign_${workOrder.id}`;
                const actionLoading = companyMode
                  ? savingWo === workOrder.id
                  : !!loadingStates[actionKey];
                return (
                  <tr key={workOrder.id} style={{ borderTop: `1px solid ${T.borderSoft}` }}>
                    <td style={{ padding: "14px 16px" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <button
                          onClick={() => { setSelectedWO(workOrder.id); setAiNote(null); setPage("wo_detail"); }}
                          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}
                        >
                          <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: T.accent }}>{workOrder.id}</span>
                        </button>
                        <CopyWorkOrderButton value={workOrder.id} />
                      </span>
                    </td>
                    <td style={{ padding: "14px 16px", fontSize: 13, color: T.ink }}>
                      {workOrder.store ? `Store #${workOrder.store}` : "-"}
                    </td>
                    <td style={{ padding: "14px 16px" }}>
                      <span style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                        <Badge conf={STATUS[workOrder.status]} />
                        <CapitalWorkOrderBadge workOrder={workOrder} />
                      </span>
                    </td>
                    <td style={{ padding: "14px 16px", fontSize: 13, color: assigned === "Unassigned" || assigned === "Not set" ? T.subtle : T.ink }}>
                      {assigned}
                    </td>
                    <td style={{ padding: "14px 16px" }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <DirectorySelect
                          domain={companyMode ? "company_technicians" : "legacy_team"}
                          contractorId={companyMode ? contractorAccountId : null}
                          technicianValues={companyMode}
                          value={target}
                          selectedLabel={target === currentTarget ? assigned : undefined}
                          emptyLabel={companyMode ? "Not set" : "Select team member"}
                          onChange={event => setTargets(previous => ({ ...previous, [targetKey]: event.target.value }))}
                          style={{ width: 190, padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 12, fontFamily: "inherit" }}
                        />
                        <button
                          onClick={async () => {
                            if (companyMode) {
                              setSavingWo(workOrder.id);
                              setSaveError(null);
                              try {
                                if (target.startsWith("snapshot:")) return;
                                const selectedTechnician = target ? await loadDirectorySelection(
                                  target.startsWith("legacy:") ? "company_technicians" : "technician_profile",
                                  target.startsWith("legacy:") ? target.slice(7) : target,
                                  contractorAccountId,
                                ) : null;
                                if (target && !selectedTechnician) {
                                  setSaveError("This technician is no longer available. Choose a current team member.");
                                  return;
                                }
                                if (!target) {
                                  if (workOrder.assignedTechnicianProfileId) {
                                    await doAssignPortalTechnician(workOrder.id, null, null);
                                  } else {
                                    await doSetTechnician(workOrder.id, "");
                                  }
                                } else if (selectedTechnician?.profileId) {
                                  await doAssignPortalTechnician(
                                    workOrder.id,
                                    selectedTechnician.profileId,
                                    selectedTechnician.name,
                                  );
                                } else if (selectedTechnician) {
                                  if (workOrder.assignedTechnicianProfileId) {
                                    await doAssignPortalTechnician(workOrder.id, null, null);
                                  }
                                  await doSetTechnician(workOrder.id, selectedTechnician.name);
                                }
                              } catch (error: unknown) {
                                setSaveError(safeErrorMessage(error));
                              } finally {
                                setSavingWo(null);
                              }
                              return;
                            }
                            if (!target) return;
                            if (workOrder.contractor) doReassign(workOrder.id, target);
                            else doAssign(workOrder.id, target);
                          }}
                          disabled={actionLoading || target.startsWith("snapshot:") || (!companyMode && !target)}
                          className="btn-soft"
                          style={{ padding: "8px 12px", fontSize: 11, display: "flex", alignItems: "center", gap: 6, opacity: actionLoading ? 0.7 : 1, cursor: actionLoading ? "default" : "pointer" }}
                        >
                          {actionLoading
                            ? <><BtnSpinnerDark />Saving...</>
                            : companyMode
                              ? "Save"
                              : workOrder.contractor ? "Reassign" : "Assign"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {myTeamWOs.length === 0 && !teamWorkOrdersQuery.isError && (
                <tr>
                  <td colSpan={5} style={{ padding: 28, textAlign: "center", color: T.subtle, fontSize: 13 }}>
                    {teamWorkOrdersQuery.isPending ? "Loading team work…" : "No team work orders found."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span title={COUNT_FRESHNESS_DESCRIPTION} style={{ fontSize: 11, color: T.muted }}>
          {teamWorkOrdersQuery.isFetching
            ? "Loading team work…"
            : `${teamWorkOrdersQuery.data?.totalCount ?? "—"} work orders · page ${position.page}`}
        </span>
        <span style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn-soft" disabled={position.page <= 1 || teamWorkOrdersQuery.isFetching} onClick={previousPage}>Previous</button>
          <button type="button" className="btn-soft" disabled={!teamWorkOrdersQuery.data?.hasMore || teamWorkOrdersQuery.isFetching} onClick={() => nextPage(teamWorkOrdersQuery.data?.nextCursor || null)}>Next</button>
        </span>
      </div>
    </div>
  );
}
