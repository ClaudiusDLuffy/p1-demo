"use client";

import { useRef, useState } from "react";
import { Modal } from "../../components/ui/Modal";
import { useUnsavedChangesGuard } from "../../lib/forms/useUnsavedChangesGuard";

/** Restricted guided entry to the existing snapshot-guarded no-invoice command. */
export function CloseOutNoInvoiceModal({ workOrderId, onClose, onConfirm }: {
  workOrderId: string; onClose(): void; onConfirm(): Promise<boolean>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const dismissal = useUnsavedChangesGuard({ dirty: confirmed, busy, scopeKey: workOrderId, onClose });
  async function save() {
    if (sending.current) return;
    if (!confirmed) { setError("Confirm finished work and that no billing is required anywhere."); return; }
    sending.current = true; setBusy(true); setError("");
    try {
      if (await onConfirm()) onClose();
      else setError("Closure was not confirmed. Refresh and review the work order before trying again.");
    } catch { setError("Closure was not confirmed. Refresh and review the work order before trying again."); }
    finally { sending.current = false; setBusy(false); }
  }
  return <><Modal title="Close without billing" description={workOrderId} width={500} dismissDisabled={busy} onRequestClose={dismissal.requestClose}>
    <div className="space-y-4">
      <p className="text-sm">This records that no invoice is needed. It must not be used when billing was recorded externally or under another WO. A confirmed no-invoice closure is recorded in the existing audit history.</p>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy}
        onChange={event => { setConfirmed(event.target.checked); setError(""); }} />
        <span>I confirm field work is finished, no invoices exist, and no billing is required or recorded anywhere for this work.</span></label>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div className="flex justify-end gap-2"><button type="button" className="btn-soft" disabled={busy} onClick={() => dismissal.requestClose("cancel_button")}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? "Closing..." : "Confirm no billing and close"}</button></div>
    </div>
  </Modal>{dismissal.dialog}</>;
}
