"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { Modal } from "../../components/ui/Modal";
import { useUnsavedChangesGuard } from "../../lib/forms/useUnsavedChangesGuard";
import { reconcilePartsSms } from "./api";
import { PARTS_SMS_REASON_LIMIT, PARTS_SMS_UNKNOWN_WARNING, safePartsSmsError, type PartsSmsAction,
  type PartsSmsActionResult, type PartsSmsDelivery, type PartsSmsOperation } from "./contracts";

type Props = { delivery: PartsSmsDelivery; action: PartsSmsAction; onClose: () => void;
  onCommitted: (result: PartsSmsActionResult) => void; onConflict: () => void };
export default function PartsSmsDialog({ delivery, action, onClose, onCommitted, onConflict }: Props) {
  const id = useId();
  const reasonInput = useRef<HTMLTextAreaElement>(null);
  const lock = useRef(false);
  const operation = useRef<PartsSmsOperation | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const resend = action === "resend";
  const dismissal = useUnsavedChangesGuard({ dirty: reason.length > 0 || confirmed, busy,
    onClose: () => { if (!lock.current) onClose(); } });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current || conflicted) return;
    if (!reason.trim() || reason.trim().length > PARTS_SMS_REASON_LIMIT || !confirmed) { setError("Enter a reason and confirm the action."); return; }
    lock.current = true; setBusy(true); setError(null);
    try {
      operation.current ??= { deliveryId: delivery.id, operationId: crypto.randomUUID(), reason: reason.trim() };
      const result = await reconcilePartsSms(action, operation.current); onCommitted(result); onClose();
    }
    catch (cause) {
      const failure = safePartsSmsError(cause);
      setError(failure.message); setUncertain(failure.uncertain);
      if (!failure.uncertain) { setConflicted(true); onConflict(); }
    } finally { lock.current = false; setBusy(false); }
  }
  return <><Modal title={resend ? "Confirm parts SMS resend" : "Record contact another way"}
    description="Review the parts alert state and confirm the intended action."
    onRequestClose={dismissal.requestClose} dismissDisabled={busy} initialFocusRef={reasonInput} width={540}>
    <form onSubmit={event => { void submit(event); }}>
      <p>{delivery.recipientName || "Configured staff recipient"} · {delivery.localDate}</p>
      <p id={`${id}-guidance`}>{resend && delivery.state === "unknown" ? PARTS_SMS_UNKNOWN_WARNING
        : resend ? "Queue a new attempt only for the currently eligible parts and recipient. Original attempts are preserved."
          : "Record that the communication was resolved by telephone or another method. This does not mark the SMS as sent or delivered."}</p>
      <label htmlFor={`${id}-reason`}>{resend ? "Reason for resend" : "Contact note"} (required, up to 500 characters)</label>
      <textarea ref={reasonInput} id={`${id}-reason`} required maxLength={PARTS_SMS_REASON_LIMIT} rows={4}
        disabled={busy || uncertain || conflicted} value={reason} aria-invalid={Boolean(error)}
        aria-describedby={`${id}-guidance${error ? ` ${id}-error` : ""}`}
        onChange={event => { setReason(event.target.value); setConfirmed(false); setError(null); }}
        style={{ display: "block", width: "100%", margin: "8px 0 16px", padding: 8 }} />
      <label style={{ display: "flex", gap: 8 }}><input type="checkbox" checked={confirmed}
        disabled={busy || uncertain || conflicted} onChange={event => setConfirmed(event.target.checked)} />
        {resend ? "I confirm a new SMS attempt, including the risk of duplicate delivery." : "I confirm the communication was resolved outside SMS."}</label>
      {error && <p id={`${id}-error`} role="alert">{error}</p>}
      {uncertain && <p>The original reason and request identity are locked for a safe retry. Cancelling does not undo an action that may have succeeded. Review its status before starting another request.</p>}
      {conflicted && <p>Close this dialog and review the refreshed parts alert before taking another action.</p>}
      <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
        <button type="button" className="btn-soft" onClick={() => dismissal.requestClose("cancel_button")} disabled={busy}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={busy || conflicted || !reason.trim() || !confirmed}
          style={resend ? { background: "#9f1239", border: "1px solid #881337" } : undefined}>
          {busy ? "Saving…" : uncertain ? "Retry same request" : resend ? "Confirm resend" : "Confirm contact"}</button>
      </div>
      <span role="status" aria-live="polite">{busy ? "Saving your confirmed action." : ""}</span>
    </form>
  </Modal>{dismissal.dialog}</>;
}
