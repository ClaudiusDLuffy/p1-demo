import { PORTAL_REALTIME_TABLES, type PortalRealtimeTable } from "../realtimeInvalidation";

export type RealtimeDomain = "work_orders" | "activities" | "visits" | "parts" | "photos"
  | "invoices" | "estimates" | "assignments" | "staff_work" | "staff_reads" | "payment_holds"
  | "receiving_notifications" | "financial_notifications" | "parts_sms" | "directories" | "permissions";
export type RealtimeEventType = "INSERT" | "UPDATE" | "DELETE";
export type NormalizedRealtimeEvent = {
  readonly domain: RealtimeDomain;
  readonly table: string;
  readonly eventType: RealtimeEventType;
  readonly recordId: string | null;
  readonly workOrderId: string | null;
  readonly previousWorkOrderId: string | null;
  readonly invoiceId: string | null;
  readonly profileId: string | null;
  readonly companyId: string | null;
  readonly previousCompanyId: string | null;
  readonly invoiceType: "contractor" | "staff" | null;
  readonly assignmentVersion: number | null;
  readonly activityChannel: string | null;
  readonly eventKey: string | null;
  readonly requiresSevenElevenSync: boolean | null;
  readonly requiresContractorAttention: boolean | null;
};

// Additional domains are also used by successful LOCAL mutation invalidation.
// They are not added to the browser subscription: private outbox rows remain
// inaccessible; their existing authorized RPC polling is retained.
const DOMAINS: Readonly<Record<string, RealtimeDomain>> = {
  work_orders: "work_orders", activities: "activities", work_order_visits: "visits",
  wo_parts: "parts", photos: "photos", invoices: "invoices", invoice_lines: "invoices",
  contractor_estimates: "estimates", work_order_technician_assignments: "assignments",
  staff_work_order_todos: "staff_work", staff_work_order_notification_reads: "staff_reads",
  contractor_invoice_payment_holds: "payment_holds", contractor_invoice_payment_hold_events: "payment_holds",
  contractor_receiving_dispatch_deliveries: "receiving_notifications", receiving_dispatch_attempt_events: "receiving_notifications",
  receiving_dispatch_operations: "receiving_notifications", financial_notification_events: "financial_notifications",
  financial_notification_deliveries: "financial_notifications", financial_notification_attempt_events: "financial_notifications",
  financial_notification_operations: "financial_notifications", p1_parts_alert_deliveries: "parts_sms",
  p1_parts_sms_attempt_events: "parts_sms", p1_parts_sms_operations: "parts_sms", p1_parts_sms_runs: "parts_sms",
  profiles: "directories", contractor_technicians: "directories", staff_permission_grants: "permissions",
};
function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function field(row: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
const identifier = (value: unknown): string | null => typeof value === "string"
  && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value) ? value : null;
const boolean = (value: unknown) => typeof value === "boolean" ? value : null;

/** Retains only bounded routing identities, never row bodies or contact data. */
export function normalizeRealtimeEvent(value: unknown, tableHint?: PortalRealtimeTable): NormalizedRealtimeEvent | null {
  try {
    const raw = fields(value);
    const table = tableHint ?? field(raw, "table");
    if (typeof table !== "string" || !Object.hasOwn(DOMAINS, table)) return null;
    const eventType = field(raw, "eventType");
    if (eventType !== "INSERT" && eventType !== "UPDATE" && eventType !== "DELETE") return null;
    const next = fields(field(raw, "new"));
    const old = fields(field(raw, "old"));
    const read = (key: string) => field(next, key) ?? field(old, key);
    const version = read("contractor_assignment_version") ?? read("assignment_version");
    const invoiceType = read("invoice_type");
    const channel = read("activity_channel");
    return {
      domain: DOMAINS[table], table, eventType,
      recordId: identifier(read("id") ?? read("invoice_id")),
      workOrderId: identifier(table === "work_orders" ? read("id") : read("work_order_id")),
      previousWorkOrderId: identifier(table === "work_orders" ? field(old, "id") : field(old, "work_order_id")),
      invoiceId: identifier(table === "invoices" ? read("id") : read("invoice_id")),
      profileId: identifier(table === "profiles" ? read("id") : read("profile_id") ?? read("user_id") ?? read("owner_id")),
      companyId: identifier(read("contractor_id") ?? read("contractor_organization_id") ?? read("company_id")),
      previousCompanyId: identifier(field(old, "contractor_id") ?? field(old, "contractor_organization_id") ?? field(old, "company_id")),
      invoiceType: invoiceType === "contractor" || invoiceType === "staff" ? invoiceType : null,
      assignmentVersion: typeof version === "number" && Number.isSafeInteger(version) && version >= 0 ? version : null,
      activityChannel: typeof channel === "string" && ["field_note", "internal_note", "contractor_message", "system_event", "legacy"].includes(channel) ? channel : null,
      eventKey: identifier(read("event_key")),
      requiresSevenElevenSync: boolean(read("requires_7eleven_sync")),
      requiresContractorAttention: boolean(read("requires_contractor_attention")),
    };
  } catch { return null; }
}
export function isSubscribedRealtimeTable(value: string): value is PortalRealtimeTable {
  return PORTAL_REALTIME_TABLES.some(table => table === value);
}
export function realtimeEventIdentity(event: NormalizedRealtimeEvent): string {
  return [event.domain, event.table, event.eventType, event.recordId ?? "missing", event.workOrderId ?? "",
    event.previousWorkOrderId ?? "", event.companyId ?? "", event.previousCompanyId ?? ""].join(":");
}
