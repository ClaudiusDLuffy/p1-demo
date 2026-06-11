"use client";
// @ts-nocheck

import { useMemo, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { BtnSpinnerDark } from "../../components/ui/BtnSpinner";
import { T, STATUS } from "../../lib/constants";

export default function SubDispatchView(props: any) {
  const { page, currentUser, USERS, workOrders, setSelectedWO, setPage, setAiNote, doAssign, doReassign, getUser, loadingStates = {} } = props;
  const [targets, setTargets] = useState<Record<string, string>>({});

  const team = useMemo(
    () => USERS.filter((u: any) => u.dispatcherId === currentUser?.id),
    [USERS, currentUser?.id]
  );
  const teamIds = useMemo(
    () => team.map((u: any) => u.id),
    [team]
  );
  const myTeamWOs = useMemo(
    () => workOrders.filter((w: any) =>
      w.contractor === currentUser?.id || teamIds.includes(w.contractor)
    ),
    [workOrders, currentUser?.id, teamIds]
  );

  if (page !== "team_dispatch" || currentUser?.role !== "contractor" || currentUser?.contractorTier !== "mr_freeze") return null;

  return (
    <div style={{ animation: "fadeUp 0.25s" }}>
      <div className="card" style={{ overflow: "hidden" }}>
        <div className="table-scroll" style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
            <thead>
              <tr style={{ background: T.surfaceSoft }}>
                {["WO", "Store", "Status", "Assigned technician", "Assign / Reassign"].map(h => (
                  <th key={h} style={{ textAlign: "left", padding: "12px 16px", fontSize: 10, color: T.subtle, textTransform: "uppercase", letterSpacing: 0.8 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {myTeamWOs.map((wo: any) => {
                const target = targets[wo.id] || "";
                const assigned = getUser(wo.contractor)?.name || wo.technicianOnJob || "Unassigned";
                const actionKey = wo.contractor ? "reassign_" + wo.id : "assign_" + wo.id;
                const actionLoading = !!loadingStates[actionKey];
                return (
                  <tr key={wo.id} style={{ borderTop: `1px solid ${T.borderSoft}` }}>
                    <td style={{ padding: "14px 16px" }}>
                      <button
                        onClick={() => { setSelectedWO(wo.id); setAiNote(null); setPage("wo_detail"); }}
                        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}
                      >
                        <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: T.accent }}>{wo.id}</span>
                      </button>
                    </td>
                    <td style={{ padding: "14px 16px", fontSize: 13, color: T.ink }}>
                      {wo.store ? `Store #${wo.store}` : "-"}
                    </td>
                    <td style={{ padding: "14px 16px" }}>
                      <Badge conf={STATUS[wo.status]} />
                    </td>
                    <td style={{ padding: "14px 16px", fontSize: 13, color: assigned === "Unassigned" ? T.subtle : T.ink }}>
                      {assigned}
                    </td>
                    <td style={{ padding: "14px 16px" }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <select
                          value={target}
                          onChange={(e: any) => setTargets((prev: any) => ({ ...prev, [wo.id]: e.target.value }))}
                          style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 12, fontFamily: "inherit" }}
                        >
                          <option value="">Select team member</option>
                          {team.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                        <button
                          onClick={() => {
                            if (!target) return;
                            if (wo.contractor) doReassign(wo.id, target);
                            else doAssign(wo.id, target);
                          }}
                          disabled={actionLoading}
                          className="btn-soft"
                          style={{ padding: "8px 12px", fontSize: 11, display: "flex", alignItems: "center", gap: 6, opacity: actionLoading ? 0.7 : 1, cursor: actionLoading ? "default" : "pointer" }}
                        >
                          {actionLoading ? <><BtnSpinnerDark />{wo.contractor ? "Reassigning..." : "Assigning..."}</> : (wo.contractor ? "Reassign" : "Assign")}
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
