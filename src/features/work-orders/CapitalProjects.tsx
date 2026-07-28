"use client";
// @ts-nocheck

import { Badge } from "../../components/ui/Badge";
import { Ico } from "../../components/ui/Ico";
import { T, PRIORITY } from "../../lib/constants";
import { useMemo } from "react";

export default function CapitalProjects(props: any) {
  const { page, isManager, capitalCount, workOrders, setSelectedWO, setPage, setAiNote, getUser } = props;
  const capitalWOs = useMemo(
    () => workOrders.filter(w => w.status === "capital"),
    [workOrders]
  );
  return (
    <>
          {/* ═════ CAPITAL ═════ */}
          {page === "capital" && isManager && (
            <div style={{ animation: "fadeUp 0.3s" }}>
              <div className="card mobile-alert" style={{ background: T.violetSoft, border: `1px solid ${T.violet}33`, padding: "14px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 12 }}>
                <div className="mobile-alert-icon" style={{ width: 40, height: 40, borderRadius: 10, background: T.violet, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}><Ico d="M2 20h20M5 20V8l7-5 7 5v12M9 20v-4h6v4" size={20} color="#fff" /></div>
                <div className="mobile-alert-body">
                  <div style={{ fontWeight: 700, color: T.violet, fontSize: 13 }}>{capitalCount} capital replacement{capitalCount !== 1 ? "s" : ""}</div>
                  <div style={{ fontSize: 11, color: "#4A3C73", marginTop: 2 }}>Equipment orders — separate from regular pipeline, 4-12 week lifecycle</div>
                </div>
              </div>
              <div className="capital-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                {capitalWOs.map((wo, i) => (
                  <div key={wo.id} className="card card-hover mobile-card" onClick={() => { setSelectedWO(wo.id); setPage("work_orders"); setAiNote(null); }} style={{ padding: 22, cursor: "pointer", animation: `fadeUp 0.3s ${i * 0.06}s both` }}>
                    <div className="mobile-card-top" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: T.violet }}>{wo.id}</span>
                      {wo.capitalStatus && <Badge conf={{ label: wo.capitalStatus, color: T.violet, bg: T.violetSoft, ring: "#D4C9E8" }} />}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: T.ink, marginBottom: 4 }}>{[wo.store ? `Store #${wo.store}` : null, wo.city || null].filter(Boolean).join(" · ") || wo.id}</div>
                    <div style={{ fontSize: 12, color: T.muted, marginBottom: 14, lineHeight: 1.5 }}>{wo.summary || "—"}</div>
                    <div style={{ paddingTop: 12, borderTop: `1px solid ${T.borderSoft}` }}>
                      <div>
                        <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 3 }}>Equipment</div>
                        <div style={{ fontSize: 12, fontWeight: 500 }}>{wo.partNeeded || "TBD"}</div>
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: T.subtle, marginTop: 10 }}>Contractor: {getUser(wo.contractor)?.name}</div>
                  </div>
                ))}
              </div>
            </div>
          )}


    </>
  );
}
