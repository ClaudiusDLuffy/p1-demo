"use client";
// @ts-nocheck
import { useState, useEffect, useCallback } from "react";

// ── Data ──────────────────────────────────────────────────────
const USERS = [
  { id: "clay", name: "Clay Lawrence", role: "manager", initials: "CL", email: "clay@p1services.com", color: "#2563eb" },
  { id: "derek", name: "Derek Morrison", role: "contractor", initials: "DM", email: "derek@dmrepairs.com", company: "DM Repair Services", territory: "Orlando / Kissimmee", color: "#0ea5e9" },
  { id: "ray", name: "Ray Torres", role: "contractor", initials: "RT", email: "ray@raytechservices.com", company: "Ray's Technical Services", territory: "Melbourne / Daytona", color: "#8b5cf6" },
  { id: "andy", name: "Andy Kim", role: "contractor", initials: "AK", email: "andy@akmaintenance.com", company: "AK Maintenance Co.", territory: "Tampa / Lakeland", color: "#0891b2" },
];

const WORK_ORDERS = [
  { id: "WOT0012847", store: "36190", city: "Orlando, FL", addr: "4801 S Orange Ave", issue: "HVAC unit not cooling — store temp above 80°F, customers complaining", priority: "emergency", status: "unassigned", nte: 2500, age: "2h", category: "HVAC", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134" },
  { id: "WOT0012852", store: "32236", city: "Kissimmee, FL", addr: "1920 W Vine St", issue: "Walk-in cooler compressor failure — product temp rising, potential loss", priority: "emergency", status: "unassigned", nte: 3000, age: "45m", category: "Refrigeration", afm: "Robert Chen", afmPhone: "(321) 555-0198" },
  { id: "WOT0012860", store: "41005", city: "Tampa, FL", addr: "3402 W Hillsborough Ave", issue: "Front door automatic closer broken — security risk, door staying open", priority: "routine", status: "unassigned", nte: 500, age: "1d", category: "General", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134" },
  { id: "WOT0012801", store: "36190", city: "Orlando, FL", addr: "4801 S Orange Ave", issue: "Beverage dispenser leaking at base — floor hazard near registers", priority: "critical", status: "assigned", contractor: "derek", nte: 1200, age: "1d", category: "Equipment", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134" },
  { id: "WOT0012815", store: "32236", city: "Kissimmee, FL", addr: "1920 W Vine St", issue: "Electrical panel cover missing in back room — code violation", priority: "critical", status: "assigned", contractor: "ray", nte: 800, age: "3d", category: "Electrical", afm: "Robert Chen", afmPhone: "(321) 555-0198" },
  { id: "WOT0012822", store: "41005", city: "Tampa, FL", addr: "3402 W Hillsborough Ave", issue: "Parking lot pothole near fuel pumps — liability concern", priority: "critical", status: "assigned", contractor: "andy", nte: 1500, age: "2d", category: "General", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134" },
  { id: "WOT0012779", store: "41022", city: "Lakeland, FL", addr: "2210 S Florida Ave", issue: "Slurpee machine motor replacement — unit offline 3 days", priority: "critical", status: "wip", contractor: "andy", nte: 1800, age: "2d", category: "Equipment", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134", startTime: "Apr 7, 9:15 AM" },
  { id: "WOT0012788", store: "36501", city: "Daytona Beach, FL", addr: "801 N Atlantic Ave", issue: "Grease trap overflow in kitchen — health department risk", priority: "emergency", status: "wip", contractor: "derek", nte: 2200, age: "1d", category: "Plumbing", afm: "Robert Chen", afmPhone: "(321) 555-0198", startTime: "Apr 7, 2:00 PM" },
  { id: "WOT0012756", store: "32100", city: "Melbourne, FL", addr: "1455 N Harbor City Blvd", issue: "Walk-in freezer evaporator coil — needs full replacement", priority: "critical", status: "parts", contractor: "ray", nte: 4500, age: "5d", category: "Refrigeration", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134", partNeeded: "Heatcraft BHL136BE evaporator coil", partEta: "Apr 11" },
  { id: "WOT0012771", store: "36190", city: "Orlando, FL", addr: "4801 S Orange Ave", issue: "POS terminal #3 power supply unit failure — register offline", priority: "routine", status: "parts", contractor: "andy", nte: 350, age: "4d", category: "Electrical", afm: "Robert Chen", afmPhone: "(321) 555-0198", partNeeded: "Epson PS-180 power supply", partEta: "Apr 10" },
  { id: "WOT0012745", store: "41005", city: "Tampa, FL", addr: "3402 W Hillsborough Ave", issue: "Parking lot light pole repair — 3 fixtures out, dark corner", priority: "routine", status: "completed", contractor: "derek", nte: 900, age: "6d", category: "Electrical", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134" },
  { id: "WOT0012730", store: "32236", city: "Kissimmee, FL", addr: "1920 W Vine St", issue: "Emergency plumbing — burst pipe in utility room, water damage", priority: "emergency", status: "pending_invoice", contractor: "ray", nte: 3200, age: "8d", category: "Plumbing", afm: "Robert Chen", afmPhone: "(321) 555-0198" },
  { id: "WOT0012718", store: "36501", city: "Daytona Beach, FL", addr: "801 N Atlantic Ave", issue: "Roof leak repair above walk-in cooler — water dripping on product", priority: "critical", status: "pending_invoice", contractor: "derek", nte: 5000, age: "10d", category: "General", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134" },
  { id: "WOT0012702", store: "32100", city: "Melbourne, FL", addr: "1455 N Harbor City Blvd", issue: "Complete HVAC system overhaul — both rooftop units failing", priority: "critical", status: "pending_approval", contractor: "andy", nte: 8500, age: "12d", category: "HVAC", afm: "Robert Chen", afmPhone: "(321) 555-0198", invoiceTotal: 7840 },
];

const INVOICES = [
  { num: "INV05000142", wot: "WOT0012702", state: "submitted", date: "Apr 6", store: "32100", total: 7840, contractor: "andy" },
  { num: "INV05000138", wot: "WOT0012698", state: "approved", date: "Apr 4", store: "36190", total: 2150, contractor: "derek" },
  { num: "INV05000135", wot: "WOT0012685", state: "rejected", date: "Apr 3", store: "41022", total: 4600, contractor: "ray", reason: "Lack of invoice detail" },
  { num: "INV05000131", wot: "WOT0012670", state: "approved", date: "Apr 1", store: "32236", total: 1280, contractor: "derek" },
  { num: "INV05000128", wot: "WOT0012660", state: "revised", date: "Mar 30", store: "36501", total: 3100, contractor: "ray" },
  { num: "INV05000125", wot: "WOT0012655", state: "approved", date: "Mar 28", store: "41005", total: 890, contractor: "andy" },
];

const STATUS = {
  unassigned: { label: "Unassigned", color: "#3b82f6", bg: "#eff6ff", ring: "#bfdbfe" },
  assigned: { label: "Assigned", color: "#f59e0b", bg: "#fffbeb", ring: "#fde68a" },
  wip: { label: "In progress", color: "#8b5cf6", bg: "#f5f3ff", ring: "#c4b5fd" },
  parts: { label: "Parts on order", color: "#ef4444", bg: "#fef2f2", ring: "#fecaca" },
  completed: { label: "Completed", color: "#22c55e", bg: "#f0fdf4", ring: "#bbf7d0" },
  pending_invoice: { label: "Pending invoice", color: "#ec4899", bg: "#fdf2f8", ring: "#fbcfe8" },
  pending_approval: { label: "Pending approval", color: "#64748b", bg: "#f1f5f9", ring: "#cbd5e1" },
};

const PRIORITY = {
  emergency: { label: "Emergency", color: "#dc2626", bg: "#fef2f2", icon: "⚡" },
  critical: { label: "Critical", color: "#f59e0b", bg: "#fffbeb", icon: "⚠" },
  routine: { label: "Routine", color: "#22c55e", bg: "#f0fdf4", icon: "●" },
};

const INV_STATE = {
  submitted: { label: "Submitted", color: "#3b82f6", bg: "#eff6ff" },
  approved: { label: "Approved", color: "#22c55e", bg: "#f0fdf4" },
  rejected: { label: "Rejected", color: "#ef4444", bg: "#fef2f2" },
  revised: { label: "Revised", color: "#f59e0b", bg: "#fffbeb" },
};

const fmt = n => "$" + n.toLocaleString();

// ── Components ────────────────────────────────────────────────
const Badge = ({ conf }) => conf ? (
  <span style={{ fontSize: 10, fontWeight: 600, padding: "3px 10px", borderRadius: 20, background: conf.bg, color: conf.color, whiteSpace: "nowrap", letterSpacing: 0.3, border: `1px solid ${conf.ring || conf.bg}` }}>{conf.label}</span>
) : null;

const Ico = ({ d, size = 18, color = "currentColor", sw = 1.8 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);

const Avatar = ({ initials, color, size = 36 }) => (
  <div style={{ width: size, height: size, borderRadius: "50%", background: `linear-gradient(135deg, ${color}, ${color}dd)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.33, fontWeight: 700, color: "#fff", letterSpacing: -0.5, flexShrink: 0 }}>{initials}</div>
);

// ── Main App ──────────────────────────────────────────────────
export default function P1Portal() {
  const [currentUser, setCurrentUser] = useState(null);
  const [page, setPage] = useState("dashboard");
  const [selectedWO, setSelectedWO] = useState(null);
  const [search, setSearch] = useState("");
  const [filterC, setFilterC] = useState("all");
  const [filterP, setFilterP] = useState("all");
  const [invTab, setInvTab] = useState("all");
  const [showNewWO, setShowNewWO] = useState(false);
  const [toast, setToast] = useState(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [fadeIn, setFadeIn] = useState(false);

  useEffect(() => { setTimeout(() => setFadeIn(true), 50); }, []);

  const fire = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2800); };

  const doLogin = (userId) => {
    setLoginLoading(true);
    setTimeout(() => {
      setCurrentUser(USERS.find(u => u.id === userId));
      setPage(userId === "clay" ? "dashboard" : "my_jobs");
      setLoginLoading(false);
    }, 600);
  };

  const logout = () => {
    setCurrentUser(null);
    setPage("dashboard");
    setSelectedWO(null);
    setLoginEmail("");
  };

  const isManager = currentUser?.role === "manager";
  const getUser = id => USERS.find(u => u.id === id);

  const myWOs = currentUser?.role === "contractor"
    ? WORK_ORDERS.filter(w => w.contractor === currentUser.id)
    : WORK_ORDERS;

  const activeStatuses = ["unassigned", "assigned", "wip", "parts"];
  const closingStatuses = ["completed", "pending_invoice", "pending_approval"];

  const filteredWOs = myWOs.filter(w => {
    if (search && !w.id.toLowerCase().includes(search.toLowerCase()) && !w.store.includes(search) && !w.issue.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterC !== "all" && w.contractor !== filterC) return false;
    if (filterP !== "all" && w.priority !== filterP) return false;
    return true;
  });

  const openCount = WORK_ORDERS.filter(w => activeStatuses.includes(w.status)).length;
  const openValue = WORK_ORDERS.filter(w => activeStatuses.includes(w.status)).reduce((s, w) => s + w.nte, 0);
  const emergCount = WORK_ORDERS.filter(w => w.priority === "emergency" && activeStatuses.includes(w.status)).length;
  const pendInv = WORK_ORDERS.filter(w => w.status === "pending_invoice").length;
  const pendAppr = WORK_ORDERS.filter(w => w.status === "pending_approval").length;

  const woData = selectedWO ? WORK_ORDERS.find(w => w.id === selectedWO) : null;

  // ── LOGIN SCREEN ────────────────────────────────────────────
  if (!currentUser) {
    return (
      <div style={{ minHeight: 640, background: "linear-gradient(160deg, #0f172a 0%, #1e293b 40%, #0f172a 100%)", borderRadius: 12, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans', system-ui, sans-serif", position: "relative", opacity: fadeIn ? 1 : 0, transition: "opacity 0.6s" }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />

        {/* Background grid effect */}
        <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(circle at 1px 1px, rgba(148,163,184,0.08) 1px, transparent 0)", backgroundSize: "32px 32px" }} />
        <div style={{ position: "absolute", top: -200, right: -200, width: 500, height: 500, borderRadius: "50%", background: "radial-gradient(circle, rgba(37,99,235,0.12) 0%, transparent 70%)" }} />
        <div style={{ position: "absolute", bottom: -150, left: -150, width: 400, height: 400, borderRadius: "50%", background: "radial-gradient(circle, rgba(14,165,233,0.08) 0%, transparent 70%)" }} />

        <div style={{ position: "relative", zIndex: 1, width: "100%", maxWidth: 420, padding: "0 24px" }}>
          {/* Logo */}
          <div style={{ textAlign: "center", marginBottom: 36 }}>
            <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 56, height: 56, borderRadius: 14, background: "linear-gradient(135deg, #2563eb, #3b82f6)", marginBottom: 16, boxShadow: "0 8px 32px rgba(37,99,235,0.3)" }}>
              <span style={{ fontSize: 22, fontWeight: 800, color: "#fff", fontFamily: "'DM Mono', monospace", letterSpacing: -1 }}>P1</span>
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9", letterSpacing: -0.5 }}>P1 Service Portal</div>
            <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>Operations management for 7-Eleven facility services</div>
          </div>

          {/* Login card */}
          <div style={{ background: "rgba(30,41,59,0.7)", backdropFilter: "blur(20px)", borderRadius: 16, border: "1px solid rgba(148,163,184,0.1)", padding: 28 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#e2e8f0", marginBottom: 16 }}>Sign in to your account</div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, fontWeight: 500, color: "#94a3b8", marginBottom: 6, display: "block", textTransform: "uppercase", letterSpacing: 0.6 }}>Email address</label>
              <input value={loginEmail} onChange={e => setLoginEmail(e.target.value)} placeholder="you@company.com" style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: "1px solid rgba(148,163,184,0.15)", background: "rgba(15,23,42,0.5)", color: "#f1f5f9", fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 11, fontWeight: 500, color: "#94a3b8", marginBottom: 6, display: "block", textTransform: "uppercase", letterSpacing: 0.6 }}>Password</label>
              <input type="password" defaultValue="••••••••" style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: "1px solid rgba(148,163,184,0.15)", background: "rgba(15,23,42,0.5)", color: "#f1f5f9", fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
            </div>

            {loginLoading ? (
              <div style={{ textAlign: "center", padding: "12px 0" }}>
                <div style={{ width: 24, height: 24, border: "3px solid rgba(37,99,235,0.2)", borderTopColor: "#3b82f6", borderRadius: "50%", animation: "spin 0.7s linear infinite", margin: "0 auto" }} />
              </div>
            ) : (
              <button onClick={() => doLogin("clay")} style={{ width: "100%", padding: "11px", borderRadius: 10, background: "linear-gradient(135deg, #2563eb, #3b82f6)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontSize: 13, fontFamily: "inherit", boxShadow: "0 4px 16px rgba(37,99,235,0.3)", transition: "transform 0.15s, box-shadow 0.15s" }} onMouseOver={e => { e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.boxShadow = "0 6px 24px rgba(37,99,235,0.4)"; }} onMouseOut={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "0 4px 16px rgba(37,99,235,0.3)"; }}>
                Sign in as manager
              </button>
            )}
          </div>

          {/* Quick access for demo */}
          <div style={{ marginTop: 24 }}>
            <div style={{ fontSize: 11, fontWeight: 500, color: "#475569", textAlign: "center", marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>Demo — quick access</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {USERS.map(u => (
                <button key={u.id} onClick={() => { setLoginEmail(u.email); doLogin(u.id); }} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 10, border: "1px solid rgba(148,163,184,0.1)", background: "rgba(30,41,59,0.5)", cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s", textAlign: "left" }} onMouseOver={e => { e.currentTarget.style.background = "rgba(30,41,59,0.8)"; e.currentTarget.style.borderColor = "rgba(148,163,184,0.2)"; }} onMouseOut={e => { e.currentTarget.style.background = "rgba(30,41,59,0.5)"; e.currentTarget.style.borderColor = "rgba(148,163,184,0.1)"; }}>
                  <Avatar initials={u.initials} color={u.color} size={32} />
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0" }}>{u.name}</div>
                    <div style={{ fontSize: 10, color: "#64748b" }}>{u.role === "manager" ? "Manager" : u.company}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}} @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.6}}`}</style>
      </div>
    );
  }

  // ── MAIN APP (post-login) ──────────────────────────────────
  const sideItems = isManager
    ? [
        { id: "dashboard", label: "Dashboard", icon: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" },
        { id: "work_orders", label: "Work orders", icon: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", badge: openCount },
        { id: "invoices", label: "Invoices", icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h8", badge: pendAppr > 0 ? pendAppr : null },
        { id: "contractors", label: "Contractors", icon: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" },
      ]
    : [
        { id: "my_jobs", label: "My jobs", icon: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", badge: myWOs.filter(w => activeStatuses.includes(w.status)).length },
        { id: "invoices", label: "Invoices", icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h8" },
      ];

  const renderCard = (wo) => (
    <div key={wo.id} onClick={() => { setSelectedWO(wo.id); if (!isManager) setPage("wo_detail"); else setPage("work_orders"); }} style={{ padding: "12px 14px", borderRadius: 10, border: "1px solid #f1f5f9", marginBottom: 6, cursor: "pointer", transition: "all 0.2s", background: "#fff" }} onMouseOver={e => { e.currentTarget.style.borderColor = "#cbd5e1"; e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.04)"; }} onMouseOut={e => { e.currentTarget.style.borderColor = "#f1f5f9"; e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "none"; }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: "#94a3b8", fontFamily: "'DM Mono', monospace" }}>{wo.id}</span>
        <span style={{ fontSize: 10 }}>{PRIORITY[wo.priority]?.icon}</span>
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#1e293b", marginBottom: 3 }}>Store #{wo.store}</div>
      <div style={{ fontSize: 11, color: "#64748b", lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{wo.issue}</div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, fontSize: 10, color: "#94a3b8" }}>
        <span style={{ fontWeight: 500 }}>{wo.contractor ? getUser(wo.contractor)?.name.split(" ")[0] : "—"}</span>
        <span>{wo.age}</span>
      </div>
    </div>
  );

  const renderKanbanCol = (statusKey) => {
    const c = STATUS[statusKey];
    const cards = filteredWOs.filter(w => w.status === statusKey);
    return (
      <div key={statusKey} style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: `2px solid ${c.color}20`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: c.color, boxShadow: `0 0 8px ${c.color}40` }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: "#334155" }}>{c.label}</span>
          </div>
          <span style={{ fontSize: 11, fontWeight: 700, color: c.color, background: c.bg, borderRadius: 20, padding: "2px 9px", minWidth: 22, textAlign: "center" }}>{cards.length}</span>
        </div>
        <div style={{ padding: 8, minHeight: 60 }}>
          {cards.map(renderCard)}
          {cards.length === 0 && <div style={{ textAlign: "center", padding: "20px 0", fontSize: 11, color: "#cbd5e1" }}>No items</div>}
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", minHeight: 660, fontFamily: "'DM Sans', system-ui, sans-serif", fontSize: 13, color: "#1e293b", background: "#f8fafc", borderRadius: 12, overflow: "hidden", border: "1px solid #e2e8f0", position: "relative" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />

      {/* ── Sidebar ── */}
      <div style={{ width: 230, background: "#0f172a", color: "#94a3b8", display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <div style={{ padding: "20px 18px 18px", borderBottom: "1px solid rgba(148,163,184,0.08)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg, #2563eb, #3b82f6)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 14, color: "#fff", fontFamily: "'DM Mono', monospace", letterSpacing: -0.5, boxShadow: "0 4px 12px rgba(37,99,235,0.25)" }}>P1</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#f1f5f9", letterSpacing: -0.3 }}>P1 Service</div>
              <div style={{ fontSize: 10, color: "#475569", letterSpacing: 0.5, textTransform: "uppercase" }}>{isManager ? "Operations" : "Contractor"}</div>
            </div>
          </div>
        </div>

        <div style={{ padding: "14px 12px", flex: 1 }}>
          {sideItems.map(item => (
            <button key={item.id} onClick={() => { setPage(item.id); setSelectedWO(null); }} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 12px", borderRadius: 10, border: "none", background: page === item.id || (item.id === "work_orders" && page === "work_orders") ? "rgba(37,99,235,0.12)" : "transparent", color: page === item.id ? "#e2e8f0" : "#64748b", cursor: "pointer", fontSize: 13, fontWeight: page === item.id ? 600 : 400, fontFamily: "inherit", marginBottom: 2, transition: "all 0.15s" }}>
              <Ico d={item.icon} size={16} color={page === item.id ? "#60a5fa" : "#64748b"} />
              {item.label}
              {item.badge && <span style={{ marginLeft: "auto", fontSize: 10, background: item.id === "work_orders" ? "#ef4444" : "#f59e0b", color: "#fff", borderRadius: 10, padding: "2px 8px", fontWeight: 700 }}>{item.badge}</span>}
            </button>
          ))}
        </div>

        <div style={{ padding: "16px", borderTop: "1px solid rgba(148,163,184,0.08)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <Avatar initials={currentUser.initials} color={currentUser.color} size={32} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: "#e2e8f0", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentUser.name}</div>
              <div style={{ fontSize: 10, color: "#475569" }}>{isManager ? "Manager" : currentUser.company}</div>
            </div>
          </div>
          <button onClick={logout} style={{ width: "100%", padding: "7px", borderRadius: 8, border: "1px solid rgba(148,163,184,0.1)", background: "transparent", color: "#64748b", fontSize: 11, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s" }} onMouseOver={e => { e.currentTarget.style.background = "rgba(239,68,68,0.08)"; e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.borderColor = "rgba(239,68,68,0.2)"; }} onMouseOut={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#64748b"; e.currentTarget.style.borderColor = "rgba(148,163,184,0.1)"; }}>
              Sign out
          </button>
        </div>
      </div>

      {/* ── Main ── */}
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {/* Top bar */}
        <div style={{ padding: "14px 24px", borderBottom: "1px solid #e2e8f0", background: "#fff", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a", letterSpacing: -0.4 }}>
              {page === "dashboard" && "Dashboard"}
              {page === "work_orders" && (selectedWO ? `Work order ${woData?.id || ""}` : "Work orders")}
              {page === "invoices" && "Invoices"}
              {page === "contractors" && "Contractors"}
              {page === "my_jobs" && "My jobs"}
              {page === "wo_detail" && `${woData?.id || "Work order"}`}
            </div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
              {isManager ? "Wednesday, April 8, 2026" : `${currentUser.company} · ${currentUser.territory}`}
            </div>
          </div>
          {isManager && (
            <button onClick={() => setShowNewWO(true)} style={{ padding: "9px 20px", borderRadius: 10, background: "linear-gradient(135deg, #2563eb, #3b82f6)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontSize: 12, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6, boxShadow: "0 2px 8px rgba(37,99,235,0.25)", transition: "all 0.15s" }} onMouseOver={e => { e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.boxShadow = "0 4px 16px rgba(37,99,235,0.35)"; }} onMouseOut={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "0 2px 8px rgba(37,99,235,0.25)"; }}>
              <span style={{ fontSize: 18, lineHeight: 1, fontWeight: 400 }}>+</span> New work order
            </button>
          )}
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: 24 }}>
          {/* ════ DASHBOARD ════ */}
          {page === "dashboard" && isManager && (
            <div style={{ animation: "fadeUp 0.35s" }}>
              {emergCount > 0 && (
                <div style={{ background: "linear-gradient(135deg, #fef2f2, #fff1f2)", border: "1px solid #fecaca", borderRadius: 12, padding: "14px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: "#fee2e2", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>🚨</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, color: "#dc2626", fontSize: 13 }}>{emergCount} emergency call{emergCount > 1 ? "s" : ""} need immediate dispatch</div>
                    <div style={{ fontSize: 11, color: "#991b1b", marginTop: 2 }}>Open emergency work orders waiting for contractor assignment</div>
                  </div>
                  <button onClick={() => { setPage("work_orders"); setFilterP("emergency"); }} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #fecaca", background: "#fff", color: "#dc2626", fontWeight: 600, fontSize: 11, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>View emergencies →</button>
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 28 }}>
                {[
                  { label: "Open service calls", value: openCount, color: "#3b82f6", sub: `${emergCount} emergency`, gradient: "linear-gradient(135deg, #eff6ff, #f0f9ff)" },
                  { label: "Revenue at risk", value: fmt(openValue), color: "#ef4444", sub: "Active pipeline value", gradient: "linear-gradient(135deg, #fef2f2, #fff1f2)" },
                  { label: "Pending invoices", value: pendInv, color: "#ec4899", sub: "Awaiting submission", gradient: "linear-gradient(135deg, #fdf2f8, #fff1f3)" },
                  { label: "Awaiting approval", value: pendAppr, color: "#f59e0b", sub: fmt(INVOICES.filter(i => i.state === "submitted").reduce((s, i) => s + i.total, 0)), gradient: "linear-gradient(135deg, #fffbeb, #fef9c3)" },
                ].map((s, i) => (
                  <div key={i} style={{ background: s.gradient, borderRadius: 14, padding: "20px 22px", border: "1px solid #e2e8f0", animation: `fadeUp 0.4s ${i * 0.06}s both` }}>
                    <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>{s.label}</div>
                    <div style={{ fontSize: 30, fontWeight: 800, color: s.color, letterSpacing: -1.5, fontFamily: "'DM Mono', monospace", lineHeight: 1 }}>{s.value}</div>
                    <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6, fontWeight: 500 }}>{s.sub}</div>
                  </div>
                ))}
              </div>

              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.2, color: "#94a3b8", marginBottom: 10 }}>Active pipeline</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, marginBottom: 28 }}>
                {activeStatuses.map(renderKanbanCol)}
              </div>

              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.2, color: "#94a3b8", marginBottom: 10 }}>Closing pipeline</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                {closingStatuses.map(renderKanbanCol)}
              </div>
            </div>
          )}

          {/* ════ WORK ORDERS TABLE ════ */}
          {page === "work_orders" && !selectedWO && (
            <div style={{ animation: "fadeUp 0.3s" }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search WOT #, store, or keyword..." style={{ padding: "9px 14px", borderRadius: 10, border: "1px solid #e2e8f0", fontSize: 12, width: 260, fontFamily: "inherit", background: "#fff" }} />
                <select value={filterC} onChange={e => setFilterC(e.target.value)} style={{ padding: "9px 14px", borderRadius: 10, border: "1px solid #e2e8f0", fontSize: 12, fontFamily: "inherit", background: "#fff" }}>
                  <option value="all">All contractors</option>
                  {USERS.filter(u => u.role === "contractor").map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
                <select value={filterP} onChange={e => setFilterP(e.target.value)} style={{ padding: "9px 14px", borderRadius: 10, border: "1px solid #e2e8f0", fontSize: 12, fontFamily: "inherit", background: "#fff" }}>
                  <option value="all">All priorities</option>
                  <option value="emergency">Emergency</option>
                  <option value="critical">Critical</option>
                  <option value="routine">Routine</option>
                </select>
                {(filterC !== "all" || filterP !== "all" || search) && (
                  <button onClick={() => { setFilterC("all"); setFilterP("all"); setSearch(""); }} style={{ fontSize: 11, color: "#64748b", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>Clear</button>
                )}
              </div>
              <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e2e8f0", overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead><tr style={{ background: "#f8fafc" }}>
                    {["WOT #", "Store", "Issue", "Priority", "Status", "Contractor", "NTE", "Age"].map(h => (
                      <th key={h} style={{ textAlign: h === "NTE" ? "right" : "left", padding: "11px 14px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: "#94a3b8", borderBottom: "1px solid #e2e8f0" }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {filteredWOs.map((wo, i) => (
                      <tr key={wo.id} onClick={() => setSelectedWO(wo.id)} style={{ cursor: "pointer", borderBottom: "1px solid #f1f5f9", animation: `fadeUp 0.3s ${i * 0.02}s both` }} onMouseOver={e => e.currentTarget.style.background = "#f8fafc"} onMouseOut={e => e.currentTarget.style.background = "transparent"}>
                        <td style={{ padding: "11px 14px", fontFamily: "'DM Mono', monospace", fontWeight: 600, fontSize: 11, color: "#2563eb" }}>{wo.id}</td>
                        <td style={{ padding: "11px 14px", fontWeight: 600 }}>#{wo.store}</td>
                        <td style={{ padding: "11px 14px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#475569" }}>{wo.issue}</td>
                        <td style={{ padding: "11px 14px" }}><Badge conf={PRIORITY[wo.priority]} /></td>
                        <td style={{ padding: "11px 14px" }}><Badge conf={STATUS[wo.status]} /></td>
                        <td style={{ padding: "11px 14px", color: "#64748b" }}>{wo.contractor ? getUser(wo.contractor)?.name : "—"}</td>
                        <td style={{ padding: "11px 14px", textAlign: "right", fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>{fmt(wo.nte)}</td>
                        <td style={{ padding: "11px 14px", color: "#94a3b8" }}>{wo.age}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ════ WORK ORDER DETAIL ════ */}
          {(page === "work_orders" || page === "wo_detail") && selectedWO && woData && (
            <div style={{ animation: "fadeUp 0.25s" }}>
              <button onClick={() => { setSelectedWO(null); if (!isManager) setPage("my_jobs"); }} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#64748b", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", marginBottom: 16, padding: 0 }}>
                <Ico d="M15 18l-6-6 6-6" size={14} /> Back
              </button>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 20 }}>
                <div>
                  <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e2e8f0", padding: 24, marginBottom: 16 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
                      <div>
                        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, fontWeight: 600, color: "#94a3b8", marginBottom: 4 }}>{woData.id}</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a", letterSpacing: -0.4 }}>Store #{woData.store} · {woData.city}</div>
                        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>{woData.addr}</div>
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <Badge conf={STATUS[woData.status]} />
                        <Badge conf={PRIORITY[woData.priority]} />
                      </div>
                    </div>
                    <div style={{ fontSize: 14, color: "#475569", lineHeight: 1.65, marginBottom: 20, padding: "12px 16px", background: "#f8fafc", borderRadius: 10, border: "1px solid #f1f5f9" }}>{woData.issue}</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18 }}>
                      {[
                        { l: "Category", v: woData.category },
                        { l: "NTE limit", v: fmt(woData.nte) },
                        { l: "NTE approval", v: "Not requested" },
                        { l: "Assigned to", v: woData.contractor ? getUser(woData.contractor)?.name : "Unassigned" },
                        { l: "AFM contact", v: woData.afm },
                        { l: "AFM phone", v: woData.afmPhone },
                      ].map((d, i) => (
                        <div key={i}>
                          <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6, color: "#94a3b8", marginBottom: 3 }}>{d.l}</div>
                          <div style={{ fontSize: 13, fontWeight: 500, color: "#1e293b" }}>{d.v}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
                    {woData.status === "unassigned" && isManager && (
                      <button onClick={() => fire("Dispatch dialog would open")} style={{ padding: "9px 18px", borderRadius: 10, background: "linear-gradient(135deg, #2563eb, #3b82f6)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontSize: 12, fontFamily: "inherit", boxShadow: "0 2px 8px rgba(37,99,235,0.2)" }}>Assign contractor</button>
                    )}
                    {woData.status === "assigned" && !isManager && (
                      <button onClick={() => fire("Work started — timestamp recorded")} style={{ padding: "9px 18px", borderRadius: 10, background: "linear-gradient(135deg, #8b5cf6, #a78bfa)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontSize: 12, fontFamily: "inherit", boxShadow: "0 2px 8px rgba(139,92,246,0.2)" }}>Start work</button>
                    )}
                    {woData.status === "wip" && (
                      <>
                        <button onClick={() => fire("Pause work — select Temporary Fix or Awaiting Parts")} style={{ padding: "9px 18px", borderRadius: 10, background: "#fffbeb", color: "#d97706", border: "1px solid #fde68a", cursor: "pointer", fontWeight: 600, fontSize: 12, fontFamily: "inherit" }}>Pause work</button>
                        <button onClick={() => fire("Opening questionnaire for closure")} style={{ padding: "9px 18px", borderRadius: 10, background: "#f0fdf4", color: "#16a34a", border: "1px solid #bbf7d0", cursor: "pointer", fontWeight: 600, fontSize: 12, fontFamily: "inherit" }}>Close complete</button>
                      </>
                    )}
                    {woData.status === "completed" && !isManager && (
                      <button onClick={() => fire("Invoice submission form would open")} style={{ padding: "9px 18px", borderRadius: 10, background: "linear-gradient(135deg, #ec4899, #f472b6)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontSize: 12, fontFamily: "inherit" }}>Submit invoice</button>
                    )}
                    <button onClick={() => fire("NTE increase request submitted")} style={{ padding: "9px 18px", borderRadius: 10, background: "#fff", color: "#475569", border: "1px solid #e2e8f0", cursor: "pointer", fontWeight: 600, fontSize: 12, fontFamily: "inherit" }}>Exceed NTE</button>
                  </div>

                  <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e2e8f0", padding: 20 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#0f172a", marginBottom: 14 }}>Activity</div>
                    <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
                      <input placeholder="Add a note..." style={{ flex: 1, padding: "9px 14px", borderRadius: 10, border: "1px solid #e2e8f0", fontSize: 12, fontFamily: "inherit" }} />
                      <button onClick={() => fire("Note posted")} style={{ padding: "9px 16px", borderRadius: 10, background: "#0f172a", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontSize: 12, fontFamily: "inherit" }}>Post</button>
                    </div>
                    {[
                      { author: woData.contractor ? getUser(woData.contractor)?.name : "System", time: "Apr 7, 9:15 AM", text: "Arrived on site. Starting diagnostic — checking refrigerant levels and compressor.", type: "note" },
                      { author: "System", time: "Apr 6, 2:30 PM", text: `Work order assigned to ${woData.contractor ? getUser(woData.contractor)?.name : "contractor"}.`, type: "system" },
                      { author: woData.afm, time: "Apr 6, 2:15 PM", text: "AFM approved assignment. Priority confirmed.", type: "note" },
                      { author: "System", time: "Apr 6, 10:00 AM", text: `Service call created. NTE set at ${fmt(woData.nte)}.`, type: "system" },
                    ].map((e, i) => (
                      <div key={i} style={{ display: "flex", gap: 12, marginBottom: 16, animation: `fadeUp 0.3s ${i * 0.05}s both` }}>
                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: e.type === "system" ? "#e2e8f0" : "#3b82f6", marginTop: 5, flexShrink: 0, boxShadow: e.type !== "system" ? "0 0 6px rgba(59,130,246,0.3)" : "none" }} />
                        <div>
                          <div style={{ fontSize: 12 }}>
                            <span style={{ fontWeight: 600, color: "#1e293b" }}>{e.author}</span>
                            <span style={{ color: "#94a3b8", marginLeft: 8, fontSize: 10 }}>{e.time}</span>
                          </div>
                          <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.5, marginTop: 2 }}>{e.text}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Right sidebar */}
                <div>
                  {woData.contractor && (
                    <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e2e8f0", padding: 18, marginBottom: 14 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: "#94a3b8", marginBottom: 10 }}>Contractor</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <Avatar initials={getUser(woData.contractor)?.initials} color={getUser(woData.contractor)?.color} size={38} />
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700 }}>{getUser(woData.contractor)?.name}</div>
                          <div style={{ fontSize: 11, color: "#64748b" }}>{getUser(woData.contractor)?.company}</div>
                        </div>
                      </div>
                    </div>
                  )}

                  <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e2e8f0", padding: 18, marginBottom: 14 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: "#94a3b8", marginBottom: 12 }}>Progress</div>
                    {[
                      { label: "Created", done: true },
                      { label: "Assigned", done: ["assigned","wip","parts","completed","pending_invoice","pending_approval"].includes(woData.status) },
                      { label: "Work started", done: ["wip","parts","completed","pending_invoice","pending_approval"].includes(woData.status) },
                      { label: "Completed", done: ["completed","pending_invoice","pending_approval"].includes(woData.status) },
                      { label: "Invoiced", done: ["pending_approval"].includes(woData.status) },
                    ].map((step, i, arr) => (
                      <div key={i} style={{ display: "flex", gap: 12, marginBottom: i < arr.length - 1 ? 0 : 0, position: "relative" }}>
                        {i < arr.length - 1 && <div style={{ position: "absolute", left: 9, top: 20, width: 2, height: 20, background: step.done && arr[i+1]?.done ? "#22c55e" : "#e2e8f0" }} />}
                        <div style={{ width: 20, height: 20, borderRadius: "50%", border: step.done ? "none" : "2px solid #e2e8f0", background: step.done ? "#22c55e" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: step.done ? "0 2px 6px rgba(34,197,94,0.25)" : "none" }}>
                          {step.done && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3"><path d="M20 6L9 17l-5-5"/></svg>}
                        </div>
                        <div style={{ paddingBottom: 16 }}>
                          <div style={{ fontSize: 12, fontWeight: step.done ? 600 : 400, color: step.done ? "#1e293b" : "#94a3b8" }}>{step.label}</div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {woData.partNeeded && (
                    <div style={{ background: "linear-gradient(135deg, #fffbeb, #fef9c3)", borderRadius: 14, border: "1px solid #fde68a", padding: 18 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: "#92400e", marginBottom: 6 }}>Part on order</div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#78350f" }}>{woData.partNeeded}</div>
                      <div style={{ fontSize: 11, color: "#a16207", marginTop: 4 }}>ETA: {woData.partEta}</div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ════ CONTRACTOR MY JOBS ════ */}
          {page === "my_jobs" && !isManager && (
            <div style={{ animation: "fadeUp 0.3s" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 24 }}>
                {[
                  { label: "Active jobs", value: myWOs.filter(w => activeStatuses.includes(w.status)).length, color: "#3b82f6", bg: "linear-gradient(135deg, #eff6ff, #f0f9ff)" },
                  { label: "Pending invoices", value: myWOs.filter(w => w.status === "pending_invoice").length, color: "#ec4899", bg: "linear-gradient(135deg, #fdf2f8, #fff1f3)" },
                  { label: "Completed", value: myWOs.filter(w => ["completed","pending_invoice","pending_approval"].includes(w.status)).length, color: "#22c55e", bg: "linear-gradient(135deg, #f0fdf4, #ecfdf5)" },
                ].map((s, i) => (
                  <div key={i} style={{ background: s.bg, borderRadius: 14, padding: "18px 22px", border: "1px solid #e2e8f0" }}>
                    <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>{s.label}</div>
                    <div style={{ fontSize: 28, fontWeight: 800, color: s.color, fontFamily: "'DM Mono', monospace", letterSpacing: -1.5 }}>{s.value}</div>
                  </div>
                ))}
              </div>

              {myWOs.map((wo, i) => (
                <div key={wo.id} onClick={() => { setSelectedWO(wo.id); setPage("wo_detail"); }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", marginBottom: 8, cursor: "pointer", transition: "all 0.2s", animation: `fadeUp 0.3s ${i * 0.04}s both` }} onMouseOver={e => { e.currentTarget.style.borderColor = "#cbd5e1"; e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.04)"; }} onMouseOut={e => { e.currentTarget.style.borderColor = "#e2e8f0"; e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "none"; }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", fontWeight: 600, color: "#3b82f6" }}>{wo.id}</span>
                      <Badge conf={PRIORITY[wo.priority]} />
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#0f172a", marginBottom: 2 }}>Store #{wo.store} · {wo.city}</div>
                    <div style={{ fontSize: 12, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{wo.issue}</div>
                  </div>
                  <div style={{ textAlign: "right", marginLeft: 20, flexShrink: 0 }}>
                    <Badge conf={STATUS[wo.status]} />
                    <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 4 }}>{wo.age}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ════ INVOICES ════ */}
          {page === "invoices" && (
            <div style={{ animation: "fadeUp 0.3s" }}>
              <div style={{ display: "flex", gap: 0, marginBottom: 16, borderBottom: "2px solid #e2e8f0" }}>
                {[{ id: "all", l: "All" }, { id: "submitted", l: "Submitted" }, { id: "rejected", l: "Rejected" }, { id: "approved", l: "Approved" }].map(t => (
                  <button key={t.id} onClick={() => setInvTab(t.id)} style={{ padding: "10px 20px", fontSize: 12, fontWeight: invTab === t.id ? 700 : 400, color: invTab === t.id ? "#0f172a" : "#94a3b8", background: "none", border: "none", borderBottom: invTab === t.id ? "2px solid #0f172a" : "2px solid transparent", cursor: "pointer", fontFamily: "inherit", marginBottom: -2 }}>{t.l}</button>
                ))}
              </div>
              <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e2e8f0", overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead><tr style={{ background: "#f8fafc" }}>
                    {["Invoice #", "Work order", "Contractor", "State", "Date", "Store", "Total"].map(h => (
                      <th key={h} style={{ textAlign: h === "Total" ? "right" : "left", padding: "11px 14px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: "#94a3b8", borderBottom: "1px solid #e2e8f0" }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {(isManager ? INVOICES : INVOICES.filter(i => i.contractor === currentUser.id)).filter(i => invTab === "all" || i.state === invTab).map((inv, i) => (
                      <tr key={inv.num} style={{ borderBottom: "1px solid #f1f5f9", animation: `fadeUp 0.3s ${i * 0.03}s both` }} onMouseOver={e => e.currentTarget.style.background = "#f8fafc"} onMouseOut={e => e.currentTarget.style.background = "transparent"}>
                        <td style={{ padding: "12px 14px", fontFamily: "'DM Mono', monospace", fontWeight: 600, fontSize: 11, color: "#3b82f6" }}>{inv.num}</td>
                        <td style={{ padding: "12px 14px", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#64748b" }}>{inv.wot}</td>
                        <td style={{ padding: "12px 14px", color: "#475569" }}>{getUser(inv.contractor)?.name}</td>
                        <td style={{ padding: "12px 14px" }}><Badge conf={INV_STATE[inv.state]} /></td>
                        <td style={{ padding: "12px 14px", color: "#94a3b8" }}>{inv.date}</td>
                        <td style={{ padding: "12px 14px" }}>#{inv.store}</td>
                        <td style={{ padding: "12px 14px", textAlign: "right", fontFamily: "'DM Mono', monospace", fontWeight: 700 }}>{fmt(inv.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ════ CONTRACTORS ════ */}
          {page === "contractors" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, animation: "fadeUp 0.3s" }}>
              {USERS.filter(u => u.role === "contractor").map((c, i) => {
                const cWOs = WORK_ORDERS.filter(w => w.contractor === c.id);
                const activeCount = cWOs.filter(w => activeStatuses.includes(w.status)).length;
                const completedCount = cWOs.filter(w => ["completed","pending_invoice","pending_approval"].includes(w.status)).length;
                return (
                  <div key={c.id} style={{ background: "#fff", borderRadius: 14, border: "1px solid #e2e8f0", overflow: "hidden", animation: `fadeUp 0.35s ${i * 0.08}s both` }}>
                    <div style={{ padding: "22px 22px 16px", borderBottom: "1px solid #f1f5f9" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <Avatar initials={c.initials} color={c.color} size={46} />
                        <div>
                          <div style={{ fontSize: 16, fontWeight: 700, color: "#0f172a" }}>{c.name}</div>
                          <div style={{ fontSize: 12, color: "#64748b" }}>{c.company}</div>
                        </div>
                      </div>
                    </div>
                    <div style={{ padding: "16px 22px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: "#94a3b8", marginBottom: 3 }}>Territory</div>
                        <div style={{ fontSize: 12, fontWeight: 500 }}>{c.territory}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: "#94a3b8", marginBottom: 3 }}>Active jobs</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#3b82f6" }}>{activeCount}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: "#94a3b8", marginBottom: 3 }}>Completed</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#22c55e" }}>{completedCount}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: "#94a3b8", marginBottom: 3 }}>Status</div>
                        <Badge conf={{ label: "Active", color: "#22c55e", bg: "#f0fdf4", ring: "#bbf7d0" }} />
                      </div>
                    </div>
                    <div style={{ padding: "0 22px 18px" }}>
                      <button onClick={() => { setPage("work_orders"); setFilterC(c.id); }} style={{ width: "100%", padding: "9px", borderRadius: 10, border: "1px solid #e2e8f0", background: "#f8fafc", color: "#475569", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s" }} onMouseOver={e => { e.currentTarget.style.background = "#0f172a"; e.currentTarget.style.color = "#fff"; e.currentTarget.style.borderColor = "#0f172a"; }} onMouseOut={e => { e.currentTarget.style.background = "#f8fafc"; e.currentTarget.style.color = "#475569"; e.currentTarget.style.borderColor = "#e2e8f0"; }}>View work orders →</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── New WO Modal ── */}
      {showNewWO && (
        <div onClick={e => { if (e.target === e.currentTarget) setShowNewWO(false); }} style={{ position: "absolute", inset: 0, background: "rgba(15,23,42,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20, borderRadius: 12, backdropFilter: "blur(4px)" }}>
          <div style={{ background: "#fff", borderRadius: 18, width: "90%", maxWidth: 480, padding: 28, animation: "fadeUp 0.25s", boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a", marginBottom: 20 }}>New work order</div>
            <div style={{ display: "grid", gap: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {[["Store number", "e.g. 36190", "text"], ["Priority", "", "select"]].map(([l, p, t]) => (
                  <div key={l}>
                    <label style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: "#94a3b8", marginBottom: 5, display: "block" }}>{l}</label>
                    {t === "text" ? <input placeholder={p} style={{ width: "100%", padding: "9px 12px", borderRadius: 10, border: "1px solid #e2e8f0", fontSize: 12, fontFamily: "inherit", boxSizing: "border-box" }} /> : <select style={{ width: "100%", padding: "9px 12px", borderRadius: 10, border: "1px solid #e2e8f0", fontSize: 12, fontFamily: "inherit", background: "#fff", boxSizing: "border-box" }}><option>Routine</option><option>Critical</option><option>Emergency</option></select>}
                  </div>
                ))}
              </div>
              <div>
                <label style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: "#94a3b8", marginBottom: 5, display: "block" }}>Description</label>
                <textarea rows={3} placeholder="Describe the repair needed..." style={{ width: "100%", padding: "9px 12px", borderRadius: 10, border: "1px solid #e2e8f0", fontSize: 12, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: "#94a3b8", marginBottom: 5, display: "block" }}>NTE amount</label>
                  <input placeholder="$0.00" style={{ width: "100%", padding: "9px 12px", borderRadius: 10, border: "1px solid #e2e8f0", fontSize: 12, fontFamily: "inherit", boxSizing: "border-box" }} />
                </div>
                <div>
                  <label style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: "#94a3b8", marginBottom: 5, display: "block" }}>Assign to</label>
                  <select style={{ width: "100%", padding: "9px 12px", borderRadius: 10, border: "1px solid #e2e8f0", fontSize: 12, fontFamily: "inherit", background: "#fff", boxSizing: "border-box" }}><option>Unassigned</option>{USERS.filter(u => u.role === "contractor").map(u => <option key={u.id}>{u.name}</option>)}</select>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 22, justifyContent: "flex-end" }}>
              <button onClick={() => setShowNewWO(false)} style={{ padding: "10px 20px", borderRadius: 10, background: "#fff", color: "#64748b", border: "1px solid #e2e8f0", cursor: "pointer", fontWeight: 500, fontSize: 12, fontFamily: "inherit" }}>Cancel</button>
              <button onClick={() => { setShowNewWO(false); fire("Work order created successfully"); }} style={{ padding: "10px 24px", borderRadius: 10, background: "linear-gradient(135deg, #2563eb, #3b82f6)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 700, fontSize: 12, fontFamily: "inherit", boxShadow: "0 2px 8px rgba(37,99,235,0.25)" }}>Create work order</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast ── */}
      {toast && (
        <div style={{ position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)", background: "#0f172a", color: "#f1f5f9", padding: "11px 24px", borderRadius: 12, fontSize: 13, fontWeight: 600, animation: "fadeUp 0.25s", zIndex: 30, boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }}>
          {toast}
        </div>
      )}

      <style>{`@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}} @keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
