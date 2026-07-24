export type BillingTrip = {
  id?: string;
  checkInAt: string;
  checkOutAt: string | null;
};

export type BillingTripHours = BillingTrip & {
  totalHours: number;
  regularHours: number;
  overtimeHours: number;
};

type WorkOrderLocation = Record<string, unknown> | null | undefined;

type DateTimeInputParts = {
  date: string;
  time: string;
};

const STATE_TIMEZONES: Record<string, string> = {
  AL: "America/Chicago",
  AK: "America/Anchorage",
  AZ: "America/Phoenix",
  AR: "America/Chicago",
  CA: "America/Los_Angeles",
  CO: "America/Denver",
  CT: "America/New_York",
  DC: "America/New_York",
  DE: "America/New_York",
  FL: "America/New_York",
  GA: "America/New_York",
  HI: "Pacific/Honolulu",
  IA: "America/Chicago",
  ID: "America/Boise",
  IL: "America/Chicago",
  IN: "America/Indiana/Indianapolis",
  KS: "America/Chicago",
  KY: "America/New_York",
  LA: "America/Chicago",
  MA: "America/New_York",
  MD: "America/New_York",
  ME: "America/New_York",
  MI: "America/Detroit",
  MN: "America/Chicago",
  MO: "America/Chicago",
  MS: "America/Chicago",
  MT: "America/Denver",
  NC: "America/New_York",
  ND: "America/Chicago",
  NE: "America/Chicago",
  NH: "America/New_York",
  NJ: "America/New_York",
  NM: "America/Denver",
  NV: "America/Los_Angeles",
  NY: "America/New_York",
  OH: "America/New_York",
  OK: "America/Chicago",
  OR: "America/Los_Angeles",
  PA: "America/New_York",
  RI: "America/New_York",
  SC: "America/New_York",
  SD: "America/Chicago",
  TN: "America/Chicago",
  TX: "America/Chicago",
  UT: "America/Denver",
  VA: "America/New_York",
  VT: "America/New_York",
  WA: "America/Los_Angeles",
  WI: "America/Chicago",
  WV: "America/New_York",
  WY: "America/Denver",
};

const STATE_NAMES: Record<string, string> = {
  ALABAMA: "AL",
  ALASKA: "AK",
  ARIZONA: "AZ",
  ARKANSAS: "AR",
  CALIFORNIA: "CA",
  COLORADO: "CO",
  CONNECTICUT: "CT",
  DELAWARE: "DE",
  FLORIDA: "FL",
  GEORGIA: "GA",
  HAWAII: "HI",
  IDAHO: "ID",
  ILLINOIS: "IL",
  INDIANA: "IN",
  IOWA: "IA",
  KANSAS: "KS",
  KENTUCKY: "KY",
  LOUISIANA: "LA",
  MAINE: "ME",
  MARYLAND: "MD",
  MASSACHUSETTS: "MA",
  MICHIGAN: "MI",
  MINNESOTA: "MN",
  MISSISSIPPI: "MS",
  MISSOURI: "MO",
  MONTANA: "MT",
  NEBRASKA: "NE",
  NEVADA: "NV",
  "NEW HAMPSHIRE": "NH",
  "NEW JERSEY": "NJ",
  "NEW MEXICO": "NM",
  "NEW YORK": "NY",
  "NORTH CAROLINA": "NC",
  "NORTH DAKOTA": "ND",
  OHIO: "OH",
  OKLAHOMA: "OK",
  OREGON: "OR",
  PENNSYLVANIA: "PA",
  "RHODE ISLAND": "RI",
  "SOUTH CAROLINA": "SC",
  "SOUTH DAKOTA": "SD",
  TENNESSEE: "TN",
  TEXAS: "TX",
  UTAH: "UT",
  VERMONT: "VT",
  VIRGINIA: "VA",
  WASHINGTON: "WA",
  "WEST VIRGINIA": "WV",
  WISCONSIN: "WI",
  WYOMING: "WY",
};

export function normalizeStateCode(value: unknown): string {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\./g, "");
  if (/^[A-Z]{2}$/.test(normalized)) return normalized;
  return STATE_NAMES[normalized] || "";
}

export function stateCodeFromWorkOrder(workOrder: WorkOrderLocation): string {
  const direct = normalizeStateCode(
    workOrder?.storeState || workOrder?.store_state || workOrder?.state,
  );
  if (direct) return direct;

  const text = [workOrder?.city, workOrder?.addr, workOrder?.address]
    .filter(Boolean)
    .join(", ")
    .toUpperCase();

  const codeMatch = text.match(/(?:^|[\s,])([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?(?:$|[\s,])/);
  if (codeMatch?.[1] && STATE_TIMEZONES[codeMatch[1]]) return codeMatch[1];

  for (const [name, code] of Object.entries(STATE_NAMES)) {
    if (text.includes(name)) return code;
  }
  return "";
}

export function timezoneForWorkOrder(workOrder: WorkOrderLocation): string {
  const explicit = String(
    workOrder?.storeTimezone || workOrder?.store_timezone || "",
  ).trim();
  if (explicit) return explicit;
  return STATE_TIMEZONES[stateCodeFromWorkOrder(workOrder)] || "America/New_York";
}

const dateTimePartsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function dateTimePartsInTimeZone(date: Date, timeZone: string) {
  let formatter = dateTimePartsFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    dateTimePartsFormatterCache.set(timeZone, formatter);
  }

  const parts = formatter.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find(part => part.type === type)?.value || 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

export function dateTimeInputPartsInTimeZone(
  date = new Date(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): DateTimeInputParts {
  const parts = dateTimePartsInTimeZone(date, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
    time: `${pad(parts.hour)}:${pad(parts.minute)}`,
  };
}

export function storeLocalDateTimeToIso(
  dateValue: string,
  timeValue: string,
  timeZone: string,
): string {
  const dateMatch = dateValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = timeValue.match(/^(\d{2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) {
    throw new Error("A valid date and time are required");
  }

  const target = {
    year: Number(dateMatch[1]),
    month: Number(dateMatch[2]),
    day: Number(dateMatch[3]),
    hour: Number(timeMatch[1]),
    minute: Number(timeMatch[2]),
  };
  const targetAsUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
  );
  let candidate = targetAsUtc;

  // Iterate because the zone offset can change near daylight-saving
  // boundaries. Two passes are normally enough; a third is inexpensive.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rendered = dateTimePartsInTimeZone(new Date(candidate), timeZone);
    const renderedAsUtc = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      rendered.hour,
      rendered.minute,
    );
    const delta = renderedAsUtc - targetAsUtc;
    if (delta === 0) break;
    candidate -= delta;
  }

  return new Date(candidate).toISOString();
}

export function defaultLineTaxable(type: unknown, description: unknown): boolean {
  const lineType = String(type || "").toLowerCase();
  const text = `${lineType} ${String(description || "").toLowerCase()}`;
  if (lineType.includes("part") || /hardware|material/.test(text)) return true;
  if (/\bhvac\b|building|ems|plumbing|electrical/.test(text)) return false;
  return false;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function localClockParts(date: Date, timeZone: string) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }

  const parts = formatter.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(part => part.type === type)?.value || "";
  return {
    weekday: value("weekday"),
    hour: Number(value("hour")),
    minute: Number(value("minute")),
  };
}

function isOvertimeInstant(date: Date, timeZone: string) {
  const local = localClockParts(date, timeZone);
  if (local.weekday === "Sat" || local.weekday === "Sun") return true;
  const minuteOfDay = local.hour * 60 + local.minute;
  return minuteOfDay < 8 * 60 || minuteOfDay >= 17 * 60;
}

export function calculateTripHours(
  trip: BillingTrip,
  timeZone: string,
  now = new Date(),
): BillingTripHours | null {
  const start = new Date(trip.checkInAt);
  const end = trip.checkOutAt ? new Date(trip.checkOutAt) : now;
  if (
    Number.isNaN(start.getTime())
    || Number.isNaN(end.getTime())
    || end.getTime() <= start.getTime()
  ) {
    return null;
  }

  let cursor = start.getTime();
  const endMs = end.getTime();
  let overtimeMs = 0;
  while (cursor < endMs) {
    const nextMinute = (Math.floor(cursor / 60_000) + 1) * 60_000;
    const segmentEnd = Math.min(endMs, nextMinute);
    const midpoint = new Date(cursor + (segmentEnd - cursor) / 2);
    if (isOvertimeInstant(midpoint, timeZone)) {
      overtimeMs += segmentEnd - cursor;
    }
    cursor = segmentEnd;
  }

  const totalHours = (endMs - start.getTime()) / 3_600_000;
  const overtimeHours = overtimeMs / 3_600_000;
  return {
    ...trip,
    totalHours,
    regularHours: Math.max(0, totalHours - overtimeHours),
    overtimeHours,
  };
}

export function calculateTrips(
  trips: BillingTrip[],
  timeZone: string,
): BillingTripHours[] {
  return trips
    .map(trip => calculateTripHours(trip, timeZone))
    .filter((trip): trip is BillingTripHours => !!trip);
}
