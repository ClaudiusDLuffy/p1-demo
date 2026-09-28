"use client";

import { useCallback, useState, type DragEvent } from "react";
import type { PortalAuthProfile } from "../auth/authProfile";
import type { WorkOrderReadModel } from "../work-orders/data/workOrderReadContracts";
import { PendingScheduleWork } from "./PendingScheduleWork";
import { ScheduleCalendar } from "./ScheduleCalendar";
import { ScheduleDialog } from "./ScheduleDialog";
import { ScheduleFilters } from "./ScheduleFilters";
import { addDays, addMonths, toDateKey, type CalendarView } from "./scheduleModel";
import { visibleScheduleRange, type ScheduleFilters as Filters } from "./scheduleQueryModel";
import { useScheduleData } from "./useScheduleData";
import { ScheduleCapacityError } from "./scheduleReadRepository";
import { useWorkOrderScheduling } from "./useWorkOrderScheduling";
import { BetaBadge } from "../../components/ui/BetaBadge";

type MyScheduleProps = {
  active: boolean;
  currentUser: PortalAuthProfile;
  isManager: boolean;
  onOpenWorkOrder: (workOrderId: string) => void;
};
const SUMMARY_CARD = "grid min-w-0 gap-[5px] rounded-xl border border-p1-border bg-p1-surface px-[7px] py-[9px] text-left text-p1-muted min-[481px]:p-[11px] min-[701px]:px-4 min-[701px]:py-3.5";
const SUMMARY_VALUE = "font-display text-[22px] leading-none font-normal text-p1-ink min-[481px]:text-[25px] min-[701px]:text-[29px]";

export default function MySchedule({ active, currentUser, isManager, onOpenWorkOrder }: MyScheduleProps) {
  const [view, setView] = useState<CalendarView>("month");
  const [activeDate, setActiveDate] = useState(() => toDateKey(new Date()));
  const [pendingOpen, setPendingOpen] = useState(false);
  const defaults: Filters = { search: "", status: "all", priority: "all", technicianId: null, technicianName: null,
    contractorId: isManager ? null : currentUser.contractorAccountId || currentUser.id };
  const [filters, setFilters] = useState<Filters>(defaults);
  const [pendingPage, setPendingPage] = useState(0);
  // Non-staff scope cannot be widened by presentation state. RLS still decides
  // access, including technician/team boundaries, for every read and count.
  const effectiveFilters = { ...filters, contractorId: isManager ? filters.contractorId : defaults.contractorId };
  const range = visibleScheduleRange(activeDate, view);
  const { calendar, pending, unscheduled, progress } = useScheduleData(effectiveFilters, range, pendingPage, pendingOpen, active, currentUser);
  const updateFilters = (next: Filters) => { setFilters(next); setPendingPage(0); };
  const handleScheduled = useCallback((date: string) => {
    setActiveDate(date); setView("day"); setPendingOpen(false); setPendingPage(0);
  }, []);
  const scheduler = useWorkOrderScheduling({ onScheduled: handleScheduled });
  const moveCalendar = useCallback((direction: -1 | 1) => {
    setActiveDate(current => view === "month" ? addMonths(current, direction) : addDays(current, direction * (view === "week" ? 7 : 1)));
  }, [view]);
  const dropPending = (event: DragEvent, date: string) => {
    event.preventDefault();
    const workOrder = pending.data?.items.find(item => item.id === event.dataTransfer.getData("text/work-order-id"));
    if (workOrder) scheduler.open(workOrder, date);
  };
  const openScheduler = (workOrder: WorkOrderReadModel) => scheduler.open(workOrder, activeDate);
  const summaryFailed = unscheduled.isError || progress.isError;
  if (!active) return null;

  return <section className="animate-fade-up min-w-0" aria-labelledby="my-schedule-heading">
    <header className="mb-[18px] flex flex-col items-stretch gap-2.5 min-[701px]:flex-row min-[701px]:items-end min-[701px]:justify-between">
      <div className="min-w-0">
        <span className="text-[10px] font-extrabold tracking-[.9px] text-p1-accent uppercase">Field planning</span>
        <div className="flex flex-wrap items-center gap-2">
          <h1 id="my-schedule-heading" className="my-1 font-display text-[30px] leading-tight font-normal tracking-[-.7px] text-p1-ink min-[701px]:text-[42px]">My Schedule</h1>
          <BetaBadge />
        </div>
        <p className="m-0 max-w-[760px] leading-[1.55] text-p1-muted">ETAs in each store&apos;s local time. Open a job to start, pause or complete work.</p>
      </div>
      <button type="button" className="btn-soft shrink-0" onClick={() => setActiveDate(toDateKey(new Date()))}>Today</button>
    </header>
    <ScheduleFilters filters={effectiveFilters} onChange={updateFilters} isManager={isManager}
      canFilterTeam={Boolean(currentUser.canManageTeam || currentUser.canLeadTeam)} onClear={() => updateFilters(defaults)} />
    <div className="mb-3.5 grid grid-cols-3 gap-1.5 min-[701px]:gap-2.5">
      <button type="button" className={SUMMARY_CARD} onClick={() => setPendingOpen(current => !current)} aria-expanded={pendingOpen} aria-controls="pending-schedule-work">
        <span className="text-[10px] font-extrabold tracking-wide uppercase">Unscheduled</span>
        <strong className={SUMMARY_VALUE}>{unscheduled.isError ? "—" : unscheduled.data ?? "…"}</strong>
        <small className="text-[11px] text-p1-subtle">{pendingOpen ? "Hide work" : "Show work"}</small>
      </button>
      <div className={SUMMARY_CARD}>
        <span className="text-[10px] font-extrabold tracking-wide uppercase">Scheduled</span>
        <strong className={SUMMARY_VALUE}>{calendar.isError ? "—" : calendar.data?.length ?? "…"}</strong>
        <small className="text-[11px] text-p1-subtle">Visible dates</small>
      </div>
      <div className={SUMMARY_CARD}>
        <span className="text-[10px] font-extrabold tracking-wide uppercase">In progress</span>
        <strong className={SUMMARY_VALUE}>{progress.isError ? "—" : progress.data ?? "…"}</strong>
        <small className="text-[11px] text-p1-subtle">All dates</small>
      </div>
    </div>
    {summaryFailed && <div role="alert" className="mb-3 text-sm text-p1-danger">Some counts could not load. <button type="button" className="btn-soft" onClick={() => { void unscheduled.refetch(); void progress.refetch(); }}>Retry counts</button></div>}
    {pendingOpen && <PendingScheduleWork workOrders={pending.data?.items ?? []} total={pending.data?.total ?? 0}
      page={pendingPage} onPageChange={setPendingPage} busy={pending.isFetching || pending.isPending} failed={pending.isError}
      onRetry={() => void pending.refetch()} onOpenWorkOrder={onOpenWorkOrder} onSchedule={openScheduler} />}
    {calendar.isPending && <p role="status" className="text-sm text-p1-muted">Loading your schedule…</p>}
    {calendar.isFetching && !calendar.isPending && <p role="status" className="text-sm text-p1-muted">Updating your schedule…</p>}
    {calendar.isError && <div role="alert" className="mb-3 text-sm text-p1-danger">
      {calendar.error instanceof ScheduleCapacityError ? calendar.error.message : "Your schedule could not be loaded. No work-order data was changed."}
      <button type="button" className="btn-soft ml-2" onClick={() => void calendar.refetch()}>Retry schedule</button>
    </div>}
    <ScheduleCalendar activeDate={activeDate} events={calendar.isError ? [] : calendar.data ?? []}
      loading={calendar.isPending || calendar.isError} onDateChange={setActiveDate} onDropPending={dropPending}
      onMove={moveCalendar} onOpenWorkOrder={onOpenWorkOrder} onViewChange={setView} view={view} />
    <ScheduleDialog controller={scheduler} />
  </section>;
}
