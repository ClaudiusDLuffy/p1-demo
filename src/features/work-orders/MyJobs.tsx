"use client";
// @ts-nocheck

import { Badge } from "../../components/ui/Badge";
import { SlaBadge } from "../../components/SlaBadge";
import { T, PRIORITY, STATUS } from "../../lib/constants";
import { useMemo } from "react";

export default function MyJobs(props: any) {
  const { page, isManager, myWOs, activeStatuses, slaLabel, setSelectedWO, setPage, setAiNote } = props;
  const jobCounts = useMemo(() => ({
    active: myWOs.filter(w => activeStatuses.includes(w.status)).length,
    pendingInvoice: myWOs.filter(w => w.status === "pending_invoice").length,
    capital: myWOs.filter(w => w.status === "capital").length,
  }), [myWOs, activeStatuses]);
  return (
    <>
          {/* ═════ MY JOBS (contractor) ═════ */}
          {page === "my_jobs" && !isManager && (
            <div style={{ animation: "fadeUp 0.3s" }}>
              <div className="stats-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 24 }}>
                {[
                  { l: "Active", v: jobCounts.active, c: T.accent, bg: T.accentSoft },
                  { l: "Pending inv.", v: jobCounts.pendingInvoice, c: T.violet, bg: T.violetSoft },
                  { l: "Capital", v: jobCounts.capital, c: T.warn, bg: T.warnSoft },
                ].map((s, i) => (
                  <div key={i} className="card" style={{ background: s.bg, padding: "20px 22px" }}>
                    <div style={{ fontSize: 11, color: s.c, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>{s.l}</div>
                    <div className="display stat-value" style={{ fontSize: 30, fontWeight: 500, color: s.c, letterSpacing: -0.6 }}>{s.v}</div>
                  </div>
                ))}
              </div>
              {myWOs.map((wo, i) => {
                const sla = slaLabel(wo);
                const hasNewSla = !!(wo.responseBreachAt || wo.resolutionBreachAt);
                return (
                  <div key={wo.id} className="card card-hover" onClick={() => { setSelectedWO(wo.id); setPage("wo_detail"); setAiNote(null); }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", marginBottom: 10, cursor: "pointer", animation: `fadeUp 0.3s ${i * 0.04}s both`, gap: 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                        <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: T.accent }}>{wo.id}</span>
                        <Badge conf={PRIORITY[wo.priority]} small />
                        {hasNewSla
                          ? <SlaBadge responseBreachAt={wo.responseBreachAt} resolutionBreachAt={wo.resolutionBreachAt} size="sm" />
                          : sla && <span style={{ fontSize: 10, fontWeight: 700, color: sla.color, background: sla.bg, padding: "2px 8px", borderRadius: 10 }}>{sla.text}</span>}
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: T.ink, marginBottom: 3 }}>{[wo.store ? `Store #${wo.store}` : null, wo.city || null].filter(Boolean).join(" · ") || wo.id}</div>
                      <div style={{ fontSize: 12, color: T.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{wo.summary || "—"}</div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <Badge conf={STATUS[wo.status]} small />
                      <div style={{ fontSize: 10, color: T.subtle, marginTop: 4 }}>{wo.age}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}


    </>
  );
}
