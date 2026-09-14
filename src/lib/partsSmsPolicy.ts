// Pure parts-alert presentation/clock policy. No provider, credentials, database
// or Node-only dependency may enter this module's browser-safe graph.
export const PARTS_SMS_MESSAGE_MAX_CHARACTERS = 1_500;
export const PARTS_SMS_WORK_ORDER_PREVIEW_LIMIT = 8;

export type PartsSmsMessageInput = {
  partCount: number;
  workOrderCount: number;
  previewWorkOrderIds: readonly string[];
  portalUrl: string;
};

/** Existing message wording and character cap, using trusted bounded inputs. */
export function composePartsSmsMessage(input: PartsSmsMessageInput): string {
  const { partCount, workOrderCount } = input;
  const preview = input.previewWorkOrderIds.slice(0, PARTS_SMS_WORK_ORDER_PREVIEW_LIMIT).join(", ");
  const overflow = workOrderCount > PARTS_SMS_WORK_ORDER_PREVIEW_LIMIT
    ? ` +${workOrderCount - PARTS_SMS_WORK_ORDER_PREVIEW_LIMIT} more` : "";
  return [
    `P1 parts alert: ${partCount} part request${partCount === 1 ? "" : "s"} across ${workOrderCount} work order${workOrderCount === 1 ? "" : "s"}.`,
    `${preview}${overflow}`,
    input.portalUrl,
  ].filter(Boolean).join("\n").slice(0, PARTS_SMS_MESSAGE_MAX_CHARACTERS);
}

export type PartsSmsClock = { date: string; time: string };

/** Identical local-date/minute interpretation to the original parts route. */
export function partsSmsZonedClock(date: Date, timeZone: string): PartsSmsClock {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}`,
  };
}

export type PartsSmsWindowSettings = {
  enabled: boolean;
  timezone: string;
  cutoffTime: string | null;
};
export type PartsSmsWindow = PartsSmsClock & {
  status: "disabled" | "before_cutoff" | "eligible";
};

/** No historical catch-up: each evaluation considers only its current local day. */
export function evaluatePartsSmsWindow(date: Date, settings: PartsSmsWindowSettings): PartsSmsWindow {
  const clock = partsSmsZonedClock(date, settings.timezone);
  if (!settings.enabled || !settings.cutoffTime) return { ...clock, status: "disabled" };
  return { ...clock, status: clock.time < settings.cutoffTime.slice(0, 5) ? "before_cutoff" : "eligible" };
}

export type PartsSmsSignaturePart = {
  id: string;
  updated_at?: string | null;
  p1_requested_at?: string | null;
};

/**
 * Existing canonical source string; hashing belongs to trusted server/SQL code.
 * Source timestamp values are authoritative serialized values, never client
 * timestamps. Raw description/quantity are not independently added: the existing
 * business rule observes their authoritative updated_at change.
 */
export function canonicalPartsSmsSignature(parts: readonly PartsSmsSignaturePart[]): string {
  return parts.map(part => `${part.id}:${part.updated_at || part.p1_requested_at || ""}`).sort().join("|");
}

export type PartsSmsSourcePart = {
  ordering_responsibility: string;
  p1_order_status: string | null;
  work_orders: { deleted_at: string | null; status: string };
};

export function isPartsSmsSourceEligible(part: PartsSmsSourcePart): boolean {
  return part.ordering_responsibility === "p1" && part.p1_order_status === "requested"
    && part.work_orders.deleted_at === null
    && !["closed", "capital", "pending_capital_completion"].includes(part.work_orders.status);
}
