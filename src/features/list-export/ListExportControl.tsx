"use client";

import { useId } from "react";
import { useListExport, type ListExportOptions } from "./useListExport";

export function ListExportControl<T>(props: ListExportOptions<T> & { label: string; disabled?: boolean }) {
  const id = useId();
  const action = useListExport(props);
  if (!props.enabled) return null;
  return <div className="min-w-0 space-y-1" aria-label={props.label}>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className="btn-soft min-h-11" aria-describedby={`${id}-hint`}
        aria-label={props.label} disabled={props.disabled || action.busy} onClick={() => void action.start()}>
        {action.busy ? `Exporting… ${action.count}` : "Export filtered list (CSV)"}
      </button>
      {action.busy && <button type="button" className="btn-soft min-h-11" aria-label={`Cancel ${props.label}`}
        onClick={action.cancel}>Cancel export</button>}
    </div>
    <p id={`${id}-hint`} className="text-xs text-p1-muted">All accessible matches, not just this page. CSV only; no accounting handoff. Changing filters cancels the export.</p>
    {action.busy && <p role="status" className="text-xs text-p1-muted">Preparing {action.count} matching records…</p>}
    {action.message && <p role="status" className="text-xs text-p1-muted">{action.message}</p>}
    {action.error && <p role="alert" className="text-sm text-p1-danger">{action.error}</p>}
  </div>;
}
