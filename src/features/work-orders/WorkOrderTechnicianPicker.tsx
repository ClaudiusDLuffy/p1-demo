"use client";
import { useEffect, useRef, useState } from "react";
import { DirectorySelect } from "../directory/DirectorySelect";
import { loadDirectorySelection } from "../directory/api";
import { AppError } from "../../lib/errors/AppError";
import { safeErrorMessage } from "../../lib/errors/normalizeUnknown";
import { T } from "../../lib/constants";
import type { DirectoryActor } from "../directory/contracts";

export default function WorkOrderTechnicianPicker({ workOrder, actor, isManager, doAssignPortalTechnician, doSetTechnician }: {
  workOrder: { id: string; contractor?: string | null; assignedTechnicianProfileId?: string | null; technicianOnJob?: string | null };
  actor: DirectoryActor & { name?: string }; isManager: boolean;
  doAssignPortalTechnician: (id: string, profileId: string | null, name: string | null) => Promise<unknown>;
  doSetTechnician: (id: string, name: string) => Promise<unknown>;
}) {
  const canManage = actor?.canManageTeam === true;
  const canLead = actor?.canLeadTeam === true;
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => () => { pending.current?.abort(); }, [workOrder.id, workOrder.contractor]);
  const readOnly = isManager || (actor?.contractorAccessLevel === "report_only" && !canLead)
    || Boolean(actor?.contractorOrganizationId && !canManage && !canLead);
  return <div className="card" style={{ padding: 18, marginBottom: 16 }}>
    <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: .8, color: T.subtle, marginBottom: 10 }}>Technician on Job</div>
    {!readOnly && canManage ? <DirectorySelect domain="company_technicians" contractorId={workOrder.contractor} technicianValues disabled={busy}
      value={workOrder.assignedTechnicianProfileId || ""} selectedLabel={workOrder.technicianOnJob || undefined} emptyLabel="— Not set —"
      onChange={async (event, technician) => {
        if (pending.current) return;
        const controller = new AbortController(); pending.current = controller; setBusy(true); setError("");
        try {
          if (!event.target.value) {
            if (workOrder.assignedTechnicianProfileId) await doAssignPortalTechnician(workOrder.id, null, null);
            else await doSetTechnician(workOrder.id, "");
          } else if (technician) {
            const exact = await loadDirectorySelection("company_technicians", technician.id, workOrder.contractor, controller.signal);
            if (!exact || exact.profileId !== technician.profileId) throw new AppError("INVALID_REQUEST");
            controller.signal.throwIfAborted();
            if (exact.profileId) await doAssignPortalTechnician(workOrder.id, exact.profileId, exact.name);
            else {
              if (workOrder.assignedTechnicianProfileId && await doAssignPortalTechnician(workOrder.id, null, null) === false) return;
              controller.signal.throwIfAborted();
              await doSetTechnician(workOrder.id, exact.name);
            }
          }
        } catch (failure) { if (!controller.signal.aborted) setError(safeErrorMessage(failure)); }
        finally {
          if (pending.current === controller) pending.current = null;
          if (!controller.signal.aborted) setBusy(false);
        }
      }} /> : !readOnly && canLead ?
      <DirectorySelect domain="legacy_team" value={workOrder.assignedTechnicianProfileId || ""}
        selectedLabel={workOrder.technicianOnJob || undefined} emptyLabel="Choose a team member" disabled={busy}
        onChange={async (_event, technician) => {
          if (pending.current) return;
          const controller = new AbortController(); pending.current = controller; setBusy(true); setError("");
          try {
            const exact = technician ? await loadDirectorySelection("legacy_team", technician.id, null, controller.signal) : null;
            if (technician && !exact) throw new AppError("INVALID_REQUEST");
            controller.signal.throwIfAborted();
            if (!exact) throw new AppError("INVALID_REQUEST");
            await doAssignPortalTechnician(workOrder.id, exact.id, exact.name);
          } catch (failure) { if (!controller.signal.aborted) setError(safeErrorMessage(failure)); }
          finally {
            if (pending.current === controller) pending.current = null;
            if (!controller.signal.aborted) setBusy(false);
          }
        }} />
      : <div style={{ fontSize: 14, fontWeight: 500, color: workOrder.technicianOnJob ? T.ink : T.subtle }}>
        {(!readOnly && actor?.contractorTier === "contracted" ? actor.name : workOrder.technicianOnJob) || "(not set)"}
      </div>}
    {error && <div role="alert" style={{ color: T.danger, fontSize: 12, marginTop: 8 }}>{error}</div>}
  </div>;
}
