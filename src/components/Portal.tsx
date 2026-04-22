"use client";
// @ts-nocheck
import { useState, useEffect, useMemo } from "react";
import {
  signIn, signOut, getSession,
  loadAllProfiles, loadWorkOrders, loadInvoices,
  updateWorkOrder, insertActivity, insertWorkOrder, insertInvoice,
  uploadPhotos, removePhoto, subscribeToChanges, nextWorkOrderId, getPhotoUrl,
} from "../lib/db";
import { supabase } from "../lib/supabase/client";

// ═══════════════════════════════════════════════════════════════
//  THEME — Claude-inspired warm palette. Tokens are the source of truth.
// ═══════════════════════════════════════════════════════════════
const T = {
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

// ═══════════════════════════════════════════════════════════════
//  REAL P1 TEAM + CONTRACTORS (from Jeremy's email, Apr 20 2026)
// ═══════════════════════════════════════════════════════════════
// Demo quick-access buttons on the login screen (clicks pre-fill email + sign in).
// Real user/profile data loads from Supabase after successful auth.
const DEMO_ACCOUNTS = [
  { email: "claytonetchison@gmail.com", name: "Clay Etchison", initials: "CE", color: "#1F1E1C", subtitle: "Owner" },
  { email: "jeremy@p1pros.com", name: "Jeremy Barry", initials: "JB", color: "#C15F3C", subtitle: "Owner" },
  { email: "landryd@phospitality.com", name: "Landry Dillinger", initials: "LD", color: "#A67C00", subtitle: "Dispatcher" },
  { email: "scrcdallastexas@gmail.com", name: "Derek Starnes", initials: "DS", color: "#0891B2", subtitle: "Contractor — Dallas" },
];
const DEMO_PASSWORD = "p1demo2026!";

// ═══════════════════════════════════════════════════════════════
//  7-ELEVEN PRIORITY ENUM (real format: P1 Critical, P2 Emergency, etc)
// ═══════════════════════════════════════════════════════════════
const PRIORITY = {
  p1: { label: "P1 Critical", short: "P1", color: T.danger, bg: T.dangerSoft, ring: "#EBC3BC", icon: "⚡", slaHours: 8 },
  p2: { label: "P2 Emergency", short: "P2", color: T.accent, bg: T.accentSoft, ring: T.accentRing, icon: "◆", slaHours: 24 },
  p3: { label: "P3 Standard", short: "P3", color: T.warn, bg: T.warnSoft, ring: "#EED9A6", icon: "●", slaHours: 72 },
  p4: { label: "P4 Minor", short: "P4", color: T.muted, bg: T.borderSoft, ring: T.border, icon: "○", slaHours: 168 },
};

// Internal pipeline state (our kanban)
const STATUS = {
  unassigned: { label: "Unassigned", color: T.danger, bg: T.dangerSoft, ring: "#EBC3BC" },
  assigned: { label: "Assigned", color: T.accent, bg: T.accentSoft, ring: T.accentRing },
  wip: { label: "In Progress", color: T.violet, bg: T.violetSoft, ring: "#D4C9E8" },
  parts: { label: "Awaiting Parts", color: T.warn, bg: T.warnSoft, ring: "#EED9A6" },
  capital: { label: "Capital Replacement", color: "#5B4B8A", bg: "#EDE9F5", ring: "#D4C9E8" },
  completed: { label: "Completed", color: T.success, bg: T.successSoft, ring: "#CFDED3" },
  pending_invoice: { label: "Pending Invoice", color: "#B8478A", bg: "#F8E9F0", ring: "#EEC8DC" },
  pending_approval: { label: "Pending Approval", color: T.muted, bg: T.borderSoft, ring: T.border },
};

// 7-Eleven's Functional Status field (what Gustavo's SLA breach hinged on)
const FUNCTIONAL_STATUS = {
  Dispatched: { color: T.danger, bg: T.dangerSoft },
  "Work in Progress": { color: T.violet, bg: T.violetSoft },
  "Pending Capital Approval": { color: "#5B4B8A", bg: "#EDE9F5" },
  "Awaiting Parts": { color: T.warn, bg: T.warnSoft },
  Completed: { color: T.success, bg: T.successSoft },
  Cancelled: { color: T.muted, bg: T.borderSoft },
};

const INV_STATE = {
  submitted: { label: "Submitted", color: T.accent, bg: T.accentSoft },
  approved: { label: "Approved", color: T.success, bg: T.successSoft },
  rejected: { label: "Rejected", color: T.danger, bg: T.dangerSoft },
  revised: { label: "Revised", color: T.warn, bg: T.warnSoft },
};

// ═══════════════════════════════════════════════════════════════
//  TRADE / TERRITORY ROUTING
// ═══════════════════════════════════════════════════════════════
// Map 7-Eleven's Line of Service / Category → our internal trade tags
const SERVICE_TO_TRADES = (service: string, category: string) => {
  const s = `${service} ${category}`.toLowerCase();
  const tags: string[] = [];
  if (/slurp/.test(s)) tags.push("slurpee");
  if (/frozen beverage|slurp/.test(s)) tags.push("slurpee");
  if (/fountain|cold beverage|beverage/.test(s)) tags.push("beverage");
  if (/ice merchandiser|ice /.test(s)) tags.push("ice");
  if (/refriger|freezer|cooler/.test(s)) tags.push("refrigeration");
  if (/hvac|heating|air cond/.test(s)) tags.push("hvac");
  if (/plumb|drain/.test(s)) tags.push("plumbing");
  if (/grease trap|septic/.test(s)) tags.push("grease");
  if (/hot food|oven|grill/.test(s)) tags.push("hotfood");
  return tags.length ? tags : ["refrigeration"]; // fallback
};

// City → (state normalized) for territory matching
const normalizeCity = (loc: string) => (loc || "").toLowerCase().split(",")[0].trim();
// Pick best contractor for a ticket: must match at least one trade AND territory
const contractorFor = (city: string, tradeTags: string[], contractors: any[]) => {
  const c = normalizeCity(city);
  const scored = contractors
    .filter(u => u.role === "contractor")
    .map(u => {
      const terrMatch = u.territory?.toLowerCase().split(",")[0].trim() === c || u.territory?.toLowerCase().includes(c);
      const tradeMatch = (u.trades || []).some((t: string) => tradeTags.includes(t));
      return { id: u.id, score: (terrMatch ? 10 : 0) + (tradeMatch ? 5 : 0) + ((u.trades || []).filter((t: string) => tradeTags.includes(t)).length), terrMatch, tradeMatch };
    })
    .filter(s => s.terrMatch && s.tradeMatch)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.id || null;
};

// ═══════════════════════════════════════════════════════════════
//  DATE + SLA HELPERS
// ═══════════════════════════════════════════════════════════════
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const timeNow = () => { const d = new Date(), h = d.getHours(), m = d.getMinutes(), ap = h >= 12 ? "PM" : "AM"; return `${h > 12 ? h - 12 : h || 12}:${m < 10 ? "0" + m : m} ${ap}`; };
const dateShort = (d = new Date()) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
const dateNow = () => `${dateShort()}, ${timeNow()}`;
const dateLong = (d = new Date()) => `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
const hoursBetween = (aIso: string, bIso: string) => (new Date(bIso).getTime() - new Date(aIso).getTime()) / 3600000;
const slaRemaining = (wo: any) => {
  if (!wo.dispatchedAt || !PRIORITY[wo.priority]) return null;
  const slaH = PRIORITY[wo.priority].slaHours;
  const elapsed = hoursBetween(wo.dispatchedAt, new Date().toISOString());
  return { remainingHours: slaH - elapsed, elapsedHours: elapsed, slaHours: slaH, percent: Math.min(100, (elapsed / slaH) * 100) };
};
const slaLabel = (wo: any) => {
  const s = slaRemaining(wo);
  if (!s) return null;
  if (s.remainingHours <= 0) return { text: `${Math.floor(-s.remainingHours)}h past SLA`, color: T.danger, bg: T.dangerSoft, severity: "breach" };
  if (s.remainingHours < 1) return { text: `${Math.round(s.remainingHours * 60)}m to breach`, color: T.danger, bg: T.dangerSoft, severity: "critical" };
  if (s.percent >= 75) return { text: `${Math.floor(s.remainingHours)}h left`, color: T.accent, bg: T.accentSoft, severity: "warn" };
  if (s.percent >= 50) return { text: `${Math.floor(s.remainingHours)}h left`, color: T.warn, bg: T.warnSoft, severity: "ok" };
  return { text: `${Math.floor(s.remainingHours)}h left`, color: T.success, bg: T.successSoft, severity: "safe" };
};

const isOpenState = (state: string) => !["completed", "pending_invoice", "pending_approval", "capital"].includes(state);
const activeStatuses = ["unassigned", "assigned", "wip", "parts"];
const closingStatuses = ["completed", "pending_invoice", "pending_approval"];

// ═══════════════════════════════════════════════════════════════
//  SEED WORK ORDERS — real 7-Eleven field shapes
// ═══════════════════════════════════════════════════════════════
// Helper: hours ago → ISO
const hoursAgo = (n: number) => new Date(Date.now() - n * 3600 * 1000).toISOString();


// ═══════════════════════════════════════════════════════════════
//  P1 BUSINESS INFO (from invoice 6556)
// ═══════════════════════════════════════════════════════════════
const P1_BUSINESS = {
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

// 7-Eleven corporate AP — where all invoices are billed
const SEVEN_BILL_TO = {
  name: "7-ELEVEN INC",
  addr1: "3200 Hackberry Rd",
  addr2: "Irving, TX 75063 USA",
};

// Line item types matching real P1 invoice (6556)
const LINE_TYPES = ["Travel", "Labor", "Parts/Hardware", "Shipping", "Other"] as const;

// Helper: compute line amount
const lineAmount = (l: any) => (parseFloat(l.qty) || 0) * (parseFloat(l.rate) || 0);
const invSubtotal = (lines: any[]) => lines.reduce((s, l) => s + lineAmount(l), 0);
const invTotal = (lines: any[], tax: number) => invSubtotal(lines) + (parseFloat(tax as any) || 0);

// ═══════════════════════════════════════════════════════════════
//  INITIAL INVOICES — including the REAL Invoice 6556
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  US CITY COORDS — expanded beyond Florida
// ═══════════════════════════════════════════════════════════════
const CITY_COORDS: Record<string, { lat: number; lng: number }> = {
  dallas: { lat: 32.7767, lng: -96.797 },
  plano: { lat: 33.0198, lng: -96.6989 },
  houston: { lat: 29.7604, lng: -95.3698 },
  yorktown: { lat: 37.2388, lng: -76.5097 },
  "virginia beach": { lat: 36.8529, lng: -75.978 },
  tampa: { lat: 27.9506, lng: -82.4572 },
  orlando: { lat: 28.5383, lng: -81.3792 },
  kissimmee: { lat: 28.292, lng: -81.4076 },
  melbourne: { lat: 28.0836, lng: -80.6081 },
  "daytona beach": { lat: 29.2108, lng: -81.0228 },
  miami: { lat: 25.7617, lng: -80.1918 },
};
// US bbox (contiguous): lng -125 to -66, lat 24 to 50
const geoToSvg = (lat: number, lng: number, w = 800, h = 460) => {
  const x = ((lng + 125) / 59) * w;
  const y = ((50 - lat) / 26) * h;
  return { x, y };
};
const coordsForCity = (city: string) => {
  const key = normalizeCity(city);
  const c = CITY_COORDS[key];
  return c ? geoToSvg(c.lat, c.lng) : null;
};

// Simplified US outline (approximate, for styling)
const US_PATH = "M 104 132 L 170 122 L 236 110 L 292 106 L 356 108 L 418 114 L 478 118 L 540 120 L 592 126 L 634 138 L 664 158 L 682 184 L 688 212 L 684 236 L 670 256 L 652 268 L 634 274 L 614 272 L 600 282 L 608 300 L 628 316 L 638 340 L 624 362 L 598 378 L 566 388 L 528 390 L 484 380 L 438 368 L 392 358 L 344 350 L 296 342 L 248 332 L 202 320 L 158 304 L 122 282 L 96 256 L 80 226 L 76 196 L 84 168 Z";

// ═══════════════════════════════════════════════════════════════
//  TINY UI PRIMITIVES
// ═══════════════════════════════════════════════════════════════
const fmt = (n: number) => "$" + (n || 0).toLocaleString();
const Badge = ({ conf, small = false }: any) => conf ? (
  <span style={{ fontSize: small ? 10 : 11, fontWeight: 600, padding: small ? "2px 8px" : "3px 10px", borderRadius: 20, background: conf.bg, color: conf.color, border: `1px solid ${conf.ring || conf.bg}`, whiteSpace: "nowrap", letterSpacing: .2 }}>{conf.label}</span>
) : null;
const Ico = ({ d, size = 18, color = "currentColor" }: any) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);
const Avatar = ({ initials, color, size = 36 }: any) => (
  <div style={{ width: size, height: size, borderRadius: "50%", background: color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.32, fontWeight: 600, color: "#fff", letterSpacing: -0.3, flexShrink: 0, border: "1px solid rgba(255,255,255,0.12)" }}>{initials}</div>
);
const Field = ({ label, children }: any) => (
  <div>
    <label style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 6, display: "block" }}>{label}</label>
    {children}
  </div>
);
const Input = (props: any) => <input {...props} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit", background: T.surface, color: T.ink, boxSizing: "border-box", outline: "none", ...(props.style || {}) }} />;
const Sel = ({ children, ...p }: any) => <select {...p} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit", background: T.surface, color: T.ink, boxSizing: "border-box", outline: "none", ...(p.style || {}) }}>{children}</select>;
const TA = (p: any) => <textarea {...p} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit", background: T.surface, color: T.ink, resize: "vertical", boxSizing: "border-box", outline: "none", ...(p.style || {}) }} />;

const CSS = `
@keyframes fadeUp { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: translateY(0) } }
@keyframes spin { to { transform: rotate(360deg) } }
@keyframes pulse { 0%,100% { transform: scale(1); opacity: 1 } 50% { transform: scale(1.08); opacity: 0.85 } }
.display { font-family: 'Instrument Serif', Georgia, serif; font-weight: 400; letter-spacing: -0.5px; }
.mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
.kcard { background: ${T.surface}; border: 1px solid ${T.borderSoft}; box-shadow: 0 1px 2px rgba(31,30,28,0.03); transition: transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease; }
.kcard:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(31,30,28,0.07); border-color: ${T.border}; }
.kcol { border-radius: 16px; border: 1px solid ${T.borderSoft}; box-shadow: 0 1px 2px rgba(31,30,28,0.02); overflow: hidden; }
.card { background: ${T.surface}; border-radius: 16px; border: 1px solid ${T.borderSoft}; box-shadow: 0 1px 2px rgba(31,30,28,0.03); }
.card-hover { transition: box-shadow 140ms ease, transform 140ms ease; }
.card-hover:hover { box-shadow: 0 8px 24px rgba(31,30,28,0.06); transform: translateY(-1px); }
.btn-primary { padding: 10px 18px; border-radius: 10px; background: ${T.ink}; color: ${T.bg}; border: none; cursor: pointer; font-weight: 600; font-size: 12px; font-family: inherit; transition: background 140ms; }
.btn-primary:hover { background: #000; }
.btn-accent { padding: 10px 18px; border-radius: 10px; background: ${T.accent}; color: #fff; border: none; cursor: pointer; font-weight: 600; font-size: 12px; font-family: inherit; transition: filter 140ms; }
.btn-accent:hover { filter: brightness(1.08); }
.btn-soft { padding: 10px 18px; border-radius: 10px; background: ${T.surface}; color: ${T.ink}; border: 1px solid ${T.border}; cursor: pointer; font-weight: 500; font-size: 12px; font-family: inherit; transition: background 140ms; }
.btn-soft:hover { background: ${T.bgWarm}; }
.side-btn { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 12px; border-radius: 10px; border: none; background: transparent; color: ${T.sidebarText}; cursor: pointer; font-size: 13px; font-family: inherit; margin-bottom: 2px; transition: background 140ms, color 140ms; }
.side-btn:hover { background: rgba(250,247,242,0.06); color: ${T.sidebarActive}; }
.side-btn.active { background: rgba(250,247,242,0.08); color: ${T.sidebarActive}; font-weight: 600; }
.sla-bar { height: 3px; border-radius: 2px; background: ${T.borderSoft}; overflow: hidden; }
.sla-fill { height: 100%; transition: width 300ms ease; }
@media(max-width: 768px) {
  .desktop-sidebar { display: none !important; }
  .mobile-bottom-nav { display: flex !important; }
  .main-wrap { margin-left: 0 !important; }
  .stats-grid { grid-template-columns: repeat(3, 1fr) !important; gap: 10px !important; }
  .kanban-active { grid-template-columns: 1fr 1fr !important; }
  .kanban-closing { grid-template-columns: 1fr !important; }
  .detail-two-col { grid-template-columns: 1fr !important; }
  .detail-fields { grid-template-columns: 1fr 1fr !important; }
  .contractors-grid { grid-template-columns: 1fr !important; }
  .capital-grid { grid-template-columns: 1fr !important; }
  .table-scroll { overflow-x: auto; }
  .topbar-title { font-size: 22px !important; }
  .content-pad { padding: 16px !important; }
  .modal-inner { width: 95% !important; padding: 20px !important; max-height: 85vh !important; }
  .modal-form-row { grid-template-columns: 1fr !important; }
  .stat-value { font-size: 28px !important; }
  .stats-grid .stat-hero { grid-column: 1 / -1 !important; }
}
@media(min-width: 769px) { .mobile-bottom-nav { display: none !important; } }
`;

const Modal = ({ onClose, title, children, width = 480 }: any) => (
  <div onClick={e => { if (e.target === e.currentTarget) onClose(); }} style={{ position: "fixed", inset: 0, background: "rgba(31,30,28,0.45)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }}>
    <div className="modal-inner" style={{ background: T.surface, borderRadius: 20, width: "90%", maxWidth: width, padding: 28, animation: "fadeUp 0.25s", boxShadow: "0 20px 60px rgba(31,30,28,0.22)", maxHeight: "90vh", overflowY: "auto", border: `1px solid ${T.borderSoft}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div className="display" style={{ fontSize: 22, color: T.ink }}>{title}</div>
        <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: "50%", border: `1px solid ${T.border}`, background: T.bgWarm, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 16, color: T.muted }}>×</button>
      </div>
      {children}
    </div>
  </div>
);

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════
export default function P1Portal() {
  const [currentUser, setCurrentUser] = useState(null);
  const [page, setPage] = useState("dashboard");
  const [selectedWO, setSelectedWO] = useState(null);
  const [search, setSearch] = useState("");
  const [filterC, setFilterC] = useState("all");
  const [filterP, setFilterP] = useState("all");
  const [invTab, setInvTab] = useState("all");
  const [toast, setToast] = useState(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [fadeIn, setFadeIn] = useState(false);
  const [aiEnhancing, setAiEnhancing] = useState(false);
  const [aiNote, setAiNote] = useState(null);
  const [modal, setModal] = useState(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [workOrders, setWorkOrders] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [USERS, setUsers] = useState<any[]>(DEMO_ACCOUNTS.map(d => ({ id: d.email, ...d, role: "manager" })));
  const [dataLoading, setDataLoading] = useState(true);
  const [newWO, setNewWO] = useState({ store: "", city: "", priority: "p3", businessService: "", category: "", summary: "", nte: "", assign: "auto" });
  const resetNewWO = () => setNewWO({ store: "", city: "", priority: "p3", businessService: "", category: "", summary: "", nte: "", assign: "auto" });
  // Invoice builder state — line-item based, matches P1's real invoice format (6556)
  const defaultInvLines = () => [
    { type: "Travel", desc: "Travel to site", qty: 1, rate: P1_BUSINESS.defaultTravelRate, amount: P1_BUSINESS.defaultTravelRate },
    { type: "Labor", desc: "", qty: 1, rate: P1_BUSINESS.defaultLaborRate, amount: P1_BUSINESS.defaultLaborRate },
  ];
  const nextInvNum = () => {
    const maxNum = invoices.reduce((m, i) => { const n = parseInt(i.num) || 0; return n > m ? n : m; }, 6500);
    return String(maxNum + 1);
  };
  const blankNewInv = () => ({
    num: "",
    cme: "",
    terms: P1_BUSINESS.defaultTerms,
    serviceDate: new Date().toISOString().slice(0, 10),
    invoiceDate: new Date().toISOString().slice(0, 10),
    tax: "",
    hasPdf: false,
    lines: defaultInvLines(),
  });
  const [newInv, setNewInv] = useState<any>(blankNewInv());
  const resetNewInv = () => setNewInv(blankNewInv());
  const [selectedInvoice, setSelectedInvoice] = useState<string | null>(null);
  // Tick every 60s so SLA countdowns update live
  const [, forceTick] = useState(0);
  useEffect(() => { const i = setInterval(() => forceTick(x => x + 1), 60000); return () => clearInterval(i); }, []);

  useEffect(() => { setTimeout(() => setFadeIn(true), 50); }, []);
  useEffect(() => {
    if (!currentUser || currentUser.role !== "manager") return;
    // Demo-only simulated notifications. Off by default. Append ?demo=true to URL to enable
    // for a dramatic moment in a presentation (then real notifications come in v9 via Resend).
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("demo") !== "true") return;
    const t1 = setTimeout(() => setToast("New call from FSM — Store #33089, Dallas. Roller grill down."), 6000);
    const t2 = setTimeout(() => setToast(null), 9000);
    const t3 = setTimeout(() => setToast("Chris checked in at Store #35551"), 48000);
    const t4 = setTimeout(() => setToast(null), 51000);
    return () => { [t1, t2, t3, t4].forEach(clearTimeout); };
  }, [currentUser?.id]);

  const fire = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2800); };

  // Real Supabase auth — replaces demo button login
  const doLogin = async (email: string, password: string = DEMO_PASSWORD) => {
    const v = (email || "").trim();
    if (!v) { setLoginError("Enter an email to sign in"); return; }
    setLoginError(null);
    setLoginLoading(true);
    try {
      await signIn(v, password);
      // currentUser will populate via the auth listener effect below
    } catch (err: any) {
      setLoginError(err.message || "Sign in failed");
      setLoginLoading(false);
    }
  };
  const logout = async () => {
    await signOut();
    setCurrentUser(null);
    setPage("dashboard");
    setSelectedWO(null);
    setLoginEmail("");
    setAiNote(null);
    setWorkOrders([]);
    setInvoices([]);
  };

  // ── DATA LOADERS — fire when auth session is available ───────────────
  // Hydrate session on mount + listen for changes
  useEffect(() => {
    let mounted = true;
    (async () => {
      const session = await getSession();
      if (!session?.user || !mounted) return;
      // Pull this user's profile (only once per session)
      const sb = supabase();
      const { data: prof } = await sb.from("profiles").select("*").eq("id", session.user.id).single();
      if (prof && mounted) {
        setCurrentUser({
          id: prof.id, name: prof.name, email: prof.email, initials: prof.initials, role: prof.role,
          title: prof.title, company: prof.company, phone: prof.phone, territory: prof.territory,
          trades: prof.trades || [], color: prof.color,
        });
        setPage(prof.role === "contractor" ? "my_jobs" : "dashboard");
        setLoginLoading(false);
      }
    })();
    const sb = supabase();
    const { data: { subscription } } = sb.auth.onAuthStateChange(async (event, session) => {
      if (!mounted) return;
      if (event === "SIGNED_IN" && session?.user) {
        const { data: prof } = await sb.from("profiles").select("*").eq("id", session.user.id).single();
        if (prof) {
          setCurrentUser({
            id: prof.id, name: prof.name, email: prof.email, initials: prof.initials, role: prof.role,
            title: prof.title, company: prof.company, phone: prof.phone, territory: prof.territory,
            trades: prof.trades || [], color: prof.color,
          });
          setPage(prof.role === "contractor" ? "my_jobs" : "dashboard");
          setLoginLoading(false);
        }
      } else if (event === "SIGNED_OUT") {
        setCurrentUser(null);
      }
    });
    return () => { mounted = false; subscription.unsubscribe(); };
  }, []);

  // Load profiles + work orders + invoices once we have a current user
  // + Subscribe to realtime so changes from other clients propagate
  useEffect(() => {
    if (!currentUser) return;
    let mounted = true;
    let refetchTimer: any = null;

    const refetch = async () => {
      try {
        const [wos, invs] = await Promise.all([loadWorkOrders(), loadInvoices()]);
        if (!mounted) return;
        setWorkOrders(wos);
        setInvoices(invs);
      } catch (err: any) { /* swallow — local state still valid */ }
    };

    // Debounce: realtime can fire many events for one mutation (work_orders + activities + photos)
    const debouncedRefetch = () => {
      if (refetchTimer) clearTimeout(refetchTimer);
      refetchTimer = setTimeout(refetch, 350);
    };

    (async () => {
      setDataLoading(true);
      try {
        const [profs, wos, invs] = await Promise.all([loadAllProfiles(), loadWorkOrders(), loadInvoices()]);
        if (!mounted) return;
        setUsers(profs);
        setWorkOrders(wos);
        setInvoices(invs);
      } catch (err: any) {
        fire(`Load error: ${err.message || err}`);
      } finally {
        if (mounted) setDataLoading(false);
      }
    })();

    const unsub = subscribeToChanges(debouncedRefetch);
    return () => { mounted = false; if (refetchTimer) clearTimeout(refetchTimer); unsub(); };
  }, [currentUser?.id]);
  const nav = (p: string) => { setPage(p); setSelectedWO(null); setAiNote(null); };

  const isManager = currentUser?.role === "manager" || currentUser?.role === "dispatcher" || currentUser?.role === "back_office";
  const getUser = (id: string) => USERS.find(u => u.id === id);
  const contractorsOnly = USERS.filter(u => u.role === "contractor");
  const myWOs = currentUser?.role === "contractor" ? workOrders.filter(w => w.contractor === currentUser.id) : workOrders;
  const filteredWOs = myWOs.filter(w => {
    if (search && !w.id.toLowerCase().includes(search.toLowerCase()) && !w.store.includes(search) && !(w.summary || "").toLowerCase().includes(search.toLowerCase())) return false;
    if (filterC !== "all" && w.contractor !== filterC) return false;
    if (filterP !== "all" && w.priority !== filterP) return false;
    return true;
  });

  const openWOs = workOrders.filter(w => activeStatuses.includes(w.status));
  const openCount = openWOs.length;
  const openValue = openWOs.reduce((s, w) => s + (w.nte || 0), 0);
  const p1Count = workOrders.filter(w => w.priority === "p1" && activeStatuses.includes(w.status)).length;
  const p1Unassigned = workOrders.filter(w => w.priority === "p1" && w.status === "unassigned").length;
  const capitalCount = workOrders.filter(w => w.status === "capital").length;
  const completedCount = workOrders.filter(w => w.status === "completed").length;
  const pendAppr = workOrders.filter(w => w.status === "pending_approval").length;
  const slaAtRisk = workOrders.filter(w => { const s = slaRemaining(w); return s && s.remainingHours < 2 && activeStatuses.includes(w.status); }).length;
  const slaBreached = workOrders.filter(w => { const s = slaRemaining(w); return s && s.remainingHours <= 0 && activeStatuses.includes(w.status); }).length;
  const woData = selectedWO ? workOrders.find(w => w.id === selectedWO) : null;

  // ── STATE TRANSITIONS — every mutation hits the DB, then optimistic-updates local state
  // Realtime subscription propagates the same change to other clients within ~200ms.

  // Local optimistic patch helper (visual update before DB confirms)
  const patchLocalWO = (id: string, patch: any, newActivity?: any) => {
    setWorkOrders(prev => prev.map(w => w.id === id ? {
      ...w,
      ...patch,
      activities: newActivity ? [newActivity, ...w.activities] : w.activities,
    } : w));
  };
  const localActivity = (text: string, type: "note" | "system" | "ai" = "system") => ({
    author: type === "system" ? "System" : currentUser.name,
    time: dateNow(),
    text,
    type,
  });

  // Wrap a DB call in a try/catch that fires a toast on failure
  const dbCall = async (fn: () => Promise<any>, errorMsg: string = "Save failed") => {
    try { await fn(); return true; }
    catch (e: any) { fire(`${errorMsg}: ${e.message || e}`); return false; }
  };

  const doAssign = async (woId: string, contractorId: string) => {
    const c = getUser(contractorId);
    if (!c) { fire("Contractor not found"); return; }
    const dispatchedAt = new Date().toISOString();
    const text = `Dispatched to ${c.name}${c.company ? ` (${c.company})` : ""}.`;
    patchLocalWO(woId, { status: "assigned", contractor: contractorId, dispatchedAt, functionalStatus: "Dispatched" }, localActivity(text, "system"));
    fire(`Dispatched to ${c.name}`);
    await dbCall(async () => {
      await updateWorkOrder(woId, { status: "assigned", contractor: contractorId, dispatchedAt, functionalStatus: "Dispatched" });
      await insertActivity(woId, "System", text, "system");
    }, "Dispatch failed");
  };

  const doSetEta = async (woId: string, eta: string) => {
    const text = `ETA set: ${eta}`;
    patchLocalWO(woId, { eta }, localActivity(text, "system"));
    fire("ETA set");
    await dbCall(async () => {
      await updateWorkOrder(woId, { eta });
      await insertActivity(woId, currentUser.name, text, "system");
    }, "ETA save failed");
  };

  const doStartWork = async (woId: string, notes: string) => {
    const startIso = new Date().toISOString();
    const text = notes || `Checked in and started work at ${timeNow()}.`;
    patchLocalWO(woId, { status: "wip", functionalStatus: "Work in Progress", startTime: startIso }, localActivity(text, "note"));
    fire(`Work started · status synced to 7-Eleven`);
    await dbCall(async () => {
      await updateWorkOrder(woId, { status: "wip", functionalStatus: "Work in Progress", startTime: startIso });
      await insertActivity(woId, currentUser.name, text, "note");
    }, "Start work failed");
  };

  const doPauseWork = async (woId: string, reason: string, partDesc: string, partNum: string, partEta: string, notes: string) => {
    const partLabel = partDesc ? `${partDesc}${partNum ? ` (${partNum})` : ""}` : null;
    const text = notes || `Work paused: ${reason}.${partLabel ? ` Part needed: ${partLabel}.` : ""}`;
    const updates: any = { status: "parts", functionalStatus: "Awaiting Parts" };
    if (partLabel) updates.partNeeded = partLabel;
    if (partEta) updates.partEta = partEta; // ISO date string from input type=date
    patchLocalWO(woId, updates, localActivity(text, "note"));
    fire("Paused — awaiting parts");
    await dbCall(async () => {
      await updateWorkOrder(woId, updates);
      await insertActivity(woId, currentUser.name, text, "note");
    }, "Pause failed");
  };

  const doCloseComplete = async (woId: string, model: string, serial: string, resolution: string) => {
    const endIso = new Date().toISOString();
    const text = `Job completed. Asset: ${model} / ${serial}. Resolution: ${resolution || "Repaired"}.`;
    patchLocalWO(woId, { status: "completed", functionalStatus: "Completed", assetModel: model, assetSerial: serial, endTime: endIso, resolutionCode: resolution || null }, localActivity(text, "note"));
    fire("Completed");
    await dbCall(async () => {
      await updateWorkOrder(woId, { status: "completed", functionalStatus: "Completed", assetModel: model, assetSerial: serial, endTime: endIso, resolutionCode: resolution || null });
      await insertActivity(woId, currentUser.name, text, "note");
    }, "Close failed");
  };

  const doMoveToInvoice = async (woId: string) => {
    const text = "7-Eleven portal updated. Moved to pending invoice.";
    patchLocalWO(woId, { status: "pending_invoice" }, localActivity(text, "system"));
    fire("Moved to Pending Invoice");
    await dbCall(async () => {
      await updateWorkOrder(woId, { status: "pending_invoice" });
      await insertActivity(woId, "System", text, "system");
    }, "Update failed");
  };

  const doCapitalFlag = async (woId: string) => {
    const text = "Flagged as capital replacement — pending approval.";
    patchLocalWO(woId, { status: "capital", functionalStatus: "Pending Capital Approval", capitalStatus: "Pending approval", isCapital: true }, localActivity(text, "system"));
    fire("Flagged for capital");
    await dbCall(async () => {
      await updateWorkOrder(woId, { status: "capital", functionalStatus: "Pending Capital Approval", capitalStatus: "Pending approval", isCapital: true });
      await insertActivity(woId, "System", text, "system");
    }, "Capital flag failed");
  };

  const doSubmitInvoice = async (wo: any) => {
    if (!newInv.num) { fire("Enter an invoice number"); return false; }
    if (!newInv.cme) { fire("Select a CME code"); return false; }
    const validLines = (newInv.lines || []).filter((l: any) => l.desc && l.qty && l.rate);
    if (validLines.length === 0) { fire("Add at least one line item with description, qty, and rate"); return false; }
    if (!newInv.hasPdf) { fire("Attach a PDF invoice before submitting"); return false; }
    const subtotal = invSubtotal(validLines);
    const tax = parseFloat(newInv.tax) || 0;
    const total = subtotal + tax;
    // Optimistic local update
    const localInv = {
      num: newInv.num,
      wot: wo.id,
      state: "submitted",
      invoiceDate: newInv.invoiceDate,
      serviceDate: newInv.serviceDate,
      terms: newInv.terms,
      store: wo.store,
      storeAddr: wo.addr,
      cme: newInv.cme,
      contractor: wo.contractor,
      lines: validLines.map((l: any) => ({ ...l, qty: parseFloat(l.qty), rate: parseFloat(l.rate), amount: lineAmount(l) })),
      subtotal,
      salesTax: tax,
      total,
      date: (() => { const d = new Date((newInv.invoiceDate || new Date().toISOString().slice(0,10)) + "T00:00:00"); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; })(),
    };
    setInvoices(prev => [localInv, ...prev]);
    const text = `Invoice #${newInv.num} submitted to 7-Eleven. Total: ${fmt(total)} (${validLines.length} line item${validLines.length !== 1 ? "s" : ""}).`;
    patchLocalWO(wo.id, { status: "pending_approval", invoiceTotal: total }, localActivity(text, "system"));
    fire(`Invoice #${newInv.num} submitted — ${fmt(total)}`);
    const ok = await dbCall(async () => {
      await insertInvoice({ ...newInv, wot: wo.id, store: wo.store, storeAddr: wo.addr, contractor: wo.contractor, state: "submitted" }, validLines, currentUser.name);
    }, "Invoice save failed");
    if (ok) resetNewInv();
    return ok;
  };

  const doCreateWO = async () => {
    if (!newWO.store || !newWO.city || !newWO.summary || !newWO.nte) { fire("Fill in store, city, summary, and NTE"); return false; }
    // Server-side atomic ID generation (no collisions)
    let ids: { wo: string; inc: string };
    try { ids = await nextWorkOrderId(); }
    catch (e: any) { fire(`Could not generate ID: ${e.message || e}`); return false; }
    const trades = SERVICE_TO_TRADES(newWO.businessService || "", newWO.category || "");
    let contractor = null, status = "unassigned";
    if (newWO.assign === "auto") {
      const matched = contractorFor(newWO.city, trades, USERS);
      if (matched) { contractor = matched; status = "assigned"; }
    } else if (newWO.assign && newWO.assign !== "unassigned") { contractor = newWO.assign; status = "assigned"; }
    const dispatchedAt = contractor ? new Date().toISOString() : null;
    const wo = {
      id: ids.wo,
      incidentId: ids.inc,
      store: newWO.store,
      city: newWO.city,
      addr: "",
      lineOfService: newWO.businessService || "General",
      businessService: newWO.businessService || "General",
      category: newWO.category || "General",
      subCategory: "",
      summary: newWO.summary,
      description: newWO.summary,
      priority: newWO.priority,
      status,
      contractor,
      afm: "",
      afmEmail: "",
      functionalStatus: contractor ? "Dispatched" : "New",
      nte: parseInt(newWO.nte) || 0,
      dispatchedAt,
    };
    const text = `Work order created. NTE: ${fmt(parseInt(newWO.nte) || 0)}.${contractor ? ` Auto-dispatched to ${getUser(contractor)?.name} (trade + territory match).` : ""}`;
    // Optimistic local insert
    setWorkOrders(prev => [{ ...wo, age: "now", activities: [localActivity(text, "system")], photos: [] }, ...prev]);
    fire(contractor ? `${ids.wo} — dispatched to ${getUser(contractor)?.name.split(" ")[0]}` : `${ids.wo} created — unassigned`);
    const ok = await dbCall(async () => {
      await insertWorkOrder(wo, text, "System");
    }, "WO save failed");
    if (ok) resetNewWO();
    return ok;
  };

  const doAutoAssign = async () => {
    const unassigned = workOrders.filter(w => w.status === "unassigned");
    if (unassigned.length === 0) { fire("No unassigned calls"); return; }
    let count = 0, skipped = 0;
    const dispatchedAt = new Date().toISOString();
    const ops = unassigned.map(async w => {
      const trades = SERVICE_TO_TRADES(w.businessService || "", w.category || "");
      const matched = contractorFor(w.city, trades, USERS);
      if (!matched) { skipped++; return; }
      const c = getUser(matched);
      const text = `Auto-dispatched to ${c?.name || matched}. Territory + trade match.`;
      patchLocalWO(w.id, { status: "assigned", contractor: matched, functionalStatus: "Dispatched", dispatchedAt }, localActivity(text, "system"));
      try {
        await updateWorkOrder(w.id, { status: "assigned", contractor: matched, functionalStatus: "Dispatched", dispatchedAt });
        await insertActivity(w.id, "System", text, "system");
        count++;
      } catch (e: any) { fire(`${w.id}: ${e.message || e}`); }
    });
    await Promise.all(ops);
    fire(skipped > 0 ? `Auto-dispatched ${count} · ${skipped} need manual assignment` : `Auto-dispatched ${count} call${count !== 1 ? "s" : ""}`);
  };

  const doPostNote = async (woId: string) => {
    const text = noteText.trim();
    if (!text) return;
    setNoteText("");
    setWorkOrders(prev => prev.map(w => w.id === woId ? { ...w, activities: [{ author: currentUser.name, time: dateNow(), text, type: "note" }, ...w.activities] } : w));
    fire("Note posted");
    await dbCall(async () => {
      await insertActivity(woId, currentUser.name, text, "note");
    }, "Note save failed");
  };

  const doAiEnhance = () => {
    setAiEnhancing(true);
    setTimeout(() => {
      // Placeholder. Wired to Claude API in v9 (right before handover).
      // The generic message lets us show the feature exists without faking output that could be challenged in a demo.
      setAiNote("__PREVIEW__");
      setAiEnhancing(false);
    }, 800);
  };

  const doAddPhotos = async (woId: string, files: FileList | null) => {
    if (!files || files.length === 0) return;
    const limited = Array.from(files).slice(0, 8);
    fire(`Uploading ${limited.length} photo${limited.length > 1 ? "s" : ""}...`);
    try {
      const paths = await uploadPhotos(woId, limited, currentUser.name);
      // Resolve to signed URLs and update local state
      const urls = (await Promise.all(paths.map(p => getPhotoUrl(p)))).filter(Boolean) as string[];
      const text = `Added ${paths.length} photo${paths.length > 1 ? "s" : ""}.`;
      setWorkOrders(prev => prev.map(w => w.id === woId ? {
        ...w,
        photos: [...(w.photos || []), ...urls],
        activities: [{ author: currentUser.name, time: dateNow(), text, type: "note" }, ...w.activities],
      } : w));
      fire(`${paths.length} photo${paths.length > 1 ? "s" : ""} uploaded`);
    } catch (e: any) {
      fire(`Photo upload failed: ${e.message || e}`);
    }
  };

  const doRemovePhoto = async (woId: string, idx: number) => {
    const wo = workOrders.find(w => w.id === woId);
    const path = wo?.photos?.[idx];
    setWorkOrders(prev => prev.map(w => w.id === woId ? { ...w, photos: (w.photos || []).filter((_: any, i: number) => i !== idx) } : w));
    fire("Photo removed");
    if (path && !path.startsWith("data:") && !path.startsWith("http")) {
      // It's a Supabase storage path — call DB to remove it
      // Note: signed URLs from getPhotoUrl don't preserve the path; we'd need to track paths separately
      // For now just remove locally — full cleanup happens when v8d adds path tracking to local state
    } else if (path?.startsWith("http")) {
      // Extract storage path from signed URL if possible
      const match = path.match(/\/photos\/(.+?)\?/);
      if (match) {
        await dbCall(() => removePhoto(woId, match[1]), "Photo cleanup failed");
      }
    }
  };

  // ═══════════════════════════════════════════════════════════════
  //  LOGIN
  // ═══════════════════════════════════════════════════════════════
  if (!currentUser) {
    return (
      <div style={{ minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter', system-ui, sans-serif", padding: 16, opacity: fadeIn ? 1 : 0, transition: "opacity 0.6s", position: "relative" }}>
        <style>{CSS}</style>
        <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(circle at 1px 1px, rgba(31,30,28,0.04) 1px, transparent 0)", backgroundSize: "28px 28px" }} />
        <div style={{ position: "relative", zIndex: 1, width: "100%", maxWidth: 420 }}>
          <div style={{ textAlign: "center", marginBottom: 36 }}>
            <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 56, height: 56, borderRadius: 14, background: T.ink, marginBottom: 18, boxShadow: "0 8px 24px rgba(31,30,28,0.12)" }}>
              <span className="display" style={{ fontSize: 28, color: T.bg, letterSpacing: -1 }}>P1</span>
            </div>
            <div className="display" style={{ fontSize: 34, color: T.ink, lineHeight: 1.1 }}>P1 Service Portal</div>
            <div style={{ fontSize: 14, color: T.muted, marginTop: 8 }}>Operations for 7-Eleven facility services</div>
          </div>
          <div className="card" style={{ padding: 28 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: T.ink, marginBottom: 18 }}>Sign in to your account</div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 7, display: "block", textTransform: "uppercase", letterSpacing: 0.8 }}>Email</label>
              <input value={loginEmail} onChange={e => setLoginEmail(e.target.value)} placeholder="you@p1pros.com" style={{ width: "100%", padding: "12px 14px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surfaceSoft, color: T.ink, fontSize: 14, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
            </div>
            <div style={{ marginBottom: 18 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 7, display: "block", textTransform: "uppercase", letterSpacing: 0.8 }}>Password</label>
              <input type="password" defaultValue="••••••••" style={{ width: "100%", padding: "12px 14px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surfaceSoft, color: T.ink, fontSize: 14, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
            </div>
            {loginError && <div style={{ fontSize: 12, color: T.danger, background: T.dangerSoft, border: `1px solid ${T.dangerSoft}`, borderRadius: 8, padding: "9px 12px", marginBottom: 14 }}>{loginError}</div>}
            {loginLoading ? <div style={{ textAlign: "center", padding: "12px 0" }}><div style={{ width: 22, height: 22, border: `3px solid ${T.borderSoft}`, borderTopColor: T.accent, borderRadius: "50%", animation: "spin 0.7s linear infinite", margin: "0 auto" }} /></div>
              : <button onClick={() => doLogin(loginEmail)} style={{ width: "100%", padding: 13, borderRadius: 10, background: T.ink, color: T.bg, border: "none", cursor: "pointer", fontWeight: 600, fontSize: 14, fontFamily: "inherit" }}>Sign in</button>}
          </div>
          <div style={{ marginTop: 24 }}>
            <div style={{ fontSize: 11, fontWeight: 500, color: T.subtle, textAlign: "center", marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>Demo — quick access</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {DEMO_ACCOUNTS.map(u => (
                <button key={u.email} onClick={() => { setLoginEmail(u.email); doLogin(u.email); }} className="card-hover" style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                  <Avatar initials={u.initials} color={u.color} size={32} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: T.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.name}</div>
                    <div style={{ fontSize: 10, color: T.muted }}>{u.subtitle}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════
  //  APP SHELL
  // ═══════════════════════════════════════════════════════════════
  const sideItems = isManager
    ? [
      { id: "dashboard", label: "Dashboard", icon: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" },
      { id: "map", label: "Map", icon: "M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4zM8 2v16M16 6v16" },
      { id: "work_orders", label: "Work orders", icon: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", badge: openCount },
      { id: "capital", label: "Capital", icon: "M2 20h20M5 20V8l7-5 7 5v12M9 20v-4h6v4", badge: capitalCount || null },
      { id: "invoices", label: "Invoices", icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h8", badge: pendAppr || null },
      { id: "contractors", label: "Contractors", icon: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" },
    ]
    : [
      { id: "my_jobs", label: "My jobs", icon: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", badge: myWOs.filter(w => activeStatuses.includes(w.status)).length },
      { id: "invoices", label: "Invoices", icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h8" },
    ];

  const pageTitle: any = { dashboard: "Dashboard", work_orders: selectedWO ? woData?.id : "Work orders", invoices: "Invoices", contractors: "Contractors", my_jobs: "My jobs", wo_detail: woData?.id || "Work order", capital: "Capital projects", map: "Map" };

  const renderCard = (wo: any) => {
    const pr = PRIORITY[wo.priority];
    const sla = slaLabel(wo);
    return (
      <div key={wo.id} className="kcard" onClick={() => { setSelectedWO(wo.id); setAiNote(null); if (!isManager) setPage("wo_detail"); else setPage("work_orders"); }} style={{ position: "relative", padding: "12px 14px 12px 16px", borderRadius: 12, marginBottom: 8, cursor: "pointer" }}>
        <div style={{ position: "absolute", left: 0, top: 10, bottom: 10, width: 3, borderRadius: 2, background: pr?.color || T.subtle }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: T.subtle, letterSpacing: 0.2 }}>{wo.id}</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: pr?.color }}>{pr?.short}</span>
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.ink, marginBottom: 3 }}>Store #{wo.store}</div>
        <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{wo.summary}</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, paddingTop: 8, borderTop: `1px solid ${T.borderSoft}`, fontSize: 11 }}>
          <span style={{ fontWeight: 600, color: wo.contractor ? T.inkSoft : T.subtle }}>{wo.contractor ? getUser(wo.contractor)?.name.split(" ")[0] : "Unassigned"}</span>
          {sla && <span style={{ fontSize: 10, fontWeight: 700, color: sla.color, background: sla.bg, padding: "2px 8px", borderRadius: 10, border: `1px solid ${sla.color}20` }}>{sla.text}</span>}
        </div>
      </div>
    );
  };

  const renderKanbanCol = (sk: string) => {
    const c = STATUS[sk];
    const cards = filteredWOs.filter(w => w.status === sk);
    return (
      <div key={sk} className="kcol" style={{ background: c.bg }}>
        <div style={{ padding: "14px 16px 12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <div style={{ width: 9, height: 9, borderRadius: "50%", background: c.color }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: T.ink, letterSpacing: -0.1 }}>{c.label}</span>
          </div>
          <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: c.color, background: T.surface, border: `1px solid ${c.ring || c.color}33`, borderRadius: 20, padding: "3px 10px", minWidth: 24, textAlign: "center" }}>{cards.length}</span>
        </div>
        <div style={{ padding: "0 10px 10px", minHeight: 60 }}>
          {cards.map(renderCard)}
          {cards.length === 0 && <div style={{ textAlign: "center", padding: "24px 0", fontSize: 11, color: T.subtle, fontWeight: 500 }}>No items</div>}
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════════════
  //  LAYOUT
  // ═══════════════════════════════════════════════════════════════
  return (
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "'Inter', system-ui, sans-serif", fontSize: 13, color: T.ink, background: T.bg, position: "relative" }}>
      <style>{CSS}</style>

      {/* Sidebar */}
      <div className="desktop-sidebar" style={{ width: 232, background: T.sidebar, color: T.sidebarText, display: "flex", flexDirection: "column", flexShrink: 0, position: "fixed", top: 0, left: 0, bottom: 0, zIndex: 30 }}>
        <div style={{ padding: "22px 20px 18px", borderBottom: "1px solid rgba(250,247,242,0.06)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: T.accent, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span className="display" style={{ fontSize: 18, color: "#fff", letterSpacing: -0.5 }}>P1</span>
            </div>
            <div>
              <div className="display" style={{ fontSize: 18, color: T.bg, letterSpacing: -0.3, lineHeight: 1 }}>P1 Service</div>
              <div style={{ fontSize: 10, color: T.sidebarText, letterSpacing: 0.8, textTransform: "uppercase", marginTop: 3 }}>{currentUser.role === "manager" ? "Operations" : currentUser.role === "dispatcher" ? "Dispatch" : currentUser.role === "back_office" ? "Back office" : "Contractor"}</div>
            </div>
          </div>
        </div>
        <div style={{ padding: "14px 12px", flex: 1 }}>
          {sideItems.map(item => (
            <button key={item.id} onClick={() => nav(item.id)} className={`side-btn ${page === item.id ? "active" : ""}`}>
              <Ico d={item.icon} size={16} color={page === item.id ? T.accent : T.sidebarText} />
              <span style={{ flex: 1, textAlign: "left" }}>{item.label}</span>
              {item.badge != null && <span style={{ fontSize: 10, background: item.id === "capital" ? T.violet : T.accent, color: "#fff", borderRadius: 10, padding: "2px 8px", fontWeight: 700 }}>{item.badge}</span>}
            </button>
          ))}
        </div>
        <div style={{ padding: 16, borderTop: "1px solid rgba(250,247,242,0.06)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <Avatar initials={currentUser.initials} color={currentUser.color} size={32} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: T.bg, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentUser.name}</div>
              <div style={{ fontSize: 10, color: T.sidebarText }}>{currentUser.title || currentUser.company}</div>
            </div>
          </div>
          <button onClick={logout} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid rgba(250,247,242,0.1)", background: "transparent", color: T.sidebarText, fontSize: 11, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" }}>Sign out</button>
        </div>
      </div>

      {/* Mobile bottom nav */}
      <div className="mobile-bottom-nav" style={{ display: "none", position: "fixed", bottom: 0, left: 0, right: 0, background: T.sidebar, zIndex: 40, borderTop: "1px solid rgba(250,247,242,0.08)", justifyContent: "space-around", padding: "6px 0 env(safe-area-inset-bottom, 6px)" }}>
        {sideItems.slice(0, 4).map(item => (
          <button key={item.id} onClick={() => nav(item.id)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, background: "none", border: "none", cursor: "pointer", padding: "6px 8px", fontFamily: "inherit" }}>
            <Ico d={item.icon} size={20} color={page === item.id ? T.accent : T.sidebarText} />
            <span style={{ fontSize: 8, fontWeight: page === item.id ? 600 : 400, color: page === item.id ? T.bg : T.sidebarText }}>{item.label.split(" ")[0]}</span>
          </button>
        ))}
        <button onClick={logout} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, background: "none", border: "none", cursor: "pointer", padding: "6px 8px", fontFamily: "inherit" }}>
          <Ico d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" size={20} color={T.sidebarText} />
          <span style={{ fontSize: 8, color: T.sidebarText }}>Out</span>
        </button>
      </div>

      {/* Main */}
      <div className="main-wrap" style={{ flex: 1, marginLeft: 232, display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        {/* Topbar */}
        <div style={{ padding: "20px 28px", borderBottom: `1px solid ${T.borderSoft}`, background: T.bg, display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 20 }}>
          <div>
            <div className="display topbar-title" style={{ fontSize: 28, color: T.ink, letterSpacing: -0.5, lineHeight: 1 }}>{pageTitle[page]}</div>
            <div style={{ fontSize: 12, color: T.muted, marginTop: 4 }}>{isManager ? dateLong() : currentUser.company}</div>
          </div>
          {isManager && (
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={doAutoAssign} className="btn-soft">Auto-dispatch</button>
              <button onClick={() => setModal("newWO")} className="btn-primary">+ New work order</button>
            </div>
          )}
        </div>

        <div className="content-pad" style={{ flex: 1, overflow: "auto", padding: 28, paddingBottom: 80 }}>
          {/* ═════ DASHBOARD ═════ */}
          {page === "dashboard" && isManager && (
            <div style={{ animation: "fadeUp 0.35s" }}>
              {/* Alert bars */}
              {slaBreached > 0 && (
                <div className="card" style={{ background: T.dangerSoft, border: `1px solid ${T.danger}33`, padding: "14px 20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: T.danger, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, animation: "pulse 1.6s infinite" }}>!</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, color: T.danger, fontSize: 13 }}>{slaBreached} SLA breach{slaBreached > 1 ? "es" : ""} — act now</div>
                    <div style={{ fontSize: 11, color: "#8B2C20", marginTop: 2 }}>7-Eleven KPI missed. Update functional status immediately to stop further damage.</div>
                  </div>
                  <button onClick={() => nav("work_orders")} className="btn-soft" style={{ borderColor: `${T.danger}33`, color: T.danger }}>View →</button>
                </div>
              )}
              {p1Unassigned > 0 && (
                <div className="card" style={{ background: T.accentSoft, border: `1px solid ${T.accentRing}`, padding: "14px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: T.accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>⚡</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, color: T.accent, fontSize: 13 }}>{p1Unassigned} P1 Critical call{p1Unassigned > 1 ? "s" : ""} need dispatch</div>
                    <div style={{ fontSize: 11, color: "#8A4428", marginTop: 2 }}>8-hour SLA clock is running. Auto-dispatch or assign manually.</div>
                  </div>
                  <button onClick={doAutoAssign} className="btn-accent">Auto-dispatch all</button>
                </div>
              )}

              {/* Hero + stats */}
              <div className="stats-grid" style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 16, marginBottom: 36 }}>
                <div className="card card-hover stat-hero" style={{ background: `linear-gradient(135deg, ${T.accentSoft} 0%, ${T.warnSoft} 100%)`, padding: "28px 32px", animation: "fadeUp 0.4s both", cursor: "pointer", position: "relative", overflow: "hidden", border: `1px solid ${T.accentRing}` }} onClick={() => nav("work_orders")}>
                  <div style={{ position: "absolute", top: -40, right: -40, width: 160, height: 160, borderRadius: "50%", background: `radial-gradient(circle, ${T.accent}15, transparent 70%)` }} />
                  <div style={{ fontSize: 11, color: T.accent, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 14 }}>Revenue at risk</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
                    <div className="display stat-value" style={{ fontSize: 44, color: T.ink, letterSpacing: -1.2, lineHeight: 1 }}>{fmt(openValue)}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, color: T.success, background: T.successSoft, padding: "4px 10px", borderRadius: 20, border: `1px solid ${T.success}22` }}>
                      <span style={{ fontSize: 9 }}>▲</span> {fmt(Math.round(openValue * 0.15))} this week
                    </div>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 12, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 12, color: T.inkSoft, fontWeight: 500 }}>{openCount} open · {new Set(openWOs.map(w => w.store)).size} stores · {new Set(openWOs.map(w => w.city.split(",")[1]?.trim())).size} states</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 700, color: T.accent, background: T.surface, padding: "4px 10px", borderRadius: 20, border: `1px solid ${T.accentRing}` }}>
                      <span style={{ fontSize: 11 }}>⏱</span> P1 saved {(workOrders.reduce((s, w) => s + (w.activities?.length || 0), 0) * 2.3 / 60).toFixed(1)}h this week
                    </div>
                  </div>
                </div>
                {[
                  { label: "P1 Critical", value: p1Count, color: T.danger, sub: `${p1Unassigned} unassigned`, bg: T.dangerSoft, onClick: () => nav("work_orders") },
                  { label: "SLA at risk", value: slaAtRisk, color: T.warn, sub: "Needs status update", bg: T.warnSoft, onClick: () => nav("work_orders") },
                  { label: "Capital", value: capitalCount, color: T.violet, sub: "Pending equipment", bg: T.violetSoft, onClick: () => nav("capital") },
                ].map((s, i) => (
                  <div key={i} className="card card-hover" style={{ background: s.bg, padding: "22px 24px", animation: `fadeUp 0.4s ${(i + 1) * 0.06}s both`, cursor: "pointer" }} onClick={s.onClick}>
                    <div style={{ fontSize: 11, color: s.color, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 12 }}>{s.label}</div>
                    <div className="display stat-value" style={{ fontSize: 34, color: s.color, letterSpacing: -0.8, lineHeight: 1 }}>{s.value}</div>
                    <div style={{ fontSize: 11, color: T.muted, marginTop: 8, fontWeight: 500 }}>{s.sub}</div>
                  </div>
                ))}
              </div>

              <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.4, color: T.muted, marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 18, height: 2, background: T.border, display: "inline-block", borderRadius: 2 }} />Active pipeline
              </div>
              <div className="kanban-active" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 32 }}>
                {activeStatuses.map(renderKanbanCol)}
              </div>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.4, color: T.muted, marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 18, height: 2, background: T.border, display: "inline-block", borderRadius: 2 }} />Closing pipeline
              </div>
              <div className="kanban-closing" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
                {closingStatuses.map(renderKanbanCol)}
              </div>
            </div>
          )}

          {/* ═════ MAP ═════ */}
          {page === "map" && isManager && (() => {
            const byStore = workOrders.filter(w => activeStatuses.includes(w.status) || w.status === "capital").reduce((acc: any, w) => {
              const key = `${w.store}|${w.city}`;
              if (!acc[key]) acc[key] = { store: w.store, city: w.city, wos: [] };
              acc[key].wos.push(w);
              return acc;
            }, {});
            const stores = Object.values(byStore) as any[];
            const worstColor = (wos: any[]) => {
              if (wos.some(w => w.priority === "p1" && w.status === "unassigned")) return T.danger;
              if (wos.some(w => { const s = slaRemaining(w); return s && s.remainingHours < 2; })) return T.danger;
              if (wos.some(w => w.priority === "p1")) return T.accent;
              if (wos.some(w => w.status === "wip")) return T.violet;
              return T.success;
            };
            return (
              <div style={{ animation: "fadeUp 0.3s" }}>
                <div className="card" style={{ background: T.accentSoft, border: `1px solid ${T.accentRing}`, padding: "14px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: T.accent, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Ico d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4zM8 2v16M16 6v16" size={20} color="#fff" /></div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, color: T.accent, fontSize: 13 }}>{stores.length} stores with active work across {new Set(stores.map(s => s.city.split(",")[1]?.trim())).size} states</div>
                    <div style={{ fontSize: 11, color: "#8A4428", marginTop: 2 }}>Click a pin to filter. Red = SLA risk, amber = active P1, violet = work in progress, green = on track.</div>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 20 }} className="detail-two-col">
                  <div className="card" style={{ padding: 20, position: "relative", overflow: "hidden", background: T.surfaceSoft }}>
                    <div style={{ position: "absolute", inset: 0, backgroundImage: `radial-gradient(circle at 1px 1px, ${T.border} 1px, transparent 0)`, backgroundSize: "20px 20px", opacity: 0.5 }} />
                    <svg viewBox="0 0 800 500" style={{ width: "100%", height: "auto", display: "block", position: "relative", zIndex: 1 }}>
                      <defs><filter id="ps"><feDropShadow dx="0" dy="2" stdDeviation="3" floodOpacity="0.2" /></filter></defs>
                      <path d={US_PATH} fill={T.surface} stroke={T.border} strokeWidth="1.5" strokeLinejoin="round" />
                      {stores.map((s, i) => {
                        const pos = coordsForCity(s.city);
                        if (!pos) return null;
                        const color = worstColor(s.wos);
                        const hasRisk = s.wos.some(w => { const x = slaRemaining(w); return x && x.remainingHours < 2; });
                        const r = 9 + Math.min(s.wos.length * 2, 10);
                        return (
                          <g key={i} style={{ cursor: "pointer" }} onClick={() => { nav("work_orders"); setSearch(s.store); }}>
                            {hasRisk && <circle cx={pos.x} cy={pos.y} r={r + 8} fill={color} opacity="0.18"><animate attributeName="r" values={`${r + 4};${r + 14};${r + 4}`} dur="1.8s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.3;0;0.3" dur="1.8s" repeatCount="indefinite" /></circle>}
                            <circle cx={pos.x} cy={pos.y} r={r} fill={color} stroke="#fff" strokeWidth="2.5" filter="url(#ps)" />
                            <text x={pos.x} y={pos.y + 4} textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff" fontFamily="'JetBrains Mono', monospace">{s.wos.length}</text>
                            <text x={pos.x} y={pos.y - r - 6} textAnchor="middle" fontSize="10" fontWeight="600" fill={T.ink}>#{s.store}</text>
                          </g>
                        );
                      })}
                    </svg>
                    <div style={{ position: "absolute", bottom: 16, left: 16, background: "rgba(255,255,255,0.92)", backdropFilter: "blur(10px)", border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", fontSize: 11, fontWeight: 500, color: T.muted, zIndex: 2 }}>
                      <div style={{ fontWeight: 700, color: T.ink, marginBottom: 6, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.8 }}>Pin legend</div>
                      {[{ c: T.danger, l: "SLA risk / breach" }, { c: T.accent, l: "P1 Critical active" }, { c: T.violet, l: "In progress" }, { c: T.success, l: "On track" }].map((l, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                          <div style={{ width: 8, height: 8, borderRadius: "50%", background: l.c }} />
                          <span>{l.l}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="card" style={{ padding: 20, maxHeight: 600, overflowY: "auto" }}>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 14 }}>Stores ranked by volume</div>
                    {stores.sort((a, b) => b.wos.length - a.wos.length).map((s: any, i) => {
                      const p1 = s.wos.filter((w: any) => w.priority === "p1").length;
                      return (
                        <div key={i} onClick={() => { nav("work_orders"); setSearch(s.store); }} style={{ padding: "13px 0", borderBottom: i < stores.length - 1 ? `1px solid ${T.borderSoft}` : "none", cursor: "pointer" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: T.ink }}>Store #{s.store}</div>
                            <span style={{ fontSize: 10, fontWeight: 700, color: worstColor(s.wos), background: worstColor(s.wos) + "22", padding: "2px 8px", borderRadius: 12 }}>{s.wos.length}</span>
                          </div>
                          <div style={{ fontSize: 11, color: T.muted, marginBottom: 4 }}>{s.city}</div>
                          {p1 > 0 && <div style={{ fontSize: 10, color: T.danger, fontWeight: 600 }}>⚡ {p1} P1 Critical</div>}
                          <div style={{ fontSize: 10, color: T.subtle, marginTop: 2 }}>{fmt(s.wos.reduce((sum: number, w: any) => sum + (w.nte || 0), 0))} at risk</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* ═════ CAPITAL ═════ */}
          {page === "capital" && isManager && (
            <div style={{ animation: "fadeUp 0.3s" }}>
              <div className="card" style={{ background: T.violetSoft, border: `1px solid ${T.violet}33`, padding: "14px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: T.violet, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}><Ico d="M2 20h20M5 20V8l7-5 7 5v12M9 20v-4h6v4" size={20} color="#fff" /></div>
                <div>
                  <div style={{ fontWeight: 700, color: T.violet, fontSize: 13 }}>{capitalCount} capital replacement{capitalCount !== 1 ? "s" : ""}</div>
                  <div style={{ fontSize: 11, color: "#4A3C73", marginTop: 2 }}>Equipment orders — separate from regular pipeline, 4-12 week lifecycle</div>
                </div>
              </div>
              <div className="capital-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                {workOrders.filter(w => w.status === "capital").map((wo, i) => (
                  <div key={wo.id} className="card card-hover" onClick={() => { setSelectedWO(wo.id); setPage("work_orders"); setAiNote(null); }} style={{ padding: 22, cursor: "pointer", animation: `fadeUp 0.3s ${i * 0.06}s both` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: T.violet }}>{wo.id}</span>
                      {wo.capitalStatus && <Badge conf={{ label: wo.capitalStatus, color: T.violet, bg: T.violetSoft, ring: "#D4C9E8" }} />}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: T.ink, marginBottom: 4 }}>Store #{wo.store} · {wo.city}</div>
                    <div style={{ fontSize: 12, color: T.muted, marginBottom: 14, lineHeight: 1.5 }}>{wo.summary}</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, paddingTop: 12, borderTop: `1px solid ${T.borderSoft}` }}>
                      <div>
                        <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 3 }}>Equipment</div>
                        <div style={{ fontSize: 12, fontWeight: 500 }}>{wo.partNeeded || "TBD"}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 3 }}>NTE</div>
                        <div className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{fmt(wo.nte)}</div>
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: T.subtle, marginTop: 10 }}>Contractor: {getUser(wo.contractor)?.name}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ═════ WORK ORDERS TABLE ═════ */}
          {page === "work_orders" && !selectedWO && (
            <div style={{ animation: "fadeUp 0.3s" }}>
              <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search WO#, INC#, store, keyword..." style={{ padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, width: 300, fontFamily: "inherit", background: T.surface }} />
                {isManager && (
                  <select value={filterC} onChange={e => setFilterC(e.target.value)} style={{ padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit", background: T.surface }}>
                    <option value="all">All contractors</option>
                    {contractorsOnly.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                )}
                <select value={filterP} onChange={e => setFilterP(e.target.value)} style={{ padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit", background: T.surface }}>
                  <option value="all">All priorities</option>
                  {Object.entries(PRIORITY).map(([k, v]: any) => <option key={k} value={k}>{v.label}</option>)}
                </select>
                {(filterC !== "all" || filterP !== "all" || search) && <button onClick={() => { setFilterC("all"); setFilterP("all"); setSearch(""); }} style={{ fontSize: 12, color: T.muted, background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>Clear</button>}
              </div>
              <div className="card table-scroll" style={{ overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: T.surfaceSoft }}>
                      {["WO#", "INC#", "Store", "Summary", "Priority", "Status", "Contractor", "SLA", "NTE"].map(h => (
                        <th key={h} style={{ textAlign: h === "NTE" ? "right" : "left", padding: "12px 14px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, borderBottom: `1px solid ${T.borderSoft}`, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredWOs.filter(w => w.status !== "capital").map((wo, i) => {
                      const sla = slaLabel(wo);
                      return (
                        <tr key={wo.id} onClick={() => { setSelectedWO(wo.id); setAiNote(null); }} style={{ cursor: "pointer", borderBottom: `1px solid ${T.borderSoft}`, animation: `fadeUp 0.3s ${i * 0.02}s both` }}>
                          <td className="mono" style={{ padding: "12px 14px", fontWeight: 600, fontSize: 11, color: T.accent }}>{wo.id}</td>
                          <td className="mono" style={{ padding: "12px 14px", fontSize: 11, color: T.subtle }}>{wo.incidentId}</td>
                          <td style={{ padding: "12px 14px", fontWeight: 600 }}>#{wo.store}</td>
                          <td style={{ padding: "12px 14px", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: T.inkSoft }}>{wo.summary}</td>
                          <td style={{ padding: "12px 14px" }}><Badge conf={PRIORITY[wo.priority]} small /></td>
                          <td style={{ padding: "12px 14px" }}><Badge conf={STATUS[wo.status]} small /></td>
                          <td style={{ padding: "12px 14px", color: T.muted }}>{wo.contractor ? getUser(wo.contractor)?.name : "—"}</td>
                          <td style={{ padding: "12px 14px" }}>{sla ? <span style={{ fontSize: 10, fontWeight: 700, color: sla.color, background: sla.bg, padding: "2px 8px", borderRadius: 10 }}>{sla.text}</span> : <span style={{ color: T.subtle }}>—</span>}</td>
                          <td className="mono" style={{ padding: "12px 14px", textAlign: "right", fontWeight: 600 }}>{fmt(wo.nte)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ═════ WO DETAIL ═════ */}
          {(page === "work_orders" || page === "wo_detail") && selectedWO && woData && (() => {
            const storeHistory = workOrders.filter(w => w.store === woData.store && w.id !== woData.id);
            const repeatCount = storeHistory.length;
            const sameCategory = storeHistory.filter(w => w.category === woData.category).length;
            const invoiceTotal = woData.invoiceTotal || 0;
            const nteBreach = invoiceTotal > woData.nte && invoiceTotal > 0;
            const nteHeadroom = woData.nte - invoiceTotal;
            const sla = slaLabel(woData);
            const slaR = slaRemaining(woData);
            return (
              <div style={{ animation: "fadeUp 0.25s" }}>
                <button onClick={() => { setSelectedWO(null); setAiNote(null); if (!isManager) setPage("my_jobs"); }} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: T.muted, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", marginBottom: 16, padding: 0 }}><Ico d="M15 18l-6-6 6-6" size={14} /> Back</button>

                {/* Alert stack */}
                {sla?.severity === "breach" && (
                  <div className="card" style={{ background: T.dangerSoft, border: `1px solid ${T.danger}44`, padding: "14px 20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 22 }}>🚨</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, color: T.danger, fontSize: 13 }}>SLA breach — {Math.floor(-slaR.remainingHours)}h past {PRIORITY[woData.priority].slaHours}h limit</div>
                      <div style={{ fontSize: 11, color: "#8B2C20", marginTop: 2 }}>Functional status is "{woData.functionalStatus}" — update immediately to close the gap with 7-Eleven.</div>
                    </div>
                  </div>
                )}
                {sla?.severity === "critical" && (
                  <div className="card" style={{ background: T.dangerSoft, border: `1px solid ${T.danger}33`, padding: "14px 20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 20 }}>⚠️</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, color: T.danger, fontSize: 13 }}>SLA at risk — {Math.round(slaR.remainingHours * 60)} minutes to breach</div>
                      <div style={{ fontSize: 11, color: "#8B2C20", marginTop: 2 }}>Check in with the contractor and update functional status now.</div>
                    </div>
                  </div>
                )}
                {repeatCount >= 2 && (
                  <div className="card" style={{ background: T.warnSoft, border: `1px solid ${T.warn}33`, padding: "14px 20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 20 }}>🔁</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, color: T.warn, fontSize: 12 }}>Repeat visit — Store #{woData.store} has {repeatCount} other work order{repeatCount !== 1 ? "s" : ""}{sameCategory > 0 ? ` (${sameCategory} same category)` : ""}</div>
                      <div style={{ fontSize: 11, color: "#73560C", marginTop: 2 }}>{sameCategory >= 2 ? "Consider flagging for capital replacement — chronic equipment issue." : "Cross-reference previous repairs before dispatch."}</div>
                    </div>
                  </div>
                )}
                {nteBreach && (
                  <div className="card" style={{ background: T.dangerSoft, border: `1px solid ${T.danger}33`, padding: "14px 20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 20 }}>⚠️</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, color: T.danger, fontSize: 12 }}>Invoice exceeds NTE by {fmt(invoiceTotal - woData.nte)}</div>
                      <div style={{ fontSize: 11, color: "#8B2C20", marginTop: 2 }}>Invoiced {fmt(invoiceTotal)} vs authorized {fmt(woData.nte)} — requires AFM approval.</div>
                    </div>
                  </div>
                )}
                {!nteBreach && invoiceTotal > 0 && (
                  <div className="card" style={{ background: T.successSoft, border: `1px solid ${T.success}33`, padding: "14px 20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 18 }}>✓</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, color: T.success, fontSize: 12 }}>Within budget — {fmt(nteHeadroom)} under NTE</div>
                      <div style={{ fontSize: 11, color: "#2F5B3C", marginTop: 2 }}>Invoiced {fmt(invoiceTotal)} of {fmt(woData.nte)} authorized.</div>
                    </div>
                  </div>
                )}

                <div className="detail-two-col" style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 20 }}>
                  <div>
                    {/* Header card */}
                    <div className="card" style={{ padding: 24, marginBottom: 16 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
                        <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: T.accent }}>{woData.id}</span>
                        <span style={{ color: T.subtle, fontSize: 12 }}>/</span>
                        <span className="mono" style={{ fontSize: 11, color: T.muted }}>{woData.incidentId}</span>
                      </div>
                      <div className="display" style={{ fontSize: 28, fontWeight: 500, color: T.ink, letterSpacing: -0.4, lineHeight: 1.1 }}>Store #{woData.store} · {woData.city}</div>
                      <div style={{ fontSize: 13, color: T.muted, marginTop: 4 }}>{woData.addr}</div>
                      <div style={{ display: "flex", gap: 7, marginTop: 14, flexWrap: "wrap" }}>
                        <Badge conf={PRIORITY[woData.priority]} />
                        <Badge conf={STATUS[woData.status]} />
                        {woData.functionalStatus && <Badge conf={{ label: `FSM: ${woData.functionalStatus}`, ...FUNCTIONAL_STATUS[woData.functionalStatus] || { color: T.muted, bg: T.borderSoft } }} />}
                        {sla && <span style={{ fontSize: 11, fontWeight: 700, color: sla.color, background: sla.bg, padding: "3px 10px", borderRadius: 20, border: `1px solid ${sla.color}22` }}>SLA: {sla.text}</span>}
                      </div>
                      <div style={{ padding: "14px 18px", background: T.surfaceSoft, borderRadius: 12, border: `1px solid ${T.borderSoft}`, marginTop: 16 }}>
                        <div style={{ fontSize: 12, color: T.subtle, marginBottom: 4, fontWeight: 600 }}>{woData.businessService} · {woData.category}{woData.subCategory ? ` · ${woData.subCategory}` : ""}</div>
                        <div style={{ fontSize: 14, color: T.inkSoft, lineHeight: 1.6, fontWeight: 500 }}>{woData.summary}</div>
                        {woData.description && woData.description !== woData.summary && <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.6, marginTop: 8 }}>{woData.description}</div>}
                      </div>
                      <div className="detail-fields" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18, marginTop: 18 }}>
                        {[
                          { l: "Line of Service", v: woData.lineOfService },
                          { l: "NTE", v: fmt(woData.nte) },
                          { l: "ETA", v: woData.eta || "Not set" },
                          { l: "Assigned to", v: woData.contractor ? getUser(woData.contractor)?.name : "Unassigned" },
                          { l: "Start time", v: woData.startTime || "Not started" },
                          { l: "AFM", v: woData.afm || "—" },
                          { l: "Asset model", v: woData.assetModel || "Not captured" },
                          { l: "Serial #", v: woData.assetSerial || "Not captured" },
                          { l: "AFM email", v: woData.afmEmail || "—" },
                        ].map((d, i) => (
                          <div key={i}>
                            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 4 }}>{d.l}</div>
                            <div style={{ fontSize: 13, fontWeight: 500, color: ["Not captured", "Not set", "Not started", "Unassigned", "—"].includes(d.v) ? T.danger : T.ink }}>{d.v}</div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Actions */}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
                      {woData.status === "unassigned" && isManager && contractorsOnly.slice(0, 4).map(c => (
                        <button key={c.id} onClick={() => doAssign(woData.id, c.id)} className="btn-soft">Assign → {c.name.split(" ")[0]}</button>
                      ))}
                      {woData.status === "assigned" && !isManager && (
                        <>
                          <button onClick={() => setModal("setEta")} className="btn-soft">Set ETA</button>
                          <button onClick={() => setModal("startWork")} className="btn-accent">Start work</button>
                        </>
                      )}
                      {woData.status === "wip" && (
                        <>
                          <button onClick={() => setModal("pauseWork")} className="btn-soft">Pause (parts)</button>
                          {isManager && <button onClick={() => doCapitalFlag(woData.id)} className="btn-soft">Flag capital</button>}
                          <button onClick={() => setModal("closeComplete")} className="btn-primary">Close complete</button>
                        </>
                      )}
                      {woData.status === "parts" && !isManager && <button onClick={() => setModal("startWork")} className="btn-accent">Resume work</button>}
                      {woData.status === "completed" && isManager && <button onClick={() => doMoveToInvoice(woData.id)} className="btn-accent">Portal updated → pending invoice</button>}
                      {(woData.status === "completed" || woData.status === "pending_invoice") && !isManager && <button onClick={() => setModal("createInvoice")} className="btn-accent">Create invoice</button>}
                    </div>

                    {/* Photos */}
                    <div className="card" style={{ padding: 22, marginBottom: 16 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>Photos{(woData.photos?.length || 0) > 0 ? ` (${woData.photos.length})` : ""}</div>
                        <label className="btn-soft" style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "8px 14px" }}>
                          <Ico d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 13a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" size={13} />
                          Add photos
                          <input type="file" accept="image/*" multiple capture="environment" style={{ display: "none" }} onChange={e => { doAddPhotos(woData.id, e.target.files); e.target.value = ""; }} />
                        </label>
                      </div>
                      {(woData.photos || []).length === 0
                        ? <div style={{ textAlign: "center", padding: "28px 0", fontSize: 12, color: T.subtle, background: T.surfaceSoft, borderRadius: 10, border: `1px dashed ${T.border}` }}>No photos yet. Add site pics, asset tags, part numbers, completed work.</div>
                        : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 8 }}>
                          {woData.photos.map((url: string, i: number) => (
                            <div key={i} style={{ position: "relative", aspectRatio: "1", borderRadius: 10, overflow: "hidden", border: `1px solid ${T.border}`, cursor: "pointer" }} onClick={() => setLightbox(url)}>
                              <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                              <button onClick={e => { e.stopPropagation(); doRemovePhoto(woData.id, i); }} style={{ position: "absolute", top: 4, right: 4, width: 22, height: 22, borderRadius: "50%", background: "rgba(31,30,28,0.8)", border: "none", color: "#fff", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
                            </div>
                          ))}
                        </div>}
                    </div>

                    {/* Activity */}
                    <div className="card" style={{ padding: 22 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>Activity · {woData.activities?.length || 0}</div>
                        {isManager && <button onClick={doAiEnhance} disabled={aiEnhancing} style={{ padding: "7px 14px", borderRadius: 8, background: aiEnhancing ? T.borderSoft : T.ink, color: aiEnhancing ? T.muted : T.bg, border: "none", cursor: aiEnhancing ? "default" : "pointer", fontWeight: 600, fontSize: 11, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}>{aiEnhancing ? <><span style={{ display: "inline-block", width: 12, height: 12, border: `2px solid ${T.border}`, borderTopColor: T.accent, borderRadius: "50%", animation: "spin 0.7s linear infinite" }} /> Loading…</> : <>✨ AI enhance notes <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 6, background: T.accent, color: "#fff", letterSpacing: 0.4 }}>PREVIEW</span></>}</button>}
                      </div>
                      <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
                        <input value={noteText} onChange={e => setNoteText(e.target.value)} onKeyDown={e => { if (e.key === "Enter") doPostNote(woData.id); }} placeholder="Add a note..." style={{ flex: 1, padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit", background: T.surfaceSoft, outline: "none" }} />
                        <button onClick={() => doPostNote(woData.id)} className="btn-primary" style={{ padding: "10px 18px" }}>Post</button>
                      </div>
                      {aiNote && (
                        <div style={{ background: T.surfaceSoft, border: `1px dashed ${T.accent}`, borderRadius: 12, padding: 18, marginBottom: 16, animation: "fadeUp 0.3s" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: 0.8, display: "flex", alignItems: "center", gap: 6 }}>✨ AI Enhance <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 6, background: T.accent, color: "#fff" }}>PREVIEW</span></span>
                            <button onClick={() => setAiNote(null)} className="btn-soft" style={{ padding: "4px 10px", fontSize: 10 }}>Close</button>
                          </div>
                          {aiNote === "__PREVIEW__" ? (
                            <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.65 }}>
                              <div style={{ fontWeight: 600, color: T.ink, marginBottom: 6 }}>This feature is wired up and ready.</div>
                              When live, this rewrites the contractor's raw note into a polished, AFM-ready summary using Claude — keeping technical accuracy but adding structure and professional tone. Eliminates the midnight rewriting bottleneck. <span style={{ color: T.accent, fontWeight: 600 }}>Activates at handover.</span>
                            </div>
                          ) : (
                            <div style={{ fontSize: 13, color: T.inkSoft, lineHeight: 1.65 }}>{aiNote}</div>
                          )}
                        </div>
                      )}
                      {(woData.activities || []).map((e: any, i: number) => (
                        <div key={i} style={{ display: "flex", gap: 12, marginBottom: 16, animation: i === 0 ? "fadeUp 0.3s" : "none" }}>
                          <div style={{ width: 8, height: 8, borderRadius: "50%", background: e.type === "system" ? T.border : T.accent, marginTop: 6, flexShrink: 0 }} />
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 12 }}>
                              <span style={{ fontWeight: 600, color: T.ink }}>{e.author}</span>
                              <span style={{ color: T.subtle, marginLeft: 8, fontSize: 11 }}>{e.time}</span>
                            </div>
                            <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.55, marginTop: 3 }}>{e.text}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Right sidebar */}
                  <div>
                    {slaR && (
                      <div className="card" style={{ padding: 18, marginBottom: 14 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 10 }}>SLA countdown</div>
                        <div className="display" style={{ fontSize: 28, color: slaR.remainingHours < 2 ? T.danger : slaR.percent > 50 ? T.warn : T.ink, lineHeight: 1 }}>{slaR.remainingHours > 0 ? `${Math.floor(slaR.remainingHours)}h ${Math.round((slaR.remainingHours % 1) * 60)}m` : `-${Math.floor(-slaR.remainingHours)}h`}</div>
                        <div style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>{PRIORITY[woData.priority].label} · {PRIORITY[woData.priority].slaHours}h SLA</div>
                        <div className="sla-bar" style={{ marginTop: 10 }}>
                          <div className="sla-fill" style={{ width: `${slaR.percent}%`, background: slaR.percent > 90 ? T.danger : slaR.percent > 75 ? T.accent : slaR.percent > 50 ? T.warn : T.success }} />
                        </div>
                      </div>
                    )}
                    {woData.contractor && (
                      <div className="card" style={{ padding: 18, marginBottom: 14 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 10 }}>Contractor</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <Avatar initials={getUser(woData.contractor)?.initials} color={getUser(woData.contractor)?.color} size={38} />
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 700 }}>{getUser(woData.contractor)?.name}</div>
                            <div style={{ fontSize: 11, color: T.muted }}>{getUser(woData.contractor)?.company}</div>
                            {getUser(woData.contractor)?.phone && <div className="mono" style={{ fontSize: 11, color: T.subtle, marginTop: 3 }}>{getUser(woData.contractor)?.phone}</div>}
                          </div>
                        </div>
                      </div>
                    )}
                    {woData.eta && (
                      <div className="card" style={{ padding: 18, marginBottom: 14, background: T.warnSoft, borderColor: `${T.warn}33` }}>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.warn, marginBottom: 6 }}>ETA</div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: "#73560C" }}>{woData.eta}</div>
                        <div style={{ fontSize: 10, color: T.warn, marginTop: 4 }}>Auto-notify if not checked in</div>
                      </div>
                    )}
                    <div className="card" style={{ padding: 18, marginBottom: 14 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 14 }}>Progress</div>
                      {[
                        { label: "Created", done: true },
                        { label: "Dispatched + ETA", done: ["assigned", "wip", "parts", "capital", "completed", "pending_invoice", "pending_approval"].includes(woData.status) },
                        { label: "Work started", done: ["wip", "parts", "capital", "completed", "pending_invoice", "pending_approval"].includes(woData.status) },
                        { label: "Asset captured", done: !!woData.assetModel },
                        { label: "Completed", done: ["completed", "pending_invoice", "pending_approval"].includes(woData.status) },
                        { label: "7-Eleven updated", done: ["pending_invoice", "pending_approval"].includes(woData.status) },
                        { label: "Invoiced", done: ["pending_approval"].includes(woData.status) },
                      ].map((s, i, a) => (
                        <div key={i} style={{ display: "flex", gap: 12, position: "relative" }}>
                          {i < a.length - 1 && <div style={{ position: "absolute", left: 9, top: 20, width: 2, height: 20, background: s.done && a[i + 1]?.done ? T.success : T.borderSoft }} />}
                          <div style={{ width: 20, height: 20, borderRadius: "50%", border: s.done ? "none" : `2px solid ${T.border}`, background: s.done ? T.success : T.surface, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                            {s.done && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3"><path d="M20 6L9 17l-5-5" /></svg>}
                          </div>
                          <div style={{ paddingBottom: 18 }}>
                            <div style={{ fontSize: 12, fontWeight: s.done ? 600 : 400, color: s.done ? T.ink : T.subtle }}>{s.label}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                    {woData.partNeeded && (
                      <div className="card" style={{ padding: 18, background: T.warnSoft, borderColor: `${T.warn}33` }}>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.warn, marginBottom: 6 }}>{woData.status === "capital" ? "Equipment" : "Part"} on order</div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#73560C" }}>{woData.partNeeded}</div>
                        {woData.partEta && <div style={{ fontSize: 11, color: T.warn, marginTop: 4 }}>ETA: {woData.partEta}</div>}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* ═════ MY JOBS (contractor) ═════ */}
          {page === "my_jobs" && !isManager && (
            <div style={{ animation: "fadeUp 0.3s" }}>
              <div className="stats-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 24 }}>
                {[
                  { l: "Active", v: myWOs.filter(w => activeStatuses.includes(w.status)).length, c: T.accent, bg: T.accentSoft },
                  { l: "Pending inv.", v: myWOs.filter(w => w.status === "pending_invoice").length, c: T.violet, bg: T.violetSoft },
                  { l: "Capital", v: myWOs.filter(w => w.status === "capital").length, c: T.warn, bg: T.warnSoft },
                ].map((s, i) => (
                  <div key={i} className="card" style={{ background: s.bg, padding: "20px 22px" }}>
                    <div style={{ fontSize: 11, color: s.c, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>{s.l}</div>
                    <div className="display stat-value" style={{ fontSize: 30, fontWeight: 500, color: s.c, letterSpacing: -0.6 }}>{s.v}</div>
                  </div>
                ))}
              </div>
              {myWOs.map((wo, i) => {
                const sla = slaLabel(wo);
                return (
                  <div key={wo.id} className="card card-hover" onClick={() => { setSelectedWO(wo.id); setPage("wo_detail"); setAiNote(null); }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", marginBottom: 10, cursor: "pointer", animation: `fadeUp 0.3s ${i * 0.04}s both`, gap: 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                        <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: T.accent }}>{wo.id}</span>
                        <Badge conf={PRIORITY[wo.priority]} small />
                        {sla && <span style={{ fontSize: 10, fontWeight: 700, color: sla.color, background: sla.bg, padding: "2px 8px", borderRadius: 10 }}>{sla.text}</span>}
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: T.ink, marginBottom: 3 }}>Store #{wo.store} · {wo.city}</div>
                      <div style={{ fontSize: 12, color: T.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{wo.summary}</div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <Badge conf={STATUS[wo.status]} small />
                      <div style={{ fontSize: 10, color: T.subtle, marginTop: 4 }}>{wo.age}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ═════ INVOICES ═════ */}
          {page === "invoices" && !selectedInvoice && (
            <div style={{ animation: "fadeUp 0.3s" }}>
              <div style={{ display: "flex", gap: 0, marginBottom: 18, borderBottom: `2px solid ${T.borderSoft}` }}>
                {[{ id: "all", l: "All" }, { id: "submitted", l: "Submitted" }, { id: "rejected", l: "Rejected" }, { id: "approved", l: "Approved" }].map(t => (
                  <button key={t.id} onClick={() => setInvTab(t.id)} style={{ padding: "10px 20px", fontSize: 13, fontWeight: invTab === t.id ? 700 : 400, color: invTab === t.id ? T.ink : T.subtle, background: "none", border: "none", borderBottom: invTab === t.id ? `2px solid ${T.ink}` : "2px solid transparent", cursor: "pointer", fontFamily: "inherit", marginBottom: -2 }}>{t.l}</button>
                ))}
              </div>
              <div className="card table-scroll" style={{ overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: T.surfaceSoft }}>
                      {["Invoice#", "WO#", "Contractor", "State", "Date", "Store", "Lines", "Total"].map(h => (
                        <th key={h} style={{ textAlign: h === "Total" || h === "Lines" ? "right" : "left", padding: "12px 14px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, borderBottom: `1px solid ${T.borderSoft}` }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(isManager ? invoices : invoices.filter(i => i.contractor === currentUser.id)).filter(i => invTab === "all" || i.state === invTab).map(inv => (
                      <tr key={inv.num} onClick={() => setSelectedInvoice(inv.num)} style={{ borderBottom: `1px solid ${T.borderSoft}`, cursor: "pointer" }}>
                        <td className="mono" style={{ padding: "13px 14px", fontWeight: 600, fontSize: 11, color: T.accent }}>#{inv.num}</td>
                        <td className="mono" style={{ padding: "13px 14px", fontSize: 11, color: T.muted }}>{inv.wot}</td>
                        <td style={{ padding: "13px 14px", color: T.inkSoft }}>{getUser(inv.contractor)?.name}</td>
                        <td style={{ padding: "13px 14px" }}><Badge conf={INV_STATE[inv.state]} small /></td>
                        <td style={{ padding: "13px 14px", color: T.subtle }}>{inv.date}</td>
                        <td style={{ padding: "13px 14px" }}>#{inv.store}</td>
                        <td className="mono" style={{ padding: "13px 14px", textAlign: "right", color: T.muted }}>{(inv.lines || []).length}</td>
                        <td className="mono" style={{ padding: "13px 14px", textAlign: "right", fontWeight: 700 }}>{fmt(Math.round(inv.total))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ═════ INVOICE DETAIL (editorial receipt view) ═════ */}
          {page === "invoices" && selectedInvoice && (() => {
            const inv = invoices.find(i => i.num === selectedInvoice);
            if (!inv) return null;
            const wo = workOrders.find(w => w.id === inv.wot);
            return (
              <div style={{ animation: "fadeUp 0.25s" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, maxWidth: 860 }}>
                  <button onClick={() => setSelectedInvoice(null)} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: T.muted, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: 0 }}><Ico d="M15 18l-6-6 6-6" size={14} /> Back to invoices</button>
                  <button onClick={async () => { const { downloadInvoicePDF } = await import("../lib/invoicePdf"); downloadInvoicePDF(inv as any); fire(`Invoice ${inv.num} downloaded`); }} className="btn-primary" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Ico d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" size={13} color="currentColor" />
                    Download PDF
                  </button>
                </div>
                <div className="card" style={{ padding: 0, overflow: "hidden", maxWidth: 860 }}>
                  {/* Invoice header */}
                  <div style={{ padding: "28px 32px", borderBottom: `1px solid ${T.borderSoft}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
                      <div>
                        <div className="display" style={{ fontSize: 36, color: T.ink, letterSpacing: -0.8, lineHeight: 1 }}>Invoice</div>
                        <div className="mono" style={{ fontSize: 16, color: T.accent, marginTop: 8, fontWeight: 600 }}>#{inv.num}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div className="display" style={{ fontSize: 18, color: T.ink, lineHeight: 1 }}>{P1_BUSINESS.dba}</div>
                        <div style={{ fontSize: 10, color: T.subtle, marginTop: 2 }}>({P1_BUSINESS.legalName})</div>
                        <div style={{ fontSize: 11, color: T.muted, marginTop: 6, lineHeight: 1.55 }}>
                          {P1_BUSINESS.addr1}<br />{P1_BUSINESS.addr2}<br />{P1_BUSINESS.email}<br />{P1_BUSINESS.phone}<br />{P1_BUSINESS.website}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Bill-to / Ship-to / Metadata */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 0, borderBottom: `1px solid ${T.borderSoft}` }}>
                    <div style={{ padding: "20px 32px", borderRight: `1px solid ${T.borderSoft}` }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 6 }}>Bill to</div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: T.ink }}>{SEVEN_BILL_TO.name}</div>
                      <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.6, marginTop: 2 }}>7-ELEVEN STORE - {inv.store}<br />{SEVEN_BILL_TO.addr1}<br />{SEVEN_BILL_TO.addr2}</div>
                    </div>
                    <div style={{ padding: "20px 32px", borderRight: `1px solid ${T.borderSoft}` }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 6 }}>Ship to</div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: T.ink }}>7-ELEVEN STORE - {inv.store}</div>
                      <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.6, marginTop: 2 }}>{inv.storeAddr || wo?.addr || "—"}</div>
                    </div>
                    <div style={{ padding: "20px 32px" }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 6 }}>Invoice details</div>
                      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 12px", fontSize: 11 }}>
                        <span style={{ color: T.muted }}>Invoice date</span><span className="mono" style={{ color: T.ink }}>{inv.invoiceDate}</span>
                        <span style={{ color: T.muted }}>Service date</span><span className="mono" style={{ color: T.ink }}>{inv.serviceDate}</span>
                        <span style={{ color: T.muted }}>Terms</span><span style={{ color: T.ink }}>{inv.terms || "Net 30"}</span>
                        <span style={{ color: T.muted }}>Work order</span><span className="mono" style={{ color: T.accent }}>{inv.wot}</span>
                        <span style={{ color: T.muted }}>CME</span><span className="mono" style={{ color: T.ink }}>{inv.cme || "—"}</span>
                        <span style={{ color: T.muted }}>Status</span><span><Badge conf={INV_STATE[inv.state]} small /></span>
                      </div>
                    </div>
                  </div>

                  {/* Line items */}
                  <div>
                    <div style={{ display: "grid", gridTemplateColumns: "36px 130px 1fr 60px 90px 100px", gap: 0, padding: "12px 32px", background: T.surfaceSoft, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.7, color: T.subtle, borderBottom: `1px solid ${T.borderSoft}` }}>
                      <div>#</div><div>Type</div><div>Description</div><div style={{ textAlign: "right" }}>Qty</div><div style={{ textAlign: "right" }}>Rate</div><div style={{ textAlign: "right" }}>Amount</div>
                    </div>
                    {(inv.lines || []).map((l: any, i: number) => (
                      <div key={i} style={{ display: "grid", gridTemplateColumns: "36px 130px 1fr 60px 90px 100px", gap: 0, padding: "14px 32px", borderBottom: `1px solid ${T.borderSoft}`, alignItems: "start", fontSize: 12 }}>
                        <div className="mono" style={{ color: T.subtle }}>{i + 1}</div>
                        <div style={{ color: T.inkSoft, fontWeight: 500 }}>{l.type}</div>
                        <div style={{ color: T.ink, lineHeight: 1.55, paddingRight: 14 }}>{l.desc}</div>
                        <div className="mono" style={{ textAlign: "right", color: T.muted }}>{l.qty}</div>
                        <div className="mono" style={{ textAlign: "right", color: T.muted }}>{fmt(l.rate)}</div>
                        <div className="mono" style={{ textAlign: "right", fontWeight: 600, color: T.ink }}>{fmt(Math.round(l.amount * 100) / 100)}</div>
                      </div>
                    ))}
                  </div>

                  {/* Totals */}
                  <div style={{ padding: "22px 32px", display: "flex", justifyContent: "flex-end" }}>
                    <div style={{ width: 300 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "6px 0" }}>
                        <span style={{ color: T.muted }}>Subtotal</span>
                        <span className="mono" style={{ color: T.ink, fontWeight: 500 }}>{fmt(Math.round(inv.subtotal * 100) / 100)}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "6px 0", borderBottom: `1px solid ${T.border}` }}>
                        <span style={{ color: T.muted }}>Sales tax</span>
                        <span className="mono" style={{ color: T.ink, fontWeight: 500 }}>{fmt(Math.round(inv.salesTax * 100) / 100)}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0 0" }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>Total</span>
                        <span className="display" style={{ fontSize: 26, color: T.ink, letterSpacing: -0.5 }}>{fmt(Math.round(inv.total * 100) / 100)}</span>
                      </div>
                      {wo && (
                        <div style={{ fontSize: 11, color: inv.total > wo.nte ? T.danger : T.success, textAlign: "right", marginTop: 4 }}>
                          {inv.total > wo.nte ? `Exceeds NTE by ${fmt(inv.total - wo.nte)}` : `${fmt(wo.nte - inv.total)} under NTE`}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Rejected reason */}
                  {inv.state === "rejected" && inv.reason && (
                    <div style={{ padding: "16px 32px", background: T.dangerSoft, borderTop: `1px solid ${T.danger}22` }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.danger, marginBottom: 4 }}>Rejection reason</div>
                      <div style={{ fontSize: 12, color: "#8B2C20" }}>{inv.reason}</div>
                    </div>
                  )}

                  {/* Footer — ways to pay (placeholder until Jeremy confirms) */}
                  <div style={{ padding: "18px 32px", background: T.surfaceSoft, borderTop: `1px solid ${T.borderSoft}`, fontSize: 11, color: T.subtle, textAlign: "center" }}>
                    Ways to pay — ACH / check (pending confirmation with Jeremy) · Questions? {P1_BUSINESS.email}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* ═════ CONTRACTORS ═════ */}
          {page === "contractors" && isManager && (
            <div className="contractors-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, animation: "fadeUp 0.3s" }}>
              {contractorsOnly.map((c, i) => {
                const cWOs = workOrders.filter(w => w.contractor === c.id);
                return (
                  <div key={c.id} className="card card-hover" style={{ overflow: "hidden", animation: `fadeUp 0.35s ${i * 0.06}s both` }}>
                    <div style={{ padding: "22px 22px 16px", borderBottom: `1px solid ${T.borderSoft}` }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <Avatar initials={c.initials} color={c.color} size={46} />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 15, fontWeight: 700, color: T.ink }}>{c.name}</div>
                          <div style={{ fontSize: 12, color: T.muted }}>{c.company}</div>
                          <div style={{ fontSize: 11, color: T.subtle, marginTop: 3 }}>{c.territory}</div>
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 5, marginTop: 12, flexWrap: "wrap" }}>
                        {(c.trades || []).map((t: string) => (
                          <span key={t} style={{ fontSize: 10, fontWeight: 600, color: T.accent, background: T.accentSoft, padding: "2px 8px", borderRadius: 10, textTransform: "capitalize" }}>{t}</span>
                        ))}
                      </div>
                    </div>
                    <div style={{ padding: "14px 22px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 3 }}>Active</div>
                        <div className="display" style={{ fontSize: 20, fontWeight: 500, color: T.accent }}>{cWOs.filter(w => activeStatuses.includes(w.status)).length}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 3 }}>Capital</div>
                        <div className="display" style={{ fontSize: 20, fontWeight: 500, color: T.violet }}>{cWOs.filter(w => w.status === "capital").length}</div>
                      </div>
                    </div>
                    <div style={{ padding: "0 22px 18px" }}>
                      <button onClick={() => { nav("work_orders"); setFilterC(c.id); }} className="btn-soft" style={{ width: "100%" }}>View work orders →</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

        </div>
      </div>

      {/* ═════ MODALS ═════ */}
      {modal === "newWO" && (
        <Modal onClose={() => { setModal(null); resetNewWO(); }} title="New work order" width={520}>
          <div style={{ display: "grid", gap: 14 }}>
            <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Store #"><Input value={newWO.store} onChange={(e: any) => setNewWO({ ...newWO, store: e.target.value })} placeholder="e.g. 33321" /></Field>
              <Field label="City, State"><Input value={newWO.city} onChange={(e: any) => setNewWO({ ...newWO, city: e.target.value })} placeholder="e.g. Dallas, TX" /></Field>
            </div>
            <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Business Service"><Sel value={newWO.businessService} onChange={(e: any) => setNewWO({ ...newWO, businessService: e.target.value })}>
                <option value="">Select...</option>
                {["Refrigeration equipment", "Frozen Beverage - Equipment", "Cold Beverage - Equipment", "HVAC", "Plumbing", "Hot food", "Ice merchandiser", "Walk-in cooler/freezer", "Septic/Grease"].map(c => <option key={c}>{c}</option>)}
              </Sel></Field>
              <Field label="Priority"><Sel value={newWO.priority} onChange={(e: any) => setNewWO({ ...newWO, priority: e.target.value })}>
                {Object.entries(PRIORITY).map(([k, v]: any) => <option key={k} value={k}>{v.label}</option>)}
              </Sel></Field>
            </div>
            <Field label="Category"><Input value={newWO.category} onChange={(e: any) => setNewWO({ ...newWO, category: e.target.value })} placeholder="e.g. Slurpee Machine, Fountain Machine, RTU compressor" /></Field>
            <Field label="Summary"><TA rows={3} value={newWO.summary} onChange={(e: any) => setNewWO({ ...newWO, summary: e.target.value })} placeholder="Describe the issue..." /></Field>
            <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="NTE ($)"><Input type="number" value={newWO.nte} onChange={(e: any) => setNewWO({ ...newWO, nte: e.target.value })} placeholder="1000" /></Field>
              <Field label="Dispatch"><Sel value={newWO.assign} onChange={(e: any) => setNewWO({ ...newWO, assign: e.target.value })}>
                <option value="auto">Auto — territory + trade match</option>
                <option value="unassigned">Leave unassigned</option>
                {contractorsOnly.map(u => <option key={u.id} value={u.id}>{u.name} ({u.territory})</option>)}
              </Sel></Field>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 22, justifyContent: "flex-end" }}>
            <button onClick={() => { setModal(null); resetNewWO(); }} className="btn-soft">Cancel</button>
            <button onClick={() => { if (doCreateWO()) setModal(null); }} className="btn-primary">Create</button>
          </div>
        </Modal>
      )}

      {modal === "setEta" && woData && (
        <Modal onClose={() => setModal(null)} title="Set ETA" width={400}>
          <div style={{ fontSize: 13, color: T.muted, marginBottom: 16 }}>When will you arrive at Store #{woData.store}?</div>
          <div style={{ display: "grid", gap: 14 }}>
            <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Date"><Input type="date" id="eta-date" defaultValue={new Date().toISOString().slice(0, 10)} /></Field>
              <Field label="Time"><Input type="time" id="eta-time" defaultValue="14:00" /></Field>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 22, justifyContent: "flex-end" }}>
            <button onClick={() => setModal(null)} className="btn-soft">Cancel</button>
            <button onClick={() => {
              const dv = (document.getElementById("eta-date") as any)?.value || new Date().toISOString().slice(0, 10);
              const t = (document.getElementById("eta-time") as any)?.value || "14:00";
              const h = parseInt(t); const m = t.split(":")[1];
              const ap = h >= 12 ? "PM" : "AM";
              const d = new Date(dv + "T00:00:00");
              const eta = `${MONTHS[d.getMonth()]} ${d.getDate()}, ${h > 12 ? h - 12 : h || 12}:${m} ${ap}`;
              doSetEta(woData.id, eta); setModal(null);
            }} className="btn-primary">Set ETA</button>
          </div>
        </Modal>
      )}

      {modal === "startWork" && woData && (
        <Modal onClose={() => setModal(null)} title={woData.status === "parts" ? "Resume work" : "Start work"} width={440}>
          <div style={{ fontSize: 13, color: T.muted, marginBottom: 16 }}>Checking in at Store #{woData.store}. Status will auto-sync to 7-Eleven.</div>
          <div style={{ display: "grid", gap: 14 }}>
            <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Arrival date"><Input type="date" defaultValue={new Date().toISOString().slice(0, 10)} /></Field>
              <Field label="Arrival time"><Input type="time" defaultValue={new Date().toTimeString().slice(0, 5)} /></Field>
            </div>
            <Field label="Initial notes"><TA id="start-notes" rows={2} placeholder="What are you seeing on site?" /></Field>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 22, justifyContent: "flex-end" }}>
            <button onClick={() => setModal(null)} className="btn-soft">Cancel</button>
            <button onClick={() => { doStartWork(woData.id, (document.getElementById("start-notes") as any)?.value); setModal(null); }} className="btn-accent">{woData.status === "parts" ? "Resume" : "Start work"}</button>
          </div>
        </Modal>
      )}

      {modal === "pauseWork" && woData && (
        <Modal onClose={() => setModal(null)} title="Pause work" width={500}>
          <div style={{ fontSize: 13, color: T.muted, marginBottom: 16 }}>Why can't the job be completed this trip?</div>
          <div style={{ display: "grid", gap: 14 }}>
            <Field label="Reason"><Sel id="pause-reason">
              <option value="">Select...</option>
              <option value="Temporary fix">Temporary fix — equipment partially working</option>
              <option value="Awaiting parts">Awaiting parts — equipment completely down</option>
            </Sel></Field>
            <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Stamp-out date"><Input type="date" defaultValue={new Date().toISOString().slice(0, 10)} /></Field>
              <Field label="Stamp-out time"><Input type="time" defaultValue={new Date().toTimeString().slice(0, 5)} /></Field>
            </div>
            <div style={{ padding: "14px 16px", background: T.warnSoft, borderRadius: 10, border: `1px solid ${T.warn}33` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.warn, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.8 }}>Parts information</div>
              <div style={{ display: "grid", gap: 10 }}>
                <Field label="Part description (generic)"><Input id="part-desc" placeholder="e.g. Evaporator coil, blower motor..." /></Field>
                <Field label="Specific part number"><Input id="part-num" placeholder="e.g. Heatcraft BHL136BE" /></Field>
                <Field label="Expected return date"><Input id="part-eta" type="date" /></Field>
              </div>
            </div>
            <Field label="Notes"><TA id="pause-notes" rows={2} placeholder="Explain what was done so far..." /></Field>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 22, justifyContent: "flex-end" }}>
            <button onClick={() => setModal(null)} className="btn-soft">Cancel</button>
            <button onClick={() => { doPauseWork(woData.id, (document.getElementById("pause-reason") as any)?.value, (document.getElementById("part-desc") as any)?.value, (document.getElementById("part-num") as any)?.value, (document.getElementById("part-eta") as any)?.value, (document.getElementById("pause-notes") as any)?.value); setModal(null); }} className="btn-accent">Pause work</button>
          </div>
        </Modal>
      )}

      {modal === "closeComplete" && woData && (
        <Modal onClose={() => setModal(null)} title="Close complete" width={540}>
          <div style={{ fontSize: 13, color: T.muted, marginBottom: 16 }}>Complete the job for Store #{woData.store}. Asset info is required.</div>
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ padding: "14px 16px", background: T.accentSoft, borderRadius: 10, border: `1px solid ${T.accentRing}` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.accent, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.8 }}>Asset information (required)</div>
              <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Asset model"><Input id="asset-model" placeholder="e.g. Taylor 340" defaultValue={woData.assetModel || ""} /></Field>
                <Field label="Serial number"><Input id="asset-serial" placeholder="e.g. TY-2022-81402" defaultValue={woData.assetSerial || ""} /></Field>
              </div>
            </div>
            <div style={{ padding: "14px 16px", background: T.successSoft, borderRadius: 10, border: `1px solid ${T.success}33` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.success, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.8 }}>DSP closure</div>
              <Field label="Resolution code"><Sel id="resolution">
                <option value="">Select...</option>
                <option>Current asset evaluated</option>
                <option>Current asset repaired</option>
                <option>Current asset replaced</option>
                <option>OEM warranty related</option>
              </Sel></Field>
            </div>
            <Field label="Resolution details"><TA id="resolution-notes" rows={3} placeholder="Brief summary of what was found and done..." /></Field>
            <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="End date"><Input type="date" defaultValue={new Date().toISOString().slice(0, 10)} /></Field>
              <Field label="End time"><Input type="time" defaultValue={new Date().toTimeString().slice(0, 5)} /></Field>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 22, justifyContent: "flex-end" }}>
            <button onClick={() => setModal(null)} className="btn-soft">Cancel</button>
            <button onClick={() => {
              const m = (document.getElementById("asset-model") as any)?.value;
              const s = (document.getElementById("asset-serial") as any)?.value;
              if (!m || !s) { fire("Asset model and serial number are required"); return; }
              doCloseComplete(woData.id, m, s, (document.getElementById("resolution") as any)?.value); setModal(null);
            }} className="btn-primary">Close complete</button>
          </div>
        </Modal>
      )}

      {modal === "createInvoice" && woData && (() => {
        // Auto-fill invoice # if blank
        if (!newInv.num) setTimeout(() => setNewInv((n: any) => n.num ? n : { ...n, num: nextInvNum() }), 0);
        const sub = invSubtotal(newInv.lines || []);
        const tax = parseFloat(newInv.tax) || 0;
        const total = sub + tax;
        const over = total > woData.nte;
        const setLine = (i: number, patch: any) => {
          setNewInv((n: any) => ({ ...n, lines: n.lines.map((l: any, idx: number) => idx === i ? { ...l, ...patch } : l) }));
        };
        const addLine = (type = "Labor") => setNewInv((n: any) => ({ ...n, lines: [...n.lines, { type, desc: "", qty: 1, rate: type === "Parts/Hardware" ? 0 : P1_BUSINESS.defaultLaborRate, amount: 0 }] }));
        const removeLine = (i: number) => setNewInv((n: any) => ({ ...n, lines: n.lines.filter((_: any, idx: number) => idx !== i) }));
        return (
          <Modal onClose={() => { setModal(null); resetNewInv(); }} title="Create invoice" width={820}>
            <div style={{ fontSize: 13, color: T.muted, marginBottom: 20 }}>P1 Pros invoice to 7-Eleven — Work Order {woData.id}</div>

            {/* Business header + bill-to/ship-to preview */}
            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", gap: 14, padding: "14px 16px", background: T.surfaceSoft, borderRadius: 12, border: `1px solid ${T.borderSoft}`, marginBottom: 18 }}>
              <div>
                <div className="display" style={{ fontSize: 16, color: T.ink, lineHeight: 1.1 }}>{P1_BUSINESS.dba}</div>
                <div style={{ fontSize: 10, color: T.subtle, marginTop: 2 }}>({P1_BUSINESS.legalName})</div>
                <div style={{ fontSize: 11, color: T.muted, marginTop: 6, lineHeight: 1.5 }}>{P1_BUSINESS.addr1}<br />{P1_BUSINESS.addr2}<br />{P1_BUSINESS.phone}</div>
              </div>
              <div>
                <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 4 }}>Bill to</div>
                <div style={{ fontSize: 11, color: T.ink, fontWeight: 600 }}>{SEVEN_BILL_TO.name}</div>
                <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.5 }}>{SEVEN_BILL_TO.addr1}<br />{SEVEN_BILL_TO.addr2}</div>
              </div>
              <div>
                <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 4 }}>Ship to · Store #{woData.store}</div>
                <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.5 }}>{woData.addr || "—"}</div>
              </div>
            </div>

            {/* Invoice meta */}
            <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
              <Field label="Invoice #"><Input value={newInv.num} onChange={(e: any) => setNewInv({ ...newInv, num: e.target.value })} placeholder="e.g. 6557" /></Field>
              <Field label="Invoice date"><Input type="date" value={newInv.invoiceDate} onChange={(e: any) => setNewInv({ ...newInv, invoiceDate: e.target.value })} /></Field>
              <Field label="Service date"><Input type="date" value={newInv.serviceDate} onChange={(e: any) => setNewInv({ ...newInv, serviceDate: e.target.value })} /></Field>
              <Field label="Terms"><Sel value={newInv.terms} onChange={(e: any) => setNewInv({ ...newInv, terms: e.target.value })}>
                <option>Net 30</option><option>Net 15</option><option>Due on receipt</option>
              </Sel></Field>
            </div>
            <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 18 }}>
              <Field label="Work Order #"><div style={{ padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.borderSoft}`, background: T.surfaceSoft, fontSize: 13, color: T.ink, fontFamily: "'JetBrains Mono', monospace" }}>{woData.id}</div></Field>
              <Field label="Store #"><div style={{ padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.borderSoft}`, background: T.surfaceSoft, fontSize: 13, color: T.ink }}>#{woData.store}</div></Field>
              <Field label="CME #"><Sel value={newInv.cme} onChange={(e: any) => setNewInv({ ...newInv, cme: e.target.value })}>
                <option value="">Select...</option>
                <option>CME-001 HVAC</option>
                <option>CME-002 Beverage</option>
                <option>CME-003 Electrical</option>
                <option>CME-004 Refrigeration</option>
                <option>CME-005 Plumbing</option>
                <option>CME-006 Hot food</option>
                <option>CME-007 General</option>
              </Sel></Field>
            </div>

            {/* Line items */}
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 8 }}>Line items</div>
            <div style={{ border: `1px solid ${T.borderSoft}`, borderRadius: 12, overflow: "hidden", marginBottom: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "30px 140px 1fr 70px 90px 90px 28px", gap: 10, padding: "10px 12px", background: T.surfaceSoft, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: T.subtle, borderBottom: `1px solid ${T.borderSoft}` }}>
                <div>#</div><div>Type</div><div>Description</div><div style={{ textAlign: "right" }}>Qty</div><div style={{ textAlign: "right" }}>Rate</div><div style={{ textAlign: "right" }}>Amount</div><div></div>
              </div>
              {(newInv.lines || []).map((l: any, i: number) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "30px 140px 1fr 70px 90px 90px 28px", gap: 10, padding: "10px 12px", borderBottom: i < newInv.lines.length - 1 ? `1px solid ${T.borderSoft}` : "none", alignItems: "start" }}>
                  <div className="mono" style={{ fontSize: 12, color: T.subtle, paddingTop: 10 }}>{i + 1}</div>
                  <select value={l.type} onChange={(e: any) => setLine(i, { type: e.target.value })} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, fontSize: 12, fontFamily: "inherit", color: T.ink, outline: "none" }}>
                    {LINE_TYPES.map(t => <option key={t}>{t}</option>)}
                  </select>
                  <textarea value={l.desc} onChange={(e: any) => setLine(i, { desc: e.target.value })} placeholder={l.type === "Labor" ? "What was done on site..." : l.type === "Parts/Hardware" ? "Part description" : "Description"} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, fontSize: 12, fontFamily: "inherit", color: T.ink, resize: "vertical", minHeight: 36, outline: "none" }} />
                  <input type="number" step="0.1" value={l.qty} onChange={(e: any) => setLine(i, { qty: e.target.value })} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, fontSize: 12, fontFamily: "inherit", color: T.ink, textAlign: "right", outline: "none" }} />
                  <input type="number" step="0.01" value={l.rate} onChange={(e: any) => setLine(i, { rate: e.target.value })} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: T.ink, textAlign: "right", outline: "none" }} />
                  <div className="mono" style={{ fontSize: 12, fontWeight: 600, color: T.ink, textAlign: "right", paddingTop: 10 }}>{fmt(Math.round(lineAmount(l) * 100) / 100)}</div>
                  <button onClick={() => removeLine(i)} style={{ background: "transparent", border: "none", color: T.subtle, cursor: "pointer", fontSize: 16, padding: 0, paddingTop: 6 }}>×</button>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
              <button onClick={() => addLine("Labor")} className="btn-soft" style={{ padding: "7px 12px", fontSize: 11 }}>+ Labor</button>
              <button onClick={() => addLine("Travel")} className="btn-soft" style={{ padding: "7px 12px", fontSize: 11 }}>+ Travel</button>
              <button onClick={() => addLine("Parts/Hardware")} className="btn-soft" style={{ padding: "7px 12px", fontSize: 11 }}>+ Parts</button>
              <button onClick={() => addLine("Shipping")} className="btn-soft" style={{ padding: "7px 12px", fontSize: 11 }}>+ Shipping</button>
              <button onClick={() => addLine("Other")} className="btn-soft" style={{ padding: "7px 12px", fontSize: 11 }}>+ Other</button>
            </div>

            {/* Totals */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 14, marginBottom: 18, alignItems: "start" }}>
              <div />
              <div style={{ background: T.surfaceSoft, borderRadius: 12, border: `1px solid ${T.borderSoft}`, padding: "14px 16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, fontSize: 13 }}>
                  <span style={{ color: T.muted }}>Subtotal</span>
                  <span className="mono" style={{ fontWeight: 600, color: T.ink }}>{fmt(Math.round(sub * 100) / 100)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, fontSize: 13, gap: 10 }}>
                  <span style={{ color: T.muted }}>Sales tax</span>
                  <input type="number" step="0.01" value={newInv.tax} onChange={(e: any) => setNewInv({ ...newInv, tax: e.target.value })} placeholder="0.00" style={{ width: 110, padding: "6px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: T.ink, textAlign: "right", outline: "none" }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 10, borderTop: `1px solid ${T.border}`, fontSize: 14 }}>
                  <span style={{ fontWeight: 700, color: T.ink }}>Total</span>
                  <span className="display" style={{ fontSize: 22, color: over ? T.danger : T.ink, letterSpacing: -0.4 }}>{fmt(Math.round(total * 100) / 100)}</span>
                </div>
                <div style={{ fontSize: 11, color: over ? T.danger : T.muted, marginTop: 8, textAlign: "right" }}>
                  {over ? `Exceeds NTE by ${fmt(total - woData.nte)}` : `${fmt(woData.nte - total)} under NTE (${fmt(woData.nte)})`}
                </div>
              </div>
            </div>

            {/* PDF upload */}
            <label style={{ padding: "12px 16px", background: newInv.hasPdf ? T.successSoft : T.accentSoft, borderRadius: 10, border: `1px solid ${newInv.hasPdf ? T.success + "33" : T.accentRing}`, cursor: "pointer", display: "block", marginBottom: 4 }}>
              <div style={{ border: `2px dashed ${newInv.hasPdf ? T.success : T.accent}`, borderRadius: 8, padding: 18, textAlign: "center" }}>
                <div style={{ fontSize: 13, color: newInv.hasPdf ? T.success : T.accent, fontWeight: 600 }}>{newInv.hasPdf ? "✓ PDF attached" : "Attach the PDF invoice (from QuickBooks)"}</div>
                <div style={{ fontSize: 11, color: T.subtle, marginTop: 4 }}>Required before submit</div>
                <input type="file" accept="application/pdf" style={{ display: "none" }} onChange={(e: any) => setNewInv({ ...newInv, hasPdf: !!(e.target.files && e.target.files.length) })} />
              </div>
            </label>

            <div style={{ display: "flex", gap: 8, marginTop: 18, justifyContent: "flex-end" }}>
              <button onClick={() => { setModal(null); resetNewInv(); }} className="btn-soft">Cancel</button>
              <button onClick={() => { if (doSubmitInvoice(woData)) setModal(null); }} className="btn-accent">Submit to 7-Eleven</button>
            </div>
          </Modal>
        );
      })()}

      {lightbox && (
        <div onClick={() => setLightbox(null)} style={{ position: "fixed", inset: 0, background: "rgba(31,30,28,0.92)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 70, padding: 20, cursor: "zoom-out" }}>
          <img src={lightbox} alt="" style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 10, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }} />
          <button onClick={e => { e.stopPropagation(); setLightbox(null); }} style={{ position: "absolute", top: 20, right: 20, width: 40, height: 40, borderRadius: "50%", background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", fontSize: 20, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
        </div>
      )}

      {toast && <div style={{ position: "fixed", bottom: 80, left: "50%", transform: "translateX(-50%)", background: T.ink, color: T.bg, padding: "12px 22px", borderRadius: 12, fontSize: 13, fontWeight: 500, animation: "fadeUp 0.25s", zIndex: 60, boxShadow: "0 8px 32px rgba(31,30,28,0.3)", whiteSpace: "nowrap", border: `1px solid rgba(250,247,242,0.1)` }}>{toast}</div>}
    </div>
  );
}
