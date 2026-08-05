const STAFF_ROLES = new Set(["manager", "dispatcher", "back_office"]);

const SAFE_EVENT_KEYS = new Set([
  "note",
  "ai_note",
  "check_in",
  "job_completed",
  "job_paused",
  "status_change",
  "work_order_assignment",
  "work_order_reassigned",
  "work_order_unassigned",
  "assignment",
  "technician_updated",
  "eta_updated",
  "photo_added",
  "photo_removed",
]);

const SENSITIVE_BILLING_TEXT = /\b(?:nte|markup|margin|gross profit|profit margin|invoice total|sales tax|tax rate|pricing|subtotal|p1\s*(?:to|->|→)\s*7-?eleven)\b/i;

export type BillingActivityRecord = {
  id?: string;
  eventKey?: string;
  type?: string;
  text?: string;
  createdAt?: string;
  time?: string;
  author?: string;
};

export function isStaffBillingActivityViewer(role: unknown) {
  return STAFF_ROLES.has(String(role || ""));
}

export function isSafeBillingActivity(activity: BillingActivityRecord | null | undefined) {
  const eventKey = String(activity?.eventKey || "").trim().toLowerCase();
  const type = String(activity?.type || "").trim().toLowerCase();
  const value = String(activity?.text || "").trim();
  if (!value || SENSITIVE_BILLING_TEXT.test(value)) return false;
  if (eventKey === "staff_billing" || eventKey.startsWith("invoice_")) return false;
  if (SAFE_EVENT_KEYS.has(eventKey)) return true;
  if (type === "note" || type === "ai") return true;
  return eventKey === "system"
    && /\b(?:status|moved to|reopened|closed|checked in|clocked out|started work|paused|completed|assigned|unassigned|dispatched|eta|technician|photo)\b/i.test(value);
}

export function visibleBillingActivities(activities: BillingActivityRecord[], role: unknown) {
  if (!isStaffBillingActivityViewer(role)) return [];
  return (activities || [])
    .filter(isSafeBillingActivity)
    .sort((left, right) =>
      new Date(right?.createdAt || 0).getTime()
      - new Date(left?.createdAt || 0).getTime(),
    );
}

export function billingActivityLabel(activity: BillingActivityRecord) {
  const key = String(activity?.eventKey || "").toLowerCase();
  if (key === "note" || activity?.type === "note") return "Note";
  if (key === "check_in") return "Check in";
  if (key === "job_completed") return "Check out / completed";
  if (key === "job_paused") return "Paused";
  if (key.includes("assignment") || key === "assignment") return "Assignment";
  if (key.includes("photo")) return "Photo";
  if (key === "eta_updated") return "ETA";
  if (key === "technician_updated") return "Technician";
  return "Status";
}
