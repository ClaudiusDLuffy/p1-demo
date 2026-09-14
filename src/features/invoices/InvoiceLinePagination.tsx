"use client";

import { safeErrorMessage } from "../../lib/errors/normalizeUnknown";
import type { useInvoiceLinePage } from "./invoiceLineQueries";

export default function InvoiceLinePagination({ query, total }: {
  query: ReturnType<typeof useInvoiceLinePage>; total: number;
}) {
  return <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "12px 16px" }}>
    <span aria-live="polite">{query.isPending ? "Loading invoice lines…" : `Page ${query.page} · ${query.lines.length} shown · ${total} total lines`}</span>
    {query.error && <span role="alert">{safeErrorMessage(query.error)} Reload the invoice to continue.</span>}
    {query.page > 1 && <button className="btn-soft" onClick={query.first} disabled={query.isFetching}>First page</button>}
    {query.data?.hasMore && <button className="btn-soft" onClick={query.next} disabled={query.isFetching}>Next lines</button>}
    <button className="btn-soft" onClick={() => void query.refresh()} disabled={query.isFetching}>Reload invoice</button>
    {!query.data?.hasMore && query.data && <span>End of lines</span>}
  </div>;
}
