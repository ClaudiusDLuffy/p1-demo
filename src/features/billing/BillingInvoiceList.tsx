"use client";
// @ts-nocheck

import { useMemo, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { Ico } from "../../components/ui/Ico";
import { T, INV_STATE, STAFF_INV_STATE } from "../../lib/constants";
import {
  sortInvoices,
  type InvoiceSortKey,
  type SortDirection,
} from "../../lib/invoiceSort";
import { isInvoiceController } from "../../lib/staffPermissions";
import {
  billingInvoiceMatchesSearch,
  billingReadyWorkOrderMatchesSearch,
  buildBillingBuckets,
} from "./billingBuckets";

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
    contractorInvoices = [],
    readyWorkOrders = [],
    setSelectedBillingInvoice,
    onCreate,
    onCreateFromApproved,
    onCreateFromWorkOrder,
    onOpenReadyInvoice,
    fmt,
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

  const sourceOwnerById = useMemo(() => {
    const owners = new Map<string, any>();
    for (const invoice of invoices) {
      for (const sourceId of invoice.sourceInvoiceIds || []) owners.set(sourceId, invoice);
    }
    return owners;
  }, [invoices]);

  const unfilteredBuckets = useMemo(
    () => buildBillingBuckets(invoices, contractorInvoices),
    [contractorInvoices, invoices],
  );
  const buckets = useMemo(
    () => unfilteredBuckets.map(bucket => ({
      ...bucket,
      invoices: sortInvoices(
        bucket.invoices.filter(invoice => billingInvoiceMatchesSearch(invoice, search)),
        sortKey,
        sortDirection,
        () => "",
      ),
    })),
    [search, sortDirection, sortKey, unfilteredBuckets],
  );
  const visibleReadyWorkOrders = useMemo(
    () => readyWorkOrders.filter(workOrder => billingReadyWorkOrderMatchesSearch(workOrder, search)),
    [readyWorkOrders, search],
  );

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

      <div style={{ display: "grid", gap: 12 }}>
        {!controller && readyWorkOrders.length > 0 && (
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
                {search ? visibleReadyWorkOrders.length : readyWorkOrders.length}
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
              </div>
            )}
          </article>
        )}

        {buckets.map(bucket => {
          const isExpanded = expanded[bucket.id] !== false;
          const contractorBucket = bucket.kind === "contractor";
          const totalCount = unfilteredBuckets.find(item => item.id === bucket.id)?.invoices.length || 0;
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
                  {search ? bucket.invoices.length : totalCount}
                </span>
              </button>
              {isExpanded && (
                <div id={`billing-bucket-${bucket.id}`} style={{ borderTop: `1px solid ${T.borderSoft}` }}>
                  <BillingInvoiceRows
                    invoices={bucket.invoices}
                    contractorBucket={contractorBucket}
                    sourceOwnerById={sourceOwnerById}
                    onOpen={(invoice: any) => openInvoice(invoice, contractorBucket)}
                    canOpen={(invoice: any) => canOpenInvoice(invoice, contractorBucket)}
                    fmt={fmt}
                    emptyMessage={search ? "No billing records in this queue match your search." : "Nothing is waiting in this queue."}
                  />
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
