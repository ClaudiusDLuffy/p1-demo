"use client";

import { useState } from "react";
import { Field } from "../../components/ui/Field";
import { Sel } from "../../components/ui/Sel";
import { Modal } from "../../components/ui/Modal";
import { DirectorySelect } from "../directory/DirectorySelect";
import { SCHEDULE_STATUSES, type ScheduleFilters as Filters } from "./scheduleQueryModel";

type Props = {
  filters: Filters;
  onChange: (filters: Filters) => void;
  isManager: boolean;
  canFilterTeam: boolean;
  onClear: () => void;
};

export function ScheduleFilters({ filters, onChange, isManager, canFilterTeam, onClear }: Props) {
  const [open, setOpen] = useState(false);
  const count = Number(filters.status !== "all") + Number(filters.priority !== "all")
    + Number(isManager && Boolean(filters.contractorId)) + Number(Boolean(filters.technicianId || filters.technicianName));
  return <div className="mb-3 grid min-w-0 gap-2">
    <div className="flex min-w-0 gap-2">
      <input type="search" aria-label="Search schedule" placeholder="Search WO, store or city…" maxLength={200}
        value={filters.search} onChange={event => onChange({ ...filters, search: event.target.value })}
        className="min-h-11 min-w-0 flex-1 rounded-lg border border-p1-border bg-p1-surface px-3 text-sm text-p1-ink" />
      <button type="button" className="btn-soft min-h-11 shrink-0" onClick={() => setOpen(true)}>Filters{count > 0 ? ` (${count})` : ""}</button>
    </div>
    {(count > 0 || filters.search) && <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-p1-muted">
      {filters.status !== "all" && <span>{SCHEDULE_STATUSES.find(([value]) => value === filters.status)?.[1]}</span>}
      {filters.priority !== "all" && <span>{filters.priority.toUpperCase()}</span>}
      {isManager && filters.contractorId && <span>Company selected</span>}
      {(filters.technicianId || filters.technicianName) && <span>Technician selected</span>}
      <button type="button" className="min-h-11 underline" onClick={onClear}>Clear filters</button>
    </div>}
    {open && <Modal title="Schedule filters" width={440} contentStyle={{ padding: 16, width: "100%" }} onRequestClose={() => setOpen(false)}>
      <div className="grid min-w-0 gap-3">
        <Field label="Work status"><Sel value={filters.status} onChange={event => onChange({ ...filters, status: event.target.value as Filters["status"] })}>
          {SCHEDULE_STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Sel></Field>
        <Field label="Priority"><Sel value={filters.priority} onChange={event => onChange({ ...filters, priority: event.target.value as Filters["priority"] })}>
          <option value="all">All priorities</option>
          {[1, 2, 3, 4, 5].map(priority => <option key={priority} value={`p${priority}`}>P{priority}</option>)}
        </Sel></Field>
        {isManager && <Field label="Company"><DirectorySelect domain="contractor_filter" value={filters.contractorId || ""}
          emptyLabel="All permitted companies" companyLabel
          onChange={event => onChange({ ...filters, contractorId: event.target.value || null, technicianId: null, technicianName: null, technicianDirectoryId: null })} /></Field>}
        {(isManager || canFilterTeam) && filters.contractorId && <Field label="Technician"><DirectorySelect
          domain="company_technicians" contractorId={filters.contractorId} technicianValues
          value={filters.technicianId || (filters.technicianDirectoryId ? `legacy:${filters.technicianDirectoryId}` : "")}
          selectedLabel={filters.technicianName || undefined} emptyLabel="All permitted technicians"
          onChange={(_event, item) => onChange({ ...filters, technicianId: item?.profileId || null, technicianName: item && !item.profileId ? item.name : null, technicianDirectoryId: item?.id || null })} /></Field>}
        <p className="m-0 text-xs text-p1-muted">Filters apply to all counts. Unscheduled work includes all dates.</p>
        <div className="flex flex-wrap justify-end gap-2 border-t border-p1-border-soft pt-3">
          <button type="button" className="btn-soft min-h-11" onClick={onClear}>Clear filters</button>
          <button type="button" className="btn-accent min-h-11" onClick={() => setOpen(false)}>Show results</button>
        </div>
      </div>
    </Modal>}
  </div>;
}
