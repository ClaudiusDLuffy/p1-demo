"use client";

import { Badge } from "../../components/ui/Badge";
import { FUNCTIONAL_STATUS, STATUS, T } from "../../lib/constants";

const PORTAL_STATUS_HELP = [
  ["unassigned", "Received and waiting for a contractor."],
  ["assigned", "Dispatched; field work has not started."],
  ["wip", "Contractor is actively working the call."],
  ["parts", "Field work is paused while parts are awaited."],
  ["completed", "Field work is complete; P1 must finish the billing handoff."],
  ["pending_invoice", "Ready for P1 to submit the completed call to 7-Eleven."],
  ["pending_approval", "An invoice is waiting for P1 review."],
  ["capital", "Capital quote preparation or approval is in progress."],
  ["pending_capital_completion", "Capital work was approved and is awaiting final completion."],
  ["closed", "P1 completed the portal workflow."],
] as const;

const FSM_STATUS_HELP = [
  ["Dispatched", "7-Eleven shows the call as dispatched."],
  ["Work in Progress", "7-Eleven shows field work in progress."],
  ["Awaiting Parts", "7-Eleven shows the call paused for parts."],
  ["Completed", "7-Eleven FSM reports operational completion."],
  ["Cancelled", "7-Eleven FSM reports the call cancelled."],
] as const;

export default function WorkOrderStatusLegend() {
  return (
    <details className="card" style={{ marginBottom: 14, padding: "10px 14px", borderColor: T.borderSoft }}>
      <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 800, color: T.ink }}>
        Status legend: portal workflow vs. 7-Eleven FSM
      </summary>
      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 18 }}>
        <section>
          <div style={{ fontSize: 11, fontWeight: 800, color: T.ink, marginBottom: 8 }}>Portal workflow</div>
          <div style={{ display: "grid", gap: 8 }}>
            {PORTAL_STATUS_HELP.map(([status, description]) => (
              <div key={status} style={{ display: "grid", gridTemplateColumns: "minmax(120px, auto) 1fr", gap: 9, alignItems: "center", fontSize: 11 }}>
                <Badge conf={STATUS[status]} small />
                <span style={{ color: T.muted }}>{description}</span>
              </div>
            ))}
          </div>
        </section>
        <section>
          <div style={{ fontSize: 11, fontWeight: 800, color: T.ink, marginBottom: 8 }}>7-Eleven FSM status</div>
          <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.5, marginBottom: 8 }}>
            This is the external operational status from 7-Eleven. It is intentionally separate from P1&apos;s billing and closeout workflow.
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {FSM_STATUS_HELP.map(([status, description]) => (
              <div key={status} style={{ display: "grid", gridTemplateColumns: "minmax(120px, auto) 1fr", gap: 9, alignItems: "center", fontSize: 11 }}>
                <Badge conf={{ label: status, ...(FUNCTIONAL_STATUS[status] || { color: T.muted, bg: T.borderSoft }) }} small />
                <span style={{ color: T.muted }}>{description}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </details>
  );
}
