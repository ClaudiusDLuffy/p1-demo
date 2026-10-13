"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal } from "../../components/ui/Modal";
import { useUnsavedChangesGuard } from "../../lib/forms/useUnsavedChangesGuard";
import { canRecordExternalBilling } from "../billing/externalBillingContracts";
import { useDirectoryActor } from "../directory/queries";
import { createRecordedBillingCloseOutAttempt, recordedBillingCloseOutError, runRecordedBillingCloseOutAttempt,
  type RecordedBillingEvidence, type RecordedBillingReceipt } from "./recordedBillingCloseOut";

export function RecordedBillingCloseOutModal({ evidence, onClose }: { evidence: RecordedBillingEvidence; onClose(): void }) {
  const actor = useDirectoryActor(); const qc = useQueryClient();
  const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false); const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<RecordedBillingReceipt | null>(null);
  const sending = useRef(false); const attempt = useRef<ReturnType<typeof createRecordedBillingCloseOutAttempt> | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dismissal = useUnsavedChangesGuard({ dirty: !receipt && confirmed, busy, scopeKey: evidence.workOrderId, onClose });
  async function save() {
    if (sending.current || receipt || !canRecordExternalBilling(actor)) return;
    if (!confirmed) { setError("Confirm that the job is finished and the existing billing covers all current work."); return; }
    sending.current = true; setBusy(true); setError("");
    try {
      attempt.current ??= createRecordedBillingCloseOutAttempt(evidence, confirmed);
      const saved = await runRecordedBillingCloseOutAttempt(attempt.current);
      if (!mounted.current) return;
      setReceipt(saved); setUncertain(false);
      void qc.invalidateQueries({ predicate: query => /^(work-order|billing|portal-navigation|invoice|recorded-billing)/.test(String(query.queryKey[0])) }).catch(() => undefined);
    } catch (cause) {
      if (!mounted.current) return;
      const safe = recordedBillingCloseOutError(cause); setError(safe.message); setUncertain(safe.uncertain);
      // A known rejection requires reopening and a new evidence snapshot.
    } finally { sending.current = false; if (mounted.current) setBusy(false); }
  }
  if (!canRecordExternalBilling(actor)) return null;
  return <><Modal title="Close already billed work order" description={evidence.workOrderId} width={520}
    dismissDisabled={busy} onRequestClose={dismissal.requestClose}>
    {receipt ? <div className="space-y-4"><p role="status">Work order closed using the existing recorded billing for invoice #{receipt.invoiceNumber}.</p>
      <p className="text-sm">The invoice and original billing handoff are unchanged. No new invoice, payment, billing submission or CSV export was created.</p>
      <button type="button" className="btn-primary" onClick={onClose}>Done</button></div>
      : <div className="space-y-4">
        <p className="text-sm">P1 invoice #{evidence.invoiceNumber} already has a recorded 7-Eleven billing handoff ({new Date(evidence.billedAt).toLocaleDateString()}). This action only repairs the work order’s open status.</p>
        <p className="text-sm">It does not bill again, create another invoice, record customer payment, or export a CSV.</p>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy || uncertain}
          onChange={event => { setConfirmed(event.target.checked); setError(""); }} />
          <span>I confirm the job is finished, this existing billing covers all current work, and no additional billing is needed.</span></label>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2"><button type="button" className="btn-soft" disabled={busy}
          onClick={() => dismissal.requestClose("cancel_button")}>Cancel</button>
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Closing…" : uncertain ? "Retry same request" : "Confirm already billed and close"}</button></div>
      </div>}
  </Modal>{dismissal.dialog}</>;
}
