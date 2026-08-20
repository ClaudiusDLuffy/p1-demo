"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

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
const CONTROLLER_EXPORT_QUEUE_KEY = ["controller-export-queue"] as const;

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
  const fallbackCount = canExport
    ? invoices.filter(invoice =>
        (invoice.invoiceType || "contractor") === "contractor"
        && invoice.state === "approved",
      ).length
    : 0;
  const queueQuery = useQuery({
    queryKey: CONTROLLER_EXPORT_QUEUE_KEY,
    queryFn: async () => {
      const response = await controllerExportRequest("/api/controller-exports");
      const payload = await response.json().catch(() => ({})) as {
        count?: number;
        limit?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "Could not load the export queue");
      return {
        count: Number(payload.count || 0),
        limit: Number(payload.limit || MAX_CONTROLLER_EXPORT_INVOICES),
      };
    },
    enabled: canExport,
    staleTime: 30_000,
  });
  const approvedCount = queueQuery.data?.count ?? fallbackCount;
  const exportLimit = queueQuery.data?.limit ?? MAX_CONTROLLER_EXPORT_INVOICES;
  const overLimit = approvedCount > exportLimit;

  if (!canExport) return null;

  const downloadAll = async () => {
    if (approvedCount === 0 || overLimit || busy) return;
    setBusy(true);
    setError(null);

    try {
      const response = await controllerExportRequest("/api/controller-exports", {
        method: "POST",
        body: JSON.stringify({}),
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
        queryClient.invalidateQueries({ queryKey: CONTROLLER_EXPORT_QUEUE_KEY }),
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
            {approvedCount} approved invoice{approvedCount === 1 ? "" : "s"} waiting. One ZIP includes every source PDF and one consolidated QuickBooks CSV.
          </div>
        </div>
        <button
          type="button"
          className="btn-primary"
          onClick={downloadAll}
          disabled={busy || approvedCount === 0 || overLimit || queueQuery.isLoading}
          style={{ display: "flex", alignItems: "center", gap: 7, opacity: busy || approvedCount === 0 || overLimit || queueQuery.isLoading ? 0.55 : 1 }}
        >
          {busy ? <><BtnSpinner />Building package…</> : "Download All + send to QuickBooks"}
        </button>
      </div>
      <div style={{ fontSize: 10, color: T.subtle, marginTop: 8 }}>
        Invoice states change only after the archive is safely stored. A failed package leaves every invoice Approved.
      </div>
      {overLimit && (
        <div role="alert" style={{ fontSize: 11, color: T.danger, marginTop: 8 }}>
          This queue exceeds the safe {exportLimit}-invoice archive limit. Contact an administrator before exporting; no invoice has been changed.
        </div>
      )}
      {error && (
        <div role="alert" style={{ fontSize: 11, color: T.danger, marginTop: 8 }}>
          {error}
        </div>
      )}
      {!error && queueQuery.error && (
        <div role="alert" style={{ fontSize: 11, color: T.danger, marginTop: 8 }}>
          {queueQuery.error instanceof Error ? queueQuery.error.message : "Could not load the export queue"}
        </div>
      )}
    </section>
  );
}
