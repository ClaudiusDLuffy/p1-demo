"use client";
// @ts-nocheck

import { Avatar } from "../../components/ui/Avatar";
import { T } from "../../lib/constants";
import { useMemo } from "react";

export default function ContractorList(props: any) {
  const { page, isManager, contractorsOnly, workOrders, activeStatuses, nav, setFilterC, fmt } = props;
  const workOrdersByContractor = useMemo(() => {
    const grouped: Record<string, any[]> = {};
    for (const w of workOrders) {
      if (!w.contractor) continue;
      (grouped[w.contractor] ||= []).push(w);
    }
    return grouped;
  }, [workOrders]);
  const contractorCounts = useMemo(() => {
    const counts: Record<string, { active: number; capital: number }> = {};
    for (const c of contractorsOnly) {
      const cWOs = workOrdersByContractor[c.id] || [];
      counts[c.id] = {
        active: cWOs.filter(w => activeStatuses.includes(w.status)).length,
        capital: cWOs.filter(w => w.status === "capital").length,
      };
    }
    return counts;
  }, [contractorsOnly, workOrdersByContractor, activeStatuses]);
  return (
    <>
          {/* ═════ CONTRACTORS ═════ */}
          {page === "contractors" && isManager && (
            <div className="contractors-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, animation: "fadeUp 0.3s" }}>
              {contractorsOnly.map((c, i) => {
                const counts = contractorCounts[c.id] || { active: 0, capital: 0 };
                return (
                  <div key={c.id} className="card card-hover" style={{ overflow: "hidden", animation: `fadeUp 0.35s ${i * 0.06}s both` }}>
                    <div style={{ padding: "22px 22px 16px", borderBottom: `1px solid ${T.borderSoft}` }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <Avatar initials={c.initials} color={c.color} size={46} />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 15, fontWeight: 700, color: T.ink }}>{c.name}</div>
                          <div style={{ fontSize: 12, color: T.muted }}>{c.company}</div>
                          <div style={{ fontSize: 11, color: T.subtle, marginTop: 3 }}>{c.territory}</div>
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 5, marginTop: 12, flexWrap: "wrap" }}>
                        {(c.trades || []).map((t: string) => (
                          <span key={t} style={{ fontSize: 10, fontWeight: 600, color: T.accent, background: T.accentSoft, padding: "2px 8px", borderRadius: 10, textTransform: "capitalize" }}>{t}</span>
                        ))}
                      </div>
                    </div>
                    <div style={{ padding: "14px 22px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 3 }}>Active</div>
                        <div className="display" style={{ fontSize: 20, fontWeight: 500, color: T.accent }}>{counts.active}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 3 }}>Capital</div>
                        <div className="display" style={{ fontSize: 20, fontWeight: 500, color: T.violet }}>{counts.capital}</div>
                      </div>
                    </div>
                    <div style={{ padding: "0 22px 18px" }}>
                      <button onClick={() => { nav("work_orders"); setFilterC(c.id); }} className="btn-soft" style={{ width: "100%" }}>View work orders →</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}


    </>
  );
}
