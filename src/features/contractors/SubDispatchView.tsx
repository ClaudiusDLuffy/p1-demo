"use client";
// @ts-nocheck

import { useMemo, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { BtnSpinnerDark } from "../../components/ui/BtnSpinner";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { Sel } from "../../components/ui/Sel";
import { T, STATUS } from "../../lib/constants";

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
    getUser,
    loadingStates = {},
  } = props;
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [savingWo, setSavingWo] = useState<string | null>(null);
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
  const myTeamWOs = useMemo(
    () => companyMode
      ? workOrders.filter((workOrder: any) => workOrder.contractor === contractorAccountId)
      : workOrders.filter((workOrder: any) =>
          workOrder.contractor === currentUser?.id
          || legacyTeamIds.includes(workOrder.contractor),
        ),
    [companyMode, contractorAccountId, currentUser?.id, legacyTeamIds, workOrders],
  );

  const hasTeamAccess = companyMode || currentUser?.contractorTier === "mr_freeze";
  if (page !== "team_dispatch" || currentUser?.role !== "contractor" || !hasTeamAccess) {
    return null;
  }

  return (
    <div style={{ animation: "fadeUp 0.25s" }}>
      {companyMode && (
        <div style={{ marginBottom: 14, color: T.muted, fontSize: 12 }}>
          {currentUser.contractorOrganizationName || currentUser.company || "Company"}
          {companyMembers.length > 0 ? ` · ${companyMembers.length} portal account${companyMembers.length === 1 ? "" : "s"}` : ""}
          {companyTechnicians.length > 0 ? ` · ${companyTechnicians.length} technicians on file` : ""}
        </div>
      )}
      <div className="card" style={{ overflow: "hidden" }}>
        <div className="table-scroll" style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
            <thead>
              <tr style={{ background: T.surfaceSoft }}>
                {(companyMode
                  ? ["WO", "Store", "Status", "Technician on job", "Update technician"]
                  : ["WO", "Store", "Status", "Assigned technician", "Assign / Reassign"]
                ).map(header => (
                  <th key={header} style={{ textAlign: "left", padding: "12px 16px", fontSize: 10, color: T.subtle, textTransform: "uppercase", letterSpacing: 0.8 }}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {myTeamWOs.map((workOrder: any) => {
                const target = targets[workOrder.id] ?? workOrder.technicianOnJob ?? "";
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
                      <Badge conf={STATUS[workOrder.status]} />
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
                            <option key={option.id} value={companyMode ? option.name : option.id}>{option.name}</option>
                          ))}
                        </Sel>
                        <button
                          onClick={async () => {
                            if (companyMode) {
                              setSavingWo(workOrder.id);
                              try {
                                await doSetTechnician(workOrder.id, target);
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
    </div>
  );
}
