type WorkOrderCollectionProgressProps = {
  count: number;
  hasMore: boolean;
  failed: boolean;
  busy: boolean;
  serverFiltered?: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
};

export function WorkOrderCollectionProgress({
  count, hasMore, failed, busy, onLoadMore, onRetry, serverFiltered = false,
}: WorkOrderCollectionProgressProps) {
  if (count === 0 || (!hasMore && !failed)) return null;

  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-p1-border bg-p1-surface-soft p-3 text-xs text-p1-muted" role={failed ? "alert" : "status"}>
      <span className="min-w-0 flex-1 basis-48">
        {failed ? "More work could not be loaded. " : ""}
        {count} work orders loaded. {hasMore
          ? serverFiltered ? "Load more to display additional matches. Export already includes all matching pages."
            : "Counts, filters and calendar include loaded work only. Load more to include the remaining work."
          : "Refresh to check for changes."}
      </span>
      <button type="button" className="btn-soft min-h-11" disabled={busy} onClick={failed ? onRetry : onLoadMore}>
        {busy ? "Loading…" : failed ? "Retry loading work" : "Load more work orders"}
      </button>
    </div>
  );
}
