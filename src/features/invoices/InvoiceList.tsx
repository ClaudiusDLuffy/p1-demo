"use client";
// @ts-nocheck

import { Badge } from "../../components/ui/Badge";
import { T, INV_STATE } from "../../lib/constants";
import { useMemo } from "react";

export default function InvoiceList(props: any) {
  const { page, selectedInvoice, invTab, setInvTab, isManager, invoices, currentUser, setSelectedInvoice, getUser, fmt } = props;
  const currentUserId = currentUser?.id ?? null;
  const visibleInvoices = useMemo(
    () => (isManager ? invoices : invoices.filter(i => i.contractor === currentUserId))
      .filter(i => invTab === "all" ? true : invTab === "pending" ? (i.state === "submitted" || i.state === "revised") : i.state === invTab),
    [isManager, invoices, currentUserId, invTab]
  );
  return (
    <>
          {/* ═════ INVOICES ═════ */}
          {page === "invoices" && !selectedInvoice && (
            <div style={{ animation: "fadeUp 0.3s" }}>
              <div style={{ display: "flex", gap: 0, marginBottom: 18, borderBottom: `2px solid ${T.borderSoft}` }}>
                {[{ id: "all", l: "All" }, { id: "pending", l: "Pending" }, { id: "submitted", l: "Submitted" }, { id: "rejected", l: "Rejected" }, { id: "approved", l: "Approved" }].map(t => (
                  <button key={t.id} onClick={() => setInvTab(t.id)} style={{ padding: "10px 20px", fontSize: 13, fontWeight: invTab === t.id ? 700 : 400, color: invTab === t.id ? T.ink : T.subtle, background: "none", border: "none", borderBottom: invTab === t.id ? `2px solid ${T.ink}` : "2px solid transparent", cursor: "pointer", fontFamily: "inherit", marginBottom: -2 }}>{t.l}</button>
                ))}
              </div>
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
          )}

          {/* ═════ INVOICE DETAIL (editorial receipt view) ═════ */}

    </>
  );
}
