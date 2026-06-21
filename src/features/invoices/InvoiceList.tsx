"use client";
// @ts-nocheck

import { Badge } from "../../components/ui/Badge";
import { T, INV_STATE } from "../../lib/constants";
import { useMemo } from "react";

export default function InvoiceList(props: any) {
  const { page, selectedInvoice, invTab, setInvTab, isManager, invoices, currentUser, setSelectedInvoice, getUser, fmt } = props;
  const currentUserId = currentUser?.id ?? null;
  const invoiceTabs = [
    { id: "all", l: "All", m: "All" },
    { id: "draft", l: "Draft", m: "Draft" },
    { id: "submitted", l: "Submitted", m: "Sub" },
    { id: "revised", l: "Revised", m: "Rev" },
    { id: "rejected", l: "Rejected", m: "Rej" },
    { id: "approved", l: "Approved", m: "Appr" },
    { id: "paid", l: "Paid", m: "Paid" },
  ];
  const visibleInvoices = useMemo(
    () => (isManager ? invoices : invoices.filter(i => i.contractor === currentUserId))
      .filter(i => invTab === "all" ? true : i.state === invTab),
    [isManager, invoices, currentUserId, invTab]
  );
  return (
    <>
          {/* ═════ INVOICES ═════ */}
          {page === "invoices" && !selectedInvoice && (
            <div style={{ animation: "fadeUp 0.3s" }}>
              <div className="mobile-tabs invoice-tabs" style={{ display: "flex", gap: 0, marginBottom: 18, borderBottom: `2px solid ${T.borderSoft}` }}>
                {invoiceTabs.map(t => (
                  <button key={t.id} onClick={() => setInvTab(t.id)} style={{ padding: "10px 20px", fontSize: 13, fontWeight: invTab === t.id ? 700 : 400, color: invTab === t.id ? T.ink : T.subtle, background: "none", border: "none", borderBottom: invTab === t.id ? `2px solid ${T.ink}` : "2px solid transparent", cursor: "pointer", fontFamily: "inherit", marginBottom: -2 }}>
                    <span className="tab-full-label">{t.l}</span>
                    <span className="tab-short-label" style={{ display: "none" }}>{t.m}</span>
                  </button>
                ))}
              </div>
              <div className="desktop-only-table">
              <div className="card table-scroll" style={{ overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: T.surfaceSoft }}>
                      {(isManager
                        ? ["Invoice#", "WO#", "Contractor", "State", "Date", "Store", "Lines", "Total"]
                        : ["Invoice#", "WO#", "State", "Date", "Store", "Lines", "Total"]
                      ).map(h => (
                        <th key={h} style={{ textAlign: h === "Total" || h === "Lines" ? "right" : "left", padding: "12px 14px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, borderBottom: `1px solid ${T.borderSoft}` }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleInvoices.map(inv => (
                      <tr key={inv.num} onClick={() => setSelectedInvoice(inv.num)} style={{ borderBottom: `1px solid ${T.borderSoft}`, cursor: "pointer" }}>
                        <td className="mono" style={{ padding: "13px 14px", fontWeight: 600, fontSize: 11, color: T.accent }}>#{inv.num}</td>
                        <td className="mono" style={{ padding: "13px 14px", fontSize: 11, color: T.muted }}>{inv.wot}</td>
                        {isManager && <td style={{ padding: "13px 14px", color: T.inkSoft }}>{getUser(inv.contractor)?.name}</td>}
                        <td style={{ padding: "13px 14px" }}><Badge conf={INV_STATE[inv.state]} small /></td>
                        <td style={{ padding: "13px 14px", color: T.subtle }}>{inv.date}</td>
                        <td style={{ padding: "13px 14px" }}>#{inv.store}</td>
                        <td className="mono" style={{ padding: "13px 14px", textAlign: "right", color: T.muted }}>{(inv.lines || []).length}</td>
                        <td className="mono" style={{ padding: "13px 14px", textAlign: "right", fontWeight: 700 }}>{fmt(Math.round(inv.total))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </div>
              <div className="mobile-only-cards">
                {visibleInvoices.map((inv: any) => (
                  <div
                    className="mobile-card"
                    key={inv.num}
                    onClick={() => setSelectedInvoice(inv.num)}
                    style={{
                      background: "#fff",
                      borderRadius: 12,
                      border: `1px solid ${T.borderSoft}`,
                      padding: "14px 16px",
                      marginBottom: 10,
                      cursor: "pointer",
                      boxShadow: "0 1px 3px rgba(31,30,28,0.06)",
                    }}
                  >
                    <div className="mobile-card-top" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 600, color: T.accent }}>#{inv.num}</span>
                      <Badge conf={INV_STATE[inv.state]} small />
                    </div>
                    <div className="mobile-card-title" style={{ fontSize: 13, fontWeight: 600, color: T.ink, marginBottom: 4 }}>
                      Store #{inv.store}
                      {inv.date
                        ? <span style={{ fontWeight: 400, color: T.muted, fontSize: 11, marginLeft: 8 }}>{inv.date}</span>
                        : null}
                    </div>
                    {isManager && (
                      <div className="mobile-card-meta" style={{ fontSize: 12, color: T.muted, marginBottom: 6 }}>
                        {getUser(inv.contractor)?.name || "Unknown"}
                      </div>
                    )}
                    <div className="mobile-card-footer" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 8, borderTop: `1px solid ${T.borderSoft}` }}>
                      <span style={{ fontSize: 11, color: T.muted }}>
                        WO: <span style={{ fontFamily: "monospace", color: T.accent }}>{inv.wot}</span>
                      </span>
                      <span style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 700, color: T.ink }}>
                        {fmt(Math.round(inv.total))}
                      </span>
                    </div>
                  </div>
                ))}
                {visibleInvoices.length === 0 && (
                  <div style={{ textAlign: "center", padding: "40px 20px", color: T.subtle, fontSize: 13 }}>
                    No invoices found
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ═════ INVOICE DETAIL (editorial receipt view) ═════ */}

    </>
  );
}
