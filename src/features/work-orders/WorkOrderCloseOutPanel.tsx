"use client";

import { useState } from "react";
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
import { isCapitalCloseOutWork, workOrderCloseOutOptions, type CloseOutAction, type CloseOutWorkOrder, type FollowUpCloseSnapshot } from "../../lib/workOrderCloseOut";

type Props = {
  workOrder: CloseOutWorkOrder; hasCompleteEvidence: boolean; hasStaffDocuments: boolean; hasAnyDocuments: boolean;
  hasUnresolvedContractorInvoices: boolean; canCloseFollowUp: boolean;
  billingDocument?: { id: string } | null;
  capitalDocuments?: readonly CapitalCloseOutDocument[]; onCapitalDone?(outcome: CapitalCloseOutOutcome): void;
  onOpenBilling(workOrderId: string, invoiceId: string | null): void;
  onCloseFollowUp(snapshot: FollowUpCloseSnapshot, reason: string): Promise<boolean>;
  onCloseWithoutInvoice(snapshot: FollowUpCloseSnapshot): Promise<boolean>;
  canLoadMoreHistory?: boolean; historyLoading?: boolean; onLoadMoreHistory?(): Promise<void>;
};

/** One entry point, with the existing outcome-specific commands behind it. */
export function WorkOrderCloseOutPanel(props: Props) {
  const actor = useDirectoryActor();
  const scope = directoryActorScope(actor);
  const [selection, setSelection] = useState<{ action: CloseOutAction | "choose"; scope: string; snapshot: FollowUpCloseSnapshot } | null>(null);
  const [historyError, setHistoryError] = useState("");
  // Permission checks remain in every server command. Hiding the panel also
  // unmounts an old actor's form if their operational access changes.
  if (!canRecordExternalBilling(actor)) return null;
  const work = props.workOrder;
  const options = workOrderCloseOutOptions({ ...props, hasCurrentInvoice: Boolean(props.billingDocument) });
  const capital = isCapitalCloseOutWork(work);
  const close = () => setSelection(null);
  const choose = (action: CloseOutAction | "choose") => setSelection({ action, scope, snapshot: {
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
        {!props.hasCompleteEvidence && props.canLoadMoreHistory && props.onLoadMoreHistory && <div className="space-y-2">
          <p className="text-sm">Earlier history is still paged. Load the next history pages here so close-out eligibility can be checked.</p>
          <button type="button" className="btn-soft" disabled={props.historyLoading} onClick={async () => {
            setHistoryError(""); try { await props.onLoadMoreHistory?.(); }
            catch { setHistoryError("History could not load. Retry or review the WO's history before closing."); }
          }}>{props.historyLoading ? "Loading history..." : "Load more close-out history"}</button>
          {historyError && <p role="alert" className="text-sm text-red-700">{historyError}</p>}
        </div>}
        {options.length === 0 && <p role="status">This work order is already closed.</p>}
        {options.map(option => <div key={option.action} className="rounded-lg border border-p1-border p-3">
          <button type="button" className="btn-soft" disabled={Boolean(option.blocked)} onClick={() => {
            if (option.blocked) return;
            if (option.action === "review_billing") { close(); props.onOpenBilling(work.id, props.billingDocument?.id ?? null); }
            else choose(option.action);
          }}>{option.label}</button>
          <p className="mt-2 text-sm">{option.explanation}</p>
          {option.blocked && <p role="status" className="mt-1 text-sm text-amber-800">{option.blocked}</p>}
        </div>)}
        {!options.some(option => ["external_billing", "linked_billing", "follow_up", "capital_complete", "no_invoice"].includes(option.action))
          && !["capital", "closed"].includes(work.status) && <p className="text-sm">Finish field work and move the WO to billing first. Close out never checks out a technician or force-closes unfinished work.</p>}
        <button type="button" className="btn-soft" onClick={close}>Cancel</button>
      </div>
    </Modal>}
    {selected?.action === "external_quote" && <CapitalSelfServiceModal workOrderId={work.id} action="capital_external_handoff" guidedCloseOut onClose={close} />}
    {selected?.action === "capital_complete" && <CapitalSelfServiceModal workOrderId={work.id} action="capital_confirmed_completion" guidedCloseOut onClose={close} />}
    {selected?.action === "external_billing" && <ExternalBillingModal workOrderId={work.id} guidedCloseOut onClose={close} />}
    {selected?.action === "linked_billing" && <LinkedBillingModal workOrderId={work.id} guidedCloseOut onClose={close} />}
    {selected?.action === "follow_up" && <CloseReopenedFollowUpModal workOrderId={work.id} workflowCycle={selected.snapshot.workflowCycle} guidedCloseOut
      onClose={close} onConfirm={reason => props.onCloseFollowUp(selected.snapshot, reason)} />}
    {selected?.action === "no_invoice" && <CloseOutNoInvoiceModal workOrderId={work.id} onClose={close}
      onConfirm={() => props.onCloseWithoutInvoice(selected.snapshot)} />}
  </section>;
}
