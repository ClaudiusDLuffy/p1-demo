"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDirectoryActor } from "../directory/queries";
import { directoryActorScope } from "../../lib/counts/queryKeys";
import { canRecordExternalBilling } from "./externalBillingContracts";
import { loadExternalBilling } from "./externalBillingRepository";
import { ExternalBillingModal } from "./ExternalBillingModal";
import { billingClosureStatusEligible, billingClosureUnavailableReason } from "./billingClosurePolicy";

export function ExternalBillingPanel({ workOrderId, status, workflowCycle }: {
  workOrderId: string; status: string; workflowCycle: number;
}) {
  const actor = useDirectoryActor();
  const allowed = canRecordExternalBilling(actor);
  const [open, setOpen] = useState(false);
  const history = useQuery({ queryKey: ["external-billing", directoryActorScope(actor), workOrderId],
    queryFn: ({ signal }) => loadExternalBilling(workOrderId, signal), enabled: allowed, staleTime: 30_000 });
  if (!allowed) return null;
  const record = history.data;
  const currentRecord = record?.workflowCycle === workflowCycle;
  const eligible = !currentRecord && billingClosureStatusEligible(status);
  const unavailable = billingClosureUnavailableReason(status);
  return <section aria-label="External billing" className="space-y-3">
    {record && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950">
      <h3 className="font-semibold">Billed outside the portal{!currentRecord && " · earlier work cycle"}</h3>
      <p>{record.billingSystem} · Invoice #{record.invoiceReference} · {record.billedOn}</p>
      <p className="mt-1 whitespace-pre-wrap break-words">{record.note}</p>
      <p className="mt-2 text-xs">Staff-only billing record. This is not a portal invoice or confirmation of submission to 7-Eleven.</p>
    </div>}
    {history.isError && <p role="alert" className="text-sm">External billing history could not be loaded. <button type="button" className="btn-soft" onClick={() => void history.refetch()}>Retry</button></p>}
    {unavailable && status !== "closed" && <p className="rounded-lg border border-p1-border p-3 text-sm">{unavailable}</p>}
    {eligible && <button type="button" className="btn-soft" onClick={() => setOpen(true)}>Billed outside the portal</button>}
    {open && <ExternalBillingModal key={workOrderId} workOrderId={workOrderId} onClose={() => setOpen(false)} />}
  </section>;
}
