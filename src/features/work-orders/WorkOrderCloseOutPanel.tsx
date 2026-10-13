"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "../../components/ui/Modal";
import { useDirectoryActor } from "../directory/queries";
import { directoryActorScope } from "../../lib/counts/queryKeys";
import { canRecordExternalBilling } from "../billing/externalBillingContracts";
import { ExternalBillingModal } from "../billing/ExternalBillingModal";
import { LinkedBillingModal } from "../billing/LinkedBillingModal";
import { CapitalSelfServiceModal } from "./CapitalSelfServiceModal";
import { CapitalCloseOutModal, type CapitalCloseOutDocument } from "./CapitalCloseOutModal";
import type { CapitalCloseOutOutcome } from "./capitalCloseOut";
import CloseReopenedFollowUpModal from "./CloseReopenedFollowUpModal";
import { CloseOutNoInvoiceModal } from "./CloseOutNoInvoiceModal";
import { RecordedBillingCloseOutModal } from "./RecordedBillingCloseOutModal";
import { loadRecordedBillingEvidence, recordedBillingCloseOutError, type RecordedBillingEvidence } from "./recordedBillingCloseOut";
import { isCapitalCloseOutWork, workOrderCloseOutOptions, workOrderCloseOutReviewSteps, type CloseOutAction, type CloseOutReviewSection, type CloseOutReviewStep, type CloseOutWorkOrder, type FollowUpCloseSnapshot } from "../../lib/workOrderCloseOut";

const reviewSectionIds: Record<CloseOutReviewStep["target"], string> = {
  billing: "work-order-documents", documents: "work-order-documents", visits: "work-order-visits",
  history: "work-order-activity", updates: "work-order-activity", progress: "work-order-progress",
};

type Props = {
  workOrder: CloseOutWorkOrder; hasCompleteEvidence: boolean; hasStaffDocuments: boolean; hasAnyDocuments: boolean;
  hasUnresolvedContractorInvoices: boolean; canCloseFollowUp: boolean;
  billingDocument?: { id: string } | null;
  capitalDocuments?: readonly CapitalCloseOutDocument[]; onCapitalDone?(outcome: CapitalCloseOutOutcome): void;
  onOpenBilling(workOrderId: string, invoiceId: string | null): void;
  onReviewSection?(workOrderId: string, section: CloseOutReviewSection): void;
  onCloseFollowUp(snapshot: FollowUpCloseSnapshot, reason: string): Promise<boolean>;
  onCloseWithoutInvoice(snapshot: FollowUpCloseSnapshot): Promise<boolean>;
  canLoadMoreHistory?: boolean; historyLoading?: boolean; onLoadMoreHistory?(): Promise<void>;
};

/** One entry point, with the existing outcome-specific commands behind it. */
export function WorkOrderCloseOutPanel(props: Props) {
  const actor = useDirectoryActor();
  const scope = directoryActorScope(actor);
  const [selection, setSelection] = useState<{ action: CloseOutAction | "choose"; scope: string; snapshot: FollowUpCloseSnapshot; recordedBilling?: RecordedBillingEvidence } | null>(null);
  const [historyError, setHistoryError] = useState("");
  const evidence = useQuery({ queryKey: ["recorded-billing-closeout", scope, props.workOrder.id],
    queryFn: ({ signal }) => loadRecordedBillingEvidence(props.workOrder.id, signal), staleTime: 0,
    enabled: canRecordExternalBilling(actor) && selection?.scope === scope && selection.snapshot.id === props.workOrder.id
      && selection.action === "choose" && !isCapitalCloseOutWork(props.workOrder) && props.workOrder.status !== "closed",
  });
  // Permission checks remain in every server command. Hiding the panel also
  // unmounts an old actor's form if their operational access changes.
  if (!canRecordExternalBilling(actor)) return null;
  const work = props.workOrder;
  const billingDocument = props.billingDocument || (evidence.data ? { id: evidence.data.invoiceId } : null);
  const options = workOrderCloseOutOptions({ ...props, hasCurrentInvoice: Boolean(billingDocument), hasRecordedBillingEvidence: Boolean(evidence.data) })
    .map(option => option.action === "reconcile_billing" && evidence.isFetching
      ? { ...option, blocked: option.blocked || "Checking current recorded billing…" } : option);
  const capital = isCapitalCloseOutWork(work);
  const reviewStepsFor = (action: CloseOutAction) => workOrderCloseOutReviewSteps({ ...props, action, hasCurrentInvoice: Boolean(billingDocument?.id) })
    .filter(step => step.target === "billing" ? Boolean(billingDocument?.id) : Boolean(props.onReviewSection));
  const close = () => setSelection(null);
  const choose = (action: CloseOutAction | "choose") => setSelection({ action, scope, recordedBilling: action === "reconcile_billing" && evidence.data ? { ...evidence.data } : undefined, snapshot: {
    id: work.id, workflowCycle: work.workflowCycle ?? 0,
    contractorAssignmentVersion: work.contractorAssignmentVersion ?? 0, updatedAt: work.updatedAt ?? null,
  } });
  const selected = selection?.snapshot.id === work.id && selection.scope === scope ? selection : null;
  return <section aria-label="Work order close out" className="card mb-3 space-y-3 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="font-semibold">Close out</h3><p className="text-sm">{capital ? "Completed and billed goes to History. Not billed yet? Send it to billing." : "One place for installation completion and the correct billing outcome. Original records stay protected."}</p></div>
      {work.status !== "closed" && <button type="button" className="btn-primary min-h-11" onClick={() => choose("choose")}>Close out</button>}
      {work.status === "closed" && <p role="status" className="text-sm">This work order is already closed. Review its billing history below.</p>}
    </div>
    {selected?.action === "choose" && capital && <CapitalCloseOutModal workOrderId={work.id} documents={props.capitalDocuments || []}
      hasCompleteEvidence={props.hasCompleteEvidence} billedBlocker={options.find(option => option.action === "capital_billed")?.blocked}
      completionBlocker={options.find(option => option.action === "capital_to_billing")?.blocked}
      canLoadMoreHistory={props.canLoadMoreHistory} historyLoading={props.historyLoading} onLoadMoreHistory={props.onLoadMoreHistory}
      onReviewDocument={invoiceId => { close(); props.onOpenBilling(work.id, invoiceId); }} onClose={close} onDone={props.onCapitalDone} />}
    {selected?.action === "choose" && !capital && <Modal title="Close out work order" description={work.id} width={600} onRequestClose={close}>
      <div className="space-y-4">
        <p className="text-sm">Choose what actually happened. Routine audit notes are recorded automatically; references and confirmation are still required. These actions do not submit anything to 7-Eleven for you.</p>
        <p className="text-xs text-p1-muted">Review links only open existing records. They do not bill, record checkout, or close this work order.</p>
        {evidence.isFetching && <p role="status" className="text-xs">Checking existing recorded billing…</p>}
        {evidence.isError && <p role="alert" className="text-xs">{recordedBillingCloseOutError(evidence.error).message}
          <button type="button" className="ml-2 underline" onClick={() => void evidence.refetch()}>Retry billing check</button></p>}
        {!props.hasCompleteEvidence && props.canLoadMoreHistory && props.onLoadMoreHistory && <div className="space-y-2">
          <p className="text-sm">Earlier history is still paged. Load the next history pages here so close-out eligibility can be checked.</p>
          <button type="button" className="btn-soft" disabled={props.historyLoading} onClick={async () => {
            setHistoryError(""); try { await props.onLoadMoreHistory?.(); }
            catch { setHistoryError("History could not load. Retry or review the WO's history before closing."); }
          }}>{props.historyLoading ? "Loading history..." : "Load more close-out history"}</button>
          {historyError && <p role="alert" className="text-sm text-red-700">{historyError}</p>}
        </div>}
        {options.length === 0 && <p role="status">This work order is already closed.</p>}
        {options.map(option => <section key={option.action} aria-label={option.label} className="rounded-lg border border-p1-border p-3">
          <button type="button" className="btn-soft" disabled={Boolean(option.blocked)} onClick={() => {
            if (option.blocked) return;
            if (option.action === "review_billing") { close(); props.onOpenBilling(work.id, billingDocument?.id ?? null); }
            else choose(option.action);
          }}>{option.label}</button>
          <p className="mt-2 text-sm">{option.explanation}</p>
          {option.blocked && <p role="status" className="mt-1 text-sm text-amber-800">{option.blocked}</p>}
          {reviewStepsFor(option.action).length > 0 && <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="text-p1-muted">Review:</span>
            {reviewStepsFor(option.action).map(step => <a key={step.target} href={`#${reviewSectionIds[step.target]}`}
              className="inline-flex min-h-11 max-w-full items-center rounded-sm text-p1-accent underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p1-accent"
              title={step.explanation} onClick={event => {
                event.preventDefault();
                if (step.target === "billing") {
                  if (!billingDocument?.id) return;
                  close(); props.onOpenBilling(work.id, billingDocument.id);
                } else if (props.onReviewSection) {
                  close(); props.onReviewSection(work.id, step.target);
                }
              }}>{step.label}</a>)}
          </p>}
        </section>)}
        {!options.some(option => ["external_billing", "linked_billing", "reconcile_billing", "follow_up", "capital_complete", "no_invoice"].includes(option.action))
          && !["capital", "closed"].includes(work.status) && <p className="text-sm">Finish field work and move the WO to billing first. Close out never checks out a technician or force-closes unfinished work.</p>}
        <button type="button" className="btn-soft" onClick={close}>Cancel</button>
      </div>
    </Modal>}
    {selected?.action === "external_quote" && <CapitalSelfServiceModal workOrderId={work.id} action="capital_external_handoff" guidedCloseOut onClose={close} />}
    {selected?.action === "capital_complete" && <CapitalSelfServiceModal workOrderId={work.id} action="capital_confirmed_completion" guidedCloseOut onClose={close} />}
    {selected?.action === "external_billing" && <ExternalBillingModal workOrderId={work.id} guidedCloseOut onClose={close} />}
    {selected?.action === "linked_billing" && <LinkedBillingModal workOrderId={work.id} guidedCloseOut onClose={close} />}
    {selected?.action === "reconcile_billing" && selected.recordedBilling && <RecordedBillingCloseOutModal key={selected.scope}
      evidence={selected.recordedBilling} onClose={close} />}
    {selected?.action === "follow_up" && <CloseReopenedFollowUpModal workOrderId={work.id} workflowCycle={selected.snapshot.workflowCycle} guidedCloseOut
      onClose={close} onConfirm={reason => props.onCloseFollowUp(selected.snapshot, reason)} />}
    {selected?.action === "no_invoice" && <CloseOutNoInvoiceModal workOrderId={work.id} onClose={close}
      onConfirm={() => props.onCloseWithoutInvoice(selected.snapshot)} />}
  </section>;
}
