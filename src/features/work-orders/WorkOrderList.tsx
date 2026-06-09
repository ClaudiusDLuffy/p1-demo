"use client";
// @ts-nocheck

import { Badge } from "../../components/ui/Badge";
import { Ico } from "../../components/ui/Ico";
import { SlaBadge } from "../../components/SlaBadge";
import { T, PRIORITY, STATUS } from "../../lib/constants";
import { useMemo } from "react";

export default function WorkOrderList(props: any) {
  const { page, selectedWO, search, setSearch, isManager, filterC, setFilterC, contractorsOnly, filterP, setFilterP, nteQueue, setNteQueue, filteredWOs, slaLabel, setSelectedWO, setAiNote, getUser, fmt } = props;
  const tableWOs = useMemo(
    () => filteredWOs.filter(w => w.status !== "capital"),
    [filteredWOs]
  );
  return (
    <>
          {/* ═════ WORK ORDERS TABLE ═════ */}
          {page === "work_orders" && !selectedWO && (
            <div style={{ animation: "fadeUp 0.3s" }}>
              <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search WO#, INC#, store, keyword..." style={{ padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, width: 300, fontFamily: "inherit", background: T.surface }} />
                {isManager && (
                  <select value={filterC} onChange={e => setFilterC(e.target.value)} style={{ padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit", background: T.surface }}>
                    <option value="all">All contractors</option>
                    {contractorsOnly.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                )}
                <select value={filterP} onChange={e => setFilterP(e.target.value)} style={{ padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit", background: T.surface }}>
                  <option value="all">All priorities</option>
                  {Object.entries(PRIORITY).map(([k, v]: any) => <option key={k} value={k}>{v.label}</option>)}
                </select>
                {nteQueue && <span style={{ fontSize: 11, fontWeight: 700, color: T.warn, background: T.warnSoft, padding: "5px 12px", borderRadius: 20, border: `1px solid ${T.warn}33` }}>NTE Approval Needed</span>}
                {(filterC !== "all" || filterP !== "all" || search || nteQueue) && <button onClick={() => { setFilterC("all"); setFilterP("all"); setSearch(""); setNteQueue(false); }} style={{ fontSize: 12, color: T.muted, background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>Clear</button>}
              </div>
              <div className="card table-scroll" style={{ overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: T.surfaceSoft }}>
                      {["WO#", "INC#", "Store", "Summary", "Priority", "Status", "Contractor", "SLA", "NTE"].map(h => (
                        <th key={h} style={{ textAlign: h === "NTE" ? "right" : "left", padding: "12px 14px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, borderBottom: `1px solid ${T.borderSoft}`, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tableWOs.map((wo, i) => {
                      const sla = slaLabel(wo);
                      const hasNewSla = !!(wo.responseBreachAt || wo.resolutionBreachAt);
                      return (
                        <tr key={wo.id} onClick={() => { setSelectedWO(wo.id); setAiNote(null); }} style={{ cursor: "pointer", borderBottom: `1px solid ${T.borderSoft}`, animation: `fadeUp 0.3s ${i * 0.02}s both` }}>
                          <td className="mono" style={{ padding: "12px 14px", fontWeight: 600, fontSize: 11, color: T.accent }}>{wo.id}</td>
                          <td className="mono" style={{ padding: "12px 14px", fontSize: 11, color: T.subtle }}>{wo.incidentId || "—"}</td>
                          <td style={{ padding: "12px 14px", fontWeight: 600 }}>{wo.store ? `#${wo.store}` : "—"}</td>
                          <td style={{ padding: "12px 14px", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: T.inkSoft }}>{wo.summary || "—"}</td>
                          <td style={{ padding: "12px 14px" }}><Badge conf={PRIORITY[wo.priority]} small /></td>
                          <td style={{ padding: "12px 14px" }}><Badge conf={STATUS[wo.status]} small /></td>
                          <td style={{ padding: "12px 14px", color: T.muted }}>{wo.contractor ? getUser(wo.contractor)?.name : "—"}</td>
                          <td style={{ padding: "12px 14px" }}>
                            {hasNewSla
                              ? <SlaBadge responseBreachAt={wo.responseBreachAt} resolutionBreachAt={wo.resolutionBreachAt} size="sm" />
                              : (sla ? <span style={{ fontSize: 10, fontWeight: 700, color: sla.color, background: sla.bg, padding: "2px 8px", borderRadius: 10 }}>{sla.text}</span> : <span style={{ color: T.subtle }}>—</span>)}
                          </td>
                          <td className="mono" style={{ padding: "12px 14px", textAlign: "right", fontWeight: 600 }}>{fmt(wo.nte)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}


    </>
  );
}
