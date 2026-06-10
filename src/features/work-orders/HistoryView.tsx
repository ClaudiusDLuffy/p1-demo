"use client";
// @ts-nocheck

import { T } from "../../lib/constants";

export default function HistoryView(props: any) {
  const { page, isManager, selectedWO, histFrom, setHistFrom, histTo, setHistTo, histSearch, setHistSearch, histContractor, setHistContractor, histReso, setHistReso, invoices, closedWOs, contractorsOnly, setSelectedWO, setAiNote, getUser, fmt } = props;
  if (page !== "history" || selectedWO) return null;

  const filteredClosedWOs = (closedWOs || []).filter((w: any) => {
    const search = (histSearch || "").toLowerCase();
    const closedAt = w.closedAt ? new Date(w.closedAt) : null;
    if (search && !String(w.id || "").toLowerCase().includes(search)
      && !String(w.store || "").toLowerCase().includes(search)
      && !String(w.summary || "").toLowerCase().includes(search)) return false;
    if (histContractor !== "all" && w.contractor !== histContractor) return false;
    if (histReso !== "all" && (w.resolutionCode || "unknown") !== histReso) return false;
    if (histFrom && closedAt && closedAt < new Date(`${histFrom}T00:00:00`)) return false;
    if (histTo && closedAt && closedAt > new Date(`${histTo}T23:59:59`)) return false;
    return true;
  });

  const totalClosedValue = filteredClosedWOs.reduce((sum: number, w: any) => {
    const invoiceTotal = invoices?.find((i: any) => i.wot === w.id)?.total;
    return sum + (invoiceTotal || w.invoiceTotal || 0);
  }, 0);

  return (
    <>
      <section style={{ padding: 24, display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <h1 className="display" style={{ fontSize: 28, color: T.ink, margin: 0 }}>History</h1>
            <div style={{ fontSize: 13, color: T.muted, marginTop: 6 }}>
              {filteredClosedWOs.length} closed work order{filteredClosedWOs.length === 1 ? "" : "s"} - {fmt(totalClosedValue)}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              value={histSearch}
              onChange={(e: any) => setHistSearch(e.target.value)}
              placeholder="Search history..."
              style={{ minWidth: 220, padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink }}
            />
            {isManager && (
              <select value={histContractor} onChange={(e: any) => setHistContractor(e.target.value)} style={{ padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink }}>
                <option value="all">All contractors</option>
                {contractorsOnly.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <select value={histReso} onChange={(e: any) => setHistReso(e.target.value)} style={{ padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink }}>
              <option value="all">All resolutions</option>
              <option value="Repaired">Repaired</option>
              <option value="Temporary fix">Temporary fix</option>
              <option value="Awaiting parts">Awaiting parts</option>
              <option value="unknown">Unknown</option>
            </select>
            <input type="date" value={histFrom} onChange={(e: any) => setHistFrom(e.target.value)} style={{ padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink }} />
            <input type="date" value={histTo} onChange={(e: any) => setHistTo(e.target.value)} style={{ padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink }} />
          </div>
        </div>

        {filteredClosedWOs.length === 0 ? (
          <div className="card" style={{ padding: 28, color: T.muted, textAlign: "center" }}>
            No closed work orders match the current filters.
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12 }}>
            {filteredClosedWOs.map((w: any) => {
              const inv = invoices?.find((i: any) => i.wot === w.id);
              return (
                <button
                  key={w.id}
                  onClick={() => { setSelectedWO(w.id); setAiNote(null); }}
                  className="card"
                  style={{ padding: 16, textAlign: "left", border: `1px solid ${T.border}`, background: T.surface, cursor: "pointer" }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                    <div>
                      <div className="mono" style={{ fontSize: 12, color: T.accent, fontWeight: 700 }}>{w.id}</div>
                      <div style={{ fontSize: 15, color: T.ink, fontWeight: 700, marginTop: 4 }}>{w.summary || "Closed work order"}</div>
                    </div>
                    <span style={{ fontSize: 11, color: T.success, background: T.successSoft, borderRadius: 999, padding: "4px 8px", fontWeight: 700 }}>Closed</span>
                  </div>
                  <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 12, color: T.muted }}>
                    <div>Store <strong style={{ color: T.ink }}>{w.store || "-"}</strong></div>
                    <div>Contractor <strong style={{ color: T.ink }}>{w.contractor ? (getUser(w.contractor)?.name || "Unknown") : "Unassigned"}</strong></div>
                    <div>Closed <strong style={{ color: T.ink }}>{w.closedAt ? new Date(w.closedAt).toLocaleDateString() : "-"}</strong></div>
                    <div>Total <strong style={{ color: T.ink }}>{fmt(inv?.total || w.invoiceTotal || 0)}</strong></div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
