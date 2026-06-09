export const T = {
  bg: "#FAF7F2",
  bgWarm: "#F5F0E8",
  surface: "#FFFFFF",
  surfaceSoft: "#FCFAF6",
  border: "#E8E1D5",
  borderSoft: "#F0EAE0",
  ink: "#1F1E1C",
  inkSoft: "#3D3A36",
  muted: "#6B6760",
  subtle: "#9A958D",
  accent: "#C15F3C",
  accentSoft: "#F5E6DC",
  accentRing: "#E8CCB8",
  sidebar: "#1F1E1C",
  sidebarText: "#9A958D",
  sidebarActive: "#FAF7F2",
  success: "#4A7C59",
  successSoft: "#E8F0EA",
  warn: "#A67C00",
  warnSoft: "#FBF4DC",
  danger: "#C0392B",
  dangerSoft: "#FBEDEA",
  violet: "#5B4B8A",
  violetSoft: "#EDE9F5",
};

export const DEMO_ACCOUNTS = [
  { email: "claytonetchison@gmail.com", name: "Clay Etchison", initials: "CE", color: "#1F1E1C", subtitle: "Owner" },
  // Jeremy's demo auth user is the gustavo@ mailbox (Gustavo runs the demo and
  // owns that inbox for confirmations) — must match bootstrap.ts so the
  // quick-access button signs into a real auth user with the demo password.
  { email: "gustavo@myamzteam.com", name: "Jeremy Barry", initials: "JB", color: "#C15F3C", subtitle: "Owner" },
  { email: "landryd@phospitality.com", name: "Landry Dillinger", initials: "LD", color: "#A67C00", subtitle: "Dispatcher" },
  { email: "scrcdallastexas@gmail.com", name: "Derek Starnes", initials: "DS", color: "#0891B2", subtitle: "Contractor — Dallas" },
];
export const DEMO_PASSWORD = "p1demo2026!";

export const PRIORITY = {
  p1: { label: "P1 Critical", short: "P1", color: T.danger, bg: T.dangerSoft, ring: "#EBC3BC", icon: "⚡", slaHours: 8 },
  p2: { label: "P2 Emergency", short: "P2", color: T.accent, bg: T.accentSoft, ring: T.accentRing, icon: "◆", slaHours: 24 },
  p3: { label: "P3 Standard", short: "P3", color: T.warn, bg: T.warnSoft, ring: "#EED9A6", icon: "●", slaHours: 72 },
  p4: { label: "P4 Minor", short: "P4", color: T.muted, bg: T.borderSoft, ring: T.border, icon: "○", slaHours: 168 },
};

export const STATUS = {
  unassigned: { label: "Unassigned", color: T.danger, bg: T.dangerSoft, ring: "#EBC3BC" },
  assigned: { label: "Assigned", color: T.accent, bg: T.accentSoft, ring: T.accentRing },
  wip: { label: "In Progress", color: T.violet, bg: T.violetSoft, ring: "#D4C9E8" },
  parts: { label: "Awaiting Parts", color: T.warn, bg: T.warnSoft, ring: "#EED9A6" },
  capital: { label: "Capital Replacement", color: "#5B4B8A", bg: "#EDE9F5", ring: "#D4C9E8" },
  completed: { label: "Completed", color: T.success, bg: T.successSoft, ring: "#CFDED3" },
  pending_invoice: { label: "Pending Invoice", color: "#B8478A", bg: "#F8E9F0", ring: "#EEC8DC" },
  pending_approval: { label: "Pending Approval", color: T.muted, bg: T.borderSoft, ring: T.border },
  pending_payment: { label: "Pending Payment", color: "#0E7C7B", bg: "#E0F2F1", ring: "#B2DFDB" },
  closed: { label: "Closed", color: T.subtle, bg: T.borderSoft, ring: T.border },
};

export const FUNCTIONAL_STATUS = {
  Dispatched: { color: T.danger, bg: T.dangerSoft },
  "Work in Progress": { color: T.violet, bg: T.violetSoft },
  "Pending Capital Approval": { color: "#5B4B8A", bg: "#EDE9F5" },
  "Awaiting Parts": { color: T.warn, bg: T.warnSoft },
  Completed: { color: T.success, bg: T.successSoft },
  Cancelled: { color: T.muted, bg: T.borderSoft },
};

export const INV_STATE = {
  submitted: { label: "Submitted", color: T.accent, bg: T.accentSoft },
  approved: { label: "Approved", color: T.success, bg: T.successSoft },
  rejected: { label: "Rejected", color: T.danger, bg: T.dangerSoft },
  revised: { label: "Revised", color: T.warn, bg: T.warnSoft },
};

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const P1_BUSINESS = {
  legalName: "P Hospitality Repairs LLC",
  dba: "P1 Pros",
  addr1: "10181 Sample Rd #204",
  addr2: "Coral Springs, FL 33065",
  email: "eddie@phospitality.com",
  phone: "+1 (561) 421-1281",
  website: "www.p1pros.com",
  defaultLaborRate: 110, // placeholder — pending Jeremy confirmation per contractor
  defaultTravelRate: 110,
  defaultTerms: "Net 30",
};

export const SEVEN_BILL_TO = {
  name: "7-ELEVEN INC",
  addr1: "3200 Hackberry Rd",
  addr2: "Irving, TX 75063 USA",
};

export const LINE_TYPES = ["Truck Charge", "Labor", "Parts/Hardware", "Shipping", "Other"] as const;
