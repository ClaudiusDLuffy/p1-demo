"use client";

import { useMemo, useState } from "react";
import { safeErrorMessage } from "../../../lib/errors/normalizeUnknown";
import { T } from "../../../lib/constants";
import { useVaCoordinatorTeamManagement, useSaveVaCoordinatorTeam } from "./queries";
import type { VaCoordinatorPerson, VaCoordinatorTeam, VaCoordinatorTechnician } from "./contracts";

type Selection = Readonly<{ teamId: string | null; name: string; coordinatorIds: string[]; technicianIds: string[] }>;
const blankSelection: Selection = { teamId: null, name: "", coordinatorIds: [], technicianIds: [] };

export default function VaCoordinatorTeamManagement({ page, allowed, actorId }: { page: string; allowed: boolean; actorId: string }) {
  const open = page === "va_teams" && allowed;
  const directory = useVaCoordinatorTeamManagement(actorId, open);
  const save = useSaveVaCoordinatorTeam(actorId, directory.data);
  const [selection, setSelection] = useState<Selection>(blankSelection);
  const [editing, setEditing] = useState(false);
  const [filter, setFilter] = useState("");
  const [notice, setNotice] = useState("");

  const selectedTeam = directory.data?.teams.find(team => team.id === selection.teamId);
  const coordinatorOptions = mergeOptions(directory.data?.coordinators || [], selectedTeam?.coordinators || []);
  const technicianOptions = mergeOptions(directory.data?.technicians || [], selectedTeam?.technicians || []);
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const visibleCoordinators = useMemo(() => coordinatorOptions.filter(person => person.name.toLocaleLowerCase().includes(normalizedFilter)), [coordinatorOptions, normalizedFilter]);
  const visibleTechnicians = useMemo(() => technicianOptions.filter(person =>
    `${person.name} ${person.company || ""}`.toLocaleLowerCase().includes(normalizedFilter)), [technicianOptions, normalizedFilter]);

  if (!open) return null;

  const editTeam = (team: VaCoordinatorTeam) => {
    setEditing(true);
    setSelection({
      teamId: team.id,
      name: team.name,
      coordinatorIds: team.coordinators.map(person => person.id),
      technicianIds: team.technicians.map(person => person.id),
    });
    setFilter("");
    setNotice("");
    save.reset();
  };

  const startNewTeam = () => {
    setEditing(true);
    setSelection(blankSelection);
    setFilter("");
    setNotice("");
    save.reset();
  };

  const cancelEditing = () => {
    setEditing(false);
    setSelection(blankSelection);
    setFilter("");
    setNotice("");
    save.reset();
  };

  const toggle = (field: "coordinatorIds" | "technicianIds", id: string) => {
    setSelection(current => ({
      ...current,
      [field]: current[field].includes(id)
        ? current[field].filter(selected => selected !== id)
        : [...current[field], id],
    }));
    setNotice("");
  };

  const saveTeam = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice("");
    try {
      const result = await save.mutateAsync({
        teamId: selection.teamId,
        name: selection.name,
        coordinatorProfileIds: selection.coordinatorIds,
        technicianProfileIds: selection.technicianIds,
      });
      setSelection(current => ({ ...current, teamId: result.teamId }));
      setEditing(true);
      setNotice("Team access saved.");
    } catch (error) {
      setNotice(safeErrorMessage(error));
    }
  };

  return <main aria-label="VA team management" style={{ maxWidth: 1180, margin: "0 auto", padding: "24px clamp(16px, 4vw, 40px)" }}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 16, marginBottom: 20 }}>
      <div>
        <h1 style={{ fontSize: 24, lineHeight: 1.2, margin: 0 }}>VA team access</h1>
        <p style={{ color: T.muted, fontSize: 13, margin: "8px 0 0", maxWidth: 720 }}>
          Add VA coordinators to a team and choose the active technician accounts in that team. VAs can only see work orders currently assigned to those technicians.
        </p>
      </div>
      <button type="button" className="btn-primary" onClick={startNewTeam}>New team</button>
    </header>

    {directory.isPending && <p role="status" style={mutedStyle}>Loading VA teams…</p>}
    {directory.isError && <section role="alert" style={errorStyle}>
      {safeErrorMessage(directory.error)} <button type="button" className="btn-soft" onClick={() => void directory.refetch()}>Retry</button>
    </section>}

    {directory.data && <div className="va-coordinator-grid" style={{ display: "grid", gridTemplateColumns: "minmax(220px, .7fr) minmax(340px, 1.5fr)", gap: 18, alignItems: "start" }}>
      <section aria-label="Existing VA teams" style={panelStyle}>
        <h2 style={sectionHeading}>Teams</h2>
        {directory.data.teams.map(team => <button key={team.id} type="button" onClick={() => editTeam(team)}
          aria-current={selection.teamId === team.id ? "true" : undefined}
          style={{ ...teamButtonStyle, borderColor: selection.teamId === team.id ? T.accent : T.border,
            background: selection.teamId === team.id ? T.accentSoft : T.surface }}>
          <strong>{team.name}</strong>
          <span style={mutedStyle}>{team.coordinators.length} VA · {team.technicians.length} technicians</span>
        </button>)}
        {directory.data.teams.length === 0 && <p style={mutedStyle}>No active teams yet. Create one to grant team-scoped access.</p>}
      </section>

      <section aria-label="Edit VA team" style={panelStyle}>
        {!editing && <div style={{ color: T.muted, textAlign: "center", padding: 32 }}>
          Select a team to edit or choose New team.
        </div>}
        {editing && <form onSubmit={event => void saveTeam(event)}>
          <h2 style={sectionHeading}>{selection.teamId ? "Edit team" : "New team"}</h2>
          <label style={labelStyle} htmlFor="va-team-name">Team name</label>
          <input id="va-team-name" value={selection.name} maxLength={120} required
            onChange={event => setSelection(current => ({ ...current, name: event.target.value }))}
            style={inputStyle} />

          <label style={{ ...labelStyle, marginTop: 18 }} htmlFor="va-team-filter">Find coordinators or technicians</label>
          <input id="va-team-filter" type="search" value={filter} onChange={event => setFilter(event.target.value)}
            placeholder="Search by name or company" style={inputStyle} />

          <ChoiceGroup label="VA coordinators" count={selection.coordinatorIds.length}>
            {visibleCoordinators.map(person => <PersonChoice key={person.id} person={person}
              selected={selection.coordinatorIds.includes(person.id)} onToggle={() => toggle("coordinatorIds", person.id)} />)}
            {visibleCoordinators.length === 0 && <p style={mutedStyle}>No matching active VA coordinators.</p>}
          </ChoiceGroup>

          <ChoiceGroup label="Technicians whose work orders are visible" count={selection.technicianIds.length}>
            {visibleTechnicians.map(technician => <PersonChoice key={technician.id} person={technician}
              secondary={(technician as VaCoordinatorTechnician).company || "Contractor"}
              selected={selection.technicianIds.includes(technician.id)} onToggle={() => toggle("technicianIds", technician.id)} />)}
            {visibleTechnicians.length === 0 && <p style={mutedStyle}>No matching active technicians.</p>}
          </ChoiceGroup>

          {save.isError && <p role="alert" style={errorStyle}>{safeErrorMessage(save.error)}</p>}
          {notice && <p role="status" style={{ color: notice === "Team access saved." ? T.success : T.danger }}>{notice}</p>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button type="button" className="btn-soft" onClick={cancelEditing} disabled={save.isPending}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={save.isPending || !selection.name.trim()}>
              {save.isPending ? "Saving…" : "Save team access"}
            </button>
          </div>
        </form>}
      </section>
    </div>}
  </main>;
}

function ChoiceGroup({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  return <fieldset style={choiceGroupStyle}>
    <legend style={legendStyle}>{label} <span style={mutedStyle}>({count} selected)</span></legend>
    <div style={{ display: "grid", gap: 4, maxHeight: 240, overflowY: "auto" }}>{children}</div>
  </fieldset>;
}

function PersonChoice({ person, secondary, selected, onToggle }: {
  person: VaCoordinatorPerson | VaCoordinatorTechnician;
  secondary?: string;
  selected: boolean;
  onToggle: () => void;
}) {
  return <label style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 8px", borderRadius: 7,
    background: selected ? T.accentSoft : "transparent", cursor: "pointer", opacity: person.active ? 1 : 0.7 }}>
    <input type="checkbox" checked={selected} onChange={onToggle} />
    <span style={{ minWidth: 0 }}>
      <span style={{ display: "block", color: T.ink, fontSize: 13 }}>{person.name}{!person.active && " · Inactive (remove before saving)"}</span>
      {secondary && <span style={{ display: "block", color: T.muted, fontSize: 11 }}>{secondary}</span>}
    </span>
  </label>;
}

function mergeOptions<T extends VaCoordinatorPerson | VaCoordinatorTechnician>(active: T[], assigned: T[]): T[] {
  const options = new Map(active.map(person => [person.id, person]));
  for (const person of assigned) if (!options.has(person.id)) options.set(person.id, person);
  return [...options.values()].sort((left, right) => left.name.localeCompare(right.name));
}

const panelStyle = { background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18 };
const sectionHeading = { fontSize: 17, margin: "0 0 12px" };
const mutedStyle = { color: T.muted, fontSize: 12 };
const errorStyle = { color: T.danger, background: T.dangerSoft, border: `1px solid ${T.border}`, padding: 10, borderRadius: 8 };
const teamButtonStyle = { display: "grid", width: "100%", gap: 5, border: "1px solid", borderRadius: 8, padding: 11, marginBottom: 7, color: T.ink, textAlign: "left" as const, cursor: "pointer" };
const labelStyle = { display: "block", color: T.inkSoft, fontSize: 12, fontWeight: 600, marginBottom: 6 };
const inputStyle = { width: "100%", boxSizing: "border-box" as const, padding: "10px 11px", color: T.ink, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, font: "inherit" };
const choiceGroupStyle = { border: `1px solid ${T.border}`, borderRadius: 9, padding: 10, margin: "16px 0 0", minWidth: 0 };
const legendStyle = { color: T.ink, fontSize: 13, fontWeight: 700, padding: "0 5px" };
