"use client";

import { apiFetch } from "../../lib/errors/apiFetch";
import { safeErrorMessage } from "../../lib/errors/normalizeUnknown";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Avatar } from "../../components/ui/Avatar";
import { Modal } from "../../components/ui/Modal";
import { T } from "../../lib/constants";
import { supabase } from "../../lib/supabase/client";
import { isPortalVisible } from "../../lib/realtime/browserVisibility";
import { DIRECTORY_KEY, directoryScopeKey, isDirectoryId, type DirectoryItem } from "../directory/contracts";
import { useDirectoryActor, useDirectoryPage } from "../directory/queries";
import { loadDirectorySelection } from "../directory/api";
import { DirectoryError, DirectoryPageControls } from "../directory/DirectorySelect";
import { useUnsavedChangesGuard } from "../../lib/forms/useUnsavedChangesGuard";

type ContractorProfile = DirectoryItem;
type ContractorTechnician = DirectoryItem;

type TechnicianRequestPayload = {
  emailDelivery?: "invitation" | "recovery" | "none";
  warning?: string | null;
  profileId: string | null;
  contractorId: string | null;
};

type ContractorListProps = {
  page: string;
  isManager: boolean;
  nav: (page: string) => void;
  setFilterC: (contractorId: string) => void;
  fire?: (message: string) => void;
};

type DeactivateTarget = ContractorTechnician;

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
  const response = await apiFetch("/api/contractor-technicians/manage", {
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
  const technician = objectPayload(payload.technician);
  return {
    profileId: isDirectoryId(technician.profileId) ? technician.profileId : null,
    contractorId: isDirectoryId(technician.contractorId) ? technician.contractorId : null,
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

function ContractorTeam({ contractor, onEdit, onDeactivate, opening }: {
  contractor: ContractorProfile;
  onEdit: (contractor: ContractorProfile, technician: ContractorTechnician) => void;
  onDeactivate: (technician: ContractorTechnician) => void;
  opening: string;
}) {
  const directory = useDirectoryPage("technician_management", true, contractor.id);
  return <section aria-label={`${contractor.name} technicians`}>
    <input type="search" value={directory.search} onChange={event => directory.setSearch(event.target.value)}
      aria-label={`Search ${contractor.name} technicians`} placeholder="Search technicians…" style={{ width: "100%", padding: 8, marginBottom: 8 }} />
    <DirectoryError directory={directory} />
    <div style={{ display: "grid", gap: 6 }}>
      {!directory.isError && directory.items.map(technician => {
        const isActive = technician.isActive && technician.profileActive !== false;
        return <div key={technician.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "8px 9px", borderRadius: 8, background: T.surfaceSoft, border: `1px solid ${T.borderSoft}` }}>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: "block", color: isActive ? T.ink : T.subtle, fontSize: 11, fontWeight: 700 }}>{technician.name}</span>
            <span style={{ display: "block", color: T.subtle, fontSize: 9, marginTop: 2 }}>
              {!technician.profileId ? "Legacy record" : `${technician.contractorAccessLevel === "invoice" ? "Invoice + field" : "Field reporting"}${isActive ? "" : " · Inactive"}`}
            </span>
          </span>
          {technician.profileId && <span style={{ display: "flex", gap: 5 }}>
            <button type="button" className="btn-soft" disabled={Boolean(opening)} onClick={() => onEdit(contractor, technician)}
              style={{ minHeight: 28, padding: "4px 7px", fontSize: 9 }}>{opening === technician.id ? "Loading…" : isActive ? "Edit" : "Reactivate"}</button>
            {isActive && <button type="button" className="btn-soft" onClick={() => onDeactivate(technician)}
              style={{ minHeight: 28, padding: "4px 7px", color: T.danger, fontSize: 9 }}>Remove</button>}
          </span>}
        </div>;
      })}
      {!directory.waiting && !directory.isError && directory.items.length === 0 && <div role="status" style={{ color: T.subtle, fontSize: 10 }}>No matching technicians on this page.</div>}
    </div>
    <DirectoryPageControls directory={directory} />
  </section>;
}

export default function ContractorList(props: ContractorListProps) {
  const {
    page,
    isManager,
    nav,
    setFilterC,
    fire,
  } = props;
  const queryClient = useQueryClient();
  const actorScope = directoryScopeKey(useDirectoryActor());
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [deactivateTarget, setDeactivateTarget] = useState<DeactivateTarget | null>(null);
  const [deactivating, setDeactivating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [opening, setOpening] = useState("");
  const [formBaseline, setFormBaseline] = useState(emptyForm);
  const dismissal = useUnsavedChangesGuard({ enabled: Boolean(form.contractorId),
    dirty: JSON.stringify(form) !== JSON.stringify(formBaseline), busy: saving,
    onClose: () => { setForm(emptyForm); setError(""); } });
  const detailAbort = useRef<AbortController | null>(null);
  useEffect(() => () => detailAbort.current?.abort(), []);
  const directory = useDirectoryPage("contractor_directory", page === "contractors" && isManager);

  const invalidate = async (companyId: string, profileId: string | null) => {
    const scope = JSON.stringify(actorScope);
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: [...DIRECTORY_KEY, actorScope],
        predicate: ({ queryKey }) => {
          if (JSON.stringify(queryKey[1]) !== scope) return false;
          const kind = queryKey[2];
          const domain = queryKey[3];
          if (kind === "page") {
            // Renames, invitations and activation change contact/filter search
            // membership; card counts change without loading another company.
            if (["contractor_directory", "contacts", "contractor_filter"].includes(String(domain))) return true;
            return ["company_technicians", "technician_management"].includes(String(domain)) && queryKey[4] === companyId;
          }
          if (kind === "selection") {
            if (["company_technicians", "technician_management", "technician_detail", "technician_profile"].includes(String(domain))) {
              return queryKey[4] === companyId;
            }
            if (domain === "contractor_directory" && queryKey[5] === companyId) return true;
            return Boolean(profileId && queryKey[5] === profileId
              && ["profile_labels", "contact_detail", "contacts", "contractor_filter"].includes(String(domain)));
          }
          return kind === "labels" && Boolean(profileId && Array.isArray(queryKey[3]) && queryKey[3].includes(profileId));
        },
        refetchType: isPortalVisible() ? "active" : "none",
      }, { cancelRefetch: false }),
    ]);
  };

  const openAdd = (contractor: ContractorProfile) => {
    detailAbort.current?.abort();
    setOpening("");
    setError("");
    const nextForm = { ...emptyForm, contractorId: contractor.id };
    setFormBaseline(nextForm);
    setForm(nextForm);
  };

  const openEdit = async (
    contractor: ContractorProfile,
    technician: ContractorTechnician,
  ) => {
    detailAbort.current?.abort();
    const controller = new AbortController();
    detailAbort.current = controller;
    setOpening(technician.id);
    setError("");
    try {
      const profile = await loadDirectorySelection("technician_detail", technician.id, contractor.id,
        AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]));
      if (controller.signal.aborted) return;
      if (!profile?.profileId) { setError("Technician access is no longer available. Refresh the directory."); return; }
      const nextForm = { contractorId: contractor.id, profileId: profile.profileId, name: profile.name,
        email: profile.email || "", phone: profile.phone || "", accessLevel: profile.contractorAccessLevel || "report_only" };
      setFormBaseline(nextForm);
      setForm(nextForm);
    } catch (cause) { if (!controller.signal.aborted) setError(safeErrorMessage(cause)); }
    finally { if (!controller.signal.aborted) setOpening(""); }
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
      await invalidate(payload.contractorId || form.contractorId, payload.profileId || form.profileId || null);
      setForm(emptyForm);
      const delivery = payload.emailDelivery === "invitation"
        ? " Invitation sent."
        : payload.emailDelivery === "recovery"
          ? " Reactivation email sent."
          : "";
      fire?.(`Technician access saved.${delivery}`);
    } catch (saveError) {
      setError(safeErrorMessage(saveError));
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
      await invalidate(payload.contractorId || deactivateTarget.contractorId || "", payload.profileId || deactivateTarget.profileId);
      setDeactivateTarget(null);
      fire?.(payload.warning || "Technician access deactivated; history was preserved.");
    } catch (deactivateError) {
      setError(safeErrorMessage(deactivateError));
    } finally {
      setDeactivating(false);
    }
  };

  if (page !== "contractors" || !isManager) return null;

  return (
    <>
      <input type="search" value={directory.search} onChange={event => directory.setSearch(event.target.value)}
        aria-label="Search contractors" placeholder="Search contractor or company…" style={{ width: "100%", padding: 10, marginBottom: 12 }} />
      <DirectoryError directory={directory} />
      {error && !form.contractorId && !deactivateTarget && <div role="alert" style={{ color: T.danger }}>{error}</div>}
      <div className="contractors-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, animation: "fadeUp 0.3s" }}>
        {!directory.isError && directory.items.map((contractor, index) => {
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
                  ["Active", contractor.activeCount ?? 0, T.accent],
                  ["Capital", contractor.capitalCount ?? 0, T.violet],
                  ["Team", contractor.teamActiveCount ?? 0, T.success],
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
                <button type="button" className="btn-soft" aria-expanded={expanded === contractor.id}
                  onClick={() => setExpanded(current => current === contractor.id ? null : contractor.id)}>
                  {expanded === contractor.id ? "Hide technicians" : "View technicians"}
                </button>
                {expanded === contractor.id && <ContractorTeam contractor={contractor} onEdit={openEdit} onDeactivate={setDeactivateTarget} opening={opening} />}
              </div>

              <div style={{ padding: "0 20px 18px" }}>
                <button onClick={() => { nav("work_orders"); setFilterC(contractor.id); }} className="btn-soft" style={{ width: "100%" }}>View work orders →</button>
              </div>
            </div>
          );
        })}
      </div>
      {!directory.waiting && !directory.isError && directory.items.length === 0 && <div role="status">No matching contractors on this page.</div>}
      <DirectoryPageControls directory={directory} />

      {form.contractorId && (
        <Modal onRequestClose={dismissal.requestClose} dismissDisabled={saving} title={form.profileId ? "Edit technician access" : "Invite technician"} width={500}>
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
              <button type="button" className="btn-soft" disabled={saving} onClick={() => dismissal.requestClose("cancel_button")}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={saving} style={{ opacity: saving ? 0.65 : 1 }}>{saving ? "Saving…" : form.profileId ? "Save access" : "Send invitation"}</button>
            </div>
          </form>
        </Modal>
      )}

      {deactivateTarget && (
        <Modal onClose={() => { if (!deactivating) setDeactivateTarget(null); }} dismissDisabled={deactivating} title="Remove technician access" width={440}>
          <div style={{ color: T.muted, fontSize: 12, lineHeight: 1.55 }}>
            Deactivate <strong style={{ color: T.ink }}>{deactivateTarget.name}</strong>? Their login and current job access will be removed. Work-order, invoice, and assignment history will remain intact.
          </div>
          {error && <div role="alert" style={{ marginTop: 10, color: T.danger, fontSize: 10 }}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
            <button type="button" className="btn-soft" disabled={deactivating} onClick={() => setDeactivateTarget(null)}>Cancel</button>
            <button type="button" disabled={deactivating} onClick={deactivate} style={{ padding: "9px 14px", border: 0, borderRadius: 9, background: T.danger, color: "white", fontFamily: "inherit", fontWeight: 700, cursor: deactivating ? "default" : "pointer", opacity: deactivating ? 0.65 : 1 }}>{deactivating ? "Removing…" : "Deactivate access"}</button>
          </div>
        </Modal>
      )}
      {dismissal.dialog}
    </>
  );
}
