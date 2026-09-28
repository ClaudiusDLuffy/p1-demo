"use client";

import { useCallback, useMemo, useState, type DragEvent } from "react";
import type { PortalAuthProfile } from "../auth/authProfile";
import type { WorkOrderReadModel } from "../work-orders/data/workOrderReadContracts";
import { useWorkOrderCollection } from "../work-orders/useWorkOrderCollection";
import { WorkOrderCollectionProgress } from "../work-orders/WorkOrderCollectionProgress";
import { resolveWorkOrderCollectionState, WorkOrderCollectionNotice } from "../work-orders/WorkOrderCollectionNotice";
import { PendingScheduleWork } from "./PendingScheduleWork";
import { ScheduleCalendar } from "./ScheduleCalendar";
import { ScheduleDialog } from "./ScheduleDialog";
import {
  addDays,
  addMonths,
  pendingScheduleWork,
  scheduleItemsFor,
  toDateKey,
  weekDateKeys,
  type CalendarView,
  type ScheduleItem,
} from "./scheduleModel";
import { useWorkOrderScheduling } from "./useWorkOrderScheduling";
import { BetaBadge } from "../../components/ui/BetaBadge";

type MyScheduleProps = {
  active: boolean;
  currentUser: PortalAuthProfile;
  isManager: boolean;
  onOpenWorkOrder: (workOrderId: string) => void;
};

type ScheduleBodyProps = {
  activeDate: string;
  collectionState: ReturnType<typeof resolveWorkOrderCollectionState>;
  events: readonly ScheduleItem[];
  isFetching: boolean;
  onDateChange: (date: string) => void;
  onDropPending: (event: DragEvent, date: string) => void;
  onMove: (direction: -1 | 1) => void;
  onOpenWorkOrder: (workOrderId: string) => void;
  onRetry: () => void;
  onViewChange: (view: CalendarView) => void;
  view: CalendarView;
  workOrderCount: number;
};

function ScheduleBody({ collectionState, isFetching, onRetry, workOrderCount, ...calendarProps }: ScheduleBodyProps) {
  if (collectionState === "error" && workOrderCount === 0) {
    return (
      <WorkOrderCollectionNotice
        state="error"
        errorMessage="Your schedule could not be loaded. No work-order data was changed."
        onRetry={onRetry}
        retrying={isFetching}
        className="card"
      />
    );
  }
  if (collectionState === "loading" && workOrderCount === 0) {
    return <WorkOrderCollectionNotice state="loading" loadingMessage="Loading your schedule…" className="card" />;
  }
  return <ScheduleCalendar {...calendarProps} />;
}

const SUMMARY_CARD = "grid min-w-0 gap-[5px] rounded-xl border border-p1-border bg-p1-surface px-[7px] py-[9px] text-left text-p1-muted min-[481px]:p-[11px] min-[701px]:px-4 min-[701px]:py-3.5";

export default function MySchedule({ active, currentUser, isManager, onOpenWorkOrder }: MyScheduleProps) {
  const [view, setView] = useState<CalendarView>("month");
  const [activeDate, setActiveDate] = useState(() => toDateKey(new Date()));
  const [pendingOpen, setPendingOpen] = useState(false);
  const contractorId = isManager ? null : currentUser.contractorAccountId || currentUser.id;
  const query = useWorkOrderCollection({
    scope: "active",
    contractorId,
    sort: "newest",
  }, active, currentUser);
  const { workOrders } = query;
  const events = useMemo(() => scheduleItemsFor(workOrders), [workOrders]);
  const pending = useMemo(() => pendingScheduleWork(workOrders), [workOrders]);
  const collectionState = resolveWorkOrderCollectionState({
    itemCount: workOrders.length,
    isPending: query.isPending,
    isFetching: query.isFetching,
    isError: query.isError,
  });
  const currentWeek = weekDateKeys(activeDate);
  const scheduledThisWeek = events.filter(item => currentWeek.includes(item.date)).length;
  const inProgress = workOrders.filter(workOrder => workOrder.status === "wip").length;

  const handleScheduled = useCallback((date: string) => {
    setActiveDate(date);
    setView("day");
    setPendingOpen(false);
  }, []);
  const scheduler = useWorkOrderScheduling({ onScheduled: handleScheduled });

  const moveCalendar = useCallback((direction: -1 | 1) => {
    setActiveDate(current => view === "month"
      ? addMonths(current, direction)
      : addDays(current, direction * (view === "week" ? 7 : 1)));
  }, [view]);

  const dropPending = useCallback((event: DragEvent, date: string) => {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/work-order-id");
    const workOrder = pending.find(item => item.id === id);
    if (workOrder) scheduler.open(workOrder, date);
  }, [pending, scheduler]);

  const openScheduler = useCallback((workOrder: WorkOrderReadModel) => {
    scheduler.open(workOrder, activeDate);
  }, [activeDate, scheduler]);

  if (!active) return null;

  return (
    <section className="animate-fade-up" aria-labelledby="my-schedule-heading">
      <header className="mb-[18px] flex flex-col items-stretch gap-2.5 min-[701px]:flex-row min-[701px]:items-end min-[701px]:justify-between min-[701px]:gap-5">
        <div>
          <span className="text-[10px] font-extrabold tracking-[.9px] text-p1-accent uppercase">Field planning</span>
          <div className="flex flex-wrap items-center gap-2">
            <h1 id="my-schedule-heading" className="my-1 font-display text-[30px] leading-tight font-normal tracking-[-.7px] text-p1-ink min-[701px]:text-[42px]">My Schedule</h1>
            <BetaBadge />
          </div>
          <p className="m-0 max-w-[760px] leading-[1.55] text-p1-muted">Plan assigned work with the existing audited ETA workflow. Starting, pausing, and completing work still happen inside the work order.</p>
        </div>
        <button type="button" className="btn-soft" onClick={() => setActiveDate(toDateKey(new Date()))}>Today</button>
      </header>

      <div className="mb-3.5 grid grid-cols-3 gap-1.5 min-[701px]:gap-2.5">
        <button type="button" className={SUMMARY_CARD} onClick={() => setPendingOpen(current => !current)} aria-expanded={pendingOpen} aria-controls="pending-schedule-work">
          <span className="text-[10px] font-extrabold tracking-wide uppercase">Pending schedule</span>
          <strong className="font-display text-[22px] leading-none font-normal text-p1-ink min-[481px]:text-[25px] min-[701px]:text-[29px]">{pending.length}</strong>
          <small className="text-[11px] text-p1-subtle">{pendingOpen ? "Hide work" : "Show work"}{query.hasNextPage ? " · loaded" : ""}</small>
        </button>
        <div className={SUMMARY_CARD}>
          <span className="text-[10px] font-extrabold tracking-wide uppercase">{currentWeek.includes(toDateKey(new Date())) ? "This week" : "Selected week"}</span>
          <strong className="font-display text-[22px] leading-none font-normal text-p1-ink min-[481px]:text-[25px] min-[701px]:text-[29px]">{scheduledThisWeek}</strong>
          <small className="text-[11px] text-p1-subtle">{query.hasNextPage ? "Loaded ETAs" : "Scheduled ETAs"}</small>
        </div>
        <div className={SUMMARY_CARD}>
          <span className="text-[10px] font-extrabold tracking-wide uppercase">In progress</span>
          <strong className="font-display text-[22px] leading-none font-normal text-p1-ink min-[481px]:text-[25px] min-[701px]:text-[29px]">{inProgress}</strong>
          <small className="text-[11px] text-p1-subtle">{query.hasNextPage ? "Loaded work" : "Open field work"}</small>
        </div>
      </div>

      {pendingOpen && (
        <PendingScheduleWork
          workOrders={pending}
          onOpenWorkOrder={onOpenWorkOrder}
          onSchedule={openScheduler}
        />
      )}

      <WorkOrderCollectionProgress
        count={workOrders.length}
        hasMore={query.hasNextPage}
        failed={query.isError}
        busy={query.isFetching}
        onLoadMore={() => void query.fetchNextPage()}
        onRetry={() => void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())}
      />

      <ScheduleBody
        activeDate={activeDate}
        collectionState={collectionState}
        events={events}
        isFetching={query.isFetching}
        onDateChange={setActiveDate}
        onDropPending={dropPending}
        onMove={moveCalendar}
        onOpenWorkOrder={onOpenWorkOrder}
        onRetry={() => void query.refetch()}
        onViewChange={setView}
        view={view}
        workOrderCount={workOrders.length}
      />

      <ScheduleDialog controller={scheduler} />
    </section>
  );
}
