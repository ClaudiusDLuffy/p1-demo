"use client";
// @ts-nocheck

import { useDeferredValue, useMemo, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { BtnSpinnerDark } from "../../components/ui/BtnSpinner";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { CapitalWorkOrderBadge } from "../../components/ui/CapitalWorkOrderBadge";
import { Sel } from "../../components/ui/Sel";
import { T, STATUS } from "../../lib/constants";
import { CONTRACTOR_ACTIVE_WORK_ORDER_SORT } from "../../lib/workOrderView";
import { useCursorPagination } from "../../lib/useCursorPagination";
import { useWorkOrdersPageQuery } from "../work-orders/queries";
import type { WorkOrderTableSortColumn } from "../../lib/db";

export default function SubDispatchView(props: any) {
  const {
    page,
    currentUser,
    USERS,
    technicians = [],
    workOrders,
    setSelectedWO,
    setPage,
    setAiNote,
    doAssign,
    doReassign,
    doSetTechnician,
    doAssignPortalTechnician,
    getUser,
    loadingStates = {},
  } = props;
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [savingWo, setSavingWo] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sortColumn, setSortColumn] = useState<WorkOrderTableSortColumn>("created");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const companyMode = !!currentUser?.canManageTeam;
  const contractorAccountId = currentUser?.contractorAccountId || currentUser?.id;

  const legacyTeam = useMemo(
    () => USERS.filter((user: any) => user.dispatcherId === currentUser?.id),
    [USERS, currentUser?.id],
  );
  const legacyTeamIds = useMemo(
    () => legacyTeam.map((user: any) => user.id),
    [legacyTeam],
  );
  const companyMembers = useMemo(
    () => currentUser?.contractorOrganizationId
      ? USERS.filter((user: any) =>
          user.contractorOrganizationId === currentUser.contractorOrganizationId,
        )
      : [],
    [USERS, currentUser?.contractorOrganizationId],
  );
  const companyTechnicians = useMemo(
    () => technicians.filter((technician: any) =>
      technician.contractorId === contractorAccountId && technician.isActive,
    ),
    [contractorAccountId, technicians],
  );
  const teamContractorIds = useMemo(
    () => companyMode
      ? [contractorAccountId].filter(Boolean)
      : [currentUser?.id, ...legacyTeamIds].filter(Boolean),
    [companyMode, contractorAccountId, currentUser?.id, legacyTeamIds],
  );
  const deferredSearch = useDeferredValue(search.trim());
  const paginationSignature = JSON.stringify({
    search: deferredSearch,
    contractorIds: teamContractorIds,
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
    contractorIds: teamContractorIds,
    sort: CONTRACTOR_ACTIVE_WORK_ORDER_SORT,
    tableSortColumn: sortColumn,
    tableSortDirection: sortDirection,
    limit: 25,
    cursor: position.cursor,
  }, page === "team_dispatch" && currentUser?.role === "contractor");
  const visibleWorkOrders = teamWorkOrdersQuery.data?.items || workOrders;
  const myTeamWOs = useMemo(
    () => companyMode
      ? visibleWorkOrders.filter((workOrder: any) => workOrder.contractor === contractorAccountId)
      : visibleWorkOrders.filter((workOrder: any) =>
          workOrder.contractor === currentUser?.id
          || legacyTeamIds.includes(workOrder.contractor),
        ),
    [companyMode, contractorAccountId, currentUser?.id, legacyTeamIds, visibleWorkOrders],
  );

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
          {companyMembers.length > 0 ? ` · ${companyMembers.length} portal account${companyMembers.length === 1 ? "" : "s"}` : ""}
          {companyTechnicians.length > 0 ? ` · ${companyTechnicians.length} technicians on file` : ""}
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
                const matchingLegacyTechnician = companyTechnicians.find(
                  (technician: any) => !technician.profileId && technician.name === workOrder.technicianOnJob,
                );
                const currentTarget = workOrder.assignedTechnicianProfileId
                  || (matchingLegacyTechnician ? `legacy:${matchingLegacyTechnician.id}` : "");
                const target = targets[workOrder.id] ?? currentTarget;
                const assigned = companyMode
                  ? workOrder.technicianOnJob || "Not set"
                  : getUser(workOrder.contractor)?.name || workOrder.technicianOnJob || "Unassigned";
                const actionKey = workOrder.contractor ? `reassign_${workOrder.id}` : `assign_${workOrder.id}`;
                const actionLoading = companyMode
                  ? savingWo === workOrder.id
                  : !!loadingStates[actionKey];
                const options = companyMode ? companyTechnicians : legacyTeam;
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
                        <Sel
                          value={target}
                          onChange={(event: any) => setTargets(previous => ({ ...previous, [workOrder.id]: event.target.value }))}
                          style={{ width: 190, padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 12, fontFamily: "inherit" }}
                        >
                          <option value="">{companyMode ? "Not set" : "Select team member"}</option>
                          {options.map((option: any) => (
                            <option
                              key={option.id}
                              value={companyMode
                                ? option.profileId || `legacy:${option.id}`
                                : option.id}
                            >
                              {option.name}
                              {companyMode && !option.profileId
                                ? " — record only (no portal login)"
                                : ""}
                            </option>
                          ))}
                        </Sel>
                        <button
                          onClick={async () => {
                            if (companyMode) {
                              setSavingWo(workOrder.id);
                              try {
                                const selectedTechnician = companyTechnicians.find(
                                  (technician: any) => technician.profileId === target
                                    || `legacy:${technician.id}` === target,
                                );
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
                              } finally {
                                setSavingWo(null);
                              }
                              return;
                            }
                            if (!target) return;
                            if (workOrder.contractor) doReassign(workOrder.id, target);
                            else doAssign(workOrder.id, target);
                          }}
                          disabled={actionLoading || (!companyMode && !target)}
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
              {myTeamWOs.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: 28, textAlign: "center", color: T.subtle, fontSize: 13 }}>
                    No team work orders found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 11, color: T.muted }}>
          {teamWorkOrdersQuery.isFetching
            ? "Loading team work…"
            : `${teamWorkOrdersQuery.data?.totalCount || 0} work orders · page ${position.page}`}
        </span>
        <span style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn-soft" disabled={position.page <= 1 || teamWorkOrdersQuery.isFetching} onClick={previousPage}>Previous</button>
          <button type="button" className="btn-soft" disabled={!teamWorkOrdersQuery.data?.hasMore || teamWorkOrdersQuery.isFetching} onClick={() => nextPage(teamWorkOrdersQuery.data?.nextCursor || null)}>Next</button>
        </span>
      </div>
    </div>
  );
}
