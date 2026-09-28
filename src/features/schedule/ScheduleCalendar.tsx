"use client";

import { useMemo, type ComponentType, type DragEvent } from "react";
import {
  dayLabel,
  monthDateKeys,
  monthLabel,
  parseDateKey,
  timeLabel,
  weekDateKeys,
  type CalendarView,
  type ScheduleItem,
} from "./scheduleModel";

type ScheduleCalendarProps = {
  activeDate: string;
  events: readonly ScheduleItem[];
  onDateChange: (date: string) => void;
  onDropPending: (event: DragEvent, date: string) => void;
  onMove: (direction: -1 | 1) => void;
  onOpenWorkOrder: (workOrderId: string) => void;
  onViewChange: (view: CalendarView) => void;
  view: CalendarView;
};

type CalendarViewProps = Pick<
  ScheduleCalendarProps,
  "activeDate" | "onDateChange" | "onDropPending" | "onOpenWorkOrder" | "onViewChange"
> & {
  itemsByDate: ReadonlyMap<string, readonly ScheduleItem[]>;
};

const EMPTY_EVENTS: readonly ScheduleItem[] = [];
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CALENDAR_VIEWS: ReadonlyArray<CalendarView> = ["month", "week", "day"];

function eventsByDate(events: readonly ScheduleItem[]): ReadonlyMap<string, readonly ScheduleItem[]> {
  const grouped = new Map<string, ScheduleItem[]>();
  events.forEach(item => {
    const existing = grouped.get(item.date);
    if (existing) existing.push(item);
    else grouped.set(item.date, [item]);
  });
  return grouped;
}

function ScheduleEvent({ item, onOpen }: { item: ScheduleItem; onOpen: (workOrderId: string) => void }) {
  return (
    <button
      type="button"
      className="grid min-w-0 gap-0.5 rounded-lg border border-p1-accent-ring bg-p1-accent-soft p-[7px] text-left text-p1-ink-soft"
      onClick={() => onOpen(item.workOrder.id)}
    >
      <strong className="text-[11px] text-[#8f4028]">{timeLabel(item.time)}</strong>
      <span className="overflow-hidden font-mono text-[10px] font-extrabold text-ellipsis whitespace-nowrap">{item.workOrder.id}</span>
    </button>
  );
}

function MonthScheduleView({ activeDate, itemsByDate, onDateChange, onDropPending, onViewChange }: CalendarViewProps) {
  const activeMonth = parseDateKey(activeDate).getMonth();

  return (
    <div>
      <div className="grid grid-cols-7 border-b border-p1-border-soft">
        {WEEKDAY_LABELS.map(label => <span key={label} className="px-px py-1.5 text-center text-[10px] font-extrabold text-p1-subtle uppercase min-[481px]:px-[5px] min-[481px]:py-2">{label}</span>)}
      </div>
      <div className="grid grid-cols-7">
        {monthDateKeys(activeDate).map((date, index) => {
          const dateEvents = itemsByDate.get(date) || EMPTY_EVENTS;
          const muted = parseDateKey(date).getMonth() !== activeMonth;
          return (
            <button
              type="button"
              key={date}
              className="relative grid min-h-[49px] min-w-0 content-start gap-[5px] border-r border-b border-p1-border-soft bg-p1-surface p-[3px] text-left text-p1-ink shadow-[inset_0_0_0_0_transparent] data-[last-column=true]:border-r-0 data-[muted=true]:bg-p1-surface-soft data-[muted=true]:text-p1-subtle data-[selected=true]:shadow-[inset_0_0_0_2px_#c15f3c] min-[481px]:min-h-[92px] min-[481px]:p-1.5"
              data-last-column={(index + 1) % 7 === 0}
              data-muted={muted}
              data-selected={date === activeDate}
              aria-label={`${dayLabel(date, { year: "numeric" })}, ${dateEvents.length} scheduled`}
              onClick={() => { onDateChange(date); onViewChange("week"); }}
              onDragOver={event => event.preventDefault()}
              onDrop={event => onDropPending(event, date)}
            >
              <span className="grid size-5 place-items-center rounded-full text-[11px] font-extrabold min-[481px]:size-6">{parseDateKey(date).getDate()}</span>
              <span className="hidden min-w-0 gap-[3px] min-[481px]:grid">
                {dateEvents.slice(0, 2).map(item => (
                  <span key={item.id} className="overflow-hidden rounded-[5px] bg-p1-accent-soft px-1 py-[3px] text-[10px] font-bold text-[#8f4028] text-ellipsis whitespace-nowrap">
                    {timeLabel(item.time)} · {item.workOrder.id}
                  </span>
                ))}
              </span>
              {dateEvents.length > 0 && (
                <span className="absolute right-1 bottom-1 grid h-[15px] min-w-[15px] place-items-center rounded-full bg-p1-accent text-[10px] font-black text-white min-[481px]:hidden">
                  {dateEvents.length}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function WeekScheduleView({ activeDate, itemsByDate, onDateChange, onDropPending, onOpenWorkOrder, onViewChange }: CalendarViewProps) {
  return (
    <div className="grid min-h-0 grid-cols-1 min-[701px]:min-h-[360px] min-[701px]:grid-cols-7">
      {weekDateKeys(activeDate).map(date => {
        const dateEvents = itemsByDate.get(date) || EMPTY_EVENTS;
        return (
          <section
            key={date}
            className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] border-b border-p1-border-soft data-[selected=true]:bg-[#fdfaf7] min-[701px]:block min-[701px]:border-r min-[701px]:border-b-0 min-[701px]:last:border-r-0"
            data-selected={date === activeDate}
            onDragOver={event => event.preventDefault()}
            onDrop={event => onDropPending(event, date)}
          >
            <button
              type="button"
              aria-label={`View ${dayLabel(date, { year: "numeric" })}`}
              className="grid w-full content-start gap-[3px] border-r border-p1-border-soft bg-transparent px-1 py-2.5 text-center text-p1-muted min-[701px]:border-r-0 min-[701px]:border-b min-[701px]:px-[5px] min-[701px]:py-3"
              onClick={() => { onDateChange(date); onViewChange("day"); }}
            >
              <span className="text-[10px] font-extrabold uppercase">{dayLabel(date, { weekday: "short", month: undefined, day: undefined })}</span>
              <strong className="font-display text-[23px] leading-none font-normal text-p1-ink">{parseDateKey(date).getDate()}</strong>
            </button>
            <div className="grid min-h-[70px] content-start gap-[5px] p-[7px] min-[701px]:min-h-[270px] min-[701px]:p-1.5">
              {dateEvents.map(item => <ScheduleEvent key={item.id} item={item} onOpen={onOpenWorkOrder} />)}
              {dateEvents.length === 0 && <span className="mx-0.5 my-[18px] text-center text-[11px] text-p1-subtle">No scheduled work</span>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function DayScheduleView({ activeDate, itemsByDate, onOpenWorkOrder }: CalendarViewProps) {
  const dateEvents = itemsByDate.get(activeDate) || EMPTY_EVENTS;
  if (dateEvents.length === 0) {
    return <div className="grid min-h-60 place-items-center p-3.5 text-[11px] text-p1-subtle">No work is scheduled for this day.</div>;
  }

  return (
    <div className="grid min-h-[300px] gap-2.5 p-3.5">
      {dateEvents.map(item => (
        <div key={item.id} className="grid grid-cols-[55px_minmax(0,1fr)] items-start gap-[7px] min-[481px]:grid-cols-[90px_minmax(0,1fr)] min-[481px]:gap-3">
          <div className="grid gap-[3px] pt-2.5 text-right">
            <strong className="text-[10px]">{timeLabel(item.time)}</strong>
            <span className="break-words text-[10px] text-p1-subtle">{item.timeZone.replace("America/", "")}</span>
          </div>
          <div className="grid grid-cols-1 gap-x-3 gap-y-2 rounded-[10px] border-l-[3px] border-p1-accent bg-p1-surface-soft p-2.5 min-[481px]:grid-cols-[minmax(0,1fr)_auto] min-[481px]:p-3">
            <div className="grid gap-[3px]">
              <strong className="font-mono text-[11px] text-p1-accent">{item.workOrder.id}</strong>
              <span className="text-[11px] text-p1-muted">{item.workOrder.store ? `Store #${item.workOrder.store}` : item.workOrder.city || "Work order"}</span>
            </div>
            <p className="col-span-full m-0 text-xs leading-[1.45] text-p1-ink-soft">{item.workOrder.summary || item.workOrder.description || "Work order details"}</p>
            <button type="button" className="btn-soft min-[481px]:col-start-2 min-[481px]:row-start-1" onClick={() => onOpenWorkOrder(item.workOrder.id)}>View details</button>
          </div>
        </div>
      ))}
    </div>
  );
}

const VIEW_COMPONENTS: Record<CalendarView, ComponentType<CalendarViewProps>> = {
  month: MonthScheduleView,
  week: WeekScheduleView,
  day: DayScheduleView,
};

export function ScheduleCalendar(props: ScheduleCalendarProps) {
  const { activeDate, events, onMove, onViewChange, view } = props;
  const itemsByDate = useMemo(() => eventsByDate(events), [events]);
  const ActiveView = VIEW_COMPONENTS[view];
  const titles: Record<CalendarView, string> = {
    day: dayLabel(activeDate, { weekday: "long" }),
    week: `Week of ${dayLabel(weekDateKeys(activeDate)[0], { weekday: undefined, year: "numeric" })}`,
    month: monthLabel(activeDate),
  };
  const title = titles[view];

  return (
    <section className="overflow-hidden rounded-[14px] border border-p1-border bg-p1-surface" aria-label="Work schedule calendar">
      <div className="grid grid-cols-1 items-center gap-2 border-b border-p1-border-soft p-[9px] min-[341px]:grid-cols-[1fr_auto] min-[701px]:grid-cols-[1fr_auto_1fr] min-[701px]:gap-3 min-[701px]:px-3.5 min-[701px]:py-3">
        <h2 className="m-0 font-display text-[17px] leading-tight font-normal text-p1-ink min-[341px]:col-span-full min-[701px]:col-span-1 min-[701px]:col-start-2 min-[701px]:row-start-1 min-[701px]:text-center min-[701px]:text-[21px]">{title}</h2>
        <div className="flex gap-[5px] min-[701px]:col-start-1 min-[701px]:row-start-1">
          <button type="button" className="min-h-11 min-w-11 rounded-lg border border-p1-border bg-p1-surface px-1.5 py-1 text-[19px] leading-none font-bold text-p1-muted" aria-label={`Previous ${view}`} onClick={() => onMove(-1)}>‹</button>
          <button type="button" className="min-h-11 min-w-11 rounded-lg border border-p1-border bg-p1-surface px-1.5 py-1 text-[19px] leading-none font-bold text-p1-muted" aria-label={`Next ${view}`} onClick={() => onMove(1)}>›</button>
        </div>
        <div className="flex justify-self-start gap-[5px] min-[341px]:justify-self-end min-[701px]:col-start-3 min-[701px]:row-start-1" aria-label="Calendar view">
          {CALENDAR_VIEWS.map(option => (
            <button
              key={option}
              type="button"
              className="min-h-11 min-w-11 rounded-lg border border-p1-border bg-p1-surface px-2.5 py-1.5 text-[11px] font-bold text-p1-muted capitalize data-[active=true]:border-p1-ink data-[active=true]:bg-p1-ink data-[active=true]:text-white"
              data-active={view === option}
              onClick={() => onViewChange(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      <ActiveView {...props} itemsByDate={itemsByDate} />
    </section>
  );
}
