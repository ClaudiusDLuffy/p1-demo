"use client";
// @ts-nocheck

import { Badge } from "../../components/ui/Badge";
import { BtnSpinner } from "../../components/ui/BtnSpinner";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { Ico } from "../../components/ui/Ico";
import { Modal } from "../../components/ui/Modal";
import { T, INV_STATE } from "../../lib/constants";
import { canEditRejectedContractorInvoice } from "../../lib/invoicePermissions";
import { InvoiceSortKey, SortDirection } from "../../lib/invoiceSort";
import {
  canHandoffQuickBooks,
  isInvoiceController,
} from "../../lib/staffPermissions";
import ControllerExportPanel from "./ControllerExportPanel";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useCursorPagination } from "../../lib/useCursorPagination";
import { canonicalSevenElevenWorkOrderId } from "../../lib/workOrderIdentity";
import { useInvoicesPageQuery } from "./queries";

type InvoiceWorkOrderIdentity = {
  wot?: string | null;
  externalWorkOrderId?: string | null;
};

function InvoiceWorkOrderReference({
  invoice,
}: {
  invoice: InvoiceWorkOrderIdentity;
}) {
  const portalWorkOrderId = String(invoice?.wot || "").trim();
  const externalWorkOrderId = canonicalSevenElevenWorkOrderId({
    id: portalWorkOrderId,
    duplicateRootWorkOrderId: invoice?.externalWorkOrderId,
  });
  const portalReassignmentReference = externalWorkOrderId !== portalWorkOrderId
    ? portalWorkOrderId
    : null;

  if (!externalWorkOrderId) return <span style={{ color: T.subtle }}>-</span>;
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
      <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: T.muted }}>
        {externalWorkOrderId}
        <CopyWorkOrderButton value={externalWorkOrderId} />
      </span>
      {portalReassignmentReference && (
        <span className="mono" style={{ fontSize: 9, color: T.subtle }}>
          P1 portal reassignment: {portalReassignmentReference}
        </span>
      )}
    </span>
  );
}

export default function InvoiceList(props: any) {
  const { page, selectedInvoice, invTab, setInvTab, isManager, invoices, currentUser, setSelectedInvoice, getUser, fmt, doBatchReviewInvoices, onEditRejected } = props;
  const controller = isInvoiceController(currentUser);
  const canBatchReview = isManager && !controller && !!doBatchReviewInvoices;
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<InvoiceSortKey>("recent");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [selectedReviewIds, setSelectedReviewIds] = useState<Set<string>>(() => new Set());
  const [selectedHandoffIds, setSelectedHandoffIds] = useState<Set<string>>(() => new Set());
  const [batchDialog, setBatchDialog] = useState<"approve" | "reject" | null>(null);
  const [batchReason, setBatchReason] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const invoiceTabs = [
    { id: "all", l: "All", m: "All" },
    { id: "draft", l: "Draft", m: "Draft" },
    { id: "submitted", l: "Submitted", m: "Sub" },
    { id: "revised", l: "Revised", m: "Rev" },
    { id: "rejected", l: "Rejected", m: "Rej" },
    { id: "approved", l: "Approved", m: "Appr" },
    { id: "paid", l: "Entered in QuickBooks", m: "In QuickBooks" },
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
  const deferredSearch = useDeferredValue(search.trim());
  const pagingSignature = JSON.stringify({
    search: deferredSearch,
    state: invTab || "all",
    sort: sortKey,
    direction: sortDirection,
  });
  const {
    position: pagePosition,
    previous: previousPage,
    next: nextPage,
  } = useCursorPagination(pagingSignature);
  const invoicePageQuery = useInvoicesPageQuery({
    state: invTab || "all",
    search: deferredSearch,
    sort: sortKey,
    direction: sortDirection,
    limit: 25,
    cursor: pagePosition.cursor,
  }, page === "invoices" && !selectedInvoice);
  const visibleInvoices: any[] = useMemo(
    () => (invoicePageQuery.data?.items || []) as any[],
    [invoicePageQuery.data?.items],
  );
  const handoffSelectionMode = canHandoffQuickBooks(currentUser)
    && invTab === "approved";
  const handoffSelectableInvoices = useMemo(
    () => handoffSelectionMode
      ? visibleInvoices.filter(invoice =>
          invoice.state === "approved"
          && (invoice.invoiceType || "contractor") === "contractor"
          && !invoice.qboSyncedAt
          && !invoice.paymentHoldAt,
        )
      : [],
    [handoffSelectionMode, visibleInvoices],
  );
  const handoffSelectableIdSet = useMemo(
    () => new Set<string>(handoffSelectableInvoices.map(invoice => String(invoice.id))),
    [handoffSelectableInvoices],
  );
  const selectedVisibleHandoffInvoices = useMemo(
    () => handoffSelectableInvoices.filter(invoice => selectedHandoffIds.has(String(invoice.id))),
    [handoffSelectableInvoices, selectedHandoffIds],
  );
  const allVisibleHandoffSelected = handoffSelectableInvoices.length > 0
    && handoffSelectableInvoices.every(invoice => selectedHandoffIds.has(String(invoice.id)));
  const selectedHandoffInvoiceIds = useMemo(
    () => [...selectedHandoffIds],
    [selectedHandoffIds],
  );

  const reviewableInvoices = useMemo(
    () => canBatchReview
      ? visibleInvoices.filter((invoice: any) =>
          invoice.state === "submitted" || invoice.state === "revised",
        )
      : [],
    [canBatchReview, visibleInvoices],
  );
  const reviewableIdSet = useMemo(
    () => new Set<string>(reviewableInvoices.map((invoice: any) => String(invoice.id))),
    [reviewableInvoices],
  );
  const selectedReviewInvoices = useMemo(
    () => reviewableInvoices.filter((invoice: any) => selectedReviewIds.has(String(invoice.id))),
    [reviewableInvoices, selectedReviewIds],
  );
  const allVisibleReviewableSelected = reviewableInvoices.length > 0
    && reviewableInvoices.slice(0, 100).every((invoice: any) => selectedReviewIds.has(String(invoice.id)));

  useEffect(() => {
    setSelectedReviewIds(previous => {
      const next = new Set(
        [...previous].filter(invoiceId => reviewableIdSet.has(invoiceId)),
      );
      if (next.size === previous.size
          && [...next].every(invoiceId => previous.has(invoiceId))) {
        return previous;
      }
      return next;
    });
  }, [reviewableIdSet]);

  const toggleReviewSelection = (invoiceId: string) => {
    if (!reviewableIdSet.has(invoiceId)) return;
    setSelectedReviewIds(previous => {
      const next = new Set(previous);
      if (next.has(invoiceId)) next.delete(invoiceId);
      else if (next.size < 100) next.add(invoiceId);
      return next;
    });
  };

  const toggleAllVisibleReviewable = () => {
    setSelectedReviewIds(() => {
      if (allVisibleReviewableSelected) return new Set();
      return new Set(
        reviewableInvoices.slice(0, 100).map((invoice: any) => String(invoice.id)),
      );
    });
  };

  const toggleHandoffSelection = (invoiceId: string) => {
    if (!handoffSelectableIdSet.has(invoiceId)) return;
    setSelectedHandoffIds(previous => {
      const next = new Set(previous);
      if (next.has(invoiceId)) next.delete(invoiceId);
      else if (next.size < 500) next.add(invoiceId);
      return next;
    });
  };

  const toggleAllVisibleHandoff = () => {
    setSelectedHandoffIds(previous => {
      const next = new Set(previous);
      if (allVisibleHandoffSelected) {
        handoffSelectableInvoices.forEach(invoice => next.delete(String(invoice.id)));
        return next;
      }
      for (const invoice of handoffSelectableInvoices) {
        if (next.size >= 500) break;
        next.add(String(invoice.id));
      }
      return next;
    });
  };

  const closeBatchDialog = () => {
    if (batchBusy) return;
    setBatchDialog(null);
    setBatchReason("");
  };

  const submitBatchReview = async () => {
    if (!batchDialog || selectedReviewInvoices.length === 0) return;
    if (batchDialog === "reject" && !batchReason.trim()) return;
    setBatchBusy(true);
    try {
      const ok = await doBatchReviewInvoices(
        selectedReviewInvoices.map((invoice: any) => String(invoice.id)),
        batchDialog,
        batchReason,
      );
      if (ok) {
        setSelectedReviewIds(new Set());
        setBatchDialog(null);
        setBatchReason("");
      }
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <>
          {/* ═════ INVOICES ═════ */}
          {page === "invoices" && !selectedInvoice && (
            <div style={{ animation: "fadeUp 0.3s" }}>
              <ControllerExportPanel
                invoices={invoices}
                currentUser={currentUser}
                selectedInvoiceIds={selectedHandoffInvoiceIds}
                onClearSelected={() => setSelectedHandoffIds(new Set())}
              />
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
              {canBatchReview && selectedReviewInvoices.length > 0 && (
                <div
                  className="card"
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "11px 14px", marginBottom: 14, flexWrap: "wrap", borderColor: `${T.accent}44`, background: T.accentSoft }}
                >
                  <div style={{ fontSize: 12, color: T.ink }}>
                    <strong>{selectedReviewInvoices.length}</strong> reviewable invoice{selectedReviewInvoices.length === 1 ? "" : "s"} selected
                    {reviewableInvoices.length > 100 && <span style={{ color: T.muted }}> · maximum 100 per batch</span>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <button type="button" className="btn-soft" onClick={() => setSelectedReviewIds(new Set())}>Clear</button>
                    <button type="button" className="btn-primary" onClick={() => setBatchDialog("approve")}>Approve selected</button>
                    <button type="button" className="btn-soft" onClick={() => setBatchDialog("reject")} style={{ color: T.danger, borderColor: `${T.danger}44` }}>Reject selected</button>
                  </div>
                </div>
              )}
              <div className="desktop-only-table">
              <div className="card table-scroll" style={{ overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: T.surfaceSoft }}>
                      {(canBatchReview || handoffSelectionMode) && (
                        <th style={{ width: 42, padding: "12px 10px", textAlign: "center", borderBottom: `1px solid ${T.borderSoft}` }}>
                          <input
                            ref={(element: HTMLInputElement | null) => {
                              if (element) {
                                element.indeterminate = handoffSelectionMode
                                  ? selectedVisibleHandoffInvoices.length > 0 && !allVisibleHandoffSelected
                                  : selectedReviewInvoices.length > 0 && !allVisibleReviewableSelected;
                              }
                            }}
                            type="checkbox"
                            checked={handoffSelectionMode ? allVisibleHandoffSelected : allVisibleReviewableSelected}
                            disabled={handoffSelectionMode ? handoffSelectableInvoices.length === 0 : reviewableInvoices.length === 0}
                            onChange={handoffSelectionMode ? toggleAllVisibleHandoff : toggleAllVisibleReviewable}
                            aria-label={handoffSelectionMode
                              ? "Select all visible approved contractor bills for payables handoff"
                              : "Select all visible submitted and revised invoices"}
                            title={handoffSelectionMode ? "Select approved contractor bills for payables handoff" : "Select reviewable invoices"}
                            style={{ width: 16, height: 16, accentColor: T.accent, cursor: (handoffSelectionMode ? handoffSelectableInvoices.length : reviewableInvoices.length) ? "pointer" : "default" }}
                          />
                        </th>
                      )}
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
                    {visibleInvoices.map(inv => {
                      const reviewable = reviewableIdSet.has(String(inv.id));
                      const handoffSelectable = handoffSelectableIdSet.has(String(inv.id));
                      const selectedForCurrentAction = handoffSelectionMode
                        ? selectedHandoffIds.has(String(inv.id))
                        : selectedReviewIds.has(String(inv.id));
                      return (
                      <tr key={inv.id} onClick={() => setSelectedInvoice(inv.id)} style={{ borderBottom: `1px solid ${T.borderSoft}`, cursor: "pointer", background: selectedForCurrentAction ? T.accentSoft : undefined }}>
                        {(canBatchReview || handoffSelectionMode) && (
                          <td onClick={(event) => event.stopPropagation()} style={{ width: 42, padding: "13px 10px", textAlign: "center" }}>
                            {(handoffSelectionMode ? handoffSelectable : reviewable) && (
                              <input
                                type="checkbox"
                                checked={handoffSelectionMode
                                  ? selectedHandoffIds.has(String(inv.id))
                                  : selectedReviewIds.has(String(inv.id))}
                                onChange={() => handoffSelectionMode
                                  ? toggleHandoffSelection(String(inv.id))
                                  : toggleReviewSelection(String(inv.id))}
                                aria-label={handoffSelectionMode
                                  ? `Select contractor bill ${inv.num} for payables handoff`
                                  : `Select invoice ${inv.num} for batch review`}
                                style={{ width: 16, height: 16, accentColor: T.accent, cursor: "pointer" }}
                              />
                            )}
                          </td>
                        )}
                        <td className="mono" style={{ padding: "13px 14px", fontWeight: 600, fontSize: 11, color: T.accent }}>#{inv.num}</td>
                        <td style={{ padding: "13px 14px" }}>
                          <InvoiceWorkOrderReference invoice={inv} />
                        </td>
                        {isManager && <td style={{ padding: "13px 14px", color: T.inkSoft }}>{getUser(inv.contractor)?.name}</td>}
                        <td style={{ padding: "13px 14px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                            <Badge conf={INV_STATE[inv.state]} small />
                            {canEditRejectedContractorInvoice(inv, currentUser, isManager) && onEditRejected && (
                              <button
                                type="button"
                                className="btn-accent"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onEditRejected(inv);
                                }}
                                style={{ padding: "5px 8px", fontSize: 10 }}
                              >
                                Edit and resubmit
                              </button>
                            )}
                          </div>
                        </td>
                        <td style={{ padding: "13px 14px", color: T.subtle }}>{inv.date}</td>
                        <td style={{ padding: "13px 14px" }}>#{inv.store}</td>
                        <td className="mono" style={{ padding: "13px 14px", textAlign: "right", color: T.muted }}>{(inv.lines || []).length}</td>
                        <td className="mono" style={{ padding: "13px 14px", textAlign: "right", fontWeight: 700 }}>{fmt(Math.round(inv.total))}</td>
                      </tr>
                      );
                    })}
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
                      border: `1px solid ${(handoffSelectionMode ? selectedHandoffIds : selectedReviewIds).has(String(inv.id)) ? T.accent : T.borderSoft}`,
                      padding: "14px 16px",
                      marginBottom: 10,
                      cursor: "pointer",
                      boxShadow: "0 1px 3px rgba(31,30,28,0.06)",
                    }}
                  >
                    <div className="mobile-card-top" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
                        {((handoffSelectionMode && handoffSelectableIdSet.has(String(inv.id)))
                          || (!handoffSelectionMode && canBatchReview && reviewableIdSet.has(String(inv.id)))) && (
                          <input
                            type="checkbox"
                            checked={handoffSelectionMode
                              ? selectedHandoffIds.has(String(inv.id))
                              : selectedReviewIds.has(String(inv.id))}
                            onClick={(event) => event.stopPropagation()}
                            onChange={() => handoffSelectionMode
                              ? toggleHandoffSelection(String(inv.id))
                              : toggleReviewSelection(String(inv.id))}
                            aria-label={handoffSelectionMode
                              ? `Select contractor bill ${inv.num} for payables handoff`
                              : `Select invoice ${inv.num} for batch review`}
                            style={{ width: 18, height: 18, accentColor: T.accent, cursor: "pointer" }}
                          />
                        )}
                        <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 600, color: T.accent }}>#{inv.num}</span>
                      </span>
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
                        WO: <InvoiceWorkOrderReference invoice={inv} />
                      </span>
                      <span style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 700, color: T.ink }}>
                        {fmt(Math.round(inv.total))}
                      </span>
                    </div>
                    {canEditRejectedContractorInvoice(inv, currentUser, isManager) && onEditRejected && (
                      <button
                        type="button"
                        className="btn-accent"
                        onClick={(event) => {
                          event.stopPropagation();
                          onEditRejected(inv);
                        }}
                        style={{ width: "100%", justifyContent: "center", marginTop: 10 }}
                      >
                        Edit and resubmit
                      </button>
                    )}
                  </div>
                ))}
                {visibleInvoices.length === 0 && (
                  <div style={{ textAlign: "center", padding: "40px 20px", color: T.subtle, fontSize: 13 }}>
                    {search ? "No invoices match your search." : "No invoices found"}
                  </div>
                )}
              </div>

              <div style={{ marginTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: T.muted }}>
                  {invoicePageQuery.isFetching
                    ? "Loading invoices..."
                    : `${invoicePageQuery.data?.totalCount || 0} invoice${invoicePageQuery.data?.totalCount === 1 ? "" : "s"} · page ${pagePosition.page}`}
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="btn-soft"
                    disabled={pagePosition.page <= 1 || invoicePageQuery.isFetching}
                    onClick={previousPage}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    className="btn-soft"
                    disabled={!invoicePageQuery.data?.hasMore || invoicePageQuery.isFetching}
                    onClick={() => nextPage(invoicePageQuery.data?.nextCursor || null)}
                  >
                    Next
                  </button>
                </div>
              </div>
              {invoicePageQuery.isError && (
                <div role="alert" style={{ marginTop: 10, padding: 10, borderRadius: 8, background: T.dangerSoft, color: T.danger, fontSize: 11 }}>
                  Invoices could not be loaded. Refresh and try again.
                </div>
              )}

              {batchDialog === "approve" && (
                <Modal onClose={closeBatchDialog} title={`Approve ${selectedReviewInvoices.length} invoices`} width={480}>
                  <div style={{ fontSize: 13, color: T.muted, marginBottom: 12, lineHeight: 1.55 }}>
                    Approve all selected Submitted/Revised invoices in one transaction? If any invoice has changed or cannot be reviewed, none will be approved.
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: T.inkSoft, background: T.surfaceSoft, borderRadius: 9, padding: 10, marginBottom: 18, lineHeight: 1.6 }}>
                    {selectedReviewInvoices.slice(0, 8).map((invoice: any) => `#${invoice.num}`).join(", ")}
                    {selectedReviewInvoices.length > 8 ? ` +${selectedReviewInvoices.length - 8} more` : ""}
                  </div>
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button type="button" onClick={closeBatchDialog} disabled={batchBusy} className="btn-soft">Cancel</button>
                    <button type="button" onClick={submitBatchReview} disabled={batchBusy} className="btn-primary" style={{ display: "flex", alignItems: "center", gap: 6, opacity: batchBusy ? 0.7 : 1 }}>
                      {batchBusy ? <><BtnSpinner />Approving...</> : `Approve ${selectedReviewInvoices.length}`}
                    </button>
                  </div>
                </Modal>
              )}

              {batchDialog === "reject" && (
                <Modal onClose={closeBatchDialog} title={`Reject ${selectedReviewInvoices.length} invoices`} width={500}>
                  <div style={{ fontSize: 13, color: T.muted, marginBottom: 12, lineHeight: 1.55 }}>
                    The same reason will be recorded on every selected invoice and sent to each affected contractor. If any invoice cannot be rejected, the entire batch is rolled back.
                  </div>
                  <label style={{ fontSize: 11, fontWeight: 700, color: T.subtle, textTransform: "uppercase", letterSpacing: 0.6, display: "block", marginBottom: 6 }}>Shared rejection reason</label>
                  <textarea
                    rows={4}
                    value={batchReason}
                    onChange={(event) => setBatchReason(event.target.value)}
                    placeholder="e.g. Missing receipts or labor-hour details"
                    style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit", background: T.surface, color: T.ink, resize: "vertical", boxSizing: "border-box", outline: "none" }}
                  />
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                    <button type="button" onClick={closeBatchDialog} disabled={batchBusy} className="btn-soft">Cancel</button>
                    <button
                      type="button"
                      onClick={submitBatchReview}
                      disabled={batchBusy || !batchReason.trim()}
                      style={{ padding: "10px 18px", borderRadius: 10, background: T.danger, color: "#fff", border: "none", cursor: batchBusy || !batchReason.trim() ? "default" : "pointer", fontWeight: 600, fontSize: 12, fontFamily: "inherit", opacity: batchBusy || !batchReason.trim() ? 0.5 : 1, display: "flex", alignItems: "center", gap: 6 }}
                    >
                      {batchBusy ? <><BtnSpinner />Rejecting...</> : `Reject ${selectedReviewInvoices.length}`}
                    </button>
                  </div>
                </Modal>
              )}
            </div>
          )}

          {/* ═════ INVOICE DETAIL (editorial receipt view) ═════ */}

    </>
  );
}
