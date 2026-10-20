"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal } from "../../components/ui/Modal";
import { useUnsavedChangesGuard } from "../../lib/forms/useUnsavedChangesGuard";
import { supabase } from "../../lib/supabase/client";
import type { Database } from "../../lib/supabase/database.types";
import { uploadInvoicePdf } from "../../lib/db";
import { readInvoiceSummary } from "./invoiceReads";
import { useDirectoryActor } from "../directory/queries";
import { canRecordExternalBilling } from "../billing/externalBillingContracts";
import { createPriorInvoiceDraftAttempt, createPriorInvoiceSubmitAttempt, priorInvoiceContextSchema,
  priorInvoiceError, priorInvoiceFieldsSchema, type PriorInvoiceContext } from "./priorContractorInvoices";

type Draft = PriorInvoiceContext["drafts"][number];
function PriorInvoiceModal({ context, draft, onClose }: { context: PriorInvoiceContext; draft: Draft | null; onClose(): void }) {
  const qc = useQueryClient(); const actor = useDirectoryActor();
  const [assignmentId, setAssignmentId] = useState(draft?.assignmentId ?? "");
  const [num, setNum] = useState(draft?.num ?? ""); const [date, setDate] = useState(draft?.invoiceDate ?? "");
  const [total, setTotal] = useState(draft ? String(draft.total) : "");
  const [tax, setTax] = useState(draft ? String(draft.salesTax) : "0"); const [note, setNote] = useState(draft?.note ?? "");
  const [file, setFile] = useState<File | null>(null); const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false); const [locked, setLocked] = useState(false); const [error, setError] = useState("");
  const [done, setDone] = useState<"draft" | "submitted" | null>(null);
  const intent = useRef<"draft" | "submitted" | null>(null); const sending = useRef(false); const mounted = useRef(true);
  const saveAttempt = useRef<ReturnType<typeof createPriorInvoiceDraftAttempt> | null>(null);
  const submitAttempt = useRef<ReturnType<typeof createPriorInvoiceSubmitAttempt> | null>(null);
  const saved = useRef<{ id: string; invoiceVersion: number } | null>(null); const attached = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dismissal = useUnsavedChangesGuard({ dirty: !done && Boolean(num || date || total || note || file || confirmed), busy,
    scopeKey: `${context.workOrderId}:${draft?.id ?? "new"}`, onClose });
  const invalidate = () => qc.invalidateQueries({ predicate: query => /^(prior-contractor|work-order|invoice|billing|portal-navigation)/.test(String(query.queryKey[0])) });
  async function save(target: "draft" | "submitted") {
    if (sending.current || done || !canRecordExternalBilling(actor)) return;
    if (intent.current && intent.current !== target) return;
    if (!saveAttempt.current) {
      try {
        const fields = priorInvoiceFieldsSchema.parse({ num, invoiceDate: date, total: total.trim() ? Number(total) : NaN,
          salesTax: tax.trim() ? Number(tax) : NaN, note });
        if (file && (file.size === 0 || file.size > 5 * 1024 * 1024 || !/\.pdf$/i.test(file.name))) {
          setError("Choose a non-empty PDF no larger than 5 MB."); return;
        }
        if (target === "submitted" && (!confirmed || (!file && !draft?.hasPdf))) {
          setError("Attach the original invoice PDF and confirm its contractor, amount and assignment before submitting."); return;
        }
        saveAttempt.current = createPriorInvoiceDraftAttempt(context, assignmentId, fields, draft);
        intent.current = target; setLocked(true);
      } catch (cause) { setError(priorInvoiceError(cause).message); return; }
    }
    sending.current = true; setBusy(true); setError("");
    try {
      const transport = <Name extends "save_prior_contractor_invoice_v1" | "submit_prior_contractor_invoice_v1">(
        name: Name, args: Database["public"]["Functions"][Name]["Args"]) => supabase().rpc(name, args);
      if (!saved.current) {
        const receipt = await saveAttempt.current!(transport);
        saved.current = { id: receipt.invoiceId, invoiceVersion: receipt.invoiceVersion };
      }
      if (!mounted.current) return;
      if (file && !attached.current) {
        await uploadInvoicePdf(saved.current.id, num, file); attached.current = true;
      }
      if (!mounted.current) return;
      if (target === "submitted") {
        if (!submitAttempt.current) {
          const current = await readInvoiceSummary(saved.current.id);
          if (!mounted.current) return;
          if (!current || current.workOrderId !== context.workOrderId) throw new Error("Invoice unavailable");
          submitAttempt.current = createPriorInvoiceSubmitAttempt(context, { id: current.id, invoiceVersion: current.invoiceVersion });
        }
        await submitAttempt.current(transport);
      }
      if (mounted.current) setDone(target);
    } catch (cause) {
      if (mounted.current) setError(`${priorInvoiceError(cause).message}${saved.current ? " Your draft is retained; reopen it from Previous contractor invoices if needed." : ""}`);
    } finally {
      sending.current = false;
      void invalidate().catch(() => undefined);
      if (mounted.current) setBusy(false);
    }
  }
  return <><Modal title="Upload previous contractor invoice" description={context.workOrderId} width={600}
    dismissDisabled={busy} onRequestClose={dismissal.requestClose}>
    {done ? <div className="space-y-4"><p role="status">{done === "submitted" ? "Previous contractor invoice submitted for P1 review." : "Previous contractor invoice draft saved."}</p>
      <p className="text-sm">The current contractor, work-order status, customer billing and payment records are unchanged.</p>
      <button type="button" className="btn-primary" onClick={onClose}>Done</button></div>
      : <div className="space-y-4">
        <p className="text-sm">Record the actual bill from a past assignment. This does not reassign the WO, restore contractor access, bill 7-Eleven or mark anything paid.</p>
        <fieldset disabled={busy || locked} className="space-y-3">
          <label className="block text-sm">Previous contractor assignment
            <select aria-label="Previous contractor assignment" className="w-full rounded border p-2" value={assignmentId} disabled={Boolean(draft)} onChange={event => setAssignmentId(event.target.value)}>
              <option value="">Select a past assignment</option>
              {context.assignments.map(assignment => <option key={assignment.id} value={assignment.id}>
                {assignment.contractorName || "Contractor"} · assignment {assignment.assignmentVersion} · ended {new Date(assignment.endedAt).toLocaleDateString()}
              </option>)}
            </select></label>
          <label className="block text-sm">Contractor invoice number<input className="w-full rounded border p-2" value={num} maxLength={100} onChange={event => setNum(event.target.value)} /></label>
          <label className="block text-sm">Invoice date<input className="w-full rounded border p-2" type="date" value={date} onChange={event => setDate(event.target.value)} /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">Invoice total<input className="w-full rounded border p-2" type="number" inputMode="decimal" min="0.01" step="0.01" value={total} onChange={event => setTotal(event.target.value)} /></label>
            <label className="block text-sm">Sales tax included in total<input className="w-full rounded border p-2" type="number" inputMode="decimal" min="0" step="0.01" value={tax} onChange={event => setTax(event.target.value)} /></label>
          </div>
          <label className="block text-sm">Original invoice PDF<input className="block w-full" type="file" accept="application/pdf,.pdf" onChange={event => setFile(event.target.files?.[0] ?? null)} /></label>
          {draft?.hasPdf && <p className="text-sm">An original PDF is already attached. It will be kept unless you select a replacement.</p>}
          <label className="block text-sm">Audit note<textarea aria-label="Audit note" className="w-full rounded border p-2" value={note} minLength={5} maxLength={1000}
            placeholder="Explain which earlier work this bill covers." onChange={event => setNote(event.target.value)} /></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
            <span>I checked the original PDF, contractor, invoice number, date, total and tax. This bill covers the selected past assignment and is not a duplicate.</span></label>
        </fieldset>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-soft" disabled={busy} onClick={() => dismissal.requestClose("cancel_button")}>Cancel</button>
          {(!locked || intent.current === "draft") && <button type="button" className="btn-soft" disabled={busy} onClick={() => void save("draft")}>{busy ? "Saving…" : locked ? "Retry same draft" : "Save draft"}</button>}
          {(!locked || intent.current === "submitted") && <button type="button" className="btn-primary" disabled={busy} onClick={() => void save("submitted")}>{busy ? "Saving…" : locked ? "Retry same submission" : "Upload and send for review"}</button>}
        </div>
      </div>}
  </Modal>{dismissal.dialog}</>;
}

export default function PriorContractorInvoicePanel({ workOrderId }: { workOrderId: string }) {
  const actor = useDirectoryActor(); const allowed = canRecordExternalBilling(actor);
  const [editor, setEditor] = useState<{ context: PriorInvoiceContext; draft: Draft | null } | null>(null);
  const context = useQuery({ queryKey: ["prior-contractor-invoices", actor?.id, workOrderId], enabled: allowed,
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase().rpc("get_prior_contractor_invoice_context_v1", { p_work_order_id: workOrderId }).abortSignal(signal);
      if (error) throw priorInvoiceError(error);
      const result = priorInvoiceContextSchema.parse(data);
      if (result.workOrderId !== workOrderId) throw new Error("Invoice context mismatch");
      return result;
    }, staleTime: 0 });
  if (!allowed) return null;
  return <section aria-label="Previous contractor invoices" className="card mb-4 space-y-3 p-4">
    <h3 className="font-semibold">Previous contractor invoices</h3>
    <p className="text-sm">Staff can record bills received after reassignment. The current contractor’s work stays separate.</p>
    {context.isError ? <><p role="alert">{priorInvoiceError(context.error).message}</p><button type="button" className="btn-soft" onClick={() => void context.refetch()}>Retry loading past assignments</button></>
      : <button type="button" className="btn-soft" disabled={!context.data?.assignments.length || context.isFetching}
        onClick={() => context.data && setEditor({ context: context.data, draft: null })}>Upload previous contractor invoice</button>}
    {context.data?.assignments.length === 0 && <p className="text-sm">No recorded past contractor assignments. Staff must verify assignment history before recording a prior bill.</p>}
    {context.data?.drafts.map(draft => <div key={draft.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span>#{draft.num} · {draft.state === "rejected" ? "Rejected — correction needed" : "Draft"}</span>
      <button type="button" className="btn-soft" onClick={() => context.data && setEditor({ context: context.data, draft })}>Resume prior invoice {draft.num}</button>
    </div>)}
    {editor && <PriorInvoiceModal context={editor.context} draft={editor.draft} onClose={() => setEditor(null)} />}
  </section>;
}
