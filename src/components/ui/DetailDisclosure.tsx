import { Children, type ReactNode } from "react";

/** Presentation only. Collapsing a section keeps its existing controls mounted. */
export function DetailDisclosure({ focused, title, children, id }: {
  focused: boolean; title: string; children: ReactNode; id?: string;
}) {
  if (Children.toArray(children).length === 0) return null;
  if (!focused) return id ? <div id={id} tabIndex={-1}>{children}</div> : <>{children}</>;
  return (
    <details id={id} className="mb-3 min-w-0 rounded-xl border border-p1-border bg-p1-surface p-3">
      <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold text-p1-ink">{title}</summary>
      <div className="min-w-0 pt-3">{children}</div>
    </details>
  );
}
