import { timezoneForWorkOrder } from "../../lib/billingRules";
import { canSetWorkOrderEta } from "../../lib/workOrderDispatchActions";
import type { WorkOrderReadModel } from "../work-orders/data/workOrderReadContracts";

export type CalendarView = "month" | "week" | "day";

export type ScheduleItem = {
  id: string;
  date: string;
  time: string;
  timeZone: string;
  workOrder: WorkOrderReadModel;
};

const pad = (value: number) => String(value).padStart(2, "0");

export function parseDateKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

export function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(key: string, amount: number): string {
  const date = parseDateKey(key);
  date.setDate(date.getDate() + amount);
  return toDateKey(date);
}

export function addMonths(key: string, amount: number): string {
  const date = parseDateKey(key);
  const requestedDay = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + amount);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(requestedDay, lastDay));
  return toDateKey(date);
}

export function startOfWeek(key: string): string {
  const date = parseDateKey(key);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return toDateKey(date);
}

export function weekDateKeys(key: string): string[] {
  const start = startOfWeek(key);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

export function monthDateKeys(key: string): string[] {
  const date = parseDateKey(key);
  const first = toDateKey(new Date(date.getFullYear(), date.getMonth(), 1, 12));
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

export function monthLabel(key: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(parseDateKey(key));
}

export function dayLabel(key: string, options: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...options,
  }).format(parseDateKey(key));
}

function etaParts(eta: string, timeZone: string): { date: string; time: string } | null {
  const instant = new Date(eta);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}`,
  };
}

export function scheduleItemsFor(workOrders: readonly WorkOrderReadModel[]): ScheduleItem[] {
  return workOrders.flatMap(workOrder => {
    if (!workOrder.eta) return [];
    const timeZone = timezoneForWorkOrder(workOrder);
    const parts = etaParts(workOrder.eta, timeZone);
    return parts ? [{ id: workOrder.id, ...parts, timeZone, workOrder }] : [];
  }).sort((left, right) => `${left.date}T${left.time}`.localeCompare(`${right.date}T${right.time}`));
}

export function pendingScheduleWork(workOrders: readonly WorkOrderReadModel[]): WorkOrderReadModel[] {
  return workOrders.filter(workOrder => (
    !workOrder.eta
    && canSetWorkOrderEta({ contractorId: workOrder.contractor, status: workOrder.status,
      functionalStatus: workOrder.functionalStatus, assignmentTransferPendingVisit: workOrder.assignmentTransferPendingVisit })
  ));
}

export function timeLabel(value: string): string {
  const [hours, minutes] = value.split(":").map(Number);
  const suffix = hours >= 12 ? "PM" : "AM";
  return `${hours % 12 || 12}:${pad(minutes)} ${suffix}`;
}
