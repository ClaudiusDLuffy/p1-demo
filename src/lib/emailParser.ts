import type { GraphEmail } from "./graphClient";

export type EmailType =
  | "TYPE_DISPATCHED"
  | "TYPE_NTE_APPROVED"
  | "TYPE_CAPITAL_PENDING"
  | "TYPE_STATE_UPDATE"
  | "TYPE_UNKNOWN";

export type ParsedWorkOrder = {
  emailType: EmailType;
  wotId: string | null;
  fwkdId: string | null;
  incidentId: string | null;
  storeNumber: string | null;
  storeLocation: string | null;
  priority: "p1" | "p2" | "p3" | "p4" | "p5" | null;
  summary: string | null;
  description: string | null;
  lineOfService: string | null;
  businessService: string | null;
  category: string | null;
  subCategory: string | null;
  nte: number | null;
  afmName: string | null;
  afmEmail: string | null;
  city: string | null;
  address: string | null;
  state: string | null;
  vendor: string | null;
  doNotDispatch: boolean;
  emailSource: string;
  rawSubject: string;
  rawBody: string;
  parseConfidence: "high" | "medium" | "low";
};

export function detectEmailType(subject: string): EmailType {
  const normalized = subject || "";
  if (/has been dispatched/i.test(normalized)) return "TYPE_DISPATCHED";
  if (/NTE\/Quote Has Been Approved/i.test(normalized)) return "TYPE_NTE_APPROVED";
  if (/Pending Capital Approval|Capital Project Requested/i.test(normalized)) return "TYPE_CAPITAL_PENDING";
  if (/7-Eleven/i.test(normalized) || /\bWOT\S+/i.test(normalized)) return "TYPE_STATE_UPDATE";
  return "TYPE_UNKNOWN";
}

const htmlToText = (value: string) =>
  value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();

const firstMatch = (text: string, patterns: RegExp[]) => {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
};

const moneyToNumber = (value: string | null) => {
  if (!value) return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizePriority = (value: string | null): ParsedWorkOrder["priority"] => {
  const normalized = (value || "").toUpperCase();
  if (normalized === "P1") return "p1";
  if (normalized === "P2") return "p2";
  if (normalized === "P3") return "p3";
  if (normalized === "P4") return "p4";
  if (normalized === "P5") return "p5";
  return null;
};

const parseAddressParts = (address: string | null) => {
  if (!address) return { city: null, state: null };
  const parts = address.split(",").map(part => part.trim()).filter(Boolean);
  return {
    city: parts[1] || null,
    state: parts[2] || null,
  };
};

export function parseDispatchEmail(email: GraphEmail): ParsedWorkOrder {
  const rawSubject = email.subject || "";
  const rawBody = email.body?.content || "";
  const body = email.body?.contentType?.toLowerCase() === "html" ? htmlToText(rawBody) : htmlToText(rawBody);
  const emailType = detectEmailType(rawSubject);

  const subjectAndBody = `${rawSubject}\n${body}`;
  const wotId = firstMatch(subjectAndBody, [
    /^Number:\s*(WOT\S+)/m,
    /\b(WOT\d{6,12})\b/i,
  ]);
  const fwkdId = firstMatch(subjectAndBody, [/\b(FWKD\d{6,12})\b/i]);
  const incidentId = firstMatch(subjectAndBody, [
    /^Incident:\s*(INC\S+)/m,
    /\b(INC\d{6,12})\b/i,
  ]);
  const storeNumber = firstMatch(body, [/^Store Location:\s*7-ELEVEN STORE\s*-\s*(\d+)/m]);
  const storeLocation = firstMatch(body, [/^Store Location:\s*(.+?)(?=\r?\n)/m]);
  const address = firstMatch(body, [/^Store Address:\s*(.+?)(?=\r?\n)/m]);
  const addressParts = parseAddressParts(address);
  const priorityRaw = firstMatch(body, [/^Priority:\s*(P[1-5])\s*-/m]);
  const state = firstMatch(body, [/^State:\s*(.+?)(?=\r?\n)/m]);
  const lineOfService = firstMatch(body, [/^Line of Service:\s*(.+?)(?=\r?\n)/m]);
  const businessService = firstMatch(body, [/^Business Service:\s*(.+?)(?=\r?\n)/m]);
  const category = firstMatch(body, [/^Category:\s*(.+?)(?=\r?\n)/m]);
  const subCategory = firstMatch(body, [/^Sub Category:\s*(.+?)(?=\r?\n)/m]);
  const shortDescription = firstMatch(body, [/^Short description:\s*(.+?)(?=\r?\n)/m]);
  const orderSummary = firstMatch(body, [/^Order Summary:\s*(.+?)(?=\r?\n)/m]);
  const description = firstMatch(body, [
    /^Description:\s*([\s\S]+?)(?=\r?\n(?:Rejection|Order|Unsubscribe)|\s*$)/m,
    /^Order Description:\s*([\s\S]+?)(?=\r?\n(?:Rejection|Order|Unsubscribe)|\s*$)/m,
  ]);
  const summary = shortDescription || orderSummary || rawSubject.trim() || null;
  const doNotDispatch = /do not dispatch/i.test(`${summary || ""}\n${description || ""}`);

  const hasWorkOrderId = !!(wotId || fwkdId);
  const parseConfidence = hasWorkOrderId && storeNumber ? "high" : hasWorkOrderId ? "medium" : "low";

  return {
    emailType,
    wotId,
    fwkdId,
    incidentId,
    storeNumber,
    storeLocation,
    priority: normalizePriority(priorityRaw),
    summary,
    description,
    lineOfService,
    businessService,
    category,
    subCategory,
    nte: moneyToNumber(firstMatch(body, [
      /NTE[:\s$]+([0-9,]+\.?\d*)/i,
      /Not to Exceed[:\s$]+([0-9,]+\.?\d*)/i,
    ])),
    afmName: firstMatch(body, [/^AFM:\s*(.+?)(?=\r?\n)/m]),
    afmEmail: firstMatch(body, [/^Email:\s*(.+?)(?=\r?\n)/m]),
    city: addressParts.city,
    address,
    state: addressParts.state,
    vendor: firstMatch(body, [/^Vendor:\s*(.+?)(?=\r?\n)/m]),
    doNotDispatch,
    emailSource: email.from?.emailAddress?.address || "unknown",
    rawSubject,
    rawBody: body,
    parseConfidence,
  };
}
