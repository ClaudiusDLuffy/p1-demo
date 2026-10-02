"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal } from "../../components/ui/Modal";
import { Input } from "../../components/ui/Input";
import { TA } from "../../components/ui/TA";
import { useUnsavedChangesGuard } from "../../lib/forms/useUnsavedChangesGuard";
import { useWorkOrderByIdQuery } from "../work-orders/queries";
import { createExternalBillingAttempt } from "./externalBillingCommands";
import { externalBillingError, externalBillingFieldsSchema, type ExternalBillingReceipt } from "./externalBillingContracts";
import { runExternalBillingAttempt } from "./externalBillingRepository";

const changedQueryRoots = new Set(["work-orders", "work-order-pages", "work-order-count", "work-order-by-id",
  "work-order-details", "work-order-child-count", "portal-navigation-summary", "contractor-workload-summary", "external-billing"]);

export function ExternalBillingModal({ workOrderId, onClose }: { workOrderId: string; onClose(): void }) {
  const workOrder = useWorkOrderByIdQuery(workOrderId);
  const qc = useQueryClient();
  const fieldId = useId();
  const [fields, setFields] = useState({ billingSystem: "QuickBooks", invoiceReference: "", billedOn: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [receipt, setReceipt] = useState<ExternalBillingReceipt | null>(null);
  const attempt = useRef<ReturnType<typeof createExternalBillingAttempt> | null>(null);
  const sending = useRef(false);
  const dirty = !receipt && (fields.billingSystem !== "QuickBooks" || Boolean(fields.invoiceReference || fields.billedOn || fields.note));
  const dismissal = useUnsavedChangesGuard({ dirty, busy, scopeKey: workOrderId, onClose });

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current || receipt) return;
    const parsed = externalBillingFieldsSchema.safeParse(fields);
    if (!parsed.success) { setError(externalBillingError(parsed.error).message); return; }
    if (!workOrder.data) { setError("Wait for the current work order to load before saving."); return; }
    sending.current = true;
    setBusy(true); setError("");
    try {
      attempt.current ??= createExternalBillingAttempt(workOrder.data, parsed.data);
      const saved = await runExternalBillingAttempt(attempt.current);
      setReceipt(saved); setUncertain(false);
      // A refresh failure must never turn a confirmed save into a false error.
      void qc.invalidateQueries({ predicate: query => changedQueryRoots.has(String(query.queryKey[0])) }).catch(() => undefined);
    } catch (cause) {
      const safe = externalBillingError(cause);
      setError(safe.message); setUncertain(safe.uncertain);
      if (!safe.uncertain) attempt.current = null;
    } finally { sending.current = false; setBusy(false); }
  }

  const setField = (key: keyof typeof fields, value: string) => {
    setFields(current => ({ ...current, [key]: value }));
    setError("");
  };
  const locked = busy || uncertain;
  return <>
    <Modal title="Billed outside the portal" description={workOrderId} width={520}
      dismissDisabled={busy} onRequestClose={dismissal.requestClose}>
      {receipt ? <div className="space-y-4">
        <p role="status">Recorded {receipt.billingSystem} invoice #{receipt.invoiceReference}, billed {receipt.billedOn}. This work order is closed and removed from Ready to Bill.</p>
        <p className="text-sm">No portal invoice was created. The 7-Eleven status and submission records were not changed.</p>
        <button type="button" className="btn-primary" onClick={onClose}>Done</button>
      </div> : <form className="space-y-4" noValidate onSubmit={save}>
        <p className="text-sm">Use this only when the work was already billed in another system. This closes the portal work order without creating another invoice.</p>
        <p className="text-sm">One external invoice may cover several work orders. Record the same reference on each and explain the shared billing in the note. This does not mark anything submitted to 7-Eleven.</p>
        {workOrder.isPending && <p role="status">Loading current work order…</p>}
        {workOrder.isError && <p role="alert">The work order could not be loaded. <button type="button" className="btn-soft" onClick={() => void workOrder.refetch()}>Retry loading</button></p>}
        <fieldset disabled={locked} className="min-w-0 space-y-3 disabled:opacity-70">
          <label className="grid gap-1 text-sm" htmlFor={`${fieldId}-system`}>Billing system (required)
            <Input id={`${fieldId}-system`} className="w-full min-w-0" required maxLength={80}
              value={fields.billingSystem} onChange={event => setField("billingSystem", event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm" htmlFor={`${fieldId}-reference`}>Invoice reference (required)
            <Input id={`${fieldId}-reference`} className="w-full min-w-0" required maxLength={100}
              value={fields.invoiceReference} onChange={event => setField("invoiceReference", event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm" htmlFor={`${fieldId}-date`}>Billing date (required)
            <Input id={`${fieldId}-date`} type="date" className="w-full min-w-0" required
              value={fields.billedOn} onChange={event => setField("billedOn", event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm" htmlFor={`${fieldId}-note`}>Audit note (required)
            <TA id={`${fieldId}-note`} className="w-full min-w-0" rows={3} required minLength={5} maxLength={1000}
              aria-describedby={`${fieldId}-help`} value={fields.note} onChange={event => setField("note", event.target.value)} />
          </label>
          <p id={`${fieldId}-help`} className="text-xs">5–1,000 characters. Include where billing was recorded and any other work orders covered.</p>
        </fieldset>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-soft" disabled={busy} onClick={() => dismissal.requestClose("cancel_button")}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy || !workOrder.data || workOrder.isError}>
            {busy ? "Recording…" : uncertain ? "Retry same request" : "Record external billing and close"}
          </button>
        </div>
      </form>}
    </Modal>
    {dismissal.dialog}
  </>;
}
