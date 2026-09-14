"use client";

import { useState } from "react";
import { dispatchOperator, safeDispatchError } from "./contracts";
import { useCurrentDispatch } from "./queries";
import DispatchDeliveryReview from "./DispatchDeliveryReview";

export default function ReceivingDispatchStatus({ profile, workOrderId, assignmentVersion }: {
  profile: unknown; workOrderId: string; assignmentVersion: number;
}) {
  const query = useCurrentDispatch(profile, workOrderId, assignmentVersion);
  const [notice, setNotice] = useState("");
  if (!dispatchOperator(profile)) return null;
  return <section aria-label="Current contractor dispatch" style={{ padding: 16, marginBottom: 16, border: "1px solid #cbd5e1", borderRadius: 10 }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
      <h3 style={{ margin: 0 }}>Receiving dispatch</h3>
      <button className="btn-soft" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>Refresh delivery</button>
    </div>
    {query.isPending && <p role="status">Loading receiving dispatch…</p>}
    {query.isError && <p role="alert">{safeDispatchError(query.error).message}</p>}
    {notice && <p role="status">{notice}</p>}
    {query.data && !query.isError && (query.data.kind === "current" && query.data.delivery
      ? <DispatchDeliveryReview key={query.data.delivery.id} profile={profile} delivery={query.data.delivery} onNotice={setNotice} />
      : <p role={query.data.kind === "missing_intent" ? "alert" : undefined}>
        {query.data.kind === "legacy_untracked" ? "No tracked receiving-dispatch record for this earlier assignment."
          : query.data.kind === "unassigned" ? "No current receiving assignment."
            : "The current assignment is missing its required dispatch record. Contact operations support; no email can be sent from this screen."}
      </p>)}
  </section>;
}
