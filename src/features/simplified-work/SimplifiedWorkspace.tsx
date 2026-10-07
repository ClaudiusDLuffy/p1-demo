"use client";

import { useDeferredValue, useState } from "react";
import type { PortalAuthProfile } from "../auth/authProfile";
import { useDirectoryLabels } from "../directory/queries";
import { STATUS } from "../../lib/constants";
import { CAPITAL_PROJECT_FILTERS } from "../work-orders/capitalProjectStage";
import { useWorkOrderCollection } from "../work-orders/useWorkOrderCollection";
import { WorkOrderCollectionProgress } from "../work-orders/WorkOrderCollectionProgress";
import { resolveWorkOrderCollectionState, WorkOrderCollectionNotice } from "../work-orders/WorkOrderCollectionNotice";
import { SimplifiedWorkCard } from "./SimplifiedWorkCard";
import { useSimplifiedExport } from "./useSimplifiedExport";
import { directoryActorScope } from "../../lib/counts/queryKeys";
import { simplifiedWorkQuery, type SimplifiedView } from "./simplifiedWorkModel";

type SimplifiedWorkspaceProps = {
  active: boolean;
  currentUser: PortalAuthProfile;
  isManager: boolean;
  onOpenWorkOrder: (workOrderId: string) => void;
  onOpenInvoices: () => void;
};

const VIEWS: ReadonlyArray<{ value: SimplifiedView; label: string }> = [
  { value: "unassigned", label: "Unassigned" },
  { value: "open", label: "Open" },
  { value: "breached", label: "Breached" },
  { value: "capital", label: "Capital" },
  { value: "closed", label: "Closed" },
];
const CONTROL_CLASS = "min-h-11 w-full min-w-0 rounded-lg border border-p1-border bg-p1-surface px-3 py-2 text-sm text-p1-ink focus:border-p1-accent";

export default function SimplifiedWorkspace({ active, currentUser, isManager, onOpenWorkOrder, onOpenInvoices }: SimplifiedWorkspaceProps) {
  const [view, setView] = useState<SimplifiedView>("open");
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const params = simplifiedWorkQuery(
    view, status, deferredSearch, isManager ? null : currentUser.contractorAccountId || currentUser.id,
  );
  const query = useWorkOrderCollection(params, active, currentUser);
  const exporter = useSimplifiedExport(params, active && currentUser.active === true, directoryActorScope(currentUser));
  const { workOrders } = query;
  const { getUser } = useDirectoryLabels(workOrders.map(row => row.contractor), active && workOrders.length > 0, currentUser);
  const collectionState = resolveWorkOrderCollectionState({ itemCount: workOrders.length,
    isPending: query.isPending, isFetching: query.isFetching, isError: query.isError });
  const statusOptions = view === "capital" ? CAPITAL_PROJECT_FILTERS : [
    { value: "all", label: "All work statuses" },
    ...Object.entries(STATUS).filter(([key]) => view === "closed" ? key === "closed" : key !== "closed")
      .map(([value, config]) => ({ value, label: config.label })),
  ];

  if (!active) return null;
  return (
    <section className="animate-fade-up" aria-labelledby="simplified-work-heading">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 id="simplified-work-heading" className="font-display text-3xl text-p1-ink">Work, made simple</h1>
          <p className="mt-1 text-sm text-p1-muted">Choose a list, check the status, open the job.</p>
        </div>
        <button type="button" className="btn-soft min-h-11" disabled={exporter.busy || !workOrders.length || query.isFetching || search !== deferredSearch}
          onClick={() => void exporter.start()}>{exporter.busy ? `Exporting… ${exporter.count}` : "Export filtered list"}</button>
      </header>
      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Work filters">
        {VIEWS.map(option => (
          <button key={option.value} type="button" aria-pressed={view === option.value}
            disabled={exporter.busy}
            className="min-h-11 rounded-lg border border-p1-border px-4 py-2 text-sm font-bold text-p1-muted aria-pressed:border-p1-accent aria-pressed:bg-p1-accent-soft aria-pressed:text-p1-accent disabled:opacity-50"
            onClick={() => { setView(option.value); setStatus(option.value === "capital" ? "capital_active" : "all"); }}>
            {option.label}
          </button>
        ))}
        <button type="button" className="btn-soft min-h-11" onClick={onOpenInvoices}>Invoices</button>
      </nav>
      <fieldset disabled={exporter.busy} className="mb-3 grid min-w-0 gap-3 sm:grid-cols-2 disabled:opacity-50">
        <label className="grid min-w-0 gap-1 text-xs text-p1-muted">Search work orders
          <input type="search" className={CONTROL_CLASS} value={search} maxLength={200}
            onChange={event => setSearch(event.target.value)} placeholder="Search WO, store, city, keyword…" />
        </label>
        {view !== "unassigned" && <label className="grid min-w-0 gap-1 text-xs text-p1-muted">{view === "capital" ? "Capital status" : "Work status"}
          <select aria-label={view === "capital" ? "Capital status" : "Work status"} className={CONTROL_CLASS} value={status} onChange={event => setStatus(event.target.value)}>
            {statusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>}
      </fieldset>
      <p className="mb-3 text-xs text-p1-muted" role="status">
        {query.isPending ? "Loading matching work…" : `${workOrders.length} matching work orders loaded${query.hasNextPage ? " · more available" : ""}.`}
        {" "}Filters and export include the full accessible matching list. Export reads current records; changes during export may affect results.
      </p>
      {exporter.busy && <div className="mb-3 flex flex-wrap items-center gap-3" role="status">
        <span className="text-sm text-p1-muted">Preparing all matches: {exporter.count} loaded.</span>
        <button type="button" className="btn-soft min-h-11" onClick={exporter.cancel}>Cancel export</button>
      </div>}
      {exporter.error && <p role="alert" className="mb-3 text-sm text-p1-danger">{exporter.error}</p>}
      {exporter.message && <p role="status" className="mb-3 text-sm text-p1-muted">{exporter.message}</p>}
      <WorkOrderCollectionProgress count={workOrders.length} hasMore={query.hasNextPage} failed={query.isError} busy={query.isFetching}
        serverFiltered
        onLoadMore={() => void query.fetchNextPage()} onRetry={() => void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())} />
      {collectionState !== "ready" && workOrders.length === 0 ? (
        <WorkOrderCollectionNotice state={collectionState} loadingMessage="Loading the simplified work list…"
          errorMessage="The work list could not be loaded. Retry without changing any work-order data."
          emptyMessage="No work orders match these filters." onRetry={() => void query.refetch()} retrying={query.isFetching} className="card" />
      ) : (
        <div className="grid gap-2.5" aria-live="polite">
          {workOrders.map(workOrder => <SimplifiedWorkCard key={workOrder.id} workOrder={workOrder}
            showBreach={view === "breached"}
            contractorName={getUser(workOrder.contractor)?.name || "Unassigned"} onOpen={onOpenWorkOrder} />)}
        </div>
      )}
    </section>
  );
}
