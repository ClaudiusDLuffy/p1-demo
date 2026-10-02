import { dateTimeInputPartsInTimeZone, storeLocalDateTimeToIso } from "./billingRules";

/** Minute-resolution controls must not truncate an untouched stored timestamp. */
export function resolveVisitCorrectionTime(
  date: string,
  time: string,
  timeZone: string,
  original?: string | null,
): string {
  if (original && Number.isFinite(Date.parse(original))) {
    const displayed = dateTimeInputPartsInTimeZone(new Date(original), timeZone);
    if (date === displayed.date && time === displayed.time) return original;
  }
  return storeLocalDateTimeToIso(date, time, timeZone);
}
