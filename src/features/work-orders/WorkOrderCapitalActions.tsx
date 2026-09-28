import { BtnSpinnerDark, BtnSpinner } from "../../components/ui/BtnSpinner";

type CapitalActionsProps = {
  workOrderId: string; status: string; enabled: boolean; canFlag: boolean; hasOpenVisit: boolean;
  isLoading: (key: string) => boolean;
  onFlag: (id: string) => unknown; onDecline: (id: string) => unknown;
  onResume: (id: string) => unknown; onComplete: (id: string) => unknown;
};

/** Shared actions retain identical eligibility and open-visit guards in both layouts. */
export function WorkOrderCapitalActions({ workOrderId: id, status, enabled, canFlag, hasOpenVisit,
  isLoading, onFlag, onDecline, onResume, onComplete }: CapitalActionsProps) {
  if (!enabled) return null;
  return <>
    {canFlag && <button type="button" className="btn-soft" disabled={isLoading("capitalFlag_" + id)} onClick={() => void onFlag(id)}>
      {isLoading("capitalFlag_" + id) ? <><BtnSpinnerDark />Flagging...</> : "Flag capital"}
    </button>}
    {status === "capital" && <button type="button" className="btn-soft" disabled={isLoading("capitalDecline_" + id)} onClick={() => void onDecline(id)}>
      {isLoading("capitalDecline_" + id) ? <><BtnSpinnerDark />Returning...</> : "Capital declined - restore field workflow"}
    </button>}
    {status === "pending_capital_completion" && <>
      <button type="button" className="btn-accent" disabled={hasOpenVisit || isLoading("capitalResume_" + id)} onClick={() => void onResume(id)}>
        {isLoading("capitalResume_" + id) ? <><BtnSpinner />Authorizing...</> : hasOpenVisit ? "Waiting for active visit checkout" : "Authorize & resume capital work"}
      </button>
      <button type="button" className="btn-accent" disabled={hasOpenVisit || isLoading("capitalComplete_" + id)} onClick={() => void onComplete(id)}>
        {isLoading("capitalComplete_" + id) ? <><BtnSpinner />Completing...</> : hasOpenVisit ? "Checkout required before completion" : "Capital Completed"}
      </button>
    </>}
  </>;
}
