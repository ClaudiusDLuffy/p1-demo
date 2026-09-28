export const FOCUSED_BILLING_QUEUES = [
  { value: "ready", label: "Prepare invoice", description: "Work orders eligible for billing. Open the existing invoice or prepare one." },
  { value: "draft", label: "Drafts", description: "Invoices and quotes still being prepared." },
  { value: "submitted", label: "Send to 7-Eleven", description: "Ready documents without a recorded 7-Eleven submission. Already sent outside P1? Open the document and confirm it was sent." },
  { value: "sent", label: "Sent to 7-Eleven", description: "Documents with the submission step recorded in P1. They no longer appear in Send to 7-Eleven." },
  { value: "recently_approved", label: "Approved contractor bills", description: "Source contractor bills for staff preparing a P1 invoice; not invoices waiting to be sent to 7-Eleven." },
] as const;
export type FocusedBillingQueue = typeof FOCUSED_BILLING_QUEUES[number]["value"];
export const focusedBillingQueue = (value: string) => FOCUSED_BILLING_QUEUES.find(queue => queue.value === value);

export function FocusedBillingNavigation({ value, onChange, onBack }: {
  value: FocusedBillingQueue; onChange: (value: FocusedBillingQueue) => void; onBack: () => void;
}) {
  return <div className="mb-4 grid gap-3">
    <button type="button" className="btn-soft min-h-11 justify-self-start" onClick={onBack}>Back to simplified work</button>
    <h1 className="font-display text-3xl text-p1-ink">Invoices</h1>
    <nav aria-label="Invoice queues" className="flex flex-wrap gap-2">
      {FOCUSED_BILLING_QUEUES.filter(queue => queue.value !== "recently_approved").map(queue => <button key={queue.value} type="button" aria-pressed={value === queue.value}
        className="min-h-11 rounded-lg border border-p1-border px-3 py-2 text-sm text-p1-muted aria-pressed:bg-p1-accent-soft aria-pressed:text-p1-accent"
        onClick={() => onChange(queue.value)}>{queue.label}</button>)}
    </nav>
    <details className="text-sm text-p1-muted">
      <summary className="min-h-11 cursor-pointer content-center">Billing source documents</summary>
      <button type="button" className="btn-soft min-h-11" aria-pressed={value === "recently_approved"}
        onClick={() => onChange("recently_approved")}>Approved contractor bills</button>
    </details>
    <p className="text-xs text-p1-muted">{focusedBillingQueue(value)?.description} Uploading or downloading a document alone does not mark it sent.</p>
  </div>;
}
