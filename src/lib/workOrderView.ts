import { PRIORITY, T } from "./constants";
import { computeSlaState } from "./slaConfig";

export type WorkOrderSortKey = "sla_due" | "newest" | "oldest" | "priority";

const priorityRank: Record<string, number> = {
  p1: 1,
  p2: 2,
  p3: 3,
  p4: 4,
  p5: 5,
};

const toTime = (value: unknown) => {
  if (!value || typeof value !== "string") return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

export const getCreatedTime = (wo: any) =>
  toTime(wo?.createdAt || wo?.created_at || wo?.dispatchedAt || wo?.dispatched_at) || 0;

export const getUpdatedTime = (wo: any) =>
  toTime(wo?.updatedAt || wo?.updated_at || wo?.createdAt || wo?.created_at) || getCreatedTime(wo);

export const getSlaDueTime = (wo: any) => {
  const twoDeadlineState = computeSlaState(
    wo?.responseBreachAt || null,
    wo?.resolutionBreachAt || null,
    wo?.startTimeRaw || wo?.start_time || null,
  );
  if (twoDeadlineState) {
    return twoDeadlineState.headline === "response"
      ? twoDeadlineState.responseBreachAt.getTime()
      : twoDeadlineState.resolutionBreachAt.getTime();
  }

  const explicitDue = toTime(wo?.resolutionBreachAt || wo?.responseBreachAt);
  if (explicitDue) return explicitDue;

  const started = toTime(wo?.slaStartedAt || wo?.dispatchedAt || wo?.dispatched_at);
  const hours = PRIORITY[wo?.priority]?.slaHours || 0;
  if (!started || hours <= 0) return null;
  return started + hours * 3600 * 1000;
};

export const formatRelativeTime = (value: unknown) => {
  const time = typeof value === "number" ? value : toTime(value);
  if (!time) return null;

  const diff = time - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.max(1, Math.round(abs / 60000));
  const suffix = diff >= 0 ? "from now" : "ago";

  if (mins < 60) return diff >= 0 ? `in ${mins}m` : `${mins}m ${suffix}`;

  const hrs = Math.round(mins / 60);
  if (hrs < 24) return diff >= 0 ? `in ${hrs}h` : `${hrs}h ${suffix}`;

  const days = Math.round(hrs / 24);
  if (days < 14) return diff >= 0 ? `in ${days}d` : `${days}d ${suffix}`;

  const weeks = Math.round(days / 7);
  return diff >= 0 ? `in ${weeks}w` : `${weeks}w ${suffix}`;
};

export const formatShortDateTime = (value: unknown) => {
  const time = typeof value === "number" ? value : toTime(value);
  if (!time) return null;
  return new Date(time).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

export const formatDateWithRelative = (value: unknown) => {
  const date = formatShortDateTime(value);
  const rel = formatRelativeTime(value);
  if (!date) return "Not set";
  return rel ? `${date} · ${rel}` : date;
};

export const getWorkOrderDateMeta = (wo: any) => ({
  created: formatDateWithRelative(getCreatedTime(wo)),
  updated: formatDateWithRelative(getUpdatedTime(wo)),
  slaDue: getSlaDueTime(wo) ? formatDateWithRelative(getSlaDueTime(wo)) : "No SLA due",
});

export const getSlaAgingStyle = (wo: any) => {
  const due = getSlaDueTime(wo);
  if (!due) {
    return {
      label: "No SLA",
      color: T.subtle,
      bg: T.borderSoft,
      ring: T.border,
    };
  }

  const hours = (due - Date.now()) / 3600000;
  if (hours <= 0) {
    return {
      label: "Breached",
      color: T.danger,
      bg: T.dangerSoft,
      ring: "#EBC3BC",
    };
  }

  if (hours <= 2) {
    return {
      label: "Due soon",
      color: T.danger,
      bg: T.dangerSoft,
      ring: "#EBC3BC",
    };
  }

  if (hours <= 8) {
    return {
      label: "At risk",
      color: T.warn,
      bg: T.warnSoft,
      ring: "#EED9A6",
    };
  }

  return {
    label: "On track",
    color: T.success,
    bg: T.successSoft,
    ring: "#CFDED3",
  };
};

export const sortWorkOrders = (items: any[], sortBy: WorkOrderSortKey) => {
  const rows = [...items];
  rows.sort((a, b) => {
    if (sortBy === "priority") {
      const pr = (priorityRank[a?.priority] || 99) - (priorityRank[b?.priority] || 99);
      if (pr !== 0) return pr;
      return (getSlaDueTime(a) || Number.MAX_SAFE_INTEGER) - (getSlaDueTime(b) || Number.MAX_SAFE_INTEGER);
    }

    if (sortBy === "oldest") {
      return getCreatedTime(a) - getCreatedTime(b);
    }

    if (sortBy === "newest") {
      return getCreatedTime(b) - getCreatedTime(a);
    }

    const aDue = getSlaDueTime(a);
    const bDue = getSlaDueTime(b);
    if (aDue && bDue && aDue !== bDue) return aDue - bDue;
    if (aDue && !bDue) return -1;
    if (!aDue && bDue) return 1;
    return getCreatedTime(b) - getCreatedTime(a);
  });

  return rows;
};
