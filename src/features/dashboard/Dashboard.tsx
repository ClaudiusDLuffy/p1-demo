"use client";
// @ts-nocheck

import KanbanBoard from "../work-orders/KanbanBoard";
import { Ico } from "../../components/ui/Ico";
import { T, PRIORITY, STATUS } from "../../lib/constants";
import { useMemo } from "react";

export default function Dashboard(props: any) {
  const { page, isManager, openValue, openCount, openWOs, workOrders, p1Count, p1Unassigned, slaAtRisk, slaBreached, capitalCount, nav, doAutoAssign, filteredWOs, activeStatuses, closingStatuses, invoices, USERS, getUser, slaLabel, setSelectedWO, setAiNote, setPage, fmt, search, setSearch } = props;
  const p1SavedHours = useMemo(
    () => (workOrders.reduce((s, w) => s + (w.activities?.length || 0), 0) * 2.3 / 60).toFixed(1),
    [workOrders]
  );
  return (
    <>
          {/* ═════ DASHBOARD ═════ */}
          {page === "dashboard" && isManager && (
            <div style={{ animation: "fadeUp 0.35s" }}>
              {/* Alert bars */}
              {slaBreached > 0 && (
                <div className="card" style={{ background: T.dangerSoft, border: `1px solid ${T.danger}33`, padding: "14px 20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: T.danger, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, animation: "pulse 1.6s infinite" }}>!</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, color: T.danger, fontSize: 13 }}>{slaBreached} SLA breach{slaBreached > 1 ? "es" : ""} — act now</div>
                    <div style={{ fontSize: 11, color: "#8B2C20", marginTop: 2 }}>7-Eleven KPI missed. Update functional status immediately to stop further damage.</div>
                  </div>
                  <button onClick={() => nav("work_orders")} className="btn-soft" style={{ borderColor: `${T.danger}33`, color: T.danger }}>View →</button>
                </div>
              )}
              {p1Unassigned > 0 && (
                <div className="card" style={{ background: T.accentSoft, border: `1px solid ${T.accentRing}`, padding: "14px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: T.accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>⚡</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, color: T.accent, fontSize: 13 }}>{p1Unassigned} P1 Critical call{p1Unassigned > 1 ? "s" : ""} need dispatch</div>
                    <div style={{ fontSize: 11, color: "#8A4428", marginTop: 2 }}>8-hour SLA clock is running. Auto-dispatch or assign manually.</div>
                  </div>
                  <button onClick={doAutoAssign} className="btn-accent">Auto-dispatch all</button>
                </div>
              )}

              {/* Hero + stats */}
              <div className="stats-grid" style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 16, marginBottom: 36 }}>
                <div className="card card-hover stat-hero" style={{ background: `linear-gradient(135deg, ${T.accentSoft} 0%, ${T.warnSoft} 100%)`, padding: "28px 32px", animation: "fadeUp 0.4s both", cursor: "pointer", position: "relative", overflow: "hidden", border: `1px solid ${T.accentRing}` }} onClick={() => nav("work_orders")}>
                  <div style={{ position: "absolute", top: -40, right: -40, width: 160, height: 160, borderRadius: "50%", background: `radial-gradient(circle, ${T.accent}15, transparent 70%)` }} />
                  <div style={{ fontSize: 11, color: T.accent, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 14 }}>Revenue at risk</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
                    <div className="display stat-value" style={{ fontSize: 44, color: T.ink, letterSpacing: -1.2, lineHeight: 1 }}>{fmt(openValue)}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, color: T.success, background: T.successSoft, padding: "4px 10px", borderRadius: 20, border: `1px solid ${T.success}22` }}>
                      <span style={{ fontSize: 9 }}>▲</span> {fmt(Math.round(openValue * 0.15))} this week
                    </div>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 12, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 12, color: T.inkSoft, fontWeight: 500 }}>{openCount} open · {new Set(openWOs.map(w => w.store)).size} stores · {new Set(openWOs.map(w => w.city.split(",")[1]?.trim())).size} states</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 700, color: T.accent, background: T.surface, padding: "4px 10px", borderRadius: 20, border: `1px solid ${T.accentRing}` }}>
                      <span style={{ fontSize: 11 }}>⏱</span> P1 saved {p1SavedHours}h this week
                    </div>
                  </div>
                </div>
                {[
                  { label: "P1 Critical", value: p1Count, color: T.danger, sub: `${p1Unassigned} unassigned`, bg: T.dangerSoft, onClick: () => nav("work_orders") },
                  { label: "SLA at risk", value: slaAtRisk, color: T.warn, sub: "Needs status update", bg: T.warnSoft, onClick: () => nav("work_orders") },
                  { label: "Capital", value: capitalCount, color: T.violet, sub: "Pending equipment", bg: T.violetSoft, onClick: () => nav("capital") },
                ].map((s, i) => (
                  <div key={i} className="card card-hover" style={{ background: s.bg, padding: "22px 24px", animation: `fadeUp 0.4s ${(i + 1) * 0.06}s both`, cursor: "pointer" }} onClick={s.onClick}>
                    <div style={{ fontSize: 11, color: s.color, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 12 }}>{s.label}</div>
                    <div className="display stat-value" style={{ fontSize: 34, color: s.color, letterSpacing: -0.8, lineHeight: 1 }}>{s.value}</div>
                    <div style={{ fontSize: 11, color: T.muted, marginTop: 8, fontWeight: 500 }}>{s.sub}</div>
                  </div>
                ))}
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
                <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.4, color: T.muted, display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 18, height: 2, background: T.border, display: "inline-block", borderRadius: 2 }} />Active pipeline
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <input
                    value={search}
                    onChange={(e: any) => setSearch(e.target.value)}
                    placeholder="Search WO#, store, keyword..."
                    style={{ width: 280, maxWidth: "100%", padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13, fontFamily: "inherit" }}
                  />
                  {search && (
                    <button
                      type="button"
                      onClick={() => setSearch("")}
                      style={{ border: "none", background: "none", color: T.muted, fontSize: 12, cursor: "pointer", textDecoration: "underline", fontFamily: "inherit" }}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
              <KanbanBoard filteredWOs={filteredWOs} activeStatuses={activeStatuses} closingStatuses={closingStatuses} invoices={invoices} USERS={USERS} workOrders={workOrders} getUser={getUser} slaLabel={slaLabel} setSelectedWO={setSelectedWO} setAiNote={setAiNote} setPage={setPage} isManager={isManager} />
            </div>
          )}



    </>
  );
}
