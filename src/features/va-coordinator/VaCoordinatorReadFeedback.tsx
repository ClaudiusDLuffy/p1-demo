import { WorkOrderCollectionNotice } from "../work-orders/WorkOrderCollectionNotice";
import { T } from "../../lib/constants";

export type VaCoordinatorReadState = Readonly<{
  pending: boolean;
  failed: boolean;
  fetching: boolean;
  hasData: boolean;
  retry: () => unknown;
}>;

/** Loading/failed reads are not successful empty queues or photo collections. */
export function canDisplayVaReadContent(state?: VaCoordinatorReadState): boolean {
  return !state || state.hasData || (!state.pending && !state.failed);
}

/** A failed or unconfirmed read must not use the successful/current tone. */
export function vaQueueBadgeStyle(state: VaCoordinatorReadState | undefined, hasPending: boolean) {
  if (state?.failed) return { background: T.dangerSoft, color: T.danger, border: `1px solid ${T.danger}44` };
  if (state?.pending || hasPending) return { background: T.warnSoft, color: "#73560C", border: `1px solid ${T.warn}55` };
  return { background: T.successSoft, color: T.success, border: `1px solid ${T.success}44` };
}

export function VaCoordinatorReadFeedback({ state, subject }: {
  state?: VaCoordinatorReadState;
  subject: "queued updates" | "authorized photos";
}) {
  if (!state) return null;
  return <WorkOrderCollectionNotice
    state={state.failed ? "error" : state.pending ? "loading" : "ready"}
    loadingMessage={`Loading ${subject}…`}
    errorMessage={`Could not load ${subject}. Retry to refresh this section.`}
    onRetry={() => { void state.retry(); }}
    retrying={state.fetching}
    style={{ marginBottom: 14, padding: "14px 16px" }}
  />;
}
