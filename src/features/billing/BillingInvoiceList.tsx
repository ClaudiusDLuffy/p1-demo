"use client";
// @ts-nocheck

import { useMemo, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { Ico } from "../../components/ui/Ico";
import { T, INV_STATE, STAFF_INV_STATE } from "../../lib/constants";
import { isInvoiceController } from "../../lib/staffPermissions";

const tabs = [
  { id: "all", label: "All" },
  { id: "draft", label: "Draft" },
  { id: "submitted", label: "Please send to 7-Eleven" },
  { id: "approved", label: "Sent to 7-Eleven" },
  { id: "recently_approved", label: "Recently Approved" },
];

export default function BillingInvoiceList(props: any) {
  const {
    page,
    currentUser,
    invoices,
    contractorInvoices,
    readyWorkOrders = [],
    setSelectedBillingInvoice,
    onCreate,
    onCreateFromApproved,
    onCreateFromWorkOrder,
    fmt,
  } = props;
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const [readyToBillExpanded, setReadyToBillExpanded] = useState(false);
  const controller = isInvoiceController(currentUser);
  const showingRecentlyApproved = tab === "recently_approved";
  const sourceOwnerById = useMemo(() => {
    const owners = new Map<string, any>();
    for (const invoice of invoices || []) {
      for (const sourceId of invoice.sourceInvoiceIds || []) {
        owners.set(sourceId, invoice);
      }
    }
    return owners;
  }, [invoices]);

  const visibleInvoices = useMemo(
    () => (showingRecentlyApproved ? contractorInvoices || [] : invoices || [])
      .filter((invoice: any) => showingRecentlyApproved
        ? invoice.invoiceType === "contractor" && invoice.state === "approved"
        : invoice.invoiceType === "staff")
      .filter((invoice: any) =>
        showingRecentlyApproved || tab === "all" || invoice.state === tab,
      )
      .filter((invoice: any) => {
        const query = search.trim().toLowerCase();
        if (!query) return true;
        return [
          invoice.num,
          invoice.wot,
          invoice.store,
          invoice.storeAddr,
          invoice.cme,
          invoice.territory,
          ...(invoice.sourceInvoices || []).map((source: any) => source.num),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query);
      })
      .sort((a: any, b: any) => {
        if (!showingRecentlyApproved) return 0;
        return new Date(b.updatedAt || b.createdAt || 0).getTime()
          - new Date(a.updatedAt || a.createdAt || 0).getTime();
      }),
    [contractorInvoices, invoices, search, showingRecentlyApproved, tab],
  );

  const openInvoice = (invoice: any) => {
    if (!showingRecentlyApproved) {
      setSelectedBillingInvoice(invoice.id);
      return;
    }
    const existingBillingInvoice = sourceOwnerById.get(invoice.id);
    if (existingBillingInvoice) {
      setSelectedBillingInvoice(existingBillingInvoice.id);
      return;
    }
    if (controller) return;
    onCreateFromApproved?.(invoice);
  };

  const canOpenInvoice = (invoice: any) =>
    !showingRecentlyApproved
    || sourceOwnerById.has(invoice.id)
    || !controller;

  if (page !== "billing") return null;

  return (
    <div style={{ animation: "fadeUp 0.25s" }}>
      {!controller && readyWorkOrders.length > 0 && (
        <section style={{ marginBottom: 22 }}>
          <button
            type="button"
            aria-expanded={readyToBillExpanded}
            aria-controls="billing-ready-work-orders"
            onClick={() => setReadyToBillExpanded(expanded => !expanded)}
            className="card"
            style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "12px 14px", background: T.surface, color: T.ink, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span aria-hidden="true" style={{ color: T.subtle, transform: readyToBillExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>›</span>
              <strong style={{ fontSize: 14 }}>Ready to Bill</strong>
            </span>
            <span style={{ fontSize: 11, color: T.subtle }}>{readyWorkOrders.length} work order{readyWorkOrders.length === 1 ? "" : "s"}</span>
          </button>
          {readyToBillExpanded && (
            <div id="billing-ready-work-orders" className="card" style={{ overflow: "hidden", marginTop: 9 }}>
              {readyWorkOrders.map((workOrder: any, index: number) => (
                <div
                  key={workOrder.id}
                  className="billing-ready-row"
                  style={{ display: "grid", gridTemplateColumns: "minmax(160px, 1fr) minmax(120px, 1fr) minmax(160px, 2fr) auto", alignItems: "center", gap: 14, padding: "12px 14px", borderBottom: index === readyWorkOrders.length - 1 ? "none" : `1px solid ${T.borderSoft}` }}
                >
                  <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: T.accent, fontSize: 11, fontWeight: 700 }}>
                    {workOrder.id}
                    <CopyWorkOrderButton value={workOrder.id} />
                  </span>
                  <span style={{ color: T.ink, fontSize: 12 }}>Store #{workOrder.store || "-"}</span>
                  <span style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
                    {workOrder.billingOnly && (
                      <span style={{ flex: "0 0 auto", padding: "3px 7px", borderRadius: 999, background: "#FEF3C7", color: "#92400E", fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.35 }}>
                        Billing only · no dispatch
                      </span>
                    )}
                    <span style={{ minWidth: 0, color: T.muted, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {workOrder.summary || "Billing-only work order"}
                    </span>
                  </span>
                  <button type="button" className="btn-primary" onClick={() => onCreateFromWorkOrder?.(workOrder)}>Create invoice</button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, marginBottom: 18, flexWrap: "wrap" }}>
        <div
          className="billing-status-tabs"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 0,
            borderBottom: `2px solid ${T.borderSoft}`,
            overflow: "visible",
            maxWidth: "100%",
          }}
        >
          {tabs.map(t => (
            <button
              key={t.id}
              className="billing-status-tab"
              onClick={() => setTab(t.id)}
              style={{
                padding: "10px 18px",
                fontSize: 13,
                fontWeight: tab === t.id ? 700 : 400,
                color: tab === t.id ? T.ink : T.subtle,
                background: "none",
                border: "none",
                borderBottom: tab === t.id ? `2px solid ${T.ink}` : "2px solid transparent",
                cursor: "pointer",
                fontFamily: "inherit",
                whiteSpace: "nowrap",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", flex: "1 1 300px", justifyContent: "flex-end" }}>
          <label style={{ position: "relative", flex: "1 1 220px", maxWidth: 340 }}>
            <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", display: "flex", color: T.subtle, pointerEvents: "none" }}>
              <Ico d="M21 21l-4.35-4.35M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0z" size={15} color="currentColor" />
            </span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search invoices"
              aria-label="Search billing invoices"
              style={{ width: "100%", minHeight: 38, padding: "8px 12px 8px 34px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontFamily: "inherit", fontSize: 12 }}
            />
          </label>
          {!controller && (
            <button onClick={onCreate} className="btn-primary billing-create-button">+ Create Invoice</button>
          )}
        </div>
      </div>

      <div className="desktop-only-table">
        <div className="card table-scroll" style={{ overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: T.surfaceSoft }}>
                {["Invoice #", "Date", "Work Order", "Store", "Territory", "Amount", "Status"].map(h => (
                  <th
                    key={h}
                    style={{
                      textAlign: h === "Amount" ? "right" : "left",
                      padding: "12px 14px",
                      fontSize: 10,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: 0.8,
                      color: T.subtle,
                      borderBottom: `1px solid ${T.borderSoft}`,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleInvoices.map((invoice: any) => (
                <tr
                  key={invoice.id}
                  onClick={() => openInvoice(invoice)}
                  style={{
                    borderBottom: `1px solid ${T.borderSoft}`,
                    cursor: canOpenInvoice(invoice) ? "pointer" : "default",
                  }}
                >
                  <td className="mono" style={{ padding: "13px 14px", fontWeight: 600, color: T.accent }}>#{invoice.num}</td>
                  <td style={{ padding: "13px 14px", color: T.subtle }}>{invoice.date || invoice.invoiceDate}</td>
                  <td style={{ padding: "13px 14px", color: invoice.wot ? T.muted : T.subtle }}>
                    <div className="mono" style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      {invoice.wot || "Standalone"}
                      {invoice.wot && <CopyWorkOrderButton value={invoice.wot} />}
                    </div>
                    {(invoice.sourceInvoices || []).length > 0 && <div style={{ fontSize: 10, color: T.subtle, marginTop: 3 }}>{invoice.sourceInvoices.length} contractor invoice{invoice.sourceInvoices.length === 1 ? "" : "s"}</div>}
                  </td>
                  <td style={{ padding: "13px 14px" }}>{invoice.store ? `#${invoice.store}` : "-"}</td>
                  <td style={{ padding: "13px 14px", color: invoice.territory ? T.ink : T.subtle }}>{invoice.territory || "-"}</td>
                  <td className="mono" style={{ padding: "13px 14px", textAlign: "right", fontWeight: 700 }}>{fmt(Math.round(invoice.total || 0))}</td>
                  <td style={{ padding: "13px 14px" }}>
                    <Badge conf={showingRecentlyApproved ? INV_STATE.approved : STAFF_INV_STATE[invoice.state]} small />
                    {showingRecentlyApproved && sourceOwnerById.has(invoice.id) && (
                      <div style={{ fontSize: 9, color: T.subtle, marginTop: 4 }}>Already in Billing</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {visibleInvoices.length === 0 && (
            <div style={{ textAlign: "center", padding: "44px 20px", color: T.subtle, fontSize: 13 }}>
              {search
                ? "No billing invoices match your search."
                : showingRecentlyApproved
                  ? "No approved contractor invoices are available."
                  : "No P1 to 7-Eleven invoices yet. Create your first invoice above."}
            </div>
          )}
        </div>
      </div>

      <div className="mobile-only-cards responsive-card-grid">
        {visibleInvoices.map((invoice: any) => (
          <div
            key={invoice.id}
            className="mobile-card"
            onClick={() => openInvoice(invoice)}
            style={{
              background: "#fff",
              borderRadius: 12,
              border: `1px solid ${T.borderSoft}`,
              padding: "14px 16px",
              marginBottom: 10,
              cursor: canOpenInvoice(invoice) ? "pointer" : "default",
              boxShadow: "0 1px 3px rgba(31,30,28,0.06)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: T.accent }}>#{invoice.num}</span>
              <Badge conf={showingRecentlyApproved ? INV_STATE.approved : STAFF_INV_STATE[invoice.state]} small />
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: T.ink, marginBottom: 4 }}>
              Store #{invoice.store || "-"}
              {invoice.date ? <span style={{ fontWeight: 400, color: T.muted, fontSize: 11, marginLeft: 8 }}>{invoice.date}</span> : null}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 8, borderTop: `1px solid ${T.borderSoft}` }}>
              <span style={{ fontSize: 11, color: T.muted }}>
                WO: <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 4, color: invoice.wot ? T.accent : T.subtle }}>
                  {invoice.wot || "Standalone"}
                  {invoice.wot && <CopyWorkOrderButton value={invoice.wot} />}
                </span>
                {(invoice.sourceInvoices || []).length > 0 && <span> / {invoice.sourceInvoices.length} source{invoice.sourceInvoices.length === 1 ? "" : "s"}</span>}
                {showingRecentlyApproved && sourceOwnerById.has(invoice.id) && <span> / already in Billing</span>}
              </span>
              <span className="mono" style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>{fmt(Math.round(invoice.total || 0))}</span>
            </div>
          </div>
        ))}
        {visibleInvoices.length === 0 && (
          <div style={{ textAlign: "center", padding: "40px 20px", color: T.subtle, fontSize: 13 }}>
            {search
              ? "No billing invoices match your search."
              : showingRecentlyApproved
                ? "No approved contractor invoices are available."
                : "No P1 to 7-Eleven invoices yet. Create your first invoice above."}
          </div>
        )}
      </div>
    </div>
  );
}
