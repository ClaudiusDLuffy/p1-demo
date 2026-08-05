"use client";
// @ts-nocheck

import { Badge } from "../../components/ui/Badge";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { Ico } from "../../components/ui/Ico";
import { T, INV_STATE } from "../../lib/constants";
import { InvoiceSortKey, SortDirection, sortInvoices } from "../../lib/invoiceSort";
import { useMemo, useState } from "react";

export default function InvoiceList(props: any) {
  const { page, selectedInvoice, invTab, setInvTab, isManager, invoices, currentUser, setSelectedInvoice, getUser, fmt } = props;
  const currentContractorId = currentUser?.contractorAccountId || currentUser?.id || null;
  const controller = String(currentUser?.email || "").trim().toLowerCase()
    === "emilyb@phospitality.com";
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<InvoiceSortKey>("recent");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const invoiceTabs = [
    { id: "all", l: "All", m: "All" },
    { id: "draft", l: "Draft", m: "Draft" },
    { id: "submitted", l: "Submitted", m: "Sub" },
    { id: "revised", l: "Revised", m: "Rev" },
    { id: "rejected", l: "Rejected", m: "Rej" },
    { id: "approved", l: "Approved", m: "Appr" },
    { id: "paid", l: "Sent to QuickBooks", m: "Sent to QB" },
  ];
  const sortOptions = [
    { id: "recent", label: "Recently added" },
    { id: "invoice", label: "Invoice #" },
    { id: "work_order", label: "WO #" },
    ...(isManager ? [{ id: "contractor", label: "Contractor" }] : []),
    { id: "status", label: "Status" },
    { id: "date", label: "Invoice date" },
    { id: "store", label: "Store" },
    { id: "lines", label: "Lines" },
    { id: "total", label: "Total" },
  ] as { id: InvoiceSortKey; label: string }[];
  const tableHeaders = [
    { key: "invoice", label: "Invoice#" },
    { key: "work_order", label: "WO#" },
    ...(isManager ? [{ key: "contractor", label: "Contractor" }] : []),
    { key: "status", label: "State" },
    { key: "date", label: "Date" },
    { key: "store", label: "Store" },
    { key: "lines", label: "Lines", align: "right" },
    { key: "total", label: "Total", align: "right" },
  ] as { key: InvoiceSortKey; label: string; align?: "left" | "right" }[];
  const chooseSort = (key: InvoiceSortKey) => {
    if (key === sortKey) {
      setSortDirection(direction => direction === "asc" ? "desc" : "asc");
      return;
    }
    setSortKey(key);
    setSortDirection(key === "recent" || key === "date" ? "desc" : "asc");
  };
  const visibleInvoices = useMemo(
    () => {
      const filtered = (isManager ? invoices : invoices.filter(i => i.contractor === currentContractorId))
        .filter(i => (i.invoiceType || "contractor") === "contractor")
        .filter(i => !controller || ["approved", "paid"].includes(i.state))
        .filter(i => invTab === "all" ? true : i.state === invTab)
        .filter(i => {
        const query = search.trim().toLowerCase();
        if (!query) return true;
        const contractor = getUser(i.contractor);
        return [
          i.num,
          i.wot,
          i.store,
          i.storeAddr,
          i.state,
          contractor?.name,
          contractor?.company,
          ...(i.lines || []).flatMap((line: any) => [
            line.type,
            line.desc,
            line.description,
          ]),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query);
        });
      return sortInvoices(
        filtered,
        sortKey,
        sortDirection,
        contractorId => {
          const contractor = getUser(contractorId);
          return contractor?.company || contractor?.name || "";
        },
      );
    },
    [controller, currentContractorId, getUser, invTab, invoices, isManager, search, sortDirection, sortKey]
  );
  return (
    <>
          {/* ═════ INVOICES ═════ */}
          {page === "invoices" && !selectedInvoice && (
            <div style={{ animation: "fadeUp 0.3s" }}>
              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 14, marginBottom: 18, flexWrap: "wrap" }}>
                <div className="mobile-tabs invoice-tabs" style={{ display: "flex", gap: 0, borderBottom: `2px solid ${T.borderSoft}` }}>
                  {invoiceTabs.map(t => (
                    <button key={t.id} onClick={() => setInvTab(t.id)} style={{ padding: "10px 20px", fontSize: 13, fontWeight: invTab === t.id ? 700 : 400, color: invTab === t.id ? T.ink : T.subtle, background: "none", border: "none", borderBottom: invTab === t.id ? `2px solid ${T.ink}` : "2px solid transparent", cursor: "pointer", fontFamily: "inherit", marginBottom: -2 }}>
                      <span className="tab-full-label">{t.l}</span>
                      <span className="tab-short-label" style={{ display: "none" }}>{t.m}</span>
                    </button>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flex: "1 1 360px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <select
                      value={sortKey}
                      onChange={(event) => {
                        const next = event.target.value as InvoiceSortKey;
                        setSortKey(next);
                        setSortDirection(next === "recent" || next === "date" ? "desc" : "asc");
                      }}
                      aria-label="Sort invoices by"
                      style={{ minHeight: 38, padding: "8px 28px 8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontFamily: "inherit", fontSize: 12 }}
                    >
                      {sortOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                    </select>
                    <button
                      type="button"
                      onClick={() => setSortDirection(direction => direction === "asc" ? "desc" : "asc")}
                      aria-label={`Sort ${sortDirection === "asc" ? "descending" : "ascending"}`}
                      title={sortDirection === "asc" ? "Ascending" : "Descending"}
                      className="btn-soft"
                      style={{ minWidth: 38, minHeight: 38, padding: "7px 10px", fontSize: 15 }}
                    >
                      {sortDirection === "asc" ? "↑" : "↓"}
                    </button>
                  </div>
                  <label style={{ position: "relative", flex: "1 1 220px", maxWidth: 340 }}>
                    <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", display: "flex", color: T.subtle, pointerEvents: "none" }}>
                      <Ico d="M21 21l-4.35-4.35M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0z" size={15} color="currentColor" />
                    </span>
                    <input
                      type="search"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search invoices"
                      aria-label="Search contractor invoices"
                      style={{ width: "100%", minHeight: 38, padding: "8px 12px 8px 34px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontFamily: "inherit", fontSize: 12 }}
                    />
                  </label>
                </div>
              </div>
              <div className="desktop-only-table">
              <div className="card table-scroll" style={{ overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: T.surfaceSoft }}>
                      {tableHeaders.map(header => (
                        <th
                          key={header.key}
                          aria-sort={sortKey === header.key ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
                          style={{ textAlign: header.align || "left", padding: 0, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, borderBottom: `1px solid ${T.borderSoft}` }}
                        >
                          <button
                            type="button"
                            onClick={() => chooseSort(header.key)}
                            style={{ width: "100%", padding: "12px 14px", display: "flex", justifyContent: header.align === "right" ? "flex-end" : "flex-start", alignItems: "center", gap: 5, border: "none", background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", fontWeight: "inherit", textTransform: "inherit", letterSpacing: "inherit" }}
                          >
                            {header.label}
                            {sortKey === header.key && <span aria-hidden="true">{sortDirection === "asc" ? "↑" : "↓"}</span>}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleInvoices.map(inv => (
                      <tr key={inv.id} onClick={() => setSelectedInvoice(inv.id)} style={{ borderBottom: `1px solid ${T.borderSoft}`, cursor: "pointer" }}>
                        <td className="mono" style={{ padding: "13px 14px", fontWeight: 600, fontSize: 11, color: T.accent }}>#{inv.num}</td>
                        <td style={{ padding: "13px 14px" }}>
                          <span className="mono" style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: T.muted }}>
                            {inv.wot}
                            {inv.wot && <CopyWorkOrderButton value={inv.wot} />}
                          </span>
                        </td>
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
                {visibleInvoices.length === 0 && (
                  <div style={{ textAlign: "center", padding: "40px 20px", color: T.subtle, fontSize: 13 }}>
                    {search ? "No invoices match your search." : "No invoices found"}
                  </div>
                )}
              </div>
              </div>
              <div className="mobile-only-cards responsive-card-grid">
                {visibleInvoices.map((inv: any) => (
                  <div
                    className="mobile-card"
                    key={inv.id}
                    onClick={() => setSelectedInvoice(inv.id)}
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
                        WO: <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "monospace", color: T.accent }}>
                          {inv.wot}
                          {inv.wot && <CopyWorkOrderButton value={inv.wot} />}
                        </span>
                      </span>
                      <span style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 700, color: T.ink }}>
                        {fmt(Math.round(inv.total))}
                      </span>
                    </div>
                  </div>
                ))}
                {visibleInvoices.length === 0 && (
                  <div style={{ textAlign: "center", padding: "40px 20px", color: T.subtle, fontSize: 13 }}>
                    {search ? "No invoices match your search." : "No invoices found"}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ═════ INVOICE DETAIL (editorial receipt view) ═════ */}

    </>
  );
}
