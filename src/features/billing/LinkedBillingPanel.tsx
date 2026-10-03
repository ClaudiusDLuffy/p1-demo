"use client";

import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useDirectoryActor } from "../directory/queries";
import { directoryActorScope } from "../../lib/counts/queryKeys";
import { canRecordExternalBilling } from "./externalBillingContracts";
import { billingClosureStatusEligible } from "./billingClosurePolicy";
import { loadLinkedBillingHistory } from "./linkedBillingRepository";
import type { LinkedBillingCursor } from "./linkedBillingContracts";
import { LinkedBillingModal } from "./LinkedBillingModal";

export function LinkedBillingPanel({ workOrderId, status, onOpenWorkOrder }: {
  workOrderId: string; status: string; onOpenWorkOrder(id: string): void;
}) {
  const actor = useDirectoryActor(); const allowed = canRecordExternalBilling(actor);
  const [open, setOpen] = useState(false);
  const history = useInfiniteQuery({ queryKey: ["linked-billing", directoryActorScope(actor), workOrderId],
    initialPageParam: null as LinkedBillingCursor,
    queryFn: ({ signal, pageParam }) => loadLinkedBillingHistory(workOrderId, pageParam, signal),
    getNextPageParam: page => {
      const last = page.items.at(-1)?.receipt;
      return page.hasMore && last ? { closedAt: last.closedAt, operationId: last.operationId } : undefined;
    }, enabled: allowed, staleTime: 30_000 });
  if (!allowed) return null;
  return <section aria-label="Linked billing" className="my-3 space-y-3">
    {history.data?.pages.flatMap(page => page.items).map(({ receipt, active }) => {
      const outgoing = receipt.workOrderId === workOrderId;
      const other = outgoing ? receipt.billingWorkOrderId : receipt.workOrderId;
      return <div key={receipt.operationId} className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950">
        <h3 className="font-semibold">{outgoing ? "Billed under another work order" : "Invoice covers another work order"}{!active && " · historical link"}</h3>
        <p className="break-words">Portal invoice #{receipt.invoiceNumber} · {receipt.invoiceDate ?? "Date not recorded"}</p>
        <button type="button" className="btn-soft my-2 max-w-full break-words" onClick={() => onOpenWorkOrder(other)}>View {other}</button>
        <p className="whitespace-pre-wrap break-words">{receipt.note}</p>
        <p className="mt-2 text-xs">Staff-only coverage record. Invoice details shown are the snapshot at closure; no additional revenue or 7-Eleven submission was recorded.</p>
      </div>;
    })}
    {history.isError && <p role="alert" className="text-sm">Linked billing history could not be loaded. <button type="button" className="btn-soft" onClick={() => void history.refetch()}>Retry history</button></p>}
    {history.hasNextPage && <button type="button" className="btn-soft" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>Load older billing links</button>}
    {billingClosureStatusEligible(status) && <button type="button" className="btn-soft" onClick={() => setOpen(true)}>Billed under another work order</button>}
    {open && <LinkedBillingModal workOrderId={workOrderId} onClose={() => setOpen(false)} />}
  </section>;
}
