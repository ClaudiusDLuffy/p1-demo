"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Ico } from "../../components/ui/Ico";

export function focusWorkOrderSection(id: string) {
  const section = document.getElementById(id);
  if (!section) return;
  if (section instanceof HTMLDetailsElement) section.open = true;
  (section.querySelector<HTMLElement>("summary") || section).focus({ preventScroll: true });
  section.scrollIntoView({ block: "start" });
}

/** Consistent entry, not a new upload pipeline or permission boundary. */
export function AttachmentsButton({ onClick }: { onClick?: () => void }) {
  return <button type="button" className="btn-soft inline-flex min-h-11 items-center gap-2"
    onClick={onClick || (() => focusWorkOrderSection("work-order-attachments"))}>
    <Ico d="M21 11.5 12 20.5a6 6 0 0 1-8.5-8.5L13 2.5a4 4 0 0 1 5.7 5.7L9.2 17.7a2 2 0 0 1-2.8-2.8L15 6.3" size={15} />
    Attachments
  </button>;
}

export function WorkOrderAttachments({ children, canViewDocuments, focusRequested, onFocused }: {
  children: ReactNode; canViewDocuments: boolean; focusRequested?: boolean; onFocused?: () => void;
}) {
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focusRequested) return;
    section.current?.focus({ preventScroll: true });
    section.current?.scrollIntoView({ block: "start" });
    onFocused?.();
  }, [focusRequested, onFocused]);
  return <section ref={section} id="work-order-attachments" tabIndex={-1} aria-label="Work order attachments" className="min-w-0 scroll-mt-4">
    <div className="mb-3">
      <h2 className="text-base font-semibold text-p1-ink">Attachments</h2>
      <p className="text-xs text-p1-muted">Photos stay with this work order. Invoice PDFs and equipment forms stay with their invoice or estimate.</p>
      {canViewDocuments && <button type="button" className="btn-soft mt-2 min-h-11"
        onClick={() => focusWorkOrderSection("work-order-documents")}>Invoice / estimate documents</button>}
    </div>
    {children}
  </section>;
}
