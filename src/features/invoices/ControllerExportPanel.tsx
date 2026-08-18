"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { BtnSpinner } from "../../components/ui/BtnSpinner";
import { T } from "../../lib/constants";
import {
  canExportQuickBooks,
  type StaffPermissionProfile,
} from "../../lib/staffPermissions";
import { supabase } from "../../lib/supabase/client";
import { WORK_ORDERS_KEY } from "../work-orders/queries";
import { INVOICES_KEY } from "./queries";

type ControllerInvoice = {
  id: string;
  state?: string | null;
  invoiceType?: string | null;
};

type ErrorPayload = { error?: string };

const MAX_CONTROLLER_EXPORT_INVOICES = 500;

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
  const canExport = canExportQuickBooks(currentUser);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approvedInvoices = useMemo(
    () => canExport
      ? invoices.filter(invoice =>
          (invoice.invoiceType || "contractor") === "contractor"
          && invoice.state === "approved",
        )
      : [],
    [canExport, invoices],
  );
  const overLimit = approvedInvoices.length > MAX_CONTROLLER_EXPORT_INVOICES;

  if (!canExport) return null;

  const downloadAll = async () => {
    if (approvedInvoices.length === 0 || overLimit || busy) return;
    setBusy(true);
    setError(null);

    try {
      const sb = supabase();
      const { data: sessionData } = await sb.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("Your session expired. Sign in again.");

      const response = await fetch("/api/controller-exports", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          invoiceIds: approvedInvoices.map(invoice => invoice.id),
        }),
      });
      if (!response.ok) {
        const payload = await response.json()
          .catch((): ErrorPayload => ({})) as ErrorPayload;
        throw new Error(payload.error || "Controller export failed");
      }

      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") || "";
      const filename = disposition.match(/filename="([^"]+)"/i)?.[1]
        || `QuickBooks-Handoff-${new Date().toISOString().slice(0, 10)}.zip`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 1_000);

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: INVOICES_KEY }),
        queryClient.invalidateQueries({ queryKey: WORK_ORDERS_KEY }),
      ]);
    } catch (downloadError) {
      setError(downloadError instanceof Error
        ? downloadError.message
        : "Controller export failed");
    } finally {
      setBusy(false);
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
            {approvedInvoices.length} approved invoice{approvedInvoices.length === 1 ? "" : "s"} waiting. One ZIP includes every source PDF and one consolidated QuickBooks CSV.
          </div>
        </div>
        <button
          type="button"
          className="btn-primary"
          onClick={downloadAll}
          disabled={busy || approvedInvoices.length === 0 || overLimit}
          style={{ display: "flex", alignItems: "center", gap: 7, opacity: busy || approvedInvoices.length === 0 || overLimit ? 0.55 : 1 }}
        >
          {busy ? <><BtnSpinner />Building package…</> : "Download All + send to QuickBooks"}
        </button>
      </div>
      <div style={{ fontSize: 10, color: T.subtle, marginTop: 8 }}>
        Invoice states change only after the archive is safely stored. A failed package leaves every invoice Approved.
      </div>
      {overLimit && (
        <div role="alert" style={{ fontSize: 11, color: T.danger, marginTop: 8 }}>
          This queue exceeds the safe {MAX_CONTROLLER_EXPORT_INVOICES}-invoice archive limit. Contact an administrator before exporting; no invoice has been changed.
        </div>
      )}
      {error && (
        <div role="alert" style={{ fontSize: 11, color: T.danger, marginTop: 8 }}>
          {error}
        </div>
      )}
    </section>
  );
}
