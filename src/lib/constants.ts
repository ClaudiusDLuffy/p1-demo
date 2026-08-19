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

export const DEMO_ACCOUNTS: {
  email: string
  name: string
  initials: string
  color: string
  subtitle: string
}[] = [];

export const PRIORITY = {
  p1: { label: "P1 Critical", short: "P1", color: T.danger, bg: T.dangerSoft, ring: "#EBC3BC", icon: "âš¡", slaHours: 8 },
  p2: { label: "P2 Emergency", short: "P2", color: T.accent, bg: T.accentSoft, ring: T.accentRing, icon: "â—†", slaHours: 24 },
  p3: { label: "P3 Standard", short: "P3", color: T.warn, bg: T.warnSoft, ring: "#EED9A6", icon: "â—", slaHours: 72 },
  p4: { label: "P4 Minor", short: "P4", color: T.muted, bg: T.borderSoft, ring: T.border, icon: "â—‹", slaHours: 168 },
  p5: { label: "P5 Preventative", short: "P5", color: T.success, bg: T.successSoft, ring: "#CFDED3", icon: "PM", slaHours: 0 },
};

export const STATUS = {
  unassigned: { label: "Unassigned", color: T.danger, bg: T.dangerSoft, ring: "#EBC3BC" },
  assigned: { label: "Assigned", color: T.accent, bg: T.accentSoft, ring: T.accentRing },
  wip: { label: "In Progress", color: T.violet, bg: T.violetSoft, ring: "#D4C9E8" },
  parts: { label: "Awaiting Parts", color: T.warn, bg: T.warnSoft, ring: "#EED9A6" },
  capital: { label: "Capital Replacement", color: "#5B4B8A", bg: "#EDE9F5", ring: "#D4C9E8" },
  pending_capital_completion: { label: "Pending Capital Completion", color: "#5B4B8A", bg: "#EDE9F5", ring: "#D4C9E8" },
  completed: { label: "Completed", color: T.success, bg: T.successSoft, ring: "#CFDED3" },
  pending_invoice: { label: "Pending 7-Eleven Submission", color: "#B8478A", bg: "#F8E9F0", ring: "#EEC8DC" },
  pending_approval: { label: "Pending Approval", color: T.muted, bg: T.borderSoft, ring: T.border },
  // Compatibility alias for rows created before the payment stage was retired.
  pending_payment: { label: "Pending 7-Eleven Submission", color: "#B8478A", bg: "#F8E9F0", ring: "#EEC8DC" },
  closed: { label: "Closed", color: T.subtle, bg: T.borderSoft, ring: T.border },
};

export const FUNCTIONAL_STATUS = {
  Dispatched: { color: T.danger, bg: T.dangerSoft },
  "Work in Progress": { color: T.violet, bg: T.violetSoft },
  "Pending Capital Approval": { color: "#5B4B8A", bg: "#EDE9F5" },
  "Pending Capital Completion": { color: "#5B4B8A", bg: "#EDE9F5" },
  "Awaiting Parts": { color: T.warn, bg: T.warnSoft },
  Completed: { color: T.success, bg: T.successSoft },
  Cancelled: { color: T.muted, bg: T.borderSoft },
};

export const INV_STATE = {
  draft: { label: "Draft", color: T.subtle, bg: T.surfaceSoft },
  submitted: { label: "Submitted", color: T.accent, bg: T.accentSoft },
  approved: { label: "Approved", color: T.success, bg: T.successSoft },
  rejected: { label: "Rejected", color: T.danger, bg: T.dangerSoft },
  revised: { label: "Revised", color: T.warn, bg: T.warnSoft },
  paid: { label: "Sent to QuickBooks", color: T.success, bg: T.successSoft },
};

export const STAFF_INV_STATE = {
  ...INV_STATE,
  submitted: { ...INV_STATE.submitted, label: "Please send to 7-Eleven" },
  approved: { ...INV_STATE.approved, label: "Sent to 7-Eleven" },
};

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Single source of truth for P1 Pros invoice contact info. invoicePdf.ts
// imports from here too — DO NOT add a divergent copy. Legal-name
// parenthetical intentionally removed (Lindsay 2026-06-16).
export const P1_BUSINESS = {
  dba: "P1 Pros",
  addr1: "10181 Sample Rd #204",
  addr2: "Coral Springs, FL 33065",
  email: "service@p1pros.com",
  phone: "352-585-6498",
  website: "www.p1pros.com",
  // Rate fields start empty — the contractor enters their own number.
  // Truck Charge is the one exception: editable default of 60.
  defaultTruckCharge: 60,
  defaultTerms: "Net 30",
};

export const SEVEN_BILL_TO = {
  name: "7-ELEVEN INC",
  addr1: "3200 Hackberry Rd",
  addr2: "Irving, TX 75063 USA",
};

export const SEVEN_STAFF_BILL_TO = {
  name: "7-Eleven Inc",
  addr1: "2711 Haskell Ave",
  addr2: "Dallas TX 75204",
};

export const LINE_TYPES = ["Truck Charge", "Labor", "Parts/Hardware", "Shipping", "Other"] as const;
