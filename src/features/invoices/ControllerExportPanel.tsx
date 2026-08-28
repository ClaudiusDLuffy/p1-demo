"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { BtnSpinner } from "../../components/ui/BtnSpinner";
import { T } from "../../lib/constants";
import {
  canHandoffQuickBooks,
  type StaffPermissionProfile,
} from "../../lib/staffPermissions";
import { supabase } from "../../lib/supabase/client";
import { WORK_ORDERS_KEY } from "../work-orders/queries";
import {
  CONTROLLER_INVOICE_HOLDS_KEY,
  INVOICES_KEY,
} from "./queries";

type ControllerInvoice = {
  id: string;
  state?: string | null;
  invoiceType?: string | null;
};

type ErrorPayload = { error?: string };

type HandoffItem = {
  invoiceId: string;
  invoiceNumber: string;
  workOrderId: string | null;
  contractorName: string;
  total: number;
};

type HandoffBatch = {
  id: string;
  status: "pending" | "confirmed" | "cancelled";
  createdAt: string;
  createdBy: string;
  createdByName: string;
  confirmedAt: string | null;
  confirmedByName: string;
  cancelledAt: string | null;
  cancelledByName: string;
  cancellationReason: string | null;
  invoiceCount: number;
  total: number;
  items: HandoffItem[];
};

type HandoffActor = { id: string; name: string };

type PaymentHold = {
  invoiceId: string;
  invoiceNumber: string;
  workOrderId: string | null;
  contractorName: string;
  total: number;
  holdAt: string;
  holdBy: string;
  holdByName: string;
  reason: string;
};

const MAX_CONTROLLER_EXPORT_INVOICES = 500;
const CONTROLLER_EXPORT_QUEUE_KEY = ["controller-export-queue"] as const;
const CONTROLLER_EXPORT_HISTORY_KEY = "controller-export-history";

async function controllerExportRequest(path: string, init?: RequestInit) {
  const sb = supabase();
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session expired. Sign in again.");
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init?.body) headers.set("Content-Type", "application/json");
  return fetch(path, { ...init, headers });
}

const downloadResponse = async (response: Response, fallbackName: string) => {
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const filename = disposition.match(/filename="([^"]+)"/i)?.[1] || fallbackName;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
};

const dateTime = (value: string | null) => value
  ? new Date(value).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  : "—";

const money = (value: number) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
}).format(Number(value || 0));

const batchStatus = {
  pending: { label: "Awaiting QuickBooks confirmation", color: T.warn, bg: T.warnSoft },
  confirmed: { label: "Confirmed in QuickBooks", color: T.success, bg: T.successSoft },
  cancelled: { label: "Cancelled", color: T.danger, bg: T.dangerSoft },
} as const;

export default function ControllerExportPanel({
  invoices,
  currentUser,
  compact = false,
}: {
  invoices: ControllerInvoice[];
  currentUser: StaffPermissionProfile | null | undefined;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(!compact);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [actor, setActor] = useState("");
  const fallbackCount = invoices.filter(invoice =>
    (invoice.invoiceType || "contractor") === "contractor"
    && invoice.state === "approved",
  ).length;

  const queueQuery = useQuery({
    queryKey: CONTROLLER_EXPORT_QUEUE_KEY,
    queryFn: async () => {
      const response = await controllerExportRequest("/api/controller-exports");
      const payload = await response.json().catch(() => ({})) as {
        count?: number;
        limit?: number;
        pendingCount?: number;
        oldestPendingAt?: string | null;
        canHandoff?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "Could not load the export queue");
      return {
        count: Number(payload.count || 0),
        limit: Number(payload.limit || MAX_CONTROLLER_EXPORT_INVOICES),
        pendingCount: Number(payload.pendingCount || 0),
        oldestPendingAt: payload.oldestPendingAt || null,
        canHandoff: Boolean(payload.canHandoff),
      };
    },
    staleTime: 30_000,
  });

  const historyQuery = useQuery({
    queryKey: [CONTROLLER_EXPORT_HISTORY_KEY, fromDate, toDate, actor],
    queryFn: async () => {
      const params = new URLSearchParams({ history: "1" });
      if (fromDate) params.set("from", fromDate);
      if (toDate) params.set("to", toDate);
      if (actor) params.set("actor", actor);
      const response = await controllerExportRequest(`/api/controller-exports?${params}`);
      const payload = await response.json().catch(() => ({})) as {
        history?: HandoffBatch[];
        actors?: HandoffActor[];
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "Could not load handoff history");
      return {
        history: payload.history || [],
        actors: payload.actors || [],
      };
    },
    enabled: showHistory,
    staleTime: 15_000,
  });

  const holdsQuery = useQuery({
    queryKey: CONTROLLER_INVOICE_HOLDS_KEY,
    queryFn: async () => {
      const response = await controllerExportRequest("/api/contractor-invoice-holds");
      const payload = await response.json().catch(() => ({})) as {
        holds?: PaymentHold[];
        canRelease?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "Could not load payment holds");
      return {
        holds: payload.holds || [],
        canRelease: Boolean(payload.canRelease),
      };
    },
    staleTime: 15_000,
  });

  const approvedCount = queueQuery.data?.count ?? fallbackCount;
  const exportLimit = queueQuery.data?.limit ?? MAX_CONTROLLER_EXPORT_INVOICES;
  const pendingCount = queueQuery.data?.pendingCount ?? 0;
  const oldestPendingAt = queueQuery.data?.oldestPendingAt || null;
  const canHandoff = queueQuery.data?.canHandoff
    ?? canHandoffQuickBooks(currentUser);
  const overLimit = approvedCount > exportLimit;
  const actors = useMemo(() => historyQuery.data?.actors || [], [historyQuery.data?.actors]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: INVOICES_KEY }),
      queryClient.invalidateQueries({ queryKey: WORK_ORDERS_KEY }),
      queryClient.invalidateQueries({ queryKey: CONTROLLER_EXPORT_QUEUE_KEY }),
      queryClient.invalidateQueries({ queryKey: [CONTROLLER_EXPORT_HISTORY_KEY] }),
      queryClient.invalidateQueries({ queryKey: CONTROLLER_INVOICE_HOLDS_KEY }),
    ]);
  };

  const stageAll = async () => {
    if (!canHandoff || approvedCount === 0 || overLimit || busyAction) return;
    setBusyAction("stage");
    setError(null);
    setNotice(null);
    try {
      const response = await controllerExportRequest("/api/controller-exports", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const payload = await response.json().catch((): ErrorPayload => ({}));
        throw new Error(payload.error || "QuickBooks handoff failed");
      }
      const batchId = response.headers.get("x-controller-export-batch") || "";
      await downloadResponse(
        response,
        `QuickBooks-Handoff-${new Date().toISOString().slice(0, 10)}.zip`,
      );
      setNotice(`Batch ${batchId.slice(0, 8)} staged. Invoices remain Approved until the QuickBooks import is confirmed.`);
      setShowHistory(true);
      await refresh();
    } catch (downloadError) {
      setError(downloadError instanceof Error
        ? downloadError.message
        : "QuickBooks handoff failed");
    } finally {
      setBusyAction("");
    }
  };

  const updateBatch = async (batch: HandoffBatch, action: "confirm" | "cancel") => {
    if (!canHandoff || busyAction) return;
    let reason = "";
    if (action === "cancel") {
      reason = window.prompt(
        "Why is this handoff batch being cancelled? The reason is saved in the audit log.",
      )?.trim() || "";
      if (!reason) return;
    }
    setBusyAction(`${action}:${batch.id}`);
    setError(null);
    setNotice(null);
    try {
      const response = await controllerExportRequest("/api/controller-exports", {
        method: "PATCH",
        body: JSON.stringify({ action, batchId: batch.id, reason }),
      });
      const payload = await response.json().catch((): ErrorPayload => ({}));
      if (!response.ok) throw new Error(payload.error || `Could not ${action} batch`);
      setNotice(action === "confirm"
        ? `Batch ${batch.id.slice(0, 8)} confirmed in QuickBooks.`
        : `Batch ${batch.id.slice(0, 8)} cancelled; its approved invoices are available for a new handoff.`);
      await refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : `Could not ${action} batch`);
    } finally {
      setBusyAction("");
    }
  };

  const downloadBatch = async (batch: HandoffBatch) => {
    setBusyAction(`download:${batch.id}`);
    setError(null);
    try {
      const response = await controllerExportRequest(
        `/api/controller-exports?batch=${encodeURIComponent(batch.id)}`,
      );
      if (!response.ok) {
        const payload = await response.json().catch((): ErrorPayload => ({}));
        throw new Error(payload.error || "Stored handoff could not be downloaded");
      }
      await downloadResponse(response, `QuickBooks-Handoff-${batch.id.slice(0, 8)}.zip`);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "Stored handoff could not be downloaded");
    } finally {
      setBusyAction("");
    }
  };

  const releaseHold = async (hold: PaymentHold) => {
    if (!canHandoff || busyAction) return;
    const reason = window.prompt(
      `Why is the payment hold on invoice #${hold.invoiceNumber} being released?`,
    )?.trim() || "";
    if (!reason) return;
    setBusyAction(`release:${hold.invoiceId}`);
    setError(null);
    setNotice(null);
    try {
      const response = await controllerExportRequest("/api/contractor-invoice-holds", {
        method: "PATCH",
        body: JSON.stringify({
          action: "release",
          invoiceId: hold.invoiceId,
          reason,
        }),
      });
      const payload = await response.json().catch((): ErrorPayload => ({}));
      if (!response.ok) throw new Error(payload.error || "Could not release payment hold");
      setNotice(`Payment hold released for invoice #${hold.invoiceNumber}.`);
      await refresh();
    } catch (releaseError) {
      setError(releaseError instanceof Error
        ? releaseError.message
        : "Could not release payment hold");
    } finally {
      setBusyAction("");
    }
  };

  const downloadAudit = async () => {
    setBusyAction("audit");
    setError(null);
    try {
      const params = new URLSearchParams({ history: "1", format: "csv" });
      if (fromDate) params.set("from", fromDate);
      if (toDate) params.set("to", toDate);
      if (actor) params.set("actor", actor);
      const response = await controllerExportRequest(`/api/controller-exports?${params}`);
      if (!response.ok) {
        const payload = await response.json().catch((): ErrorPayload => ({}));
        throw new Error(payload.error || "Audit CSV could not be downloaded");
      }
      await downloadResponse(response, `QuickBooks-Handoff-Audit-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "Audit CSV could not be downloaded");
    } finally {
      setBusyAction("");
    }
  };

  return (
    <section
      aria-label="Accounting QuickBooks handoff"
      className="card"
      style={{
        padding: compact ? 14 : 16,
        marginBottom: 16,
        borderColor: `${T.success}44`,
        background: T.successSoft,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 800, color: T.ink }}>
            Accounting · QuickBooks handoff
          </div>
          <div style={{ fontSize: 11, color: T.muted, marginTop: 4, lineHeight: 1.5 }}>
            {approvedCount} approved invoice{approvedCount === 1 ? "" : "s"} waiting
            {pendingCount > 0 ? ` · ${pendingCount} already staged` : ""}.
            {(holdsQuery.data?.holds.length || 0) > 0
              ? ` ${holdsQuery.data?.holds.length} invoice${holdsQuery.data?.holds.length === 1 ? " is" : "s are"} on payment hold.`
              : ""}
            {canHandoff
              ? " Downloading stages a batch; only confirmation marks it sent."
              : " The queue is visible, but only the accounting handoff owner can stage or confirm it."}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn-soft" onClick={() => setShowHistory(value => !value)}>
            {showHistory ? "Hide audit log" : "View audit log"}
          </button>
          {canHandoff && (
            <button
              type="button"
              className="btn-primary"
              onClick={stageAll}
              disabled={Boolean(busyAction) || approvedCount === 0 || overLimit || queueQuery.isLoading}
              style={{ display: "flex", alignItems: "center", gap: 7, opacity: busyAction || approvedCount === 0 || overLimit || queueQuery.isLoading ? 0.55 : 1 }}
            >
              {busyAction === "stage" ? <><BtnSpinner />Building package…</> : "Download handoff ZIP"}
            </button>
          )}
        </div>
      </div>
      <div style={{ fontSize: 10, color: T.subtle, marginTop: 8 }}>
        A ZIP download never marks invoices paid. Confirm the pending batch only after Emily verifies the QuickBooks import.
      </div>
      {pendingCount > 0 && (
        <div role="alert" style={{ fontSize: 11, color: "#92400E", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "9px 11px", marginTop: 9 }}>
          {pendingCount} staged invoice{pendingCount === 1 ? " is" : "s are"} still awaiting QuickBooks confirmation
          {oldestPendingAt ? ` (oldest: ${dateTime(oldestPendingAt)})` : ""}. Resolve these before the Wednesday contractor-payment run.
        </div>
      )}
      {overLimit && (
        <div role="alert" style={{ fontSize: 11, color: T.danger, marginTop: 8 }}>
          This queue exceeds the safe {exportLimit}-invoice archive limit. Export a selected/smaller batch before continuing.
        </div>
      )}
      {notice && <div role="status" style={{ fontSize: 11, color: T.success, marginTop: 8 }}>{notice}</div>}
      {error && <div role="alert" style={{ fontSize: 11, color: T.danger, marginTop: 8 }}>{error}</div>}
      {!error && queueQuery.error && (
        <div role="alert" style={{ fontSize: 11, color: T.danger, marginTop: 8 }}>
          {queueQuery.error instanceof Error ? queueQuery.error.message : "Could not load the export queue"}
        </div>
      )}

      {(holdsQuery.data?.holds.length || 0) > 0 && (
        <div style={{ marginTop: 14, padding: 12, borderRadius: 10, border: `1px solid ${T.danger}44`, background: T.dangerSoft }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: T.danger, marginBottom: 8 }}>
            Held — do not pay or export
          </div>
          <div style={{ display: "grid", gap: 7 }}>
            {(holdsQuery.data?.holds || []).map(hold => (
              <div key={hold.invoiceId} style={{ display: "grid", gridTemplateColumns: "minmax(85px,.6fr) minmax(90px,.7fr) minmax(140px,1.2fr) minmax(180px,1.6fr) auto", gap: 8, alignItems: "center", fontSize: 10, color: T.muted }}>
                <span className="mono" style={{ color: T.danger, fontWeight: 800 }}>#{hold.invoiceNumber}</span>
                <span className="mono">{hold.workOrderId || "—"}</span>
                <span>{hold.contractorName}</span>
                <span title={hold.reason}>{hold.reason} · {hold.holdByName} · {dateTime(hold.holdAt)}</span>
                <span style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 7 }}>
                  <span className="mono" style={{ color: T.ink }}>{money(hold.total)}</span>
                  {canHandoff && (
                    <button
                      type="button"
                      className="btn-soft"
                      disabled={Boolean(busyAction)}
                      onClick={() => void releaseHold(hold)}
                    >
                      {busyAction === `release:${hold.invoiceId}` ? "Releasing…" : "Release"}
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {holdsQuery.error && (
        <div role="alert" style={{ fontSize: 11, color: T.danger, marginTop: 8 }}>
          {holdsQuery.error instanceof Error ? holdsQuery.error.message : "Could not load payment holds"}
        </div>
      )}

      {showHistory && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${T.border}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "end", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
              <label style={{ fontSize: 10, color: T.muted }}>
                <span style={{ display: "block", marginBottom: 4 }}>From</span>
                <input type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} style={{ padding: "7px 8px", borderRadius: 7, border: `1px solid ${T.border}` }} />
              </label>
              <label style={{ fontSize: 10, color: T.muted }}>
                <span style={{ display: "block", marginBottom: 4 }}>To</span>
                <input type="date" value={toDate} onChange={event => setToDate(event.target.value)} style={{ padding: "7px 8px", borderRadius: 7, border: `1px solid ${T.border}` }} />
              </label>
              <label style={{ fontSize: 10, color: T.muted }}>
                <span style={{ display: "block", marginBottom: 4 }}>Run by</span>
                <select value={actor} onChange={event => setActor(event.target.value)} style={{ minWidth: 170, padding: "7px 8px", borderRadius: 7, border: `1px solid ${T.border}` }}>
                  <option value="">All staff</option>
                  {actors.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
                </select>
              </label>
            </div>
            <button type="button" className="btn-soft" onClick={downloadAudit} disabled={Boolean(busyAction)}>
              {busyAction === "audit" ? "Preparing CSV…" : "Export audit CSV"}
            </button>
          </div>

          {historyQuery.isLoading && <div role="status" style={{ color: T.muted, fontSize: 11 }}>Loading handoff history…</div>}
          {historyQuery.error && (
            <div role="alert" style={{ color: T.danger, fontSize: 11 }}>
              {historyQuery.error instanceof Error ? historyQuery.error.message : "Could not load handoff history"}
            </div>
          )}
          <div style={{ display: "grid", gap: 10 }}>
            {(historyQuery.data?.history || []).map(batch => {
              const status = batchStatus[batch.status] || batchStatus.pending;
              return (
                <article key={batch.id} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span className="mono" style={{ fontSize: 11, fontWeight: 800 }}>Batch {batch.id.slice(0, 8)}</span>
                        <span style={{ padding: "3px 7px", borderRadius: 999, background: status.bg, color: status.color, fontSize: 9, fontWeight: 800 }}>{status.label}</span>
                      </div>
                      <div style={{ color: T.muted, fontSize: 10, marginTop: 5 }}>
                        Run by {batch.createdByName} · {dateTime(batch.createdAt)} · {batch.invoiceCount} invoice{batch.invoiceCount === 1 ? "" : "s"} · {money(batch.total)}
                      </div>
                      {batch.status === "confirmed" && (
                        <div style={{ color: T.success, fontSize: 10, marginTop: 3 }}>
                          Confirmed by {batch.confirmedByName} · {dateTime(batch.confirmedAt)}
                        </div>
                      )}
                      {batch.status === "cancelled" && (
                        <div style={{ color: T.danger, fontSize: 10, marginTop: 3 }}>
                          Cancelled by {batch.cancelledByName} · {dateTime(batch.cancelledAt)} · {batch.cancellationReason}
                        </div>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 7, alignItems: "start", flexWrap: "wrap" }}>
                      {batch.status !== "cancelled" && (
                        <button type="button" className="btn-soft" disabled={Boolean(busyAction)} onClick={() => void downloadBatch(batch)}>
                          {busyAction === `download:${batch.id}` ? "Downloading…" : "Re-download ZIP"}
                        </button>
                      )}
                      {canHandoff && batch.status === "pending" && (
                        <>
                          <button type="button" className="btn-soft" disabled={Boolean(busyAction)} onClick={() => void updateBatch(batch, "cancel")} style={{ color: T.danger }}>Cancel batch</button>
                          <button type="button" className="btn-primary" disabled={Boolean(busyAction)} onClick={() => void updateBatch(batch, "confirm")}>
                            {busyAction === `confirm:${batch.id}` ? "Confirming…" : "Confirm imported"}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <div style={{ display: "grid", gap: 4, marginTop: 10, paddingTop: 9, borderTop: `1px solid ${T.borderSoft}` }}>
                    {batch.items.map(item => (
                      <div key={item.invoiceId} style={{ display: "grid", gridTemplateColumns: "minmax(90px, .7fr) minmax(100px, .8fr) minmax(160px, 1.5fr) auto", gap: 8, fontSize: 10, color: T.muted }}>
                        <span className="mono" style={{ color: T.accent }}>#{item.invoiceNumber}</span>
                        <span className="mono">{item.workOrderId || "—"}</span>
                        <span>{item.contractorName}</span>
                        <span className="mono" style={{ color: T.ink }}>{money(item.total)}</span>
                      </div>
                    ))}
                  </div>
                </article>
              );
            })}
            {!historyQuery.isLoading && !historyQuery.error && (historyQuery.data?.history || []).length === 0 && (
              <div style={{ color: T.subtle, fontSize: 11 }}>No QuickBooks handoff batches match these filters.</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
