"use client";

import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "../../components/ui/Input";
import { directoryActorScope } from "../../lib/counts/queryKeys";
import { useDirectoryActor } from "../directory/queries";
import { linkedBillingLookupSchema, type LinkedBillingCandidate } from "./linkedBillingContracts";
import { loadLinkedBillingCandidates } from "./linkedBillingRepository";

export function LinkedBillingInvoicePicker({ sourceWorkOrderId, selected, disabled, onSelect }: {
  sourceWorkOrderId: string; selected: LinkedBillingCandidate | null; disabled: boolean;
  onSelect(candidate: LinkedBillingCandidate | null): void;
}) {
  const fieldId = useId();
  const actor = useDirectoryActor();
  const [fields, setFields] = useState({ workOrderId: "", invoiceNumber: "" });
  const [lookup, setLookup] = useState<typeof fields | null>(null);
  const [error, setError] = useState("");
  const result = useQuery({
    queryKey: ["linked-billing-candidates", directoryActorScope(actor), lookup],
    queryFn: ({ signal }) => loadLinkedBillingCandidates(lookup!.workOrderId, lookup!.invoiceNumber, signal),
    enabled: lookup !== null, staleTime: 0,
  });
  function edit(key: keyof typeof fields, value: string) {
    setFields(current => ({ ...current, [key]: value })); setLookup(null); onSelect(null); setError("");
  }
  function find() {
    const parsed = linkedBillingLookupSchema.safeParse(fields);
    if (!parsed.success || parsed.data.workOrderId === sourceWorkOrderId) {
      setError("Enter a different work order number. An optional exact invoice number can narrow the results."); return;
    }
    onSelect(null); setError("");
    if (lookup?.workOrderId === parsed.data.workOrderId && lookup.invoiceNumber === parsed.data.invoiceNumber) void result.refetch();
    else setLookup(parsed.data);
  }
  return <fieldset disabled={disabled} className="min-w-0 space-y-3 disabled:opacity-70">
    <label htmlFor={`${fieldId}-work`} className="grid gap-1 text-sm">Billing work order number (required)
      <Input id={`${fieldId}-work`} className="w-full min-w-0" value={fields.workOrderId} maxLength={128}
        onChange={event => edit("workOrderId", event.target.value)} placeholder="Enter the other work order number" />
    </label>
    <label htmlFor={`${fieldId}-invoice`} className="grid gap-1 text-sm">Exact invoice number (optional)
      <Input id={`${fieldId}-invoice`} className="w-full min-w-0" value={fields.invoiceNumber} maxLength={100}
        onChange={event => edit("invoiceNumber", event.target.value)} />
    </label>
    <button type="button" className="btn-soft" disabled={result.isFetching || disabled} onClick={find}>Find submitted invoices</button>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {lookup && result.isFetching && <p role="status" className="text-sm">Loading submitted invoices…</p>}
    {lookup && result.isError && <p role="alert" className="text-sm text-red-700">Invoices could not be loaded. Try Find submitted invoices again.</p>}
    {lookup && result.isSuccess && !result.isFetching && <div className="space-y-2">
      {result.data.items.length === 0 && <p className="text-sm">No eligible submitted P1 invoices found. Check the number, or submit the invoice on the other work order first. Drafts, rejected invoices, quotes, and contractor bills are excluded.</p>}
      {result.data.items.map(candidate => <label key={candidate.invoiceId} className="flex min-w-0 items-start gap-2 rounded-lg border border-p1-border p-3 text-sm">
        <input type="radio" name={`${fieldId}-selection`} className="mt-1 shrink-0" checked={selected?.invoiceId === candidate.invoiceId}
          onChange={() => onSelect(candidate)} />
        <span className="min-w-0 break-words">Invoice #{candidate.invoiceNumber} · {candidate.state}<br />
          {candidate.workOrderId} · {candidate.invoiceDate ?? "Date not recorded"}</span>
      </label>)}
      {result.data.hasMore && <p className="text-sm">More than 25 invoices match. Enter the exact invoice number to find the right one.</p>}
    </div>}
  </fieldset>;
}
