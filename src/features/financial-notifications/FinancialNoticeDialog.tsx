"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { Modal } from "../../components/ui/Modal";
import { useUnsavedChangesGuard } from "../../lib/forms/useUnsavedChangesGuard";
import { reconcileFinancialNotice } from "./api";
import { FINANCIAL_NOTICE_REASON_LIMIT, safeNoticeError, type NoticeAction, type NoticeActionResult,
  type FinancialNotice, type NoticeOperation } from "./contracts";

type Props = {
  delivery: FinancialNotice;
  action: NoticeAction;
  onClose: () => void;
  onCommitted: (result: NoticeActionResult) => void;
  onConflict: () => void;
};

export default function FinancialNoticeDialog({ delivery, action, onClose, onCommitted, onConflict }: Props) {
  const id = useId();
  const reasonInput = useRef<HTMLTextAreaElement>(null);
  const submitLock = useRef(false);
  const operation = useRef<NoticeOperation | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const resend = action === "resend";
  const historyNote = action === "history_note";
  const title = resend ? "Confirm notification resend" : historyNote ? "Add historical review note" : "Record contact another way";

  const dismissal = useUnsavedChangesGuard({ dirty: reason.length > 0 || confirmed, busy,
    onClose: () => { if (!submitLock.current) onClose(); } });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitLock.current || conflicted) return;
    if (!reason.trim() || reason.trim().length > FINANCIAL_NOTICE_REASON_LIMIT || !confirmed) {
      setError("Enter a reason and confirm this action.");
      return;
    }
    submitLock.current = true;
    setBusy(true);
    setError(null);
    // Preserve both the UUID and normalized payload after an unconfirmed response.
    operation.current ??= { deliveryId: delivery.id, eventId: delivery.eventId,
      operationId: crypto.randomUUID(), reason: reason.trim() };
    try {
      const result = await reconcileFinancialNotice(action, operation.current);
      onCommitted(result);
      onClose();
    } catch (cause) {
      const failure = safeNoticeError(cause);
      setError(failure.message);
      setUncertain(failure.uncertain);
      if (!failure.uncertain) {
        setConflicted(true);
        onConflict();
      }
    } finally {
      submitLock.current = false;
      setBusy(false);
    }
  }

  return <><Modal title={title} description="Review the notification state and confirm the intended action."
    onRequestClose={dismissal.requestClose} dismissDisabled={busy} initialFocusRef={reasonInput} width={540}>
    <form onSubmit={event => { void submit(event); }}>
      <p>Intended recipient: {delivery.recipientLabel || "Contact identity unavailable"}</p>
      <p id={`${id}-guidance`}>
        {historyNote ? delivery.state === "unknown"
          ? "A later hold change superseded this notice. Delivery could not be confirmed and the recipient may already have received this email. This note records historical review only: it does not change the original outcome, claim contact, or authorize a resend."
          : "A later hold change made this notice no longer required. This note records historical review only. It does not claim that email was sent or that the recipient was contacted, and it does not authorize a resend."
          : resend && delivery.state === "unknown"
          ? "Delivery could not be confirmed and the recipient may already have received the email. Resending can create a duplicate message. Enter a reason to continue."
          : resend ? "This queues a new notification attempt for the same eligible recipient. The original delivery history will be preserved."
            : "Record that you contacted the recipient by telephone or another method. This does not mark the email as sent."}
      </p>
      <label htmlFor={`${id}-reason`}>{resend ? "Reason for resend" : historyNote ? "Historical review note" : "Contact note"} (required, up to 500 characters)</label>
      <textarea ref={reasonInput} id={`${id}-reason`} required maxLength={FINANCIAL_NOTICE_REASON_LIMIT} rows={4}
        aria-describedby={`${id}-guidance${error ? ` ${id}-error` : ""}`} aria-invalid={Boolean(error)}
        disabled={busy || uncertain || conflicted} value={reason}
        onChange={event => { setReason(event.target.value); setConfirmed(false); setError(null); }}
        style={{ display: "block", width: "100%", margin: "8px 0 16px", padding: 8 }} />
      <label style={{ display: "flex", gap: 8, alignItems: "start" }}>
        <input type="checkbox" checked={confirmed} disabled={busy || uncertain || conflicted}
          onChange={event => setConfirmed(event.target.checked)} />
        {historyNote ? "I confirm this note documents historical review only and does not authorize another email."
          : resend ? "I confirm that a new email attempt should be queued, including the risk of duplicate delivery."
          : "I confirm that the recipient was contacted another way."}
      </label>
      {error && <p id={`${id}-error`} role="alert">{error}</p>}
      {uncertain && <p>The original reason and request identity are locked for a safe retry. Cancelling does not undo a request that may have succeeded; review the status before starting another action.</p>}
      {conflicted && <p>Close this dialog and review the refreshed invoice and delivery status.</p>}
      <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
        <button type="button" className="btn-soft" disabled={busy} onClick={() => dismissal.requestClose("cancel_button")}>Cancel</button>
        <button type="submit" className="btn-primary"
          style={resend ? { background: "#9f1239", border: "1px solid #881337" } : undefined}
          disabled={busy || conflicted || !reason.trim() || !confirmed}>
          {busy ? "Saving…" : uncertain ? "Retry same request" : resend ? "Confirm resend" : historyNote ? "Save historical note" : "Confirm contact"}
        </button>
      </div>
      <span role="status" aria-live="polite">{busy ? "Saving your confirmed action." : ""}</span>
    </form>
  </Modal>{dismissal.dialog}</>;
}
