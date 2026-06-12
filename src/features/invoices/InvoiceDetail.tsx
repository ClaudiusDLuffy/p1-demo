"use client";
// @ts-nocheck

import { Badge } from "../../components/ui/Badge";
import { Ico } from "../../components/ui/Ico";
import { BtnSpinner } from "../../components/ui/BtnSpinner";
import { Modal } from "../../components/ui/Modal";
import { T, INV_STATE, P1_BUSINESS, SEVEN_BILL_TO, MONTHS } from "../../lib/constants";
import { useMemo, useState } from "react";

export default function InvoiceDetail(props: any) {
  const { page, selectedInvoice, invoices, workOrders, isManager, setSelectedInvoice, doApproveInvoice, doDownloadInvoice, doDeleteInvoice, pdfBusy, fmt, loadingStates = {} } = props;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
                <div className="invoice-action-bar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, maxWidth: 860 }}>
                  <button onClick={() => setSelectedInvoice(null)} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: T.muted, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: 0 }}><Ico d="M15 18l-6-6 6-6" size={14} /> Back to invoices</button>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => doDownloadInvoice(inv)} disabled={pdfBusy} className="btn-soft" style={{ display: "flex", alignItems: "center", gap: 6, opacity: pdfBusy ? 0.6 : 1, cursor: pdfBusy ? "default" : "pointer" }}>
                      <Ico d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" size={13} color="currentColor" />
                      {pdfBusy ? "Preparing…" : "Download PDF"}
                    </button>
                    {isManager && (inv.state === "submitted" || inv.state === "revised") && (
                      <button
                        onClick={async () => { await doApproveInvoice(inv.wot); setSelectedInvoice(null); }}
                        disabled={loadingStates["approveInvoice_" + inv.wot]}
                        className="btn-primary"
                        style={{ display: "flex", alignItems: "center", gap: 6, opacity: loadingStates["approveInvoice_" + inv.wot] ? 0.7 : 1, cursor: loadingStates["approveInvoice_" + inv.wot] ? "default" : "pointer" }}
                      >
                        {loadingStates["approveInvoice_" + inv.wot] ? <><BtnSpinner />Approving...</> : "Approve (on behalf of AFM)"}
                      </button>
                    )}
                    {/* Staff-only soft delete (testing-phase cleanup) — contractors never see this. */}
                    {isManager && (
                      <button onClick={() => setConfirmDelete(true)} className="btn-soft" style={{ color: T.danger, borderColor: `${T.danger}44` }}>Delete</button>
                    )}
                  </div>
                </div>
                {confirmDelete && (
                  <Modal onClose={() => setConfirmDelete(false)} title="Delete invoice" width={420}>
                    <div style={{ fontSize: 13, color: T.muted, marginBottom: 20, lineHeight: 1.55 }}>
                      Delete this invoice? This cannot be undone from the portal.
                    </div>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button onClick={() => setConfirmDelete(false)} className="btn-soft">Cancel</button>
                      <button
                        onClick={async () => {
                          setDeleting(true);
                          const ok = await doDeleteInvoice(inv);
                          setDeleting(false);
                          setConfirmDelete(false);
                          if (ok) setSelectedInvoice(null);
                        }}
                        disabled={deleting}
                        style={{ padding: "10px 18px", borderRadius: 10, background: T.danger, color: "#fff", border: "none", cursor: deleting ? "default" : "pointer", fontWeight: 600, fontSize: 12, fontFamily: "inherit", opacity: deleting ? 0.7 : 1, display: "flex", alignItems: "center", gap: 6 }}
                      >{deleting ? <><BtnSpinner />Deleting...</> : "Delete"}</button>
                    </div>
                  </Modal>
                )}
                <div className="card invoice-detail-container" style={{ padding: 0, overflow: "hidden", maxWidth: 860 }}>
                  {/* Invoice header */}
                  <div style={{ padding: "28px 32px", borderBottom: `1px solid ${T.borderSoft}` }}>
                    <div className="invoice-top-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
                      <div className="invoice-top-header-left">
                        <div className="display invoice-title-text" style={{ fontSize: 36, color: T.ink, letterSpacing: -0.8, lineHeight: 1 }}>Invoice</div>
                        <div className="mono" style={{ fontSize: 16, color: T.accent, marginTop: 8, fontWeight: 600 }}>#{inv.num}</div>
                      </div>
                      <div className="invoice-top-header-right" style={{ textAlign: "right" }}>
                        <div className="display invoice-company-name" style={{ fontSize: 18, color: T.ink, lineHeight: 1 }}>{P1_BUSINESS.dba}</div>
                        <div className="invoice-company-legal" style={{ fontSize: 10, color: T.subtle, marginTop: 2 }}>({P1_BUSINESS.legalName})</div>
                        <div className="invoice-company-details" style={{ fontSize: 11, color: T.muted, marginTop: 6, lineHeight: 1.55 }}>
                          {P1_BUSINESS.addr1}<br />{P1_BUSINESS.addr2}<br />{P1_BUSINESS.email}<br />{P1_BUSINESS.phone}<br />{P1_BUSINESS.website}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Bill-to / Ship-to / Metadata */}
                  <div className="invoice-header-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 0, borderBottom: `1px solid ${T.borderSoft}` }}>
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
                      <div className="invoice-meta-grid" style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 12px", fontSize: 11 }}>
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
                    <div className="desktop-only-table">
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
                    <div className="mobile-only-cards">
                      {(inv.lines || []).map((line: any, i: number) => (
                        <div
                          key={i}
                          style={{
                            padding: "14px 0",
                            borderBottom: `1px solid ${T.borderSoft}`,
                          }}
                        >
                          <div style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "flex-start",
                            marginBottom: 6,
                          }}>
                            <div>
                              <div style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: T.ink,
                                marginBottom: 2,
                              }}>
                                {i + 1}. {line.lineType || line.type}
                              </div>
                              <div style={{
                                fontSize: 12,
                                color: T.muted,
                              }}>
                                {line.description || line.desc}
                              </div>
                            </div>
                            <div style={{
                              fontSize: 14,
                              fontWeight: 700,
                              color: T.ink,
                              textAlign: "right",
                              flexShrink: 0,
                              marginLeft: 12,
                            }}>
                              {fmt(Math.round(((line.qty || 1) * (line.rate || 0)) * 100) / 100)}
                            </div>
                          </div>
                          <div style={{
                            display: "flex",
                            gap: 16,
                            fontSize: 11,
                            color: T.muted,
                          }}>
                            <span>Qty: {line.qty || 1}</span>
                            <span>Rate: {fmt(line.rate || 0)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Totals */}
                  <div className="invoice-totals-section" style={{ padding: "22px 32px", display: "flex", justifyContent: "flex-end" }}>
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
