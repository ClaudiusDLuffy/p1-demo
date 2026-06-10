"use client";
// @ts-nocheck

import { Badge } from "../../components/ui/Badge";
import { Ico } from "../../components/ui/Ico";
import { T, INV_STATE, P1_BUSINESS, SEVEN_BILL_TO, MONTHS } from "../../lib/constants";
import { useMemo } from "react";

export default function InvoiceDetail(props: any) {
  const { page, selectedInvoice, invoices, workOrders, isManager, setSelectedInvoice, doApproveInvoice, doDownloadInvoice, pdfBusy, fmt } = props;
  const inv = useMemo(
    () => invoices.find(i => i.num === selectedInvoice),
    [invoices, selectedInvoice]
  );
  const wo = useMemo(
    () => inv ? workOrders.find(w => w.id === inv.wot) : null,
    [workOrders, inv]
  );
  return (
    <>
          {page === "invoices" && selectedInvoice && (() => {
            if (!inv) return null;
            return (
              <div style={{ animation: "fadeUp 0.25s" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, maxWidth: 860 }}>
                  <button onClick={() => setSelectedInvoice(null)} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: T.muted, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: 0 }}><Ico d="M15 18l-6-6 6-6" size={14} /> Back to invoices</button>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => doDownloadInvoice(inv)} disabled={pdfBusy} className="btn-soft" style={{ display: "flex", alignItems: "center", gap: 6, opacity: pdfBusy ? 0.6 : 1, cursor: pdfBusy ? "default" : "pointer" }}>
                      <Ico d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" size={13} color="currentColor" />
                      {pdfBusy ? "Preparing…" : "Download PDF"}
                    </button>
                    {isManager && (inv.state === "submitted" || inv.state === "revised") && (
                      <button onClick={() => { doApproveInvoice(inv.wot); setSelectedInvoice(null); }} className="btn-primary">Approve (on behalf of AFM)</button>
                    )}
                  </div>
                </div>
                <div className="card" style={{ padding: 0, overflow: "hidden", maxWidth: 860 }}>
                  {/* Invoice header */}
                  <div style={{ padding: "28px 32px", borderBottom: `1px solid ${T.borderSoft}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
                      <div>
                        <div className="display" style={{ fontSize: 36, color: T.ink, letterSpacing: -0.8, lineHeight: 1 }}>Invoice</div>
                        <div className="mono" style={{ fontSize: 16, color: T.accent, marginTop: 8, fontWeight: 600 }}>#{inv.num}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div className="display" style={{ fontSize: 18, color: T.ink, lineHeight: 1 }}>{P1_BUSINESS.dba}</div>
                        <div style={{ fontSize: 10, color: T.subtle, marginTop: 2 }}>({P1_BUSINESS.legalName})</div>
                        <div style={{ fontSize: 11, color: T.muted, marginTop: 6, lineHeight: 1.55 }}>
                          {P1_BUSINESS.addr1}<br />{P1_BUSINESS.addr2}<br />{P1_BUSINESS.email}<br />{P1_BUSINESS.phone}<br />{P1_BUSINESS.website}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Bill-to / Ship-to / Metadata */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 0, borderBottom: `1px solid ${T.borderSoft}` }}>
                    <div style={{ padding: "20px 32px", borderRight: `1px solid ${T.borderSoft}` }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 6 }}>Bill to</div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: T.ink }}>{SEVEN_BILL_TO.name}</div>
                      <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.6, marginTop: 2 }}>7-ELEVEN STORE - {inv.store}<br />{SEVEN_BILL_TO.addr1}<br />{SEVEN_BILL_TO.addr2}</div>
                    </div>
                    <div style={{ padding: "20px 32px", borderRight: `1px solid ${T.borderSoft}` }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 6 }}>Ship to</div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: T.ink }}>7-ELEVEN STORE - {inv.store}</div>
                      <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.6, marginTop: 2 }}>{inv.storeAddr || wo?.addr || "—"}</div>
                    </div>
                    <div style={{ padding: "20px 32px" }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 6 }}>Invoice details</div>
                      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 12px", fontSize: 11 }}>
                        <span style={{ color: T.muted }}>Invoice date</span><span className="mono" style={{ color: T.ink }}>{inv.invoiceDate}</span>
                        <span style={{ color: T.muted }}>Service date</span><span className="mono" style={{ color: T.ink }}>{inv.serviceDate}</span>
                        <span style={{ color: T.muted }}>Terms</span><span style={{ color: T.ink }}>{inv.terms || "Net 30"}</span>
                        <span style={{ color: T.muted }}>Work order</span><span className="mono" style={{ color: T.accent }}>{inv.wot}</span>
                        <span style={{ color: T.muted }}>CME</span><span className="mono" style={{ color: T.ink }}>{inv.cme || "—"}</span>
                        <span style={{ color: T.muted }}>Status</span><span><Badge conf={INV_STATE[inv.state]} small /></span>
                      </div>
                    </div>
                  </div>

                  {/* Line items */}
                  <div>
                    <div style={{ display: "grid", gridTemplateColumns: "36px 130px 1fr 60px 90px 100px", gap: 0, padding: "12px 32px", background: T.surfaceSoft, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.7, color: T.subtle, borderBottom: `1px solid ${T.borderSoft}` }}>
                      <div>#</div><div>Type</div><div>Description</div><div style={{ textAlign: "right" }}>Qty</div><div style={{ textAlign: "right" }}>Rate</div><div style={{ textAlign: "right" }}>Amount</div>
                    </div>
                    {(inv.lines || []).map((l: any, i: number) => (
                      <div key={i} style={{ display: "grid", gridTemplateColumns: "36px 130px 1fr 60px 90px 100px", gap: 0, padding: "14px 32px", borderBottom: `1px solid ${T.borderSoft}`, alignItems: "start", fontSize: 12 }}>
                        <div className="mono" style={{ color: T.subtle }}>{i + 1}</div>
                        <div style={{ color: T.inkSoft, fontWeight: 500 }}>{l.type}</div>
                        <div style={{ color: T.ink, lineHeight: 1.55, paddingRight: 14 }}>{l.desc}</div>
                        <div className="mono" style={{ textAlign: "right", color: T.muted }}>{l.qty}</div>
                        <div className="mono" style={{ textAlign: "right", color: T.muted }}>{fmt(l.rate)}</div>
                        <div className="mono" style={{ textAlign: "right", fontWeight: 600, color: T.ink }}>{fmt(Math.round(l.amount * 100) / 100)}</div>
                      </div>
                    ))}
                  </div>

                  {/* Totals */}
                  <div style={{ padding: "22px 32px", display: "flex", justifyContent: "flex-end" }}>
                    <div style={{ width: 300 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "6px 0" }}>
                        <span style={{ color: T.muted }}>Subtotal</span>
                        <span className="mono" style={{ color: T.ink, fontWeight: 500 }}>{fmt(Math.round(inv.subtotal * 100) / 100)}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "6px 0", borderBottom: `1px solid ${T.border}` }}>
                        <span style={{ color: T.muted }}>Sales tax</span>
                        <span className="mono" style={{ color: T.ink, fontWeight: 500 }}>{fmt(Math.round(inv.salesTax * 100) / 100)}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0 0" }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>Total</span>
                        <span className="display" style={{ fontSize: 26, color: T.ink, letterSpacing: -0.5 }}>{fmt(Math.round(inv.total * 100) / 100)}</span>
                      </div>
                      {wo && (
                        <div style={{ fontSize: 11, color: inv.total > wo.nte ? T.danger : T.success, textAlign: "right", marginTop: 4 }}>
                          {inv.total > wo.nte ? `Exceeds NTE by ${fmt(inv.total - wo.nte)}` : `${fmt(wo.nte - inv.total)} under NTE`}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Rejected reason */}
                  {inv.state === "rejected" && inv.reason && (
                    <div style={{ padding: "16px 32px", background: T.dangerSoft, borderTop: `1px solid ${T.danger}22` }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.danger, marginBottom: 4 }}>Rejection reason</div>
                      <div style={{ fontSize: 12, color: "#8B2C20" }}>{inv.reason}</div>
                    </div>
                  )}

                  {/* Footer — ways to pay (placeholder until Jeremy confirms) */}
                  <div style={{ padding: "18px 32px", background: T.surfaceSoft, borderTop: `1px solid ${T.borderSoft}`, fontSize: 11, color: T.subtle, textAlign: "center" }}>
                    Ways to pay — ACH / check (pending confirmation with Jeremy) · Questions? {P1_BUSINESS.email}
                  </div>
                </div>
              </div>
            );
          })()}


    </>
  );
}
