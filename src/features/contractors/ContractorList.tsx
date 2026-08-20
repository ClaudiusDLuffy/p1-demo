"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Avatar } from "../../components/ui/Avatar";
import { Modal } from "../../components/ui/Modal";
import { T } from "../../lib/constants";
import { supabase } from "../../lib/supabase/client";
import {
  CONTRACTOR_WORKLOAD_SUMMARY_KEY,
  PROFILES_KEY,
  TECHNICIANS_KEY,
  WORK_ORDERS_KEY,
  useContractorWorkloadSummaryQuery,
} from "../work-orders/queries";

type ContractorProfile = {
  id: string;
  name: string;
  initials: string;
  company?: string | null;
  territory?: string | null;
  trades?: string[] | null;
  color: string;
};

type PortalProfile = {
  id: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  active?: boolean | null;
  contractorAccessLevel?: string | null;
};

type ContractorTechnician = {
  id: string;
  contractorId: string;
  profileId?: string | null;
  name?: string | null;
  isActive?: boolean | null;
};

type ContractorWorkOrder = {
  contractor?: string | null;
  status: string;
};

type TechnicianRequestPayload = {
  emailDelivery?: "invitation" | "recovery" | "none";
  warning?: string | null;
};

type ContractorListProps = {
  page: string;
  isManager: boolean;
  contractorsOnly: ContractorProfile[];
  technicians?: ContractorTechnician[];
  users?: PortalProfile[];
  workOrders?: ContractorWorkOrder[];
  activeStatuses: readonly string[];
  nav: (page: string) => void;
  setFilterC: (contractorId: string) => void;
  fire?: (message: string) => void;
};

type DeactivateTarget = ContractorTechnician & {
  profile?: PortalProfile | null;
};

const objectPayload = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

async function technicianRequest(init: RequestInit): Promise<TechnicianRequestPayload> {
  const sb = supabase();
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session expired. Sign in again.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");
  const response = await fetch("/api/contractor-technicians/manage", {
    ...init,
    headers,
  });
  const payload = objectPayload(await response.json().catch(() => ({})));
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : "Technician request failed",
    );
  }
  return {
    emailDelivery: payload.emailDelivery === "invitation"
      || payload.emailDelivery === "recovery"
      || payload.emailDelivery === "none"
      ? payload.emailDelivery
      : undefined,
    warning: typeof payload.warning === "string" ? payload.warning : null,
  };
}

const emptyForm = {
  contractorId: "",
  profileId: "",
  name: "",
  email: "",
  phone: "",
  accessLevel: "report_only",
};

export default function ContractorList(props: ContractorListProps) {
  const {
    page,
    isManager,
    contractorsOnly,
    technicians = [],
    users = [],
    workOrders = [],
    activeStatuses,
    nav,
    setFilterC,
    fire,
  } = props;
  const queryClient = useQueryClient();
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [deactivateTarget, setDeactivateTarget] = useState<DeactivateTarget | null>(null);
  const [deactivating, setDeactivating] = useState(false);
  const workloadQuery = useContractorWorkloadSummaryQuery(
    page === "contractors" && isManager,
  );

  const profilesById = useMemo<Map<string, PortalProfile>>(
    () => new Map(users.map(profile => [profile.id, profile])),
    [users],
  );
  const workOrdersByContractor = useMemo(() => {
    const grouped: Record<string, ContractorWorkOrder[]> = {};
    for (const workOrder of workOrders) {
      if (!workOrder.contractor) continue;
      (grouped[workOrder.contractor] ||= []).push(workOrder);
    }
    return grouped;
  }, [workOrders]);
  const techniciansByContractor = useMemo(() => {
    const grouped: Record<string, ContractorTechnician[]> = {};
    for (const technician of technicians) {
      if (!technician.contractorId) continue;
      (grouped[technician.contractorId] ||= []).push(technician);
    }
    for (const team of Object.values(grouped)) {
      team.sort((left, right) =>
        Number(right.isActive) - Number(left.isActive)
        || String(left.name || "").localeCompare(String(right.name || "")),
      );
    }
    return grouped;
  }, [technicians]);
  const fallbackContractorCounts = useMemo(() => {
    const counts: Record<string, { active: number; capital: number }> = {};
    for (const contractor of contractorsOnly) {
      const contractorWorkOrders = workOrdersByContractor[contractor.id] || [];
      counts[contractor.id] = {
        active: contractorWorkOrders.filter(workOrder => activeStatuses.includes(workOrder.status)).length,
        capital: contractorWorkOrders.filter(workOrder =>
          ["capital", "pending_capital_completion"].includes(workOrder.status),
        ).length,
      };
    }
    return counts;
  }, [activeStatuses, contractorsOnly, workOrdersByContractor]);
  const contractorCounts = workloadQuery.data || fallbackContractorCounts;

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: PROFILES_KEY }),
      queryClient.invalidateQueries({ queryKey: TECHNICIANS_KEY }),
      queryClient.invalidateQueries({ queryKey: WORK_ORDERS_KEY }),
      queryClient.invalidateQueries({ queryKey: CONTRACTOR_WORKLOAD_SUMMARY_KEY }),
    ]);
  };

  const openAdd = (contractor: ContractorProfile) => {
    setError("");
    setForm({ ...emptyForm, contractorId: contractor.id });
  };

  const openEdit = (
    contractor: ContractorProfile,
    technician: ContractorTechnician,
  ) => {
    const profile = technician.profileId
      ? profilesById.get(technician.profileId)
      : null;
    setError("");
    setForm({
      contractorId: contractor.id,
      profileId: technician.profileId || "",
      name: profile?.name || technician.name || "",
      email: profile?.email || "",
      phone: profile?.phone || "",
      accessLevel: profile?.contractorAccessLevel || "report_only",
    });
  };

  const saveTechnician = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = await technicianRequest({
        method: "POST",
        body: JSON.stringify(form),
      });
      await invalidate();
      setForm(emptyForm);
      const delivery = payload.emailDelivery === "invitation"
        ? " Invitation sent."
        : payload.emailDelivery === "recovery"
          ? " Reactivation email sent."
          : "";
      fire?.(`Technician access saved.${delivery}`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save technician");
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async () => {
    if (!deactivateTarget?.profileId) return;
    setDeactivating(true);
    setError("");
    try {
      const payload = await technicianRequest({
        method: "DELETE",
        body: JSON.stringify({ profileId: deactivateTarget.profileId }),
      });
      await invalidate();
      setDeactivateTarget(null);
      fire?.(payload.warning || "Technician access deactivated; history was preserved.");
    } catch (deactivateError) {
      setError(deactivateError instanceof Error
        ? deactivateError.message
        : "Could not deactivate technician");
    } finally {
      setDeactivating(false);
    }
  };

  if (page !== "contractors" || !isManager) return null;

  return (
    <>
      <div className="contractors-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, animation: "fadeUp 0.3s" }}>
        {contractorsOnly.map((contractor, index) => {
          const counts = contractorCounts[contractor.id] || { active: 0, capital: 0 };
          const team = techniciansByContractor[contractor.id] || [];
          const activeTeamCount = team.filter(technician => technician.isActive).length;
          return (
            <div key={contractor.id} className="card card-hover" style={{ overflow: "hidden", animation: `fadeUp 0.35s ${index * 0.04}s both` }}>
              <div style={{ padding: "20px 20px 15px", borderBottom: `1px solid ${T.borderSoft}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <Avatar initials={contractor.initials} color={contractor.color} size={46} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: T.ink }}>{contractor.name}</div>
                    <div style={{ fontSize: 12, color: T.muted }}>{contractor.company}</div>
                    <div style={{ fontSize: 11, color: T.subtle, marginTop: 3 }}>{contractor.territory}</div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 5, marginTop: 12, flexWrap: "wrap" }}>
                  {(contractor.trades || []).map((trade: string) => (
                    <span key={trade} style={{ fontSize: 10, fontWeight: 600, color: T.accent, background: T.accentSoft, padding: "2px 8px", borderRadius: 10, textTransform: "capitalize" }}>{trade}</span>
                  ))}
                </div>
              </div>

              <div style={{ padding: "13px 20px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, borderBottom: `1px solid ${T.borderSoft}` }}>
                {[
                  ["Active", counts.active, T.accent],
                  ["Capital", counts.capital, T.violet],
                  ["Team", activeTeamCount, T.success],
                ].map(([label, value, color]) => (
                  <div key={String(label)}>
                    <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.7, color: T.subtle, marginBottom: 3 }}>{label}</div>
                    <div className="display" style={{ fontSize: 19, fontWeight: 500, color: String(color) }}>{value}</div>
                  </div>
                ))}
              </div>

              <div style={{ padding: "14px 20px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 9 }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: T.ink, textTransform: "uppercase", letterSpacing: 0.7 }}>Technicians</div>
                  <button type="button" className="btn-soft" onClick={() => openAdd(contractor)} style={{ minHeight: 30, padding: "5px 9px", fontSize: 10 }}>+ Add</button>
                </div>
                <div style={{ display: "grid", gap: 6 }}>
                  {team.map(technician => {
                    const profile = technician.profileId
                      ? profilesById.get(technician.profileId)
                      : null;
                    const isActive = technician.isActive && profile?.active !== false;
                    const access = profile?.contractorAccessLevel;
                    return (
                      <div key={technician.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "8px 9px", borderRadius: 8, background: T.surfaceSoft, border: `1px solid ${T.borderSoft}` }}>
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: "block", color: isActive ? T.ink : T.subtle, fontSize: 11, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis" }}>{profile?.name || technician.name}</span>
                          <span style={{ display: "block", color: T.subtle, fontSize: 9, marginTop: 2 }}>
                            {!technician.profileId
                              ? "Legacy record"
                              : `${access === "invoice" ? "Invoice + field" : "Field reporting"}${isActive ? "" : " · Inactive"}`}
                          </span>
                        </span>
                        {technician.profileId && (
                          <span style={{ display: "flex", gap: 5 }}>
                            <button type="button" className="btn-soft" onClick={() => openEdit(contractor, technician)} style={{ minHeight: 28, padding: "4px 7px", fontSize: 9 }}>{isActive ? "Edit" : "Reactivate"}</button>
                            {isActive && <button type="button" className="btn-soft" onClick={() => setDeactivateTarget({ ...technician, profile })} style={{ minHeight: 28, padding: "4px 7px", color: T.danger, fontSize: 9 }}>Remove</button>}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {team.length === 0 && <div style={{ color: T.subtle, fontSize: 10 }}>No individual technicians yet.</div>}
                </div>
              </div>

              <div style={{ padding: "0 20px 18px" }}>
                <button onClick={() => { nav("work_orders"); setFilterC(contractor.id); }} className="btn-soft" style={{ width: "100%" }}>View work orders →</button>
              </div>
            </div>
          );
        })}
      </div>

      {form.contractorId && (
        <Modal onClose={() => { if (!saving) setForm(emptyForm); }} title={form.profileId ? "Edit technician access" : "Invite technician"} width={500}>
          <form onSubmit={saveTechnician} style={{ display: "grid", gap: 12 }}>
            <label style={{ color: T.muted, fontSize: 10 }}>Name
              <input required value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} style={{ display: "block", width: "100%", minHeight: 42, marginTop: 5, padding: "9px 11px", border: `1px solid ${T.border}`, borderRadius: 8 }} />
            </label>
            <label style={{ color: T.muted, fontSize: 10 }}>Email
              <input required type="email" readOnly={Boolean(form.profileId)} value={form.email} onChange={event => setForm(current => ({ ...current, email: event.target.value }))} style={{ display: "block", width: "100%", minHeight: 42, marginTop: 5, padding: "9px 11px", border: `1px solid ${T.border}`, borderRadius: 8, background: form.profileId ? T.surfaceSoft : T.surface }} />
            </label>
            <label style={{ color: T.muted, fontSize: 10 }}>Phone (optional)
              <input type="tel" value={form.phone} onChange={event => setForm(current => ({ ...current, phone: event.target.value }))} style={{ display: "block", width: "100%", minHeight: 42, marginTop: 5, padding: "9px 11px", border: `1px solid ${T.border}`, borderRadius: 8 }} />
            </label>
            <label style={{ color: T.muted, fontSize: 10 }}>Access
              <select value={form.accessLevel} onChange={event => setForm(current => ({ ...current, accessLevel: event.target.value }))} style={{ display: "block", width: "100%", minHeight: 42, marginTop: 5, padding: "9px 11px", border: `1px solid ${T.border}`, borderRadius: 8, background: T.surface }}>
                <option value="report_only">Field reporting only</option>
                <option value="invoice">Invoice and field reporting</option>
              </select>
            </label>
            {!form.profileId && <div style={{ color: T.subtle, fontSize: 10, lineHeight: 1.5 }}>Supabase will email an invitation. This account will belong only to the selected contractor company and will not be assignable as a separate contractor.</div>}
            {error && <div role="alert" style={{ color: T.danger, fontSize: 10 }}>{error}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn-soft" disabled={saving} onClick={() => setForm(emptyForm)}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={saving} style={{ opacity: saving ? 0.65 : 1 }}>{saving ? "Saving…" : form.profileId ? "Save access" : "Send invitation"}</button>
            </div>
          </form>
        </Modal>
      )}

      {deactivateTarget && (
        <Modal onClose={() => { if (!deactivating) setDeactivateTarget(null); }} title="Remove technician access" width={440}>
          <div style={{ color: T.muted, fontSize: 12, lineHeight: 1.55 }}>
            Deactivate <strong style={{ color: T.ink }}>{deactivateTarget.profile?.name || deactivateTarget.name}</strong>? Their login and current job access will be removed. Work-order, invoice, and assignment history will remain intact.
          </div>
          {error && <div role="alert" style={{ marginTop: 10, color: T.danger, fontSize: 10 }}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
            <button type="button" className="btn-soft" disabled={deactivating} onClick={() => setDeactivateTarget(null)}>Cancel</button>
            <button type="button" disabled={deactivating} onClick={deactivate} style={{ padding: "9px 14px", border: 0, borderRadius: 9, background: T.danger, color: "white", fontFamily: "inherit", fontWeight: 700, cursor: deactivating ? "default" : "pointer", opacity: deactivating ? 0.65 : 1 }}>{deactivating ? "Removing…" : "Deactivate access"}</button>
          </div>
        </Modal>
      )}
    </>
  );
}
