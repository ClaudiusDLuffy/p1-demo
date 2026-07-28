"use client";
// @ts-nocheck

import { useMemo, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Ico } from "../../components/ui/Ico";
import { T, STAFF_INV_STATE } from "../../lib/constants";

const tabs = [
  { id: "all", label: "All" },
  { id: "draft", label: "Draft" },
  { id: "submitted", label: "Submitted to 7-Eleven" },
  { id: "approved", label: "Approved" },
  { id: "paid", label: "Sent to QuickBooks" },
];

export default function BillingInvoiceList(props: any) {
  const {
    page,
    invoices,
    setSelectedBillingInvoice,
    onCreate,
    fmt,
  } = props;
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");

  const visibleInvoices = useMemo(
    () => (invoices || [])
      .filter((invoice: any) => invoice.invoiceType === "staff")
      .filter((invoice: any) => tab === "all" || invoice.state === tab)
      .filter((invoice: any) => {
        const query = search.trim().toLowerCase();
        if (!query) return true;
        return [
          invoice.num,
          invoice.wot,
          invoice.store,
          invoice.storeAddr,
          invoice.cme,
          ...(invoice.sourceInvoices || []).map((source: any) => source.num),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query);
      }),
    [invoices, search, tab],
  );

  if (page !== "billing") return null;

  return (
    <div style={{ animation: "fadeUp 0.25s" }}>
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
          <button onClick={onCreate} className="btn-primary billing-create-button">+ Create Invoice</button>
        </div>
      </div>

      <div className="desktop-only-table">
        <div className="card table-scroll" style={{ overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: T.surfaceSoft }}>
                {["Invoice #", "Date", "Work Order", "Store", "Amount", "Status"].map(h => (
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
                  onClick={() => setSelectedBillingInvoice(invoice.id)}
                  style={{ borderBottom: `1px solid ${T.borderSoft}`, cursor: "pointer" }}
                >
                  <td className="mono" style={{ padding: "13px 14px", fontWeight: 600, color: T.accent }}>#{invoice.num}</td>
                  <td style={{ padding: "13px 14px", color: T.subtle }}>{invoice.date || invoice.invoiceDate}</td>
                  <td style={{ padding: "13px 14px", color: invoice.wot ? T.muted : T.subtle }}>
                    <div className="mono">{invoice.wot || "Standalone"}</div>
                    {(invoice.sourceInvoices || []).length > 0 && <div style={{ fontSize: 10, color: T.subtle, marginTop: 3 }}>{invoice.sourceInvoices.length} contractor invoice{invoice.sourceInvoices.length === 1 ? "" : "s"}</div>}
                  </td>
                  <td style={{ padding: "13px 14px" }}>{invoice.store ? `#${invoice.store}` : "-"}</td>
                  <td className="mono" style={{ padding: "13px 14px", textAlign: "right", fontWeight: 700 }}>{fmt(Math.round(invoice.total || 0))}</td>
                  <td style={{ padding: "13px 14px" }}><Badge conf={STAFF_INV_STATE[invoice.state]} small /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {visibleInvoices.length === 0 && (
            <div style={{ textAlign: "center", padding: "44px 20px", color: T.subtle, fontSize: 13 }}>
              {search ? "No billing invoices match your search." : "No P1 to 7-Eleven invoices yet. Create your first invoice above."}
            </div>
          )}
        </div>
      </div>

      <div className="mobile-only-cards">
        {visibleInvoices.map((invoice: any) => (
          <div
            key={invoice.id}
            className="mobile-card"
            onClick={() => setSelectedBillingInvoice(invoice.id)}
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
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: T.accent }}>#{invoice.num}</span>
              <Badge conf={STAFF_INV_STATE[invoice.state]} small />
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: T.ink, marginBottom: 4 }}>
              Store #{invoice.store || "-"}
              {invoice.date ? <span style={{ fontWeight: 400, color: T.muted, fontSize: 11, marginLeft: 8 }}>{invoice.date}</span> : null}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 8, borderTop: `1px solid ${T.borderSoft}` }}>
              <span style={{ fontSize: 11, color: T.muted }}>
                WO: <span className="mono" style={{ color: invoice.wot ? T.accent : T.subtle }}>{invoice.wot || "Standalone"}</span>
                {(invoice.sourceInvoices || []).length > 0 && <span> / {invoice.sourceInvoices.length} source{invoice.sourceInvoices.length === 1 ? "" : "s"}</span>}
              </span>
              <span className="mono" style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>{fmt(Math.round(invoice.total || 0))}</span>
            </div>
          </div>
        ))}
        {visibleInvoices.length === 0 && (
          <div style={{ textAlign: "center", padding: "40px 20px", color: T.subtle, fontSize: 13 }}>
            {search ? "No billing invoices match your search." : "No P1 to 7-Eleven invoices yet. Create your first invoice above."}
          </div>
        )}
      </div>
    </div>
  );
}
