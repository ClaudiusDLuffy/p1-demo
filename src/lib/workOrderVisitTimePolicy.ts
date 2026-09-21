export const FIELD_EVENT_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;

export type FieldEventKind = "arrival" | "checkout" | "completion";

const EVENT_LABEL: Record<FieldEventKind, string> = {
  arrival: "Arrival",
  checkout: "Checkout",
  completion: "Completion",
};

export function validateFieldEventTime(input: {
  eventAt: string;
  kind: FieldEventKind;
  activeVisitCheckInAt?: string | null;
  nowMs?: number;
}): string | null {
  const eventMs = Date.parse(input.eventAt);
  if (!Number.isFinite(eventMs)) return `${EVENT_LABEL[input.kind]} time is invalid.`;

  const nowMs = input.nowMs ?? Date.now();
  if (eventMs > nowMs + FIELD_EVENT_FUTURE_TOLERANCE_MS) {
    return `${EVENT_LABEL[input.kind]} time cannot be more than 5 minutes in the future.`;
  }

  if (input.kind !== "arrival" && input.activeVisitCheckInAt) {
    const checkInMs = Date.parse(input.activeVisitCheckInAt);
    if (Number.isFinite(checkInMs) && eventMs < checkInMs) {
      return `${EVENT_LABEL[input.kind]} time cannot be before this visit's check-in time.`;
    }
  }

  return null;
}
