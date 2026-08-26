"use client";
// @ts-nocheck

import { useDeferredValue, useMemo, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { Ico } from "../../components/ui/Ico";
import { T, INV_STATE, STAFF_INV_STATE } from "../../lib/constants";
import {
  type InvoiceSortKey,
  type SortDirection,
} from "../../lib/invoiceSort";
import { isInvoiceController } from "../../lib/staffPermissions";
import { useCursorBuckets } from "../../lib/useCursorPagination";
import { useInvoicesPageQuery } from "../invoices/queries";
import { useWorkOrdersPageQuery } from "../work-orders/queries";
import BillingTaxRulePanel from "./BillingTaxRulePanel";
import { useBillingInvoicePageQuery } from "./queries";

const BILLING_PAGE_KEYS = [
  "ready",
  "all",
  "draft",
  "submitted",
  "sent",
  "recently_approved",
] as const;

function BillingDocumentBadge({ invoice }: { invoice: any }) {
  if (invoice.documentKind === "capital_quote") {
    return (
      <span style={{ padding: "3px 7px", borderRadius: 999, color: T.violet, background: T.violetSoft, fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.35 }}>
        Capital quote
      </span>
    );
  }
  if (invoice.sourceCapitalQuoteId) {
    return (
      <span style={{ padding: "3px 7px", borderRadius: 999, color: T.violet, background: T.violetSoft, fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.35 }}>
        Capital final
      </span>
    );
  }
  return null;
}

function BillingInvoiceRows({
  invoices,
  contractorBucket,
  sourceOwnerById,
  onOpen,
  canOpen,
  fmt,
  emptyMessage,
}: any) {
  return (
    <>
      <div className="desktop-only-table">
        <div className="table-scroll" style={{ overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: T.surfaceSoft }}>
                {["Invoice #", "Date", "Work Order", "Store", "Territory", "Amount", "Status"].map(header => (
                  <th
                    key={header}
                    style={{
                      textAlign: header === "Amount" ? "right" : "left",
                      padding: "12px 14px",
                      fontSize: 10,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: 0.8,
                      color: T.subtle,
                      borderBottom: `1px solid ${T.borderSoft}`,
                    }}
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice: any) => (
                <tr
                  key={invoice.id}
                  onClick={() => onOpen(invoice)}
                  style={{
                    borderBottom: `1px solid ${T.borderSoft}`,
                    cursor: canOpen(invoice) ? "pointer" : "default",
                  }}
                >
                  <td className="mono" style={{ padding: "13px 14px", fontWeight: 600, color: T.accent }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                      #{invoice.num}
                      <BillingDocumentBadge invoice={invoice} />
                    </span>
                  </td>
                  <td style={{ padding: "13px 14px", color: T.subtle }}>{invoice.date || invoice.invoiceDate}</td>
                  <td style={{ padding: "13px 14px", color: invoice.wot ? T.muted : T.subtle }}>
                    <div className="mono" style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      {invoice.wot || "Standalone"}
                      {invoice.wot && <CopyWorkOrderButton value={invoice.wot} />}
                    </div>
                    {(invoice.sourceInvoices || []).length > 0 && (
                      <div style={{ fontSize: 10, color: T.subtle, marginTop: 3 }}>
                        {invoice.sourceInvoices.length} contractor invoice{invoice.sourceInvoices.length === 1 ? "" : "s"}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: "13px 14px" }}>{invoice.store ? `#${invoice.store}` : "-"}</td>
                  <td style={{ padding: "13px 14px", color: invoice.territory ? T.ink : T.subtle }}>{invoice.territory || "-"}</td>
                  <td className="mono" style={{ padding: "13px 14px", textAlign: "right", fontWeight: 700 }}>{fmt(Math.round(invoice.total || 0))}</td>
                  <td style={{ padding: "13px 14px" }}>
                    <Badge conf={contractorBucket ? INV_STATE.approved : STAFF_INV_STATE[invoice.state]} small />
                    {contractorBucket && sourceOwnerById.has(invoice.id) && (
                      <div style={{ fontSize: 9, color: T.subtle, marginTop: 4 }}>Already in Billing</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mobile-only-cards responsive-card-grid" style={{ padding: invoices.length ? "10px 12px 2px" : 0 }}>
        {invoices.map((invoice: any) => (
          <div
            key={invoice.id}
            className="mobile-card"
            onClick={() => onOpen(invoice)}
            style={{
              background: "#fff",
              borderRadius: 12,
              border: `1px solid ${T.borderSoft}`,
              padding: "14px 16px",
              marginBottom: 10,
              cursor: canOpen(invoice) ? "pointer" : "default",
              boxShadow: "0 1px 3px rgba(31,30,28,0.06)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: T.accent }}>#{invoice.num}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <BillingDocumentBadge invoice={invoice} />
                <Badge conf={contractorBucket ? INV_STATE.approved : STAFF_INV_STATE[invoice.state]} small />
              </span>
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: T.ink, marginBottom: 4 }}>
              Store #{invoice.store || "-"}
              {invoice.date ? <span style={{ fontWeight: 400, color: T.muted, fontSize: 11, marginLeft: 8 }}>{invoice.date}</span> : null}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, paddingTop: 8, borderTop: `1px solid ${T.borderSoft}` }}>
              <span style={{ fontSize: 11, color: T.muted }}>
                WO: <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 4, color: invoice.wot ? T.accent : T.subtle }}>
                  {invoice.wot || "Standalone"}
                  {invoice.wot && <CopyWorkOrderButton value={invoice.wot} />}
                </span>
                {contractorBucket && sourceOwnerById.has(invoice.id) && <span> / already in Billing</span>}
              </span>
              <span className="mono" style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>{fmt(Math.round(invoice.total || 0))}</span>
            </div>
          </div>
        ))}
      </div>

      {invoices.length === 0 && (
        <div style={{ textAlign: "center", padding: "26px 20px", color: T.subtle, fontSize: 12 }}>
          {emptyMessage}
        </div>
      )}
    </>
  );
}

export default function BillingInvoiceList(props: any) {
  const {
    page,
    currentUser,
    invoices = [],
    readyWorkOrders = [],
    setSelectedBillingInvoice,
    onCreate,
    onCreateFromApproved,
    onCreateFromWorkOrder,
    onOpenReadyInvoice,
    fmt,
    fire,
  } = props;
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<InvoiceSortKey>("invoice");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    ready: true,
    all: true,
    draft: false,
    submitted: true,
    sent: false,
    recently_approved: false,
  });
  const controller = isInvoiceController(currentUser);
  const deferredSearch = useDeferredValue(search.trim());
  const staffSort = sortKey === "status" ? "status" : "invoice";
  const pagingSignature = JSON.stringify({
    search: deferredSearch,
    direction: sortDirection,
    sort: staffSort,
  });
  const {
    positions,
    previous: previousBucketPage,
    next: nextBucketPage,
  } = useCursorBuckets(pagingSignature, BILLING_PAGE_KEYS);
  const queryEnabled = page === "billing";
  const allQuery = useBillingInvoicePageQuery({ queue: "all", search: deferredSearch, sort: staffSort, direction: sortDirection, limit: 20, cursor: positions.all.cursor }, queryEnabled);
  const draftQuery = useBillingInvoicePageQuery({ queue: "draft", search: deferredSearch, sort: staffSort, direction: sortDirection, limit: 20, cursor: positions.draft.cursor }, queryEnabled);
  const submittedQuery = useBillingInvoicePageQuery({ queue: "submitted", search: deferredSearch, sort: staffSort, direction: sortDirection, limit: 20, cursor: positions.submitted.cursor }, queryEnabled);
  const sentQuery = useBillingInvoicePageQuery({ queue: "sent", search: deferredSearch, sort: staffSort, direction: sortDirection, limit: 20, cursor: positions.sent.cursor }, queryEnabled);
  const approvedQuery = useInvoicesPageQuery({ state: "approved", search: deferredSearch, sort: staffSort, direction: sortDirection, limit: 20, cursor: positions.recently_approved.cursor }, queryEnabled);
  const readyQuery = useWorkOrdersPageQuery({ scope: "ready_to_bill", search: deferredSearch, sort: "newest", limit: 20, cursor: positions.ready.cursor }, queryEnabled && !controller);

  const sourceOwnerById = useMemo(() => {
    const owners = new Map<string, any>();
    for (const invoice of invoices) {
      for (const sourceId of invoice.sourceInvoiceIds || []) owners.set(sourceId, invoice);
    }
    for (const invoice of (approvedQuery.data?.items || []) as any[]) {
      if (invoice.sourceStaffInvoiceId) {
        owners.set(invoice.id, { id: invoice.sourceStaffInvoiceId });
      }
    }
    return owners;
  }, [approvedQuery.data?.items, invoices]);

  const buckets = useMemo(() => [
    { id: "all", label: "All", description: "P1 billing documents still being prepared or waiting to be sent.", color: "#2563EB", kind: "staff", query: allQuery },
    { id: "draft", label: "Drafts", description: "Billing documents that still need to be completed.", color: "#6B7280", kind: "staff", query: draftQuery },
    { id: "submitted", label: "Please send to 7-Eleven", description: "Completed billing documents waiting for the 7-Eleven submission step.", color: "#B8478A", kind: "staff", query: submittedQuery },
    { id: "sent", label: "Sent to 7-Eleven", description: "Finished submissions, retained here without cluttering All.", color: "#2F7D4A", kind: "staff", query: sentQuery },
    { id: "recently_approved", label: "Recently Approved", description: "Approved contractor invoices available as sources for P1 billing.", color: "#B86B32", kind: "contractor", query: approvedQuery },
  ], [allQuery, approvedQuery, draftQuery, sentQuery, submittedQuery]);
  const visibleReadyWorkOrders = useMemo(() => {
    const localById = new Map<string, any>(readyWorkOrders.map((workOrder: any) => [workOrder.id, workOrder]));
    const finalInvoiceByWorkOrder = new Map<string, any>();
    for (const invoice of invoices) {
      if (!invoice.wot || invoice.documentKind === "capital_quote") continue;
      finalInvoiceByWorkOrder.set(invoice.wot, invoice);
    }
    return (readyQuery.data?.items || []).map((workOrder: any) => ({
      ...(localById.get(workOrder.id) || {}),
      ...workOrder,
      billingInvoice: finalInvoiceByWorkOrder.get(workOrder.id)
        || localById.get(workOrder.id)?.billingInvoice
        || (workOrder.billingInvoiceId ? { id: workOrder.billingInvoiceId } : null)
        || null,
    }));
  }, [invoices, readyQuery.data?.items, readyWorkOrders]);

  const openInvoice = (invoice: any, contractorBucket: boolean) => {
    if (!contractorBucket) {
      setSelectedBillingInvoice(invoice.id);
      return;
    }
    const existingBillingInvoice = sourceOwnerById.get(invoice.id);
    if (existingBillingInvoice) {
      setSelectedBillingInvoice(existingBillingInvoice.id);
      return;
    }
    if (!controller) onCreateFromApproved?.(invoice);
  };
  const canOpenInvoice = (invoice: any, contractorBucket: boolean) =>
    !contractorBucket || sourceOwnerById.has(invoice.id) || !controller;

  if (page !== "billing") return null;

  return (
    <div style={{ animation: "fadeUp 0.25s" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 850, color: T.ink }}>Billing queues</div>
          <div style={{ marginTop: 4, fontSize: 11, color: T.muted }}>
            Search and work each queue without mixing completed 7-Eleven submissions into active billing.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "1 1 520px", justifyContent: "flex-end", flexWrap: "wrap" }}>
          <label style={{ position: "relative", flex: "1 1 230px", maxWidth: 360 }}>
            <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", display: "flex", color: T.subtle, pointerEvents: "none" }}>
              <Ico d="M21 21l-4.35-4.35M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0z" size={15} color="currentColor" />
            </span>
            <input
              type="search"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Search invoices and Ready to Bill"
              aria-label="Search billing invoices and work orders"
              style={{ width: "100%", minHeight: 38, padding: "8px 12px 8px 34px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontFamily: "inherit", fontSize: 12 }}
            />
          </label>
          <select
            value={sortKey}
            onChange={event => setSortKey(event.target.value as InvoiceSortKey)}
            aria-label="Sort billing invoices"
            style={{ minHeight: 38, padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontFamily: "inherit", fontSize: 12 }}
          >
            <option value="invoice">Invoice number</option>
            <option value="status">Status</option>
          </select>
          <button
            type="button"
            className="btn-soft"
            onClick={() => setSortDirection(direction => direction === "asc" ? "desc" : "asc")}
            aria-label={`Sort ${sortDirection === "asc" ? "descending" : "ascending"}`}
          >
            {sortDirection === "asc" ? "A → Z" : "Z → A"}
          </button>
          {!controller && <button onClick={onCreate} className="btn-primary billing-create-button">+ Create Invoice</button>}
        </div>
      </div>

      <BillingTaxRulePanel enabled={!controller} fire={fire} />

      <div style={{ display: "grid", gap: 12 }}>
        {!controller && (readyQuery.isPending || (readyQuery.data?.totalCount || 0) > 0 || Boolean(deferredSearch)) && (
          <article className="card" style={{ overflow: "hidden" }}>
            <button
              type="button"
              aria-expanded={expanded.ready !== false}
              aria-controls="billing-bucket-ready"
              onClick={() => setExpanded(current => ({ ...current, ready: current.ready === false }))}
              style={{ width: "100%", border: 0, background: T.surface, padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <span aria-hidden="true" style={{ color: T.accent, fontSize: 18, transform: expanded.ready !== false ? "rotate(90deg)" : "none" }}>›</span>
                <span>
                  <span style={{ display: "block", color: T.ink, fontSize: 13, fontWeight: 800 }}>Ready to Bill</span>
                  <span style={{ display: "block", color: T.subtle, fontSize: 10, marginTop: 3 }}>Every work order pending 7-Eleven submission, including legacy rows.</span>
                </span>
              </span>
              <span style={{ minWidth: 28, height: 24, padding: "0 8px", borderRadius: 999, background: T.accentSoft, color: T.accent, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 850 }}>
                {readyQuery.data?.totalCount || 0}
              </span>
            </button>
            {expanded.ready !== false && (
              <div id="billing-bucket-ready" style={{ borderTop: `1px solid ${T.borderSoft}` }}>
                {visibleReadyWorkOrders.map((workOrder: any, index: number) => (
                  <div
                    key={workOrder.id}
                    className="billing-ready-row"
                    style={{ display: "grid", gridTemplateColumns: "minmax(160px, 1fr) minmax(120px, 1fr) minmax(160px, 2fr) auto", alignItems: "center", gap: 14, padding: "12px 14px", borderBottom: index === visibleReadyWorkOrders.length - 1 ? "none" : `1px solid ${T.borderSoft}` }}
                  >
                    <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: T.accent, fontSize: 11, fontWeight: 700 }}>
                      {workOrder.id}<CopyWorkOrderButton value={workOrder.id} />
                    </span>
                    <span style={{ color: T.ink, fontSize: 12 }}>Store #{workOrder.store || "-"}</span>
                    <span style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
                      {workOrder.billingOnly && (
                        <span style={{ flex: "0 0 auto", padding: "3px 7px", borderRadius: 999, background: "#FEF3C7", color: "#92400E", fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.35 }}>
                          Billing only · no dispatch
                        </span>
                      )}
                      <span style={{ minWidth: 0, color: T.muted, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {workOrder.summary || "Ready for P1 billing"}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => workOrder.billingInvoice
                        ? onOpenReadyInvoice?.(workOrder.billingInvoice)
                        : onCreateFromWorkOrder?.(workOrder)}
                    >
                      {workOrder.billingInvoice ? "Open invoice" : "Create invoice"}
                    </button>
                  </div>
                ))}
                {visibleReadyWorkOrders.length === 0 && (
                  <div style={{ textAlign: "center", padding: "26px 20px", color: T.subtle, fontSize: 12 }}>
                    No Ready to Bill work orders match your search.
                  </div>
                )}
                <div style={{ padding: "10px 14px", borderTop: `1px solid ${T.borderSoft}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10, color: T.subtle }}>
                    {readyQuery.isFetching ? "Loading..." : `${readyQuery.data?.totalCount || 0} work order${readyQuery.data?.totalCount === 1 ? "" : "s"} · page ${positions.ready.page}`}
                  </span>
                  <div style={{ display: "flex", gap: 7 }}>
                    <button type="button" className="btn-soft" disabled={positions.ready.page <= 1 || readyQuery.isFetching} onClick={() => previousBucketPage("ready")} style={{ padding: "6px 9px", fontSize: 10 }}>Previous</button>
                    <button type="button" className="btn-soft" disabled={!readyQuery.data?.hasMore || readyQuery.isFetching} onClick={() => nextBucketPage("ready", readyQuery.data?.nextCursor || null)} style={{ padding: "6px 9px", fontSize: 10 }}>Next</button>
                  </div>
                </div>
                {readyQuery.isError && (
                  <div role="alert" style={{ padding: "10px 14px", color: T.danger, background: T.dangerSoft, fontSize: 11 }}>
                    Ready to Bill could not be loaded. Refresh and try again.
                  </div>
                )}
              </div>
            )}
          </article>
        )}

        {buckets.map(bucket => {
          const bucketId = bucket.id as keyof typeof positions;
          const isExpanded = expanded[bucket.id] !== false;
          const contractorBucket = bucket.kind === "contractor";
          const invoiceRows = bucket.query.data?.items || [];
          const totalCount = bucket.query.data?.totalCount || 0;
          const position = positions[bucketId];
          return (
            <article key={bucket.id} className="card" style={{ overflow: "hidden" }}>
              <button
                type="button"
                aria-expanded={isExpanded}
                aria-controls={`billing-bucket-${bucket.id}`}
                onClick={() => setExpanded(current => ({ ...current, [bucket.id]: !isExpanded }))}
                style={{ width: "100%", border: 0, background: T.surface, padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <span aria-hidden="true" style={{ color: bucket.color, fontSize: 18, transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>›</span>
                  <span>
                    <span style={{ display: "block", color: T.ink, fontSize: 13, fontWeight: 800 }}>{bucket.label}</span>
                    <span style={{ display: "block", color: T.subtle, fontSize: 10, marginTop: 3 }}>{bucket.description}</span>
                  </span>
                </span>
                <span style={{ minWidth: 28, height: 24, padding: "0 8px", borderRadius: 999, background: `${bucket.color}18`, color: bucket.color, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 850 }}>
                  {totalCount}
                </span>
              </button>
              {isExpanded && (
                <div id={`billing-bucket-${bucket.id}`} style={{ borderTop: `1px solid ${T.borderSoft}` }}>
                  <BillingInvoiceRows
                    invoices={invoiceRows}
                    contractorBucket={contractorBucket}
                    sourceOwnerById={sourceOwnerById}
                    onOpen={(invoice: any) => openInvoice(invoice, contractorBucket)}
                    canOpen={(invoice: any) => canOpenInvoice(invoice, contractorBucket)}
                    fmt={fmt}
                    emptyMessage={search ? "No billing records in this queue match your search." : "Nothing is waiting in this queue."}
                  />
                  <div style={{ padding: "10px 14px", borderTop: `1px solid ${T.borderSoft}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 10, color: T.subtle }}>
                      {bucket.query.isFetching ? "Loading..." : `${totalCount} record${totalCount === 1 ? "" : "s"} · page ${position.page}`}
                    </span>
                    <div style={{ display: "flex", gap: 7 }}>
                      <button
                        type="button"
                        className="btn-soft"
                        disabled={position.page <= 1 || bucket.query.isFetching}
                        onClick={() => previousBucketPage(bucketId)}
                        style={{ padding: "6px 9px", fontSize: 10 }}
                      >Previous</button>
                      <button
                        type="button"
                        className="btn-soft"
                        disabled={!bucket.query.data?.hasMore || bucket.query.isFetching}
                        onClick={() => nextBucketPage(
                          bucketId,
                          bucket.query.data?.nextCursor || null,
                        )}
                        style={{ padding: "6px 9px", fontSize: 10 }}
                      >Next</button>
                    </div>
                  </div>
                  {bucket.query.isError && (
                    <div role="alert" style={{ padding: "10px 14px", color: T.danger, background: T.dangerSoft, fontSize: 11 }}>
                      This billing queue could not be loaded. Refresh and try again.
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
