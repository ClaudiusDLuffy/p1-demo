"use client";

import { useDeferredValue, useMemo, useState } from "react";

import { Badge } from "../../components/ui/Badge";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { CapitalWorkOrderBadge } from "../../components/ui/CapitalWorkOrderBadge";
import { INV_STATE, PRIORITY, STATUS, T } from "../../lib/constants";
import { useCursorPagination } from "../../lib/useCursorPagination";
import {
  useStaffContractorPreviewInvoicesQuery,
  useStaffContractorPreviewWorkOrdersQuery,
} from "./queries";

type ContractorOption = {
  id: string;
  name?: string | null;
  company?: string | null;
  active?: boolean | null;
  isAssignable?: boolean | null;
};

const money = (value: number | null | undefined) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
    .format(Number(value || 0));

const date = (value: string | null | undefined) => value
  ? new Date(value).toLocaleDateString()
  : "—";

export default function StaffContractorPreview({
  page,
  contractors,
}: {
  page: string;
  contractors: ContractorOption[];
}) {
  const [contractorId, setContractorId] = useState("");
  const [tab, setTab] = useState<"work_orders" | "invoices">("work_orders");
  const [search, setSearch] = useState("");
  const [workOrderScope, setWorkOrderScope] = useState<"active" | "history" | "all">("active");
  const [invoiceState, setInvoiceState] = useState<"all" | "draft" | "submitted" | "revised" | "rejected" | "approved" | "paid">("all");
  const deferredSearch = useDeferredValue(search.trim());
  const options = useMemo(
    () => [...contractors]
      .filter(contractor => contractor.active !== false && contractor.isAssignable !== false)
      .sort((left, right) => String(left.company || left.name || "")
        .localeCompare(String(right.company || right.name || ""))),
    [contractors],
  );
  const selected = options.find(contractor => contractor.id === contractorId) || null;
  const signature = JSON.stringify([
    contractorId,
    tab,
    deferredSearch,
    workOrderScope,
    invoiceState,
  ]);
  const { position, previous, next } = useCursorPagination(signature);
  const visible = page === "contractor_preview";
  const workOrdersQuery = useStaffContractorPreviewWorkOrdersQuery({
    contractorId,
    scope: workOrderScope,
    search: deferredSearch,
    cursor: position.cursor,
    enabled: visible && tab === "work_orders",
  });
  const invoicesQuery = useStaffContractorPreviewInvoicesQuery({
    contractorId,
    state: invoiceState,
    search: deferredSearch,
    cursor: position.cursor,
    enabled: visible && tab === "invoices",
  });
  const activeQuery = tab === "work_orders" ? workOrdersQuery : invoicesQuery;

  if (!visible) return null;

  return (
    <section style={{ animation: "fadeUp 0.3s" }} aria-label="Read-only contractor view">
      <div className="card" role="note" style={{ padding: "14px 16px", marginBottom: 14, background: T.warnSoft, borderColor: "#EED9A6" }}>
        <div style={{ color: T.ink, fontSize: 13, fontWeight: 850 }}>Read-only staff preview — no impersonation</div>
        <div style={{ color: T.muted, fontSize: 11, lineHeight: 1.55, marginTop: 4 }}>
          This is the selected company&apos;s contractor-facing job and invoice projection. It cannot create, edit, approve, delete, dispatch, or submit anything. Internal P1 billing, margins, QuickBooks metadata, and staff-only notes are excluded.
        </div>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
          <label style={{ flex: "1 1 280px" }}>
            <span style={{ display: "block", marginBottom: 5, color: T.muted, fontSize: 10, fontWeight: 750 }}>Contractor company</span>
            <select
              value={contractorId}
              onChange={event => {
                setContractorId(event.target.value);
                setSearch("");
              }}
              style={{ width: "100%", minHeight: 40, padding: "8px 10px", borderRadius: 9, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontFamily: "inherit" }}
            >
              <option value="">Choose a contractor…</option>
              {options.map(contractor => (
                <option key={contractor.id} value={contractor.id}>
                  {contractor.company || contractor.name || contractor.id}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: "1 1 240px" }}>
            <span style={{ display: "block", marginBottom: 5, color: T.muted, fontSize: 10, fontWeight: 750 }}>Search this company</span>
            <input
              type="search"
              value={search}
              onChange={event => setSearch(event.target.value)}
              disabled={!contractorId}
              placeholder={tab === "work_orders" ? "WO#, store, address, summary…" : "Invoice#, WO#, address…"}
              style={{ width: "100%", minHeight: 40, padding: "8px 11px", borderRadius: 9, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontFamily: "inherit" }}
            />
          </label>
        </div>
        {selected && (
          <div style={{ marginTop: 9, color: T.subtle, fontSize: 10 }}>
            Company-level preview for {selected.company || selected.name}. Individual technician assignment scope may be narrower.
          </div>
        )}
      </div>

      {!contractorId ? (
        <div className="card" style={{ padding: 30, color: T.subtle, textAlign: "center" }}>
          Choose a contractor company to inspect its read-only portal view.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" className={tab === "work_orders" ? "btn-primary" : "btn-soft"} onClick={() => setTab("work_orders")}>Work orders</button>
              <button type="button" className={tab === "invoices" ? "btn-primary" : "btn-soft"} onClick={() => setTab("invoices")}>Invoices</button>
            </div>
            {tab === "work_orders" ? (
              <select value={workOrderScope} onChange={event => setWorkOrderScope(event.target.value as typeof workOrderScope)} style={{ minHeight: 36, padding: "7px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink }}>
                <option value="active">Active jobs</option>
                <option value="history">Closed history</option>
                <option value="all">All jobs</option>
              </select>
            ) : (
              <select value={invoiceState} onChange={event => setInvoiceState(event.target.value as typeof invoiceState)} style={{ minHeight: 36, padding: "7px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink }}>
                <option value="all">All invoice states</option>
                <option value="draft">Draft</option>
                <option value="submitted">Submitted</option>
                <option value="revised">Revised</option>
                <option value="rejected">Rejected</option>
                <option value="approved">Approved</option>
                <option value="paid">Sent to QuickBooks</option>
              </select>
            )}
          </div>

          {activeQuery.isLoading && (
            <div className="card" role="status" style={{ padding: 28, color: T.subtle, textAlign: "center" }}>Loading contractor view…</div>
          )}
          {activeQuery.isError && (
            <div className="card" role="alert" style={{ padding: 18, color: T.danger, background: T.dangerSoft }}>
              Could not load the contractor preview. {activeQuery.error instanceof Error ? activeQuery.error.message : "Please retry."}
            </div>
          )}

          {!activeQuery.isLoading && !activeQuery.isError && tab === "work_orders" && (
            <div style={{ display: "grid", gap: 9 }}>
              {(workOrdersQuery.data?.items || []).map(workOrder => (
                <article key={workOrder.id} className="card" style={{ padding: "13px 15px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ minWidth: 0, flex: "1 1 420px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                        <span className="mono" style={{ color: T.accent, fontWeight: 800 }}>{workOrder.id}</span>
                        <CopyWorkOrderButton value={workOrder.id} />
                        <Badge conf={PRIORITY[workOrder.priority as keyof typeof PRIORITY]} small />
                        <Badge conf={STATUS[workOrder.status as keyof typeof STATUS]} small />
                        <CapitalWorkOrderBadge workOrder={workOrder} small />
                      </div>
                      <div style={{ marginTop: 7, color: T.ink, fontSize: 12, fontWeight: 750 }}>
                        Store #{workOrder.store || "—"} · {workOrder.summary || workOrder.description || "No summary"}
                      </div>
                      <div style={{ marginTop: 4, color: T.muted, fontSize: 10, lineHeight: 1.45 }}>
                        {[workOrder.address, workOrder.city, workOrder.state].filter(Boolean).join(", ") || "No store address"}
                        {workOrder.technicianName ? ` · Technician: ${workOrder.technicianName}` : ""}
                      </div>
                    </div>
                    <div style={{ color: T.subtle, fontSize: 10, textAlign: "right" }}>
                      Received {date(workOrder.createdAt)}
                      {workOrder.invoicingCompletedAt && <div style={{ marginTop: 4, color: T.success, fontWeight: 750 }}>Invoicing complete</div>}
                    </div>
                  </div>
                </article>
              ))}
              {(workOrdersQuery.data?.items || []).length === 0 && (
                <div className="card" style={{ padding: 26, color: T.subtle, textAlign: "center" }}>No matching work orders.</div>
              )}
            </div>
          )}

          {!activeQuery.isLoading && !activeQuery.isError && tab === "invoices" && (
            <div style={{ display: "grid", gap: 9 }}>
              {(invoicesQuery.data?.items || []).map(invoice => (
                <article key={invoice.id} className="card" style={{ padding: "13px 15px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ minWidth: 0, flex: "1 1 390px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                        <span className="mono" style={{ color: T.accent, fontWeight: 800 }}>#{invoice.number}</span>
                        <Badge conf={INV_STATE[invoice.state as keyof typeof INV_STATE]} small />
                        {invoice.documentKind === "capital_quote" && <span style={{ color: T.violet, fontSize: 10, fontWeight: 800 }}>Capital quote</span>}
                      </div>
                      <div style={{ marginTop: 7, color: T.ink, fontSize: 11 }}>
                        {invoice.workOrderId || "No work order"} · Invoice date {date(invoice.invoiceDate)}
                      </div>
                      {invoice.rejectionReason && (
                        <div style={{ marginTop: 7, padding: "7px 9px", borderRadius: 7, background: T.dangerSoft, color: T.danger, fontSize: 10 }}>
                          Rejection reason: {invoice.rejectionReason}
                        </div>
                      )}
                    </div>
                    <div style={{ color: T.ink, fontSize: 14, fontWeight: 850 }}>{money(invoice.total)}</div>
                  </div>
                </article>
              ))}
              {(invoicesQuery.data?.items || []).length === 0 && (
                <div className="card" style={{ padding: 26, color: T.subtle, textAlign: "center" }}>No matching invoices.</div>
              )}
            </div>
          )}

          {!activeQuery.isLoading && !activeQuery.isError && (
            <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, color: T.subtle, fontSize: 10 }}>
              <span>Page {position.page}{activeQuery.isFetching ? " · Refreshing…" : ""}</span>
              <span style={{ display: "flex", gap: 7 }}>
                <button type="button" className="btn-soft" disabled={position.page <= 1 || activeQuery.isFetching} onClick={previous}>Previous</button>
                <button type="button" className="btn-soft" disabled={!activeQuery.data?.hasMore || activeQuery.isFetching} onClick={() => next(activeQuery.data?.nextCursor || null)}>Next</button>
              </span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
