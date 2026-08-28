"use client";
// @ts-nocheck
import { useState, useEffect, useCallback, useMemo, useRef, type ChangeEvent } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import { useQueryClient } from "@tanstack/react-query";
import {
  insertActivity, insertWorkOrder, findExistingWoId, markWorkOrderNotesSeen,
  subscribeToChanges,
} from "../lib/db";
import { supabase } from "../lib/supabase/client";
import { computeSlaState, computeSlaBreaches } from "../lib/slaConfig";
import { Modal } from "./ui/Modal";
import { Input } from "./ui/Input";
import { DatePickerField, TimePickerField } from "./ui/DateTimePicker";
import { Sel } from "./ui/Sel";
import { TA } from "./ui/TA";
import { Avatar } from "./ui/Avatar";
import { Field } from "./ui/Field";
import { Ico } from "./ui/Ico";
import { BtnSpinner, BtnSpinnerDark } from "./ui/BtnSpinner";
import { CopyWorkOrderButton } from "./ui/CopyWorkOrderButton";
import ClientDiagnostics from "./ClientDiagnostics";
import { reportClientFailure } from "../lib/clientDiagnostics";
import LoginForm from "../features/auth/LoginForm";
import useAuth from "../features/auth/useAuth";
import useWorkOrders from "../features/work-orders/useWorkOrders";
import KanbanBoard from "../features/work-orders/KanbanBoard";
import WorkOrderList from "../features/work-orders/WorkOrderList";
import WorkOrderDetail from "../features/work-orders/WorkOrderDetail";
import HistoryView from "../features/work-orders/HistoryView";
import MyJobs from "../features/work-orders/MyJobs";
import CapitalProjects from "../features/work-orders/CapitalProjects";
import {
  WORK_ORDER_DETAILS_KEY,
  WORK_ORDER_BY_ID_KEY,
  WORK_ORDER_PAGES_KEY,
  WORK_ORDERS_KEY,
  WO_PARTS_KEY,
  CONTRACTOR_WORKLOAD_SUMMARY_KEY,
  PORTAL_NAVIGATION_SUMMARY_KEY,
  useWorkOrderByIdQuery,
  useWorkOrderDetailsQuery,
  usePortalNavigationSummaryQuery,
  useProfilesQuery,
  useTechniciansQuery,
  workOrderDetailsKey,
} from "../features/work-orders/queries";
import InvoiceList from "../features/invoices/InvoiceList";
import InvoiceDetail from "../features/invoices/InvoiceDetail";
import useInvoices from "../features/invoices/useInvoices";
import {
  INVOICE_BY_ID_KEY,
  INVOICE_PAGES_KEY,
  INVOICES_KEY,
  useInvoiceByIdQuery,
} from "../features/invoices/queries";
import { CONTRACTOR_ESTIMATES_KEY } from "../features/estimates/queries";
import ContractorList from "../features/contractors/ContractorList";
import SubDispatchView from "../features/contractors/SubDispatchView";
import StaffWorkHub from "../features/staff-work/StaffWorkHub";
import {
  STAFF_NOTIFICATION_READS_KEY,
  STAFF_WORK_TODOS_KEY,
  addStaffWorkTodo,
  completeStaffWorkTodo,
  markStaffWorkOrderRead,
  transferStaffWorkTodo,
} from "../features/staff-work/queries";
import {
  buildStaffWorkRows,
  latestContractorActivityAt,
  type StaffWorkFilter,
  type StaffWorkRow,
} from "../features/staff-work/workQueue";
import Dashboard from "../features/dashboard/Dashboard";
import AddressBookModal from "../features/contacts/AddressBookModal";
import FloatingProfitCalculator from "../features/billing/FloatingProfitCalculator";
import {
  BILLING_INVOICE_BY_ID_KEY,
  BILLING_INVOICE_PAGES_KEY,
  BILLING_INVOICES_KEY,
  useBillingInvoiceByIdQuery,
} from "../features/billing/queries";
import {
  T, DEMO_ACCOUNTS, PRIORITY, MONTHS, WEEKDAYS,
} from "../lib/constants";
import {
  dateTimeInputPartsInTimeZone,
  storeLocalDateTimeToIso,
  timezoneForWorkOrder,
} from "../lib/billingRules";
import {
  PORTAL_HISTORY_KEY,
  portalUrlForView,
  portalViewFromHistoryState,
  portalViewKey,
  writePortalHistoryStateSafely,
  type PortalViewState,
} from "../lib/portalNavigation";
import { assertStaffInvoiceIntegrity } from "../lib/staffInvoiceIntegrity";
import { isInvoiceController } from "../lib/staffPermissions";
import {
  PORTAL_AUTO_REFRESH_MS,
  shouldRefreshPortal,
} from "../lib/portalRefresh";
import {
  WORK_ORDER_REOPEN_REASON_MAX_LENGTH,
  normalizeWorkOrderReopenReason,
  validateWorkOrderReopenReason,
  workOrderReopenOptions,
  type ReopenableWorkOrder,
  type WorkOrderReopenMode,
} from "../lib/workOrderReopen";
import {
  REALTIME_INVALIDATION_BATCH_MS,
  datasetsForRealtimeTables,
  type PortalRealtimeTable,
  workOrderIdFromRealtimeChange,
} from "../lib/realtimeInvalidation";
import { billingApiFetch as billingFetch } from "../lib/billingApi";

const InvoiceCreateModal = dynamic(
  () => import("../features/invoices/InvoiceCreateModal"),
  { ssr: false }
);

const BillingInvoiceList = dynamic(
  () => import("../features/billing/BillingInvoiceList"),
  { ssr: false }
);

const BillingInvoiceCreateModal = dynamic(
  () => import("../features/billing/BillingInvoiceCreateModal"),
  { ssr: false }
);

const BillingInvoiceDetail = dynamic(
  () => import("../features/billing/BillingInvoiceDetail"),
  { ssr: false }
);

const StaffContractorPreview = dynamic(
  () => import("../features/contractor-preview/StaffContractorPreview"),
  { ssr: false }
);

const WorkOrderCreateForm = dynamic(
  () => import("../features/work-orders/WorkOrderCreateForm"),
  { ssr: false }
);

const ManageAccountModal = dynamic(
  () => import("../features/auth/ManageAccountModal"),
  { ssr: false }
);

async function notificationFetch(path: string, body: Record<string, unknown>) {
  const sb = supabase();
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return;

  const res = await fetch(path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    console.error("Notification request failed", payload.error || res.statusText);
  }
}

type ReopenTarget = ReopenableWorkOrder & {
  id: string;
  status: string;
};

// ===============================================================
//  THEME - Claude-inspired warm palette. Tokens are the source of truth.
// ===============================================================
// ===============================================================
//  REAL P1 TEAM + CONTRACTORS (from Jeremy's email, Apr 20 2026)
// ===============================================================
// Demo quick-access buttons on the login screen (clicks pre-fill email + sign in).
// Real user/profile data loads from Supabase after successful auth.
// ===============================================================
//  7-ELEVEN PRIORITY ENUM (real format: P1 Critical, P2 Emergency, etc)
// ===============================================================
// Internal pipeline state (our kanban)

// 7-Eleven's Functional Status field (what Gustavo's SLA breach hinged on)
// ===============================================================
//  TRADE / TERRITORY ROUTING
// ===============================================================
// Map 7-Eleven's Line of Service / Category -> our internal trade tags
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

// City -> (state normalized) for territory matching
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

// ===============================================================
//  DATE + SLA HELPERS
// ===============================================================
const timeNow = () => { const d = new Date(), h = d.getHours(), m = d.getMinutes(), ap = h >= 12 ? "PM" : "AM"; return `${h > 12 ? h - 12 : h || 12}:${m < 10 ? "0" + m : m} ${ap}`; };
const dateShort = (d = new Date()) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
const dateNow = () => `${dateShort()}, ${timeNow()}`;
const dateLong = (d = new Date()) => `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
const hoursBetween = (aIso: string, bIso: string) => (new Date(bIso).getTime() - new Date(aIso).getTime()) / 3600000;
const slaRemaining = (wo: any) => {
  if (!wo.dispatchedAt || !PRIORITY[wo.priority]) return null;
  const slaH = PRIORITY[wo.priority].slaHours;
  if (!slaH || slaH <= 0) return null;
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

const isOpenState = (state: string) => !["completed", "pending_invoice", "pending_approval", "pending_capital_completion", "closed", "capital"].includes(state);
const activeStatuses = ["unassigned", "assigned", "wip", "parts"];
const closingStatuses = ["completed", "pending_invoice", "pending_approval", "pending_capital_completion", "closed"];

// A closed WO lingers on the active board for 24h after closed_at,
// then lives only in History. A closed WO with no closed_at is treated as
// already archived (History only) so the board never lingers on undated rows.
const CLOSED_LINGER_MS = 24 * 60 * 60 * 1000;
const isArchivedClosed = (w: any) =>
  w.status === "closed" && (!w.closedAt || (Date.now() - new Date(w.closedAt).getTime()) > CLOSED_LINGER_MS);

// ===============================================================
//  SEED WORK ORDERS - real 7-Eleven field shapes
// ===============================================================
// Helper: hours ago -> ISO
const hoursAgo = (n: number) => new Date(Date.now() - n * 3600 * 1000).toISOString();


// ===============================================================
//  P1 BUSINESS INFO (from invoice 6556)
// ===============================================================
// 7-Eleven corporate AP - where all invoices are billed

// Line item types matching real P1 invoice (6556)

// Helper: compute line amount
const lineAmount = (l: any) => (parseFloat(l.qty) || 0) * (parseFloat(l.rate) || 0);
const invSubtotal = (lines: any[]) => lines.reduce((s, l) => s + lineAmount(l), 0);
const invTotal = (lines: any[], tax: number) => invSubtotal(lines) + (parseFloat(tax as any) || 0);

// ===============================================================
//  INITIAL INVOICES - including the REAL Invoice 6556
// ===============================================================

// ===============================================================
//  US CITY COORDS - expanded beyond Florida
// ===============================================================
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

// ===============================================================
//  TINY UI PRIMITIVES
// ===============================================================
const fmt = (n: number) => "$" + (n || 0).toLocaleString();

const CSS = `
@keyframes fadeUp { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: translateY(0) } }
@keyframes spin { to { transform: rotate(360deg) } }
@keyframes pulse { 0%,100% { transform: scale(1); opacity: 1 } 50% { transform: scale(1.08); opacity: 0.85 } }
html, body { width: 100%; max-width: 100%; overflow-x: hidden; overflow-x: clip; }
.display { font-family: var(--font-instrument-serif), Georgia, serif; font-weight: 400; letter-spacing: -0.5px; }
.mono { font-family: var(--font-jetbrains-mono), ui-monospace, monospace; }
.app-root { width: 100%; max-width: 100%; overflow-x: hidden; overflow-x: clip; }
.main-wrap { flex: 0 0 calc(100% - 232px) !important; min-width: 0; width: calc(100% - 232px); max-width: calc(100% - 232px); overflow-x: hidden; }
.content-pad { min-width: 0; overflow-x: hidden; box-sizing: border-box; }
.pull-refresh-indicator { overflow: hidden; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; color: ${T.muted}; font-size: 11px; font-weight: 700; background: ${T.bg}; }
.kcard { background: ${T.surface}; border: 1px solid ${T.borderSoft}; box-shadow: 0 1px 2px rgba(31,30,28,0.03); transition: transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease; }
.kcard:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(31,30,28,0.07); border-color: ${T.border}; }
.kcol { border-radius: 16px; border: 1px solid ${T.borderSoft}; box-shadow: 0 1px 2px rgba(31,30,28,0.02); overflow: hidden; }
.card { background: ${T.surface}; border-radius: 16px; border: 1px solid ${T.borderSoft}; box-shadow: 0 1px 2px rgba(31,30,28,0.03); }
.card-hover { transition: box-shadow 140ms ease, transform 140ms ease; }
.card-hover:hover { box-shadow: 0 8px 24px rgba(31,30,28,0.06); transform: translateY(-1px); }
.btn-primary { padding: 12px 18px; min-height: 44px; border-radius: 10px; background: ${T.ink}; color: ${T.bg}; border: none; cursor: pointer; font-weight: 600; font-size: 12px; font-family: inherit; transition: background 140ms; }
.btn-primary:hover { background: #000; }
.btn-accent { padding: 12px 18px; min-height: 44px; border-radius: 10px; background: ${T.accent}; color: #fff; border: none; cursor: pointer; font-weight: 600; font-size: 12px; font-family: inherit; transition: filter 140ms; }
.btn-accent:hover { filter: brightness(1.08); }
.btn-soft { padding: 12px 18px; min-height: 44px; border-radius: 10px; background: ${T.surface}; color: ${T.ink}; border: 1px solid ${T.border}; cursor: pointer; font-weight: 500; font-size: 12px; font-family: inherit; transition: background 140ms; }
.btn-soft:hover { background: ${T.bgWarm}; }
.side-btn { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 12px; border-radius: 10px; border: none; background: transparent; color: ${T.sidebarText}; cursor: pointer; font-size: 13px; font-family: inherit; margin-bottom: 2px; transition: background 140ms, color 140ms; }
.side-btn:hover { background: rgba(250,247,242,0.06); color: ${T.sidebarActive}; }
.side-btn.active { background: rgba(250,247,242,0.08); color: ${T.sidebarActive}; font-weight: 600; }
.sla-bar { height: 3px; border-radius: 2px; background: ${T.borderSoft}; overflow: hidden; }
.sla-fill { height: 100%; transition: width 300ms ease; }
.desktop-only-table { display: block; }
.mobile-only-cards { display: none; }
.desktop-only-header { display: block; }
.mobile-only-header { display: none; }
.desktop-only-activity-action { display: flex; }
.mobile-only-activity-actions { display: none; }
.app-toast {
  position: fixed;
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  max-width: min(560px, calc(100% - 32px));
  background: ${T.ink};
  color: ${T.bg};
  padding: 12px 22px;
  border-radius: 12px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.35;
  animation: fadeUp 0.25s;
  z-index: 60;
  box-shadow: 0 8px 32px rgba(31,30,28,0.3);
  white-space: normal;
  overflow-wrap: anywhere;
  text-align: center;
  border: 1px solid rgba(250,247,242,0.1);
  box-sizing: border-box;
}
.reassign-picker,
.reassign-search-wrap,
.reassign-options,
.reassign-option,
.reassign-option-row,
.reassign-option-main {
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}
.reassign-picker {
  overflow-x: hidden;
}
.reassign-search-wrap {
  position: relative;
  margin-bottom: 10px;
}
.reassign-search {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
}
.reassign-options {
  display: grid;
  gap: 8px;
  max-height: 280px;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 2px;
}
.reassign-option {
  width: 100%;
  text-align: left;
}
.reassign-option-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: center;
}
.reassign-option-main {
  flex: 1;
}
@media(max-width: 1200px) {
  :root {
    --mobile-bottom-nav-space: calc(120px + env(safe-area-inset-bottom, 0px));
  }
  html,
  body {
    overflow-x: hidden;
    overflow-x: clip;
    max-width: 100%;
  }
  .desktop-sidebar { display: none !important; }
  .mobile-bottom-nav { display: flex !important; }
  .app-toast {
    left: 12px;
    right: 12px;
    bottom: calc(var(--mobile-bottom-nav-space) - 24px);
    transform: none;
    width: auto;
    max-width: none;
    padding: 12px 14px;
    border-radius: 14px;
    font-size: 12px;
    text-align: left;
  }
  .main-wrap {
    flex: 0 0 100% !important;
    margin-left: 0 !important;
    width: 100% !important;
    max-width: 100% !important;
    overflow-x: hidden !important;
  }
  .topbar-shell { padding: 0 !important; display: block !important; }
  .desktop-only-header { display: none !important; }
  .mobile-only-header { display: block !important; }
  .mobile-header-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px 0 16px;
  }
  .mobile-header-title {
    flex: 1;
    text-align: center;
  }
  .mobile-header-actions {
    display: flex;
    gap: 10px;
    padding: 10px 16px 12px 16px;
  }
  .mobile-header-actions button {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    border-radius: 10px;
  }
  .mobile-drawer-panel { display: flex !important; }
  .content-pad {
    overflow-x: hidden !important;
    overscroll-behavior-y: contain;
    -webkit-overflow-scrolling: touch;
    max-width: 100% !important;
    padding-bottom: var(--mobile-bottom-nav-space) !important;
    box-sizing: border-box !important;
  }
  .mobile-footer-spacer {
    display: block !important;
    height: var(--mobile-bottom-nav-space);
    flex-shrink: 0;
  }
  .card,
  .kcard,
  .kcol {
    min-width: 0 !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
  }
  .kanban-card-head {
    align-items: flex-start !important;
    flex-direction: column !important;
    gap: 7px !important;
  }
  .kanban-card-id-row {
    min-width: 0 !important;
    max-width: 100% !important;
    flex-wrap: wrap !important;
  }
  .kanban-card-flags {
    width: 100% !important;
    min-width: 0 !important;
    max-width: 100% !important;
    justify-content: flex-start !important;
  }
  .kanban-card-status {
    max-width: 100% !important;
    box-sizing: border-box !important;
    white-space: normal !important;
    overflow-wrap: anywhere !important;
    line-height: 1.2 !important;
    text-align: left !important;
  }
  .stats-grid { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; gap: 10px !important; width: 100% !important; max-width: 100% !important; }
  .kanban-active { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; max-width: 100% !important; overflow-x: hidden !important; }
  .kanban-closing { grid-template-columns: minmax(0, 1fr) !important; max-width: 100% !important; overflow-x: hidden !important; }
  .detail-two-col { grid-template-columns: 1fr !important; }
  .detail-two-col,
  .detail-two-col > *,
  .detail-two-col .card {
    min-width: 0 !important;
    max-width: 100% !important;
    width: 100% !important;
    box-sizing: border-box !important;
  }
  .detail-fields { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
  .wo-date-grid { grid-template-columns: 1fr !important; }
  .billing-form-grid,
  .billing-summary-grid,
  .parts-alert-settings-grid {
    grid-template-columns: 1fr !important;
  }
  .billing-work-order-grid > * {
    min-width: 0 !important;
  }
  .billing-work-order-search {
    grid-column: 1 / -1;
  }
  .billing-source-metrics {
    grid-template-columns: 1fr !important;
  }
  .billing-line-head {
    display: none !important;
  }
  .billing-line-row {
    grid-template-columns: 1fr !important;
    gap: 8px !important;
    padding: 12px !important;
  }
  .billing-status-tabs {
    width: 100% !important;
    justify-content: center !important;
    row-gap: 0 !important;
  }
  .billing-status-tabs .billing-status-tab {
    flex: 0 0 33.333% !important;
    max-width: 33.333% !important;
    min-width: 0 !important;
    text-align: center !important;
    padding-left: 6px !important;
    padding-right: 6px !important;
  }
  .billing-create-button {
    margin-left: auto !important;
    margin-right: auto !important;
  }
  .billing-ready-row {
    grid-template-columns: minmax(0, 1fr) auto !important;
  }
  .billing-ready-row > span:nth-of-type(3) {
    grid-column: 1 / -1;
    white-space: normal !important;
  }
  .detail-fields > * {
    min-width: 0 !important;
  }
  .detail-fields div {
    overflow-wrap: anywhere;
  }
  .contractors-grid { grid-template-columns: 1fr !important; }
  .address-book-row { grid-template-columns: 38px minmax(0, 1fr) !important; }
  .address-book-contact { grid-column: 2; }
  .capital-grid { grid-template-columns: 1fr !important; }
  .table-scroll { overflow-x: auto; }
  .desktop-only-table { display: none !important; }
  .mobile-only-cards { display: block !important; }
  .mobile-only-cards.mobile-drawer-panel { display: flex !important; }
  .invoice-header-grid {
    grid-template-columns: 1fr !important;
    gap: 16px !important;
  }
  .invoice-detail-container {
    padding: 14px !important;
    border-radius: 12px !important;
  }
  .invoice-top-header {
    display: flex !important;
    flex-direction: row !important;
    justify-content: space-between !important;
    align-items: flex-start !important;
    gap: 8px !important;
    padding: 0 !important;
  }
  .invoice-top-header-left {
    flex: 0 0 auto !important;
    min-width: 0 !important;
  }
  .invoice-top-header-right {
    flex: 1 !important;
    text-align: right !important;
    font-size: 10px !important;
    line-height: 1.5 !important;
    word-break: break-word !important;
    overflow-wrap: break-word !important;
  }
  .invoice-title-text {
    font-size: 28px !important;
  }
  .invoice-top-header-right .invoice-company-name {
    font-size: 12px !important;
    font-weight: 600 !important;
  }
  .invoice-top-header-right .invoice-company-legal,
  .invoice-top-header-right .invoice-company-details {
    font-size: 10px !important;
    color: ${T.muted} !important;
  }
  .invoice-meta-grid {
    display: grid !important;
    grid-template-columns: auto 1fr !important;
    gap: 6px 16px !important;
    font-size: 12px !important;
  }
  .invoice-action-bar {
    flex-wrap: wrap !important;
    gap: 8px !important;
    padding: 12px 16px !important;
    align-items: stretch !important;
    justify-content: flex-start !important;
    width: 100% !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
  }
  .invoice-action-bar .invoice-back-button {
    flex: 0 0 auto !important;
    min-width: 0 !important;
    min-height: 36px !important;
    width: auto !important;
    justify-content: flex-start !important;
  }
  .invoice-action-buttons {
    display: grid !important;
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    gap: 8px !important;
    width: 100% !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
  }
  .invoice-action-bar button,
  .invoice-action-bar a {
    flex: 1 !important;
    min-width: 0 !important;
    justify-content: center !important;
    min-height: 44px !important;
    box-sizing: border-box !important;
    white-space: normal !important;
    text-align: center !important;
  }
  .invoice-action-buttons button,
  .invoice-action-buttons a {
    width: 100% !important;
    padding-left: 10px !important;
    padding-right: 10px !important;
  }
  .wo-invoice-list {
    overflow: visible !important;
  }
  .wo-invoice-list-header {
    align-items: flex-start !important;
    gap: 10px !important;
    flex-wrap: wrap !important;
  }
  .wo-invoice-list-header .wo-invoice-action {
    min-height: 40px !important;
    padding: 10px 12px !important;
    font-size: 12px !important;
  }
  .wo-invoice-row {
    align-items: flex-start !important;
    flex-wrap: nowrap !important;
    gap: 10px !important;
    padding: 14px !important;
  }
  .wo-invoice-row-main {
    flex: 1 1 auto !important;
    width: auto !important;
  }
  .wo-invoice-actions {
    display: none !important;
  }
  .wo-invoice-mobile-actions {
    display: block !important;
  }
  .invoice-totals-section {
    margin-top: 16px !important;
    padding-top: 16px !important;
    border-top: 2px solid ${T.borderSoft} !important;
  }
  .filter-bar {
    flex-direction: column;
  }
  .filter-bar input,
  .filter-bar select,
  .filter-bar .pretty-select,
  .filter-bar .filter-date-field {
    width: 100% !important;
    box-sizing: border-box;
  }
  .work-order-pagination {
    justify-content: center !important;
    text-align: center !important;
  }
  .work-order-pagination > div {
    justify-content: center !important;
  }
  .work-order-pagination .btn-soft:not(:disabled):focus,
  .work-order-pagination .btn-soft:not(:disabled):active {
    background: ${T.surface} !important;
    color: ${T.ink} !important;
    opacity: 1 !important;
  }
  .mobile-tabs {
    overflow-x: auto !important;
    overflow-y: hidden !important;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    margin-left: 0;
    margin-right: 0;
    padding: 0;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
  }
  .mobile-tabs::-webkit-scrollbar {
    display: none;
  }
  .mobile-tabs button {
    flex: 0 0 auto;
    min-height: 44px;
    padding: 10px 14px !important;
    white-space: nowrap;
  }
  .mobile-tabs.invoice-tabs {
    display: flex !important;
    flex-wrap: wrap !important;
    justify-content: center !important;
    overflow-x: hidden !important;
    gap: 0 !important;
  }
  .mobile-tabs.invoice-tabs button {
    flex: 0 0 25% !important;
    max-width: 25% !important;
    min-width: 0 !important;
    width: 100% !important;
    min-height: 42px !important;
    padding: 9px 2px !important;
    font-size: 10px !important;
    line-height: 1.2 !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    border-left: none !important;
    border-right: none !important;
    border-top: none !important;
    border-radius: 0 !important;
    margin-bottom: -2px !important;
  }
  .mobile-tabs.invoice-tabs .tab-full-label {
    display: inline !important;
  }
  .mobile-tabs.invoice-tabs .tab-short-label {
    display: none !important;
  }
  .mobile-tabs .tab-full-label {
    display: none !important;
  }
  .mobile-tabs .tab-short-label {
    display: inline !important;
  }
  .mobile-alert {
    align-items: flex-start !important;
    padding: 12px 14px !important;
    gap: 10px !important;
  }
  .mobile-alert-icon {
    width: 36px !important;
    height: 36px !important;
    flex-shrink: 0;
  }
  .mobile-alert-body {
    min-width: 0;
    flex: 1;
  }
  .mobile-card {
    padding: 14px !important;
    border-radius: 12px !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
  }
  .mobile-card-top {
    align-items: flex-start !important;
    gap: 8px !important;
  }
  .mobile-card-badges {
    flex-wrap: wrap;
    justify-content: flex-end;
    min-width: 0;
  }
  .mobile-card-title,
  .mobile-card-meta {
    overflow-wrap: anywhere;
  }
  .mobile-card-summary {
    white-space: normal !important;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .mobile-card-footer {
    gap: 8px !important;
  }
  .mobile-card-grid-2 {
    grid-template-columns: 1fr !important;
    gap: 10px !important;
  }
  .desktop-only-activity-action { display: none !important; }
  .mobile-only-activity-actions {
    display: flex !important;
    flex-wrap: nowrap !important;
    width: 100%;
  }
  .mobile-only-activity-actions button {
    flex: 1 1 0 !important;
    min-width: 0 !important;
    justify-content: center !important;
  }
  .topbar-title { font-size: 22px !important; }
  .content-pad { padding: 16px !important; }
  .modal-inner { width: 100% !important; padding: 18px !important; max-height: 85vh !important; max-height: calc(100dvh - 24px) !important; }
  .modal-form-row { grid-template-columns: 1fr !important; }
  .stat-value { font-size: 28px !important; }
  .stats-grid .stat-hero { grid-column: 1 / -1 !important; }
  /* ── Mobile form usability (375px baseline) ──────────────────────────
     16px font on every field kills iOS focus auto-zoom (the layout jump
     that reads as "taps don't register"); 44px min targets per HIG. */
  input, select, textarea { font-size: 16px !important; }
  .modal-overlay { align-items: center !important; justify-content: center !important; padding: 12px !important; }
  .modal-inner input:not([type="file"]), .modal-inner select { min-height: 44px; }
  .modal-inner textarea { min-height: 48px; }
  .modal-close { width: 44px !important; height: 44px !important; }
  .reassign-copy {
    line-height: 1.55 !important;
  }
  .reassign-picker,
  .reassign-search-wrap,
  .reassign-options,
  .reassign-option {
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    box-sizing: border-box !important;
  }
  .reassign-search {
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    box-sizing: border-box !important;
    font-size: 16px !important;
  }
  .reassign-option-row {
    gap: 8px !important;
    min-width: 0 !important;
    max-width: 100% !important;
  }
  .reassign-option-main {
    min-width: 0 !important;
    flex: 1 1 auto !important;
  }
  .reassign-actions {
    justify-content: stretch !important;
  }
  .reassign-actions button {
    flex: 1;
    justify-content: center;
  }
  /* Invoice line items: the desktop 7-column row can't fit at 375px —
     re-flow each line as a stacked card. Desktop grid is untouched. */
  .inv-line-head { display: none !important; }
  .inv-line-row { grid-template-columns: repeat(6, 1fr) !important; gap: 8px !important; padding: 14px 12px !important; }
  .inv-line-row .inv-num { grid-column: 1; align-self: center; padding-top: 0 !important; }
  .inv-line-row select,
  .inv-line-row .pretty-select { grid-column: 2 / 6; }
  .inv-line-row .inv-line-remove { grid-row: 1; grid-column: 6; justify-self: end; align-self: center; width: 44px !important; height: 44px !important; font-size: 22px !important; padding: 0 !important; }
  .inv-line-row textarea { grid-column: 1 / -1; min-height: 64px; }
  .inv-line-row .inv-mlabel { display: block !important; grid-column: span 2; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: #9A958D; margin-bottom: -4px; align-self: end; }
  .inv-line-row input { grid-column: span 2; }
  .inv-line-row .inv-amount { grid-column: span 2; text-align: right; padding-top: 0 !important; align-self: center; font-size: 14px !important; }
  .inv-totals-row { grid-template-columns: 1fr !important; }
  .inv-add-btns button { min-height: 44px; padding: 10px 14px !important; font-size: 13px !important; }
}
@media(max-width: 480px) {
  .kanban-active {
    grid-template-columns: 1fr !important;
  }
  .kanban-closing {
    grid-template-columns: 1fr !important;
  }
  .stats-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  }
  .modal-inner {
    width: 100% !important;
    padding: 16px !important;
    max-height: 92vh !important;
    border-radius: 16px !important;
  }
}
@media(max-width: 360px) {
  :root {
    --mobile-bottom-nav-space: calc(112px + env(safe-area-inset-bottom, 0px));
  }
  .content-pad {
    padding: 12px !important;
  }
  .mobile-header-top {
    padding: 10px 12px 0 12px;
  }
  .mobile-header-title .display {
    font-size: 19px !important;
  }
  .mobile-header-title div:last-child {
    font-size: 10px !important;
  }
  .mobile-header-actions {
    padding: 10px 12px 12px 12px;
    gap: 8px;
  }
  .mobile-header-actions button {
    padding-left: 8px !important;
    padding-right: 8px !important;
    font-size: 11px !important;
  }
  .stats-grid,
  .detail-fields,
  .mobile-card-grid-2 {
    grid-template-columns: 1fr !important;
  }
  .mobile-card {
    padding: 12px !important;
  }
  .mobile-card-top,
  .mobile-card-footer {
    flex-direction: column !important;
    align-items: flex-start !important;
  }
  .mobile-card-badges {
    justify-content: flex-start;
  }
  .mobile-bottom-nav {
    padding-left: 4px !important;
    padding-right: 4px !important;
  }
  .mobile-bottom-nav button {
    min-width: 0;
    padding-left: 0 !important;
    padding-right: 0 !important;
  }
  .mobile-bottom-nav span {
    font-size: 8px !important;
  }
  .app-toast {
    left: 10px;
    right: 10px;
    bottom: calc(var(--mobile-bottom-nav-space) - 18px);
    padding: 11px 12px;
    font-size: 11px;
  }
  .mobile-only-activity-actions {
    gap: 6px !important;
  }
  .mobile-only-activity-actions button {
    padding-left: 8px !important;
    padding-right: 8px !important;
    font-size: 11px !important;
  }
  .invoice-action-buttons {
    grid-template-columns: 1fr !important;
  }
  .mobile-tabs {
    display: grid !important;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    overflow-x: hidden !important;
    gap: 0 !important;
    width: 100% !important;
    max-width: 100% !important;
  }
  .mobile-tabs button {
    min-width: 0 !important;
    width: 100% !important;
    padding: 9px 2px !important;
    font-size: 10px !important;
    white-space: nowrap !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
  }
  .mobile-tabs.invoice-tabs {
    display: flex !important;
    flex-wrap: wrap !important;
    justify-content: center !important;
  }
  .mobile-tabs.invoice-tabs button {
    padding-left: 2px !important;
    padding-right: 2px !important;
    font-size: 10px !important;
  }
  .reassign-option {
    padding: 11px 12px !important;
  }
  .reassign-actions {
    gap: 6px !important;
  }
  .reassign-actions button {
    padding-left: 10px !important;
    padding-right: 10px !important;
  }
}
@media(min-width: 769px) and (max-width: 1200px) {
  :root {
    --mobile-bottom-nav-space: calc(104px + env(safe-area-inset-bottom, 0px));
  }
  .content-pad {
    padding: 24px !important;
  }
  .mobile-header-top {
    padding: 16px 24px 0 24px;
  }
  .mobile-header-actions {
    justify-content: flex-end;
    padding: 12px 24px 16px 24px;
  }
  .mobile-header-actions button {
    flex: 0 1 220px !important;
  }
  .responsive-card-grid {
    display: grid !important;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  .responsive-card-grid > * {
    min-width: 0;
    margin-bottom: 0 !important;
  }
  .responsive-grid-empty {
    grid-column: 1 / -1;
  }
  .filter-bar {
    display: grid !important;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: start;
  }
  .contractors-grid,
  .capital-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  }
  .kanban-closing {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  }
  .modal-inner {
    width: min(92vw, 900px) !important;
    padding: 22px !important;
  }
  .modal-form-row,
  .billing-form-grid,
  .billing-summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  }
  .billing-source-metrics {
    grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
  }
  .wo-date-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
  }
  .mobile-card-grid-2 {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  }
}
@media(min-width: 1000px) and (max-width: 1200px) {
  .detail-two-col {
    grid-template-columns: minmax(0, 1fr) 300px !important;
  }
}
@media(min-width: 1201px) { .mobile-bottom-nav { display: none !important; } }
`;


// ===============================================================
//  MAIN
// ===============================================================
export default function PortalShell() {
  const [page, setPage] = useState("dashboard");
  const [selectedWO, setSelectedWO] = useState(null);
  const [search, setSearch] = useState("");
  const [filterC, setFilterC] = useState("all");
  const [filterP, setFilterP] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [workOrderStoreView, setWorkOrderStoreView] = useState<{
    requestId: number;
    storeNumber: string;
  } | null>(null);
  const workOrderStoreViewSequenceRef = useRef(0);
  const [invTab, setInvTab] = useState("all");
  const [selectedBillingInvoice, setSelectedBillingInvoice] = useState<string | null>(null);
  const [workflowReturn, setWorkflowReturn] = useState<{
    workOrderId: string;
    page: string;
  } | null>(null);
  const [staffWorkFilter, setStaffWorkFilter] = useState<StaffWorkFilter>("all");
  const [staffWorkBusyId, setStaffWorkBusyId] = useState<string | null>(null);
  const [workOrderReturnPage, setWorkOrderReturnPage] = useState<string | null>(null);
  const [billingDraftToEdit, setBillingDraftToEdit] = useState<any>(null);
  const [billingSourceToStart, setBillingSourceToStart] = useState<string | null>(null);
  const [billingWorkOrderToStart, setBillingWorkOrderToStart] = useState<string | null>(null);
  // History (closed-job archive) filters
  const [histSearch, setHistSearch] = useState("");
  const [histContractor, setHistContractor] = useState("all");
  const [histReso, setHistReso] = useState("all");
  const [histFrom, setHistFrom] = useState("");
  const [histTo, setHistTo] = useState("");
  const [toast, setToast] = useState(null);
  const fire = useCallback((msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2800); }, []);
  const [aiEnhancing, setAiEnhancing] = useState(false);
  const [aiNote, setAiNote] = useState(null);
  const [modal, setModal] = useState(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [reopenTarget, setReopenTarget] = useState<ReopenTarget | null>(null);
  const [reopenMode, setReopenMode] = useState<WorkOrderReopenMode | "">("");
  const [reopenReason, setReopenReason] = useState("");
  const [reopenError, setReopenError] = useState("");
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [reassignTarget, setReassignTarget] = useState<string>("");
  const [reassignSearch, setReassignSearch] = useState("");
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  const pullStartYRef = useRef<number | null>(null);
  const pullEligibleRef = useRef(false);
  const pullDistanceRef = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshInFlightRef = useRef(false);
  const portalHistoryInitializedRef = useRef(false);
  const applyingPortalHistoryRef = useRef(false);
  const portalHistoryDepthRef = useRef(0);
  const lastPortalViewKeyRef = useRef<string | null>(null);
  const scrollPersistTimerRef = useRef<number | null>(null);
  const latestScrollTopRef = useRef(0);
  const [activityMenuId, setActivityMenuId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ woId: string; activityId: string } | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [imageErrors, setImageErrors] = useState<Record<string, boolean>>({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const updatePullDistance = useCallback((distance: number) => {
    pullDistanceRef.current = distance;
    setPullDistance(distance);
  }, []);
  const handlePullStart = useCallback((event: any) => {
    if (event.touches?.length !== 1) return;
    const contentAtTop = (contentScrollRef.current?.scrollTop || 0) <= 0;
    const windowAtTop = typeof window === "undefined" || window.scrollY <= 0;
    pullEligibleRef.current = contentAtTop && windowAtTop;
    pullStartYRef.current = pullEligibleRef.current
      ? event.touches[0].clientY
      : null;
  }, []);
  const handlePullMove = useCallback((event: any) => {
    if (!pullEligibleRef.current || pullStartYRef.current == null) return;
    const delta = event.touches?.[0]?.clientY - pullStartYRef.current;
    if (!Number.isFinite(delta) || delta <= 0) {
      updatePullDistance(0);
      return;
    }
    updatePullDistance(Math.min(88, delta * 0.45));
  }, [updatePullDistance]);
  const persistPortalScrollState = useCallback((scrollTop: number) => {
    if (typeof window === "undefined") return;
    const state = window.history.state;
    if (!portalViewFromHistoryState(state)) return;
    writePortalHistoryStateSafely(
      window.history,
      "replaceState",
      {
        ...state,
        p1PortalScrollTop: Number.isFinite(scrollTop) ? scrollTop : 0,
      },
      window.location.href,
    );
  }, []);
  const schedulePortalScrollPersistence = useCallback((scrollTop: number) => {
    if (typeof window === "undefined") return;
    latestScrollTopRef.current = Number.isFinite(scrollTop) ? scrollTop : 0;
    if (scrollPersistTimerRef.current != null) {
      window.clearTimeout(scrollPersistTimerRef.current);
    }
    // Persist once scrolling settles. Writing on every scroll frame can exceed
    // Mobile Safari's History API quota and crash the active route.
    scrollPersistTimerRef.current = window.setTimeout(() => {
      scrollPersistTimerRef.current = null;
      persistPortalScrollState(latestScrollTopRef.current);
    }, 500);
  }, [persistPortalScrollState]);
  const flushPortalScrollPersistence = useCallback(() => {
    if (typeof window === "undefined") return;
    if (scrollPersistTimerRef.current != null) {
      window.clearTimeout(scrollPersistTimerRef.current);
      scrollPersistTimerRef.current = null;
    }
    persistPortalScrollState(latestScrollTopRef.current);
  }, [persistPortalScrollState]);
  const [startDateInput, setStartDateInput] = useState(() => dateTimeInputPartsInTimeZone().date);
  const [startTimeInput, setStartTimeInput] = useState(() => dateTimeInputPartsInTimeZone().time);
  const [pauseDateInput, setPauseDateInput] = useState(() => dateTimeInputPartsInTimeZone().date);
  const [pauseTimeInput, setPauseTimeInput] = useState(() => dateTimeInputPartsInTimeZone().time);
  const [closeDateInput, setCloseDateInput] = useState(() => dateTimeInputPartsInTimeZone().date);
  const [closeTimeInput, setCloseTimeInput] = useState(() => dateTimeInputPartsInTimeZone().time);
  const [etaDateInput, setEtaDateInput] = useState(() => dateTimeInputPartsInTimeZone().date);
  const [etaTimeInput, setEtaTimeInput] = useState("14:00");
  // Staff "Edit work order" form. One object mirroring the editable fields;
  // populated from woData when the modal opens, diffed on save.
  const EMPTY_EDIT_WO = { priority: "", store: "", city: "", addr: "", lineOfService: "", businessService: "", category: "", subCategory: "", afm: "", afmEmail: "", summary: "", description: "" };
  const [editWoForm, setEditWoForm] = useState<any>(EMPTY_EDIT_WO);
  const [startNotesInput, setStartNotesInput] = useState("");
  const [pauseReasonInput, setPauseReasonInput] = useState("");
  const [partDescInput, setPartDescInput] = useState("");
  const [partNumInput, setPartNumInput] = useState("");
  const [partEtaInput, setPartEtaInput] = useState("");
  // Repeatable parts grid for the pause modal (one row per part). Each row
  // becomes a wo_parts insert when the contractor confirms the pause.
  const [pausePartsList, setPausePartsList] = useState<{ description: string; partNumber: string; qty: number; expectedReturnDate: string }[]>([]);
  const [pauseNotesInput, setPauseNotesInput] = useState("");
  const [assetMakeInput, setAssetMakeInput] = useState("");
  const [assetModelInput, setAssetModelInput] = useState("");
  const [assetSerialInput, setAssetSerialInput] = useState("");
  const [assetYearInput, setAssetYearInput] = useState("");
  const [resolutionInput, setResolutionInput] = useState("");
  const [resolutionNotesInput, setResolutionNotesInput] = useState("");
  const [invoices, setInvoices] = useState<any[]>([]);
  const { currentUser, setCurrentUser, loginEmail, setLoginEmail,
    loginPassword, setLoginPassword, rememberMe, setRememberMe, loginLoading, loginError,
    fadeIn, doLogin, logout: authLogout } = useAuth({ fire, setPage, setSelectedWO, setAiNote, setInvoices });
  // Wait for the profile before enabling portal data. Starting on the raw
  // session and then resetting again when the profile arrives caused every
  // initial query to run twice.
  const isAuthenticated = !!currentUser?.id;
  const isManager = currentUser?.role === "manager" || currentUser?.role === "dispatcher" || currentUser?.role === "back_office";
  const invoiceController = isInvoiceController(currentUser);
  const notesSeenInFlight = useRef(new Set<string>());
  const staffReadInFlight = useRef(new Set<string>());
  const qc = useQueryClient();
  const refreshPortal = useCallback(async () => {
    if (typeof window === "undefined" || !shouldRefreshPortal({
      authenticated: Boolean(currentUser?.id),
      visible: document.visibilityState === "visible",
      online: navigator.onLine,
      busy: refreshInFlightRef.current,
    })) return;

    // Visibility, online, interval, manual, and pull-to-refresh events can
    // arrive in the same browser tick. A ref closes that gap before React has
    // time to publish the loading state, keeping refresh strictly single-flight.
    refreshInFlightRef.current = true;
    setIsRefreshing(true);
    try {
      // Refetch mounted read models in place. Local form state, pagination,
      // navigation history, and scroll position are intentionally untouched.
      await qc.invalidateQueries({ refetchType: "active" });
    } finally {
      refreshInFlightRef.current = false;
      setIsRefreshing(false);
    }
  }, [currentUser?.id, qc]);
  const handlePullEnd = useCallback(() => {
    const shouldRefresh = pullDistanceRef.current >= 64;
    pullEligibleRef.current = false;
    pullStartYRef.current = null;
    updatePullDistance(0);
    if (shouldRefresh) void refreshPortal();
  }, [refreshPortal, updatePullDistance]);

  useEffect(() => {
    if (typeof window === "undefined" || !currentUser?.id) return;

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshPortal();
    };
    const intervalId = window.setInterval(() => {
      void refreshPortal();
    }, PORTAL_AUTO_REFRESH_MS);

    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("online", refreshWhenVisible);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("online", refreshWhenVisible);
    };
  }, [currentUser?.id, refreshPortal]);
  const { data: navigationSummary } = usePortalNavigationSummaryQuery(isAuthenticated);
  const selectedWorkOrderQuery = useWorkOrderByIdQuery(
    selectedWO,
    isAuthenticated && Boolean(selectedWO),
  );
  const selectedWorkOrderLookup = selectedWorkOrderQuery.data;
  const selectedWorkOrderError = selectedWorkOrderQuery.error instanceof Error
    ? selectedWorkOrderQuery.error.message
    : selectedWorkOrderQuery.error
      ? String(selectedWorkOrderQuery.error)
      : null;
  useEffect(() => {
    if (!selectedWorkOrderError || !selectedWO) return;
    void reportClientFailure({
      source: "selected-work-order-query",
      message: selectedWorkOrderError,
      portalView: page,
    });
  }, [page, selectedWO, selectedWorkOrderError]);
  const shellWorkOrdersData = useMemo(() => {
    return selectedWorkOrderLookup ? [selectedWorkOrderLookup] : [];
  }, [selectedWorkOrderLookup]);
  const selectedWorkOrderBase = selectedWorkOrderLookup || null;
  const workOrderDetailsQuery = useWorkOrderDetailsQuery(
    selectedWorkOrderBase,
    isAuthenticated && Boolean(selectedWO),
  );
  const selectedWorkOrderDetails = workOrderDetailsQuery.data;
  const { data: profilesData } = useProfilesQuery(isAuthenticated);
  const { data: techniciansData } = useTechniciansQuery(isAuthenticated);
  const woParts: any[] = [];
  const USERS = useMemo(
    () => profilesData ?? DEMO_ACCOUNTS.map(d => ({ id: d.email, ...d, role: "manager" })),
    [profilesData]
  );
  const technicians = useMemo(() => techniciansData ?? [], [techniciansData]);
  const { workOrders, setWorkOrders,
    loadingStates,
    patchLocalWO, localActivity, dbCall,
    doAssign, doStraightToBilling, doUnassign, doDeleteWO, doReassign,
    doStartWork, doPauseWork, doCloseComplete,
    doMoveToInvoice, doFinishContractorInvoicing,
    doApproveInvoice, doMarkPaid, doCloseWO, doCloseWithoutInvoice, doReopen,
    doEditWorkOrder, doCapitalFlag, doCapitalDecline, doCapitalComplete, doAutoAssign,
    doSetEta, doSetTechnician, doAssignPortalTechnician, doPostNote, doDeleteActivity,
    doAddPhotos, doRemovePhoto,
    doAddPart, doUpdatePart, doDeletePart,
    doRequestP1PartOrder, doSetP1PartOrderStatus,
    doMarkSevenElevenSynced,
    doMarkContractorAttention, doAcknowledgeContractorAttention } = useWorkOrders({
      currentUser, USERS, workOrdersData: shellWorkOrdersData, invoices, setInvoices, fire,
      selectedWorkOrderId: selectedWO,
      selectedWorkOrderDetails,
      startDateInput, startTimeInput, pauseDateInput, pauseTimeInput,
      setSelectedWO, setAiNote, setPage,
      isManager,
      noteText, setNoteText, SERVICE_TO_TRADES, contractorFor,
      getUser: (id: string) => USERS.find(u => u.id === id),
      dateNow, timeNow, fmt,
    });
  const logout = async () => { await authLogout(); setWorkOrders([]); };
  const handleLogout = async () => {
    setLogoutLoading(true);
    try {
      await logout();
    } finally {
      setLogoutLoading(false);
    }
  };
  const modalActionStyle = {
    opacity: modalLoading ? 0.7 : 1,
    cursor: modalLoading ? "default" : "pointer",
    display: "flex",
    alignItems: "center",
    gap: 6,
  };
  const {
    newInv, setNewInv,
    selectedInvoice, setSelectedInvoice,
    submittedInvoiceNum, setSubmittedInvoiceNum,
    pdfBusy,
    nextInvNum, nextInvNumFromDb, resetNewInv,
    doSubmitInvoice: submitInvoice,
    doSaveDraftInvoice,
    doDownloadInvoice, doDownloadInvoiceCsv, doDeleteInvoice, doRejectInvoice, doBatchReviewInvoices, doRetractInvoiceRejection, doCorrectInvoiceTotal, doPlaceInvoicePaymentHold, doReleaseInvoicePaymentHold,
    lineAmount, invSubtotal,
  } = useInvoices({ currentUser, profiles: USERS, fire });
  const selectedInvoiceInBootstrap = selectedInvoice
    ? invoices.find((invoice: any) => invoice.id === selectedInvoice) || null
    : null;
  const { data: selectedInvoiceLookup } = useInvoiceByIdQuery(
    selectedInvoice,
    isAuthenticated && Boolean(selectedInvoice) && !selectedInvoiceInBootstrap,
  );
  const invoiceDetailRows = selectedInvoiceLookup && !selectedInvoiceInBootstrap
    ? [...invoices, selectedInvoiceLookup]
    : invoices;
  const selectedInvoiceData = selectedInvoiceInBootstrap || selectedInvoiceLookup || null;
  const { data: selectedInvoiceWorkOrder } = useWorkOrderByIdQuery(
    selectedInvoiceData?.wot,
    isAuthenticated && Boolean(selectedInvoice) && Boolean(selectedInvoiceData?.wot),
  );
  const portalView = useMemo<PortalViewState>(() => ({
    page,
    selectedWorkOrderId: selectedWO || null,
    selectedInvoiceId: selectedInvoice || null,
    selectedBillingInvoiceId: selectedBillingInvoice || null,
    returnWorkOrderId: workflowReturn?.workOrderId || null,
    returnWorkOrderPage: workflowReturn?.page || null,
  }), [
    page,
    selectedBillingInvoice,
    selectedInvoice,
    selectedWO,
    workflowReturn?.page,
    workflowReturn?.workOrderId,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!currentUser?.id) {
      portalHistoryInitializedRef.current = false;
      applyingPortalHistoryRef.current = false;
      portalHistoryDepthRef.current = 0;
      lastPortalViewKeyRef.current = null;
      return;
    }

    const key = portalViewKey(portalView);
    const baseState = window.history.state && typeof window.history.state === "object"
      ? window.history.state
      : {};

    if (!portalHistoryInitializedRef.current) {
      const existingDepth = Number(baseState?.p1PortalDepth);
      portalHistoryDepthRef.current = Number.isFinite(existingDepth)
        ? existingDepth
        : 0;
      writePortalHistoryStateSafely(
        window.history,
        "replaceState",
        {
          ...baseState,
          [PORTAL_HISTORY_KEY]: portalView,
          p1PortalDepth: portalHistoryDepthRef.current,
          p1PortalScrollTop: window.scrollY || contentScrollRef.current?.scrollTop || 0,
        },
        portalUrlForView(window.location.href, portalView),
      );
      portalHistoryInitializedRef.current = true;
      lastPortalViewKeyRef.current = key;
      return;
    }

    if (applyingPortalHistoryRef.current) {
      applyingPortalHistoryRef.current = false;
      lastPortalViewKeyRef.current = key;
      return;
    }

    if (lastPortalViewKeyRef.current === key) return;

    flushPortalScrollPersistence();
    portalHistoryDepthRef.current += 1;
    writePortalHistoryStateSafely(
      window.history,
      "pushState",
      {
        ...window.history.state,
        [PORTAL_HISTORY_KEY]: portalView,
        p1PortalDepth: portalHistoryDepthRef.current,
        p1PortalScrollTop: 0,
      },
      portalUrlForView(window.location.href, portalView),
    );
    lastPortalViewKeyRef.current = key;
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      if (contentScrollRef.current) contentScrollRef.current.scrollTop = 0;
    });
  }, [currentUser?.id, flushPortalScrollPersistence, portalView]);

  useEffect(() => {
    if (typeof window === "undefined" || !currentUser?.id) return;
    const previousScrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";

    const persistWindowScroll = () => schedulePortalScrollPersistence(window.scrollY);

    window.addEventListener("scroll", persistWindowScroll, { passive: true });
    window.addEventListener("pagehide", flushPortalScrollPersistence);
    return () => {
      window.removeEventListener("scroll", persistWindowScroll);
      window.removeEventListener("pagehide", flushPortalScrollPersistence);
      flushPortalScrollPersistence();
      window.history.scrollRestoration = previousScrollRestoration;
    };
  }, [currentUser?.id, flushPortalScrollPersistence, schedulePortalScrollPersistence]);

  useEffect(() => {
    if (typeof window === "undefined" || !currentUser?.id) return;
    const onPopState = (event: PopStateEvent) => {
      const restored = portalViewFromHistoryState(event.state);
      if (!restored) return;

      applyingPortalHistoryRef.current = true;
      portalHistoryDepthRef.current = Number(event.state?.p1PortalDepth) || 0;
      setPage(restored.page);
      setSelectedWO(restored.selectedWorkOrderId);
      setSelectedInvoice(restored.selectedInvoiceId);
      setSelectedBillingInvoice(restored.selectedBillingInvoiceId);
      setWorkflowReturn(restored.returnWorkOrderId ? {
        workOrderId: restored.returnWorkOrderId,
        page: restored.returnWorkOrderPage || "work_orders",
      } : null);
      setBillingDraftToEdit(null);
      setBillingSourceToStart(null);
      setBillingWorkOrderToStart(null);
      setModal(null);
      setAiNote(null);

      const scrollTop = Number(event.state?.p1PortalScrollTop) || 0;
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (contentScrollRef.current) {
            contentScrollRef.current.scrollTop = scrollTop;
          }
          window.scrollTo({ top: scrollTop, left: 0, behavior: "auto" });
        });
      });
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [currentUser?.id, setSelectedInvoice, setSelectedWO]);

  const backFromWorkOrder = useCallback(() => {
    setAiNote(null);

    if (
      typeof window !== "undefined"
      && portalHistoryDepthRef.current > 0
      && portalViewFromHistoryState(window.history.state)?.selectedWorkOrderId
    ) {
      setWorkOrderReturnPage(null);
      window.history.back();
      return;
    }

    // Direct links do not have a portal list entry to restore, so retain the
    // existing deterministic fallback for those sessions.
    setSelectedWO(null);
    if (workOrderReturnPage) {
      setPage(workOrderReturnPage);
      setWorkOrderReturnPage(null);
    } else if (!isManager) {
      setPage("my_jobs");
    }
  }, [isManager, setSelectedWO, workOrderReturnPage]);

  const rememberWorkOrderReturn = useCallback((workOrderId: string) => {
    if (!workOrderId) return;
    setWorkflowReturn({
      workOrderId,
      page: page === "history"
        ? "history"
        : page === "wo_detail"
          ? "wo_detail"
          : page === "my_jobs"
            ? "my_jobs"
            : "work_orders",
    });
  }, [page]);

  const returnToWorkflowWorkOrder = useCallback(() => {
    if (!workflowReturn?.workOrderId) return false;
    setSelectedInvoice(null);
    setSelectedBillingInvoice(null);
    setBillingDraftToEdit(null);
    setBillingSourceToStart(null);
    setBillingWorkOrderToStart(null);
    setModal(null);
    setAiNote(null);
    setPage(workflowReturn.page || "work_orders");
    setSelectedWO(workflowReturn.workOrderId);
    setWorkflowReturn(null);
    return true;
  }, [setSelectedInvoice, setSelectedWO, workflowReturn]);

  const backToAllWorkOrders = useCallback(() => {
    setSelectedInvoice(null);
    setSelectedBillingInvoice(null);
    setBillingDraftToEdit(null);
    setBillingSourceToStart(null);
    setBillingWorkOrderToStart(null);
    setModal(null);
    setAiNote(null);
    setWorkflowReturn(null);
    setWorkOrderReturnPage(null);
    setSelectedWO(null);
    setPage(isManager ? "work_orders" : "my_jobs");
  }, [isManager, setSelectedInvoice, setSelectedWO]);

  const closeBillingInvoiceEditor = useCallback(() => {
    if (returnToWorkflowWorkOrder()) return;
    setModal(null);
    setBillingDraftToEdit(null);
    setBillingSourceToStart(null);
    setBillingWorkOrderToStart(null);
  }, [returnToWorkflowWorkOrder]);

  const openContractorInvoiceFromWorkOrder = useCallback((invoice: any, workOrderId: string) => {
    if (!invoice?.id || !workOrderId) return;
    rememberWorkOrderReturn(workOrderId);
    setSelectedInvoice(invoice.id);
    setSelectedWO(null);
    setAiNote(null);
    setPage("invoices");
  }, [rememberWorkOrderReturn, setSelectedInvoice, setSelectedWO]);
  // Holds the draft invoice (if any) the user clicked "Resume" on. Cleared
  // on modal close. Passed to InvoiceCreateModal to hydrate the form.
  const [resumeDraft, setResumeDraft] = useState<any>(null);
  const { data: resumeDraftWorkOrder } = useWorkOrderByIdQuery(
    resumeDraft?.wot,
    isAuthenticated && modal === "createInvoice" && Boolean(resumeDraft?.wot),
  );
  const doSubmitInvoice = async (wo: any, data?: any, existingInvoiceId?: string | null) => {
    const ok = await submitInvoice(wo, data, existingInvoiceId ?? resumeDraft?.id ?? null);
    if (ok) { setResumeDraft(null); setModal("invoiceSubmitted"); }
    return ok;
  };
  const doSaveDraft = async (wo: any, data?: any, existingInvoiceId?: string | null) => {
    const ok = await doSaveDraftInvoice(wo, data, existingInvoiceId ?? resumeDraft?.id ?? null);
    if (ok) setResumeDraft(null);
    return ok;
  };
  const openCreateInvoice = (draft?: any) => { setResumeDraft(draft ?? null); setModal("createInvoice"); };  // Tick every 60s so SLA countdowns update live
  const [, forceTick] = useState(0);
  useEffect(() => { const i = setInterval(() => forceTick(x => x + 1), 60000); return () => clearInterval(i); }, []);

  const isDemoManager = currentUser?.role === "manager" && currentUser?.isDemo === true;
  useEffect(() => {
    if (!isDemoManager) return;
    // Demo-only simulated notifications. Off by default. Append ?demo=true to URL to enable
    // for a dramatic moment in a presentation (then real notifications come in v9 via Resend).
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("demo") !== "true") return;
    const t1 = setTimeout(() => setToast("New call from FSM - Store #33089, Dallas. Roller grill down."), 6000);
    const t2 = setTimeout(() => setToast(null), 9000);
    const t3 = setTimeout(() => setToast("Chris checked in at Store #35551"), 48000);
    const t4 = setTimeout(() => setToast(null), 51000);
    return () => { [t1, t2, t3, t4].forEach(clearTimeout); };
  }, [isDemoManager]);

  // Pre-fill the legacy `newInv` mirror used by the modal's other consumers.
  // The actual editable Invoice # field in InvoiceCreateModal hydrates itself
  // against nextInvNumFromDb (authoritative); this line just keeps any
  // downstream readers in sync with our best cache-derived guess.
  useEffect(() => {
    if (modal !== "createInvoice") return;
    setNewInv((n: any) => n.num ? n : { ...n, num: nextInvNum() });
  }, [modal, nextInvNum]);

  // Contractors must never see the real 7-Eleven NTE. Keep the source array
  // intact for staff calculations and replace the display value at the role
  // boundary for every contractor account, including company admins.
  const isContractorRole = currentUser?.role === "contractor";
  const contractorNteCap = currentUser?.contractorNteDisplay != null
    ? Number(currentUser.contractorNteDisplay)
    : 1000;
  const maskedWorkOrders = useMemo(
    () => isContractorRole
      ? workOrders.map((workOrder: any) => ({
          ...workOrder,
          nte: contractorNteCap,
          nteFlagThreshold: null,
          nteFlagged: false,
          nteFlagAmount: null,
        }))
      : workOrders,
    [contractorNteCap, isContractorRole, workOrders],
  );
  const selectedWorkOrderForView = useMemo(() => {
    if (!selectedWorkOrderLookup) return null;
    if (!isContractorRole) return selectedWorkOrderLookup;
    return {
      ...selectedWorkOrderLookup,
      nte: contractorNteCap,
      nteFlagThreshold: null,
      nteFlagged: false,
      nteFlagAmount: null,
    };
  }, [contractorNteCap, isContractorRole, selectedWorkOrderLookup]);
  const invoiceDetailWorkOrders = useMemo(() => {
    if (!selectedInvoiceWorkOrder) return [];
    return [isContractorRole
      ? {
          ...selectedInvoiceWorkOrder,
          nte: contractorNteCap,
          nteFlagThreshold: null,
          nteFlagged: false,
          nteFlagAmount: null,
        }
      : selectedInvoiceWorkOrder];
  }, [contractorNteCap, isContractorRole, selectedInvoiceWorkOrder]);

  const woData = useMemo(
    () => selectedWO
      ? maskedWorkOrders.find((w: any) => w.id === selectedWO)
        || selectedWorkOrderForView
      : null,
    [maskedWorkOrders, selectedWO, selectedWorkOrderForView]
  );
  const combinesContractorCompletion = !isManager
    && currentUser?.canInvoice === true
    && !woData?.billingOnly;
  const contractorFieldAlreadyComplete = woData?.functionalStatus === "Completed";
  const resetReopenForm = useCallback(() => {
    setReopenTarget(null);
    setReopenMode("");
    setReopenReason("");
    setReopenError("");
  }, []);
  const closeReopenModal = useCallback(() => {
    setModal(null);
    resetReopenForm();
  }, [resetReopenForm]);
  const requestReopen = useCallback((workOrder: ReopenTarget) => {
    if (!isManager || invoiceController) {
      fire("Operational staff access is required to reopen work orders");
      return;
    }
    if (!workOrder?.id || workOrder.status !== "closed") {
      fire("Only a closed work order can be reopened");
      return;
    }
    setReopenTarget(workOrder);
    setReopenMode("");
    setReopenReason("");
    setReopenError("");
    setModal("reopen");
  }, [fire, invoiceController, isManager]);
  const invoiceFormWorkOrder = useMemo(
    () => resumeDraft?.wot
      ? maskedWorkOrders.find((workOrder: any) => workOrder.id === resumeDraft.wot)
        || resumeDraftWorkOrder
        || null
      : woData,
    [maskedWorkOrders, resumeDraft?.wot, resumeDraftWorkOrder, woData],
  );

  useEffect(() => {
    if (
      isManager
      || !selectedWO
      || !selectedWorkOrderQuery.isSuccess
      || selectedWorkOrderQuery.data !== null
    ) return;
    setSelectedWO(null);
    setAiNote(null);
    setPage("my_jobs");
  }, [
    isManager,
    selectedWO,
    selectedWorkOrderQuery.data,
    selectedWorkOrderQuery.isSuccess,
    setAiNote,
    setPage,
    setSelectedWO,
  ]);

  useEffect(() => {
    if (!isManager || !selectedWO || !woData?.hasUnreadNotes || !woData?.latestNoteAt) return;
    if (notesSeenInFlight.current.has(selectedWO)) return;

    const workOrderId = selectedWO;
    const latestNoteAt = woData.latestNoteAt;
    notesSeenInFlight.current.add(workOrderId);

    void markWorkOrderNotesSeen(workOrderId, latestNoteAt)
      .then(() => {
        const markSeen = (items: any[] | undefined) => items?.map((wo: any) =>
          wo.id === workOrderId
            ? { ...wo, staffNotesSeenAt: latestNoteAt, hasUnreadNotes: false }
            : wo
        );
        setWorkOrders((items: any[]) => markSeen(items) || []);
        qc.setQueryData(WORK_ORDERS_KEY, markSeen);
        void qc.invalidateQueries({ queryKey: WORK_ORDER_BY_ID_KEY });
        void qc.invalidateQueries({ queryKey: WORK_ORDER_PAGES_KEY });
        void qc.invalidateQueries({ queryKey: PORTAL_NAVIGATION_SUMMARY_KEY });
      })
      .catch((error: any) => {
        fire(`Could not clear new-note indicator: ${error.message || error}`);
      })
      .finally(() => {
        notesSeenInFlight.current.delete(workOrderId);
      });
  }, [fire, isManager, qc, selectedWO, setWorkOrders, woData?.hasUnreadNotes, woData?.latestNoteAt]);

  useEffect(() => {
    if (!woData) return;
    const storeNow = dateTimeInputPartsInTimeZone(
      new Date(),
      timezoneForWorkOrder(woData),
    );
    if (modal === "setEta") {
      setEtaDateInput(storeNow.date);
      setEtaTimeInput("14:00");
    }
    if (modal === "editWO") setEditWoForm({
      priority: woData.priority || "",
      store: woData.store || "",
      city: woData.city || "",
      addr: woData.addr || "",
      lineOfService: woData.lineOfService || "",
      businessService: woData.businessService || "",
      category: woData.category || "",
      subCategory: woData.subCategory || "",
      afm: woData.afm || "",
      afmEmail: woData.afmEmail || "",
      summary: woData.summary || "",
      description: woData.description || "",
    });
    if (modal === "reassign") {
      setReassignTarget("");
      setReassignSearch("");
    }
    if (modal === "startWork") {
      setStartDateInput(storeNow.date);
      setStartTimeInput(storeNow.time);
      setStartNotesInput("");
    }
    if (modal === "pauseWork") {
      setPauseDateInput(storeNow.date);
      setPauseTimeInput(storeNow.time);
      setPauseReasonInput("");
      setPartDescInput("");
      setPartNumInput("");
      setPartEtaInput("");
      setPausePartsList([]);
      setPauseNotesInput("");
    }
    if (modal === "closeComplete") {
      setCloseDateInput(storeNow.date);
      setCloseTimeInput(storeNow.time);
      setAssetMakeInput(woData.assetMake || "");
      setAssetModelInput(woData.assetModel || "");
      setAssetSerialInput(woData.assetSerial || "");
      setAssetYearInput(woData.assetYear || "");
      setResolutionInput("");
      setResolutionNotesInput(woData.resolutionNotes || "");
    }
  }, [modal, woData]);

  // Subscribe to realtime so changes from other clients propagate.
  useEffect(() => {
    if (!currentUser?.id) return;
    const pendingTables = new Set<PortalRealtimeTable>();
    const pendingWorkOrderIds = new Set<string>();
    let needsBroadDetailRefresh = false;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      flushTimer = null;
      const datasets = datasetsForRealtimeTables(pendingTables);
      pendingTables.clear();

      if (datasets.length > 0) {
        void qc.invalidateQueries({ queryKey: PORTAL_NAVIGATION_SUMMARY_KEY });
        void qc.invalidateQueries({ queryKey: CONTRACTOR_WORKLOAD_SUMMARY_KEY });
      }

      for (const dataset of datasets) {
        if (dataset === "workOrders") {
          void qc.invalidateQueries({ queryKey: WORK_ORDERS_KEY });
          void qc.invalidateQueries({ queryKey: WORK_ORDER_PAGES_KEY });
          void qc.invalidateQueries({ queryKey: WORK_ORDER_BY_ID_KEY });
        }
        if (dataset === "invoices") {
          void qc.invalidateQueries({ queryKey: INVOICES_KEY });
          void qc.invalidateQueries({ queryKey: INVOICE_PAGES_KEY });
          void qc.invalidateQueries({ queryKey: INVOICE_BY_ID_KEY });
        }
        if (dataset === "billingInvoices") {
          void qc.invalidateQueries({ queryKey: BILLING_INVOICES_KEY });
          void qc.invalidateQueries({ queryKey: BILLING_INVOICE_PAGES_KEY });
          void qc.invalidateQueries({ queryKey: BILLING_INVOICE_BY_ID_KEY });
        }
        if (dataset === "contractorEstimates") {
          void qc.invalidateQueries({ queryKey: CONTRACTOR_ESTIMATES_KEY });
        }
        if (dataset === "woParts") void qc.invalidateQueries({ queryKey: WO_PARTS_KEY });
        if (dataset === "staffWorkTodos") void qc.invalidateQueries({ queryKey: STAFF_WORK_TODOS_KEY });
        if (dataset === "staffNotificationReads") void qc.invalidateQueries({ queryKey: STAFF_NOTIFICATION_READS_KEY });
        if (dataset === "workOrderDetails") {
          // Prefix invalidation safely covers DELETE payloads that do not
          // include work_order_id unless replica identity is FULL.
          const ids = [...pendingWorkOrderIds];
          if (needsBroadDetailRefresh || ids.length === 0) {
            void qc.invalidateQueries({ queryKey: WORK_ORDER_DETAILS_KEY });
          } else {
            for (const workOrderId of ids) {
              void qc.invalidateQueries({ queryKey: workOrderDetailsKey(workOrderId) });
            }
          }
        }
      }

      pendingWorkOrderIds.clear();
      needsBroadDetailRefresh = false;
    };

    const unsub = subscribeToChanges(change => {
      pendingTables.add(change.table);
      const datasets = datasetsForRealtimeTables([change.table]);
      if (datasets.includes("workOrderDetails")) {
        const workOrderId = workOrderIdFromRealtimeChange(change);
        if (workOrderId) pendingWorkOrderIds.add(workOrderId);
        else needsBroadDetailRefresh = true;
      }
      if (!flushTimer) {
        flushTimer = setTimeout(flush, REALTIME_INVALIDATION_BATCH_MS);
      }
    });
    return () => {
      if (flushTimer) clearTimeout(flushTimer);
      unsub();
    };
  }, [currentUser?.id, qc]);
  const nav = useCallback((p: string) => {
    setPage(p);
    setSelectedWO(null);
    setSelectedBillingInvoice(null);
    setWorkflowReturn(null);
    setBillingDraftToEdit(null);
    setBillingSourceToStart(null);
    setBillingWorkOrderToStart(null);
    setAiNote(null);
    setWorkOrderReturnPage(null);
    setWorkOrderStoreView(null);
  }, []);
  const openUnassignedWorkOrders = useCallback(() => {
    setSearch("");
    setFilterC("all");
    setFilterP("all");
    setFilterStatus("unassigned");
    nav("work_orders");
  }, [nav]);
  const openStoreWorkOrders = useCallback((storeNumber: string) => {
    const exactStoreNumber = String(storeNumber || "").trim();
    if (!exactStoreNumber) return;

    setSearch(exactStoreNumber);
    setFilterC("all");
    setFilterP("all");
    setFilterStatus("all");
    nav("work_orders");
    workOrderStoreViewSequenceRef.current += 1;
    setWorkOrderStoreView({
      requestId: workOrderStoreViewSequenceRef.current,
      storeNumber: exactStoreNumber,
    });
  }, [nav]);

  // Lists own their cursor pages; the shell retains only exact records needed
  // by the active detail or editor flow.
  const billingInvoices: any[] = [];
  const { data: selectedBillingInvoiceLookup } = useBillingInvoiceByIdQuery(
    selectedBillingInvoice,
    isAuthenticated && isManager && Boolean(selectedBillingInvoice),
  );
  const selectedBillingInvoiceData = selectedBillingInvoiceLookup || null;
  const { data: selectedBillingWorkOrder } = useWorkOrderByIdQuery(
    selectedBillingInvoiceData?.wot,
    isAuthenticated
      && isManager
      && Boolean(selectedBillingInvoice)
      && Boolean(selectedBillingInvoiceData?.wot),
  );
  const billingReadyWorkOrders = useMemo(() => {
    return maskedWorkOrders
      .filter((workOrder: any) =>
        ["pending_invoice", "pending_payment"].includes(workOrder.status),
      )
      .map((workOrder: any) => ({
        ...workOrder,
        billingInvoice: workOrder.billingInvoiceId
          ? { id: workOrder.billingInvoiceId }
          : null,
      }))
      .sort((a: any, b: any) =>
        new Date(b.billingReadyAt || b.updatedAt || 0).getTime()
        - new Date(a.billingReadyAt || a.updatedAt || 0).getTime(),
      );
  }, [maskedWorkOrders]);
  const staffProfiles = useMemo(
    () => USERS.filter((profile: any) =>
      profile.active !== false
      && ["manager", "dispatcher", "back_office"].includes(profile.role),
    ),
    [USERS],
  );
  const staffWorkRows = useMemo(
    () => {
      const embeddedTodos = maskedWorkOrders
        .map((workOrder: any) => workOrder.staffTodo)
        .filter(Boolean);
      const embeddedReads = maskedWorkOrders
        .filter((workOrder: any) => workOrder.staffReadThroughAt)
        .map((workOrder: any) => ({
          userId: currentUser?.id || "",
          workOrderId: workOrder.id,
          readThroughAt: workOrder.staffReadThroughAt,
        }));

      return buildStaffWorkRows({
        workOrders: maskedWorkOrders,
        todos: embeddedTodos,
        reads: embeddedReads,
        profiles: staffProfiles,
        readyWorkOrderIds: new Set(billingReadyWorkOrders.map((workOrder: any) => workOrder.id)),
        currentUserId: currentUser?.id || "",
      });
    },
    [
      billingReadyWorkOrders,
      currentUser?.id,
      maskedWorkOrders,
      staffProfiles,
    ],
  );
  const dashboardWorkOrders = useMemo(() => {
    const unreadIds = new Set(
      staffWorkRows
        .filter(row => row.isUnread)
        .map(row => row.workOrder.id),
    );
    return maskedWorkOrders.map((workOrder: any) => ({
      ...workOrder,
      // Dashboard unread is intentionally per login; the 7-Eleven-sync flag
      // remains a separate, shared workflow state.
      hasUnreadNotes: unreadIds.has(workOrder.id),
    }));
  }, [maskedWorkOrders, staffWorkRows]);
  const staffUnreadCount = useMemo(
    () => navigationSummary?.staffUnreadCount
      ?? staffWorkRows.filter(row => row.isUnread).length,
    [navigationSummary?.staffUnreadCount, staffWorkRows],
  );
  const staffMyTodoCount = useMemo(
    () => navigationSummary?.myTodoCount
      ?? staffWorkRows.filter(row => row.isMyTodo).length,
    [navigationSummary?.myTodoCount, staffWorkRows],
  );
  const selectedStaffTodo = useMemo(
    () => woData?.staffTodo || null,
    [woData?.staffTodo],
  );
  const selectedStaffTodoOwner = useMemo(
    () => selectedStaffTodo
      ? staffProfiles.find(profile => profile.id === selectedStaffTodo.ownerId) || null
      : null,
    [selectedStaffTodo, staffProfiles],
  );
  const loadBillingInvoiceForExport = async (invoice: any) => {
    const payload = await billingFetch(
      `/api/billing-invoices?invoiceId=${encodeURIComponent(invoice.id)}`,
    );
    const exportInvoice = payload.invoice;
    if (!exportInvoice) throw new Error("Billing invoice could not be reloaded");

    assertStaffInvoiceIntegrity(exportInvoice);
    qc.setQueryData(BILLING_INVOICES_KEY, (items: any[] | undefined) =>
      (items || []).map(item => item.id === exportInvoice.id ? exportInvoice : item),
    );
    return exportInvoice;
  };
  const doDownloadBillingInvoice = async (invoice: any) => {
    try {
      // Always reload the exact invoice before creating an external document.
      // A stale or historically truncated line array must never be rendered
      // beside a header total that was calculated from more lines.
      const exportInvoice = await loadBillingInvoiceForExport(invoice);
      const { triggerBlobDownload, generateStaffInvoicePDFBlob, loadLogoDataUrl } = await import("../lib/invoicePdf");
      const logoDataUrl = await loadLogoDataUrl();
      const blob = generateStaffInvoicePDFBlob({
        num: exportInvoice.num,
        documentKind: exportInvoice.documentKind || "invoice",
        wot: exportInvoice.wot || "Standalone",
        store: exportInvoice.store || "",
        storeAddr: exportInvoice.storeAddr || "",
        invoiceDate: exportInvoice.invoiceDate || exportInvoice.invoiceDateRaw || "",
        serviceDate: exportInvoice.serviceDate || exportInvoice.serviceDateRaw || "",
        terms: exportInvoice.terms || "Net 30",
        cme: exportInvoice.cme || "",
        lines: exportInvoice.lines || [],
        subtotal: exportInvoice.subtotal || 0,
        salesTax: exportInvoice.salesTax || 0,
        total: exportInvoice.total || 0,
      }, logoDataUrl);
      const documentLabel = exportInvoice.documentKind === "capital_quote" ? "Capital-Quote" : "Invoice";
      triggerBlobDownload(blob, `${documentLabel}-${exportInvoice.num}-${exportInvoice.wot || "Standalone"}.pdf`);
      fire(`${documentLabel === "Capital-Quote" ? "Capital quote" : "Invoice"} ${exportInvoice.num} downloaded`);
    } catch (e: any) {
      fire(`Download failed: ${e.message || e}`);
    }
  };
  const doDownloadBillingInvoiceCsv = async (invoice: any) => {
    try {
      const exportInvoice = await loadBillingInvoiceForExport(invoice);
      const { downloadStaffInvoiceCsv } = await import("../lib/invoiceCsv");
      downloadStaffInvoiceCsv(exportInvoice);
      fire(`Invoice ${exportInvoice.num} CSV downloaded`);
    } catch (e: any) {
      fire(`CSV download failed: ${e.message || e}`);
    }
  };
  const doDeleteBillingInvoice = async (invoice: any) => {
    try {
      await billingFetch(`/api/billing-invoices?id=${encodeURIComponent(invoice.id)}`, { method: "DELETE" });
      setSelectedBillingInvoice(null);
      qc.invalidateQueries({ queryKey: BILLING_INVOICES_KEY });
      qc.invalidateQueries({ queryKey: BILLING_INVOICE_PAGES_KEY });
      qc.invalidateQueries({ queryKey: BILLING_INVOICE_BY_ID_KEY });
      fire(`Invoice #${invoice.num} deleted`);
    } catch (e: any) {
      fire(`Delete failed: ${e.message || e}`);
    }
  };
  const doMarkBillingInvoiceBilled = async (invoice: any) => {
    try {
      const payload = await billingFetch(
        `/api/billing-invoices?id=${encodeURIComponent(invoice.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ action: "mark_billed" }),
        },
      );
      qc.setQueryData(BILLING_INVOICES_KEY, (items: any[] | undefined) =>
        (items || []).map(item => item.id === invoice.id ? payload.invoice : item),
      );
      await Promise.all([
        qc.invalidateQueries({ queryKey: BILLING_INVOICES_KEY }),
        qc.invalidateQueries({ queryKey: BILLING_INVOICE_PAGES_KEY }),
        qc.invalidateQueries({ queryKey: BILLING_INVOICE_BY_ID_KEY }),
        qc.invalidateQueries({ queryKey: INVOICES_KEY }),
        qc.invalidateQueries({ queryKey: INVOICE_PAGES_KEY }),
        qc.invalidateQueries({ queryKey: WORK_ORDERS_KEY }),
        qc.invalidateQueries({ queryKey: WORK_ORDER_PAGES_KEY }),
      ]);
      fire(payload.finalization?.pendingCapitalCompletion
        ? `Capital quote #${invoice.num} submitted to 7-Eleven; work remains open pending completion`
        : `Invoice #${invoice.num} sent to 7-Eleven; work order closed`);
    } catch (e: any) {
      fire(`Billing update failed: ${e.message || e}`);
      throw e;
    }
  };
  const doMarkBillingInvoiceReady = async (invoice: any) => {
    try {
      const payload = await billingFetch(
        `/api/billing-invoices?id=${encodeURIComponent(invoice.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ action: "mark_ready" }),
        },
      );
      await Promise.all([
        qc.invalidateQueries({ queryKey: BILLING_INVOICES_KEY }),
        qc.invalidateQueries({ queryKey: BILLING_INVOICE_PAGES_KEY }),
        qc.invalidateQueries({ queryKey: BILLING_INVOICE_BY_ID_KEY }),
      ]);
      fire(`${invoice.documentKind === "capital_quote" ? "Capital quote" : "Invoice"} #${invoice.num} is ready for 7-Eleven`);
      return payload.invoice;
    } catch (e: any) {
      fire(`Ready-for-7-Eleven update failed: ${e.message || e}`);
      throw e;
    }
  };
  const doConvertQuoteToBillingInvoice = async (payload: Record<string, unknown>) => {
    const result = await billingFetch("/api/billing-invoices", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const invoice = result.invoice;
    qc.setQueryData(BILLING_INVOICES_KEY, (items: any[] | undefined) => {
      if (!invoice?.id) return items || [];
      return [invoice, ...(items || []).filter((item) => item.id !== invoice.id)];
    });
    await qc.invalidateQueries({ queryKey: BILLING_INVOICES_KEY });
    await qc.invalidateQueries({ queryKey: BILLING_INVOICE_PAGES_KEY });
    fire(`Invoice #${invoice?.num || ""} draft created`);
    if (invoice?.id) {
      setSelectedWO(null);
      setSelectedBillingInvoice(invoice.id);
      setPage("billing");
    }
    return invoice;
  };
  const openBillingForWorkOrder = (workOrderId: string, preserveWorkOrderReturn = false) => {
    if (preserveWorkOrderReturn) rememberWorkOrderReturn(workOrderId);
    setBillingDraftToEdit(null);
    setBillingSourceToStart(null);
    setBillingWorkOrderToStart(workOrderId);
    setSelectedBillingInvoice(null);
    setPage("billing");
    setModal("createBillingInvoice");
  };
  const openBillingFromWorkOrder = (workOrderId: string, billingInvoiceId?: string | null) => {
    rememberWorkOrderReturn(workOrderId);
    setSelectedWO(null);
    setAiNote(null);
    if (billingInvoiceId) {
      setBillingDraftToEdit(null);
      setBillingSourceToStart(null);
      setBillingWorkOrderToStart(null);
      setSelectedBillingInvoice(billingInvoiceId);
      setPage("billing");
      return;
    }
    openBillingForWorkOrder(workOrderId);
  };
  const approveInvoiceAndOpenBilling = async (invoice: any) => {
    if (!invoice?.id || !invoice?.wot) return false;
    const approved = await doApproveInvoice(invoice.id);
    if (!approved) return false;

    rememberWorkOrderReturn(invoice.wot);
    setBillingDraftToEdit(null);
    setBillingSourceToStart(invoice.id);
    setBillingWorkOrderToStart(invoice.wot);
    setSelectedBillingInvoice(null);
    setPage("billing");
    setModal("createBillingInvoice");
    return true;
  };
  const refreshStaffWork = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: STAFF_WORK_TODOS_KEY }),
      qc.invalidateQueries({ queryKey: STAFF_NOTIFICATION_READS_KEY }),
      qc.invalidateQueries({ queryKey: WORK_ORDERS_KEY }),
      qc.invalidateQueries({ queryKey: WORK_ORDER_PAGES_KEY }),
      qc.invalidateQueries({ queryKey: PORTAL_NAVIGATION_SUMMARY_KEY }),
    ]);
  };
  const runStaffWorkAction = async (
    workOrderId: string,
    action: () => Promise<unknown>,
    successMessage: string,
  ) => {
    setStaffWorkBusyId(workOrderId);
    try {
      await action();
      await refreshStaffWork();
      fire(successMessage);
    } catch (error: any) {
      fire(`My Work update failed: ${error.message || error}`);
    } finally {
      setStaffWorkBusyId(null);
    }
  };
  const openStaffWorkOrder = (row: StaffWorkRow) => {
    setWorkOrderReturnPage("staff_work");
    setSelectedWO(row.workOrder.id);
    setAiNote(null);
    setPage("wo_detail");
  };
  const openUnreadStaffWork = () => {
    setStaffWorkFilter("unread");
    nav("staff_work");
  };
  const handleStraightToBilling = async (workOrderId: string) => {
    const moved = await doStraightToBilling(workOrderId);
    if (!moved) return;
    rememberWorkOrderReturn(workOrderId);
    setSelectedWO(null);
    setAiNote(null);
    openBillingForWorkOrder(workOrderId);
  };
  const handleCapitalCompleted = async (workOrderId: string) => {
    const completed = await doCapitalComplete(workOrderId);
    if (!completed) return false;
    openBillingFromWorkOrder(workOrderId);
    return true;
  };

  useEffect(() => {
    if (!isManager || !selectedWO || !woData) return;
    const latestNotificationAt = latestContractorActivityAt(woData);
    if (!latestNotificationAt) return;

    const existingReadThroughAt = woData.staffReadThroughAt || null;
    if (
      existingReadThroughAt
      && new Date(existingReadThroughAt).getTime()
        >= new Date(latestNotificationAt).getTime()
    ) return;
    if (staffReadInFlight.current.has(selectedWO)) return;

    const workOrderId = selectedWO;
    staffReadInFlight.current.add(workOrderId);
    void markStaffWorkOrderRead(workOrderId, latestNotificationAt)
      .then(() => Promise.all([
        qc.invalidateQueries({ queryKey: STAFF_NOTIFICATION_READS_KEY }),
        qc.invalidateQueries({ queryKey: WORK_ORDER_BY_ID_KEY }),
        qc.invalidateQueries({ queryKey: WORK_ORDER_PAGES_KEY }),
        qc.invalidateQueries({ queryKey: PORTAL_NAVIGATION_SUMMARY_KEY }),
      ]))
      .catch((error: any) => {
        fire(`Could not mark update read: ${error.message || error}`);
      })
      .finally(() => staffReadInFlight.current.delete(workOrderId));
  }, [
    fire,
    isManager,
    qc,
    selectedWO,
    woData,
  ]);
  const getUser = (id: string) => USERS.find(u => u.id === id);
  const contractorsOnly = useMemo(
    () => USERS.filter(u => u.role === "contractor"),
    [USERS]
  );
  const assignableContractors = useMemo(
    () => contractorsOnly.filter((contractor: any) =>
      contractor.isAssignable !== false,
    ),
    [contractorsOnly],
  );
  const reassignContractorOptions = useMemo(() => {
    const q = reassignSearch.trim().toLowerCase();
    if (!q) return assignableContractors;
    return assignableContractors.filter((c: any) =>
      [c.name, c.company, c.territory, ...(c.trades || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [assignableContractors, reassignSearch]);
  const myWOs = useMemo(
    () => currentUser?.role === "contractor"
      ? maskedWorkOrders.filter((w: any) =>
          w.contractor === (currentUser.contractorAccountId || currentUser.id),
        )
      : maskedWorkOrders,
    [maskedWorkOrders, currentUser]
  );
  const filteredWOs = useMemo(
    () => myWOs.filter(w => {
      // Archived closed jobs (>24h past close) leave the active board -> History only.
      if (isArchivedClosed(w)) return false;
      if (search) {
        const q = search.trim().toLowerCase();
        const haystack = [
          w.id,
          w.incidentId,
          w.store,
          w.city,
          w.addr,
          w.summary,
          w.description,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (filterC !== "all" && w.contractor !== filterC) return false;
      if (filterP !== "all" && w.priority !== filterP) return false;
      if (filterStatus !== "all" && w.status !== filterStatus) return false;
      return true;
    }),
    [myWOs, search, filterC, filterP, filterStatus]
  );
  const statusCounts = useMemo(() => {
    const localOpenCount = workOrders.filter(w => activeStatuses.includes(w.status)).length;
    const localClosed = workOrders.filter(w => w.status === "closed");
    return {
      openCount: navigationSummary?.openCount ?? localOpenCount,
      p1Unassigned: navigationSummary?.p1UnassignedCount
        ?? workOrders.filter(w => w.priority === "p1" && w.status === "unassigned").length,
      capitalCount: navigationSummary?.capitalCount
        ?? workOrders.filter(w =>
          (w.isCapital || ["capital", "pending_capital_completion"].includes(w.status))
          && w.status !== "closed",
        ).length,
      pendAppr: navigationSummary?.pendingApprovalCount
        ?? workOrders.filter(w => w.status === "pending_approval").length,
      closedWOs: localClosed,
      historyCount: navigationSummary?.historyCount ?? localClosed.length,
      slaBreached: navigationSummary?.slaBreachedCount ?? workOrders.filter(w => {
        if (!activeStatuses.includes(w.status)) return false;
        const s2 = computeSlaState(w.responseBreachAt, w.resolutionBreachAt, w.startTimeRaw);
        if (s2) return s2.responseBreached || s2.resolutionBreached;
        const s = slaRemaining(w);
        return s && s.remainingHours <= 0;
      }).length,
    };
  }, [navigationSummary, workOrders]);
  const {
    openCount, p1Unassigned, capitalCount, pendAppr,
    closedWOs, historyCount, slaBreached,
  } = statusCounts;
  // Realtime subscription propagates the same change to other clients within ~200ms.

  const doCreateWO = async (newWO: any) => {
    // WOT# is the ONLY required field. Everything else is optional with
    // sensible defaults - manual intake must never be blocked on data we
    // don't have yet.
    const wot = (newWO.wot || "").trim();
    if (!wot) { return { ok: false, error: { msg: "WOT number is required." } }; }
    // Dedup: case-insensitive, trimmed. Local cache catches most duplicates
    // (incl. ones I just created); DB lookup catches duplicates that
    // landed from another session since this page loaded. Same WOT/FWKD
    // means double-dispatch risk (Jeremy's Nuance B), so we surface the
    // existing WO by name with an "open it" affordance, not a generic error.
    const wotLc = wot.toLowerCase();
    const localDup = workOrders.find(w => w.id?.toLowerCase() === wotLc);
    if (localDup) {
      return { ok: false, error: { msg: `${localDup.id} already exists - open it instead?`, openWoId: localDup.id } };
    }
    try {
      const dbDup = await findExistingWoId(wot);
      if (dbDup) {
        if (dbDup.deleted) {
          return { ok: false, error: { msg: `${dbDup.id} was previously deleted — contact a manager to restore it` } };
        }
        return { ok: false, error: { msg: `${dbDup.id} already exists — open it instead?`, openWoId: dbDup.id } };
      }
    } catch (e: any) {
      return { ok: false, error: { msg: `Dedup check failed: ${e?.message || e}` } };
    }
    // Assign-on-create: blank -> Unassigned; a contractor id -> Assigned.
    const contractor = newWO.assign || null;
    const status = contractor ? "assigned" : "unassigned";
    const contractorName = contractor ? getUser(contractor)?.name : null;
    const dispatchedAt = contractor ? new Date().toISOString() : null;
    // Priority defaults to P4 (standard) when left blank. Text fields default
    // to "" so the UI renders cleanly; a missing incident remains null.
    const priority = newWO.priority || "p4";
    const incidentId = (newWO.incidentId || "").trim() || null;
    const wo = {
      id: wot,
      incidentId,
      store: (newWO.store || "").trim(),
      city: (newWO.city || "").trim(),
      addr: (newWO.addr || "").trim(),
      lineOfService: (newWO.lineOfService || "").trim(),
      businessService: (newWO.businessService || "").trim(),
      category: (newWO.category || "").trim(),
      subCategory: (newWO.subCategory || "").trim(),
      summary: (newWO.summary || "").trim(),
      description: (newWO.description || "").trim(),
      priority,
      status,
      contractor,
      afm: (newWO.afm || "").trim(),
      afmEmail: (newWO.afmEmail || "").trim(),
      functionalStatus: contractor ? "Dispatched" : "New",
      dispatchedAt,
      source: "manual",
    };
    const createdText = `Work order created manually by ${currentUser.name}.`;
    const assignedText = contractor ? `Assigned to ${contractorName} by ${currentUser.name}.` : null;
    // Optimistic local insert (with both activity entries).
    const optimisticActivities = [localActivity(createdText, "system")];
    if (assignedText) {
      optimisticActivities.unshift(
        localActivity(assignedText, "system", false, "work_order_assignment", false, true),
      );
    }
    setWorkOrders(prev => [{ ...wo, age: "now", activities: optimisticActivities, photos: [] }, ...prev]);
    try {
      await insertWorkOrder(wo, createdText, "System");
      if (assignedText) {
        await insertActivity(wot, "System", assignedText, "system", {
          staffOnly: true,
          eventKey: "work_order_assignment",
        });
      }
      if (contractor) {
        await notificationFetch("/api/notifications/dispatch", {
          workOrderId: wot,
          contractorId: contractor,
        });
      }
      fire(contractor
        ? `Work order ${wot} created. Assigned to ${contractorName}.`
        : `Work order ${wot} created. Added to Unassigned.`);
      await Promise.all([
        qc.invalidateQueries({ queryKey: WORK_ORDER_PAGES_KEY }),
        qc.invalidateQueries({ queryKey: WORK_ORDER_BY_ID_KEY }),
        qc.invalidateQueries({ queryKey: PORTAL_NAVIGATION_SUMMARY_KEY }),
        qc.invalidateQueries({ queryKey: CONTRACTOR_WORKLOAD_SUMMARY_KEY }),
      ]);
      return true;
    } catch (e: any) {
      // Roll back the optimistic card so no phantom WO lingers, and surface
      // the failure inline in the modal - never a silent failure.
      setWorkOrders(prev => prev.filter(w => w.id !== wo.id));
      const msg = String(e?.message || e);
      // The async DB dedup above usually catches this, but a race between
      // the pre-check and the insert can still trip the unique constraint.
      // When that happens we don't know the existing id from the error
      // alone, so look it up before showing the open affordance.
      if (/duplicate|unique/i.test(msg)) {
        try {
          const existing = await findExistingWoId(wot);
          return { ok: false, error: existing
            ? existing.deleted
              ? { msg: `${existing.id} was previously deleted — contact a manager to restore it` }
              : { msg: `${existing.id} already exists — open it instead?`, openWoId: existing.id }
            : { msg: "That WOT number already exists — try a different one." } };
        } catch {
          return { ok: false, error: { msg: "That WOT number already exists - try a different one." } };
        }
      } else {
        return { ok: false, error: { msg: `Save failed: ${msg}` } };
      }
      return false;
    }
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

  const contractorActiveBadge = useMemo(
    () => navigationSummary?.contractorActiveCount
      ?? myWOs.filter(w => activeStatuses.includes(w.status)).length,
    [myWOs, navigationSummary?.contractorActiveCount],
  );
  const contractorInvoiceBadge = useMemo(
    () => (navigationSummary?.contractorInvoiceCount
      ?? invoices.filter(i =>
        i.contractor === (currentUser?.contractorAccountId || currentUser?.id)
        && (i.state === "submitted" || i.state === "revised" || i.state === "rejected"),
      ).length) || null,
    [invoices, currentUser?.contractorAccountId, currentUser?.id, navigationSummary?.contractorInvoiceCount],
  );
  const contractorAttentionBadge = useMemo(
    () => (navigationSummary?.contractorAttentionCount
      ?? myWOs.reduce(
        (count: number, wo: any) => count + Number(wo.pendingContractorAttentionCount || 0),
        0,
      )) || null,
    [myWOs, navigationSummary?.contractorAttentionCount],
  );
  const submittedInvoice = useMemo(
    () => invoices.find(i => i.num === submittedInvoiceNum),
    [invoices, submittedInvoiceNum]
  );
  const sideItems = useMemo(() => invoiceController
    ? [
      { id: "dashboard", label: "Controller", icon: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" },
      { id: "invoices", label: "Invoices", icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h8" },
    ]
    : isManager
    ? [
      { id: "dashboard", label: "Dashboard", icon: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" },
      { id: "staff_work", label: "My Work", icon: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11", badge: navigationSummary?.staffWorkCount || null },
      { id: "work_orders", label: "Work orders", icon: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", badge: openCount },
      { id: "capital", label: "Capital", icon: "M2 20h20M5 20V8l7-5 7 5v12M9 20v-4h6v4", badge: capitalCount || null },
      { id: "invoices", label: "Invoices", icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h8", badge: pendAppr || null },
      { id: "billing", label: "Billing", icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h6M9 9h1" },
      { id: "contractors", label: "Contractors", icon: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" },
      { id: "contractor_preview", label: "Contractor view", icon: "M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" },
      { id: "history", label: "History", icon: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z", badge: historyCount || null },
    ]
    : [
      { id: "my_jobs", label: "My jobs", icon: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", badge: contractorActiveBadge, attentionBadge: contractorAttentionBadge },
      ...(currentUser?.contractorTier === "mr_freeze" || currentUser?.canManageTeam ? [
        { id: "team_dispatch", label: "My Team", icon: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" },
      ] : []),
      ...(currentUser?.canInvoice ? [
        { id: "invoices", label: "Invoices", icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h8", badge: contractorInvoiceBadge },
      ] : []),
    ],
    [invoiceController, isManager, openCount, capitalCount, pendAppr, historyCount, contractorActiveBadge, contractorAttentionBadge, contractorInvoiceBadge, currentUser?.canInvoice, currentUser?.canManageTeam, currentUser?.contractorTier, navigationSummary?.staffWorkCount]
  );
  const bottomNavItems = useMemo(() => {
    const preferred = ["dashboard", "staff_work", "work_orders", "invoices"];
    const items = preferred
      .map(id => sideItems.find(item => item.id === id))
      .filter(Boolean);
    return items.length ? items : sideItems.slice(0, 4);
  }, [sideItems]);

  useEffect(() => {
    if (!invoiceController || page === "dashboard" || page === "invoices") return;
    setSelectedWO(null);
    setSelectedInvoice(null);
    setSelectedBillingInvoice(null);
    setModal(null);
    setPage("dashboard");
  }, [invoiceController, page]);

  // ===============================================================
  //  LOGIN
  // ===============================================================
  if (!currentUser) return <LoginForm loginEmail={loginEmail} setLoginEmail={setLoginEmail} loginPassword={loginPassword} setLoginPassword={setLoginPassword} rememberMe={rememberMe} setRememberMe={setRememberMe} loginLoading={loginLoading} loginError={loginError} fadeIn={fadeIn} imageErrors={imageErrors} setImageErrors={setImageErrors} doLogin={doLogin} CSS={CSS} />;

  // ===============================================================
  //  APP SHELL
  // ===============================================================
  const pageTitle: any = { dashboard: "Dashboard", staff_work: "My Work", work_orders: selectedWO ? woData?.id : "Work orders", invoices: "Invoices", billing: "Billing", contractors: "Contractors", contractor_preview: "Contractor view", my_jobs: "My jobs", team_dispatch: "My Team", wo_detail: woData?.id || "Work order", capital: "Capital projects", history: "History" };

  // =====  // ===============================================================
  //  LAYOUT
  // ===============================================================
  return (
    <div className="app-root" style={{ display: "flex", minHeight: "100vh", fontFamily: "var(--font-inter), system-ui, sans-serif", fontSize: 13, color: T.ink, background: T.bg, position: "relative" }}>
      <style>{CSS}</style>
      <ClientDiagnostics portalView={page} />

      <div
        className="mobile-only-cards"
        onClick={() => setDrawerOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(31,30,28,0.45)",
          zIndex: 200,
          opacity: drawerOpen ? 1 : 0,
          pointerEvents: drawerOpen ? "all" : "none",
          transition: "opacity 0.3s ease",
        }}
      />

      <div
        className="mobile-only-cards mobile-drawer-panel"
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          bottom: 0,
          width: "72vw",
          maxWidth: 280,
          background: T.sidebar,
          zIndex: 201,
          transform: drawerOpen ? "translateX(0)" : "translateX(-100%)",
          transition: "transform 0.35s cubic-bezier(0.4,0,0.2,1)",
          display: "flex",
          flexDirection: "column",
          boxShadow: "4px 0 24px rgba(31,30,28,0.18)",
          borderRadius: "0 20px 20px 0",
        }}
      >
        <button
          onClick={() => setDrawerOpen(false)}
          aria-label="Close menu"
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: "rgba(250,247,242,0.08)",
            border: "none",
            color: T.sidebarText,
            fontSize: 18,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ×
        </button>
        <div style={{ padding: "22px 20px 18px", borderBottom: "1px solid rgba(250,247,242,0.06)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, paddingRight: 34 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", padding: 5, boxSizing: "border-box", flexShrink: 0 }}>
              {imageErrors.sidebarLogo ? (
                <div style={{ width: 36, height: 36, background: T.accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-instrument-serif), serif", fontSize: 18, letterSpacing: -0.5 }}>P1</div>
              ) : (
                <Image
                  src="/p1-pros-logo.jpeg"
                  alt="P1 Pros"
                  width={36}
                  height={36}
                  style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }}
                  onError={() => setImageErrors(prev => ({ ...prev, sidebarLogo: true }))}
                />
              )}
            </div>
            <div>
              <div className="display" style={{ fontSize: 18, color: T.bg, letterSpacing: -0.3, lineHeight: 1 }}>P1 Service</div>
              <div style={{ fontSize: 10, color: T.sidebarText, letterSpacing: 0.8, textTransform: "uppercase", marginTop: 3 }}>Operations</div>
            </div>
          </div>
        </div>
        <div style={{ padding: "14px 0", flex: 1 }}>
          {sideItems.map(item => {
            const active = page === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  nav(item.id);
                  setDrawerOpen(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  width: "calc(100% - 20px)",
                  padding: "12px 20px",
                  cursor: "pointer",
                  borderRadius: 10,
                  margin: "2px 10px",
                  background: active ? `${T.accent}1F` : "transparent",
                  color: active ? T.accent : T.sidebarText,
                  fontWeight: active ? 600 : 400,
                  fontSize: 14,
                  transition: "background 0.15s ease",
                  border: "none",
                  fontFamily: "inherit",
                }}
              >
                <Ico d={item.icon} size={17} color={active ? T.accent : T.sidebarText} />
                <span style={{ flex: 1, textAlign: "left" }}>{item.label}</span>
                {item.badge != null && <span style={{ fontSize: 10, background: item.id === "capital" ? T.violet : T.accent, color: "#fff", borderRadius: 10, padding: "2px 8px", fontWeight: 700 }}>{item.badge}</span>}
                {item.attentionBadge != null && item.attentionBadge > 0 && (
                  <span
                    title={`${item.attentionBadge} update${item.attentionBadge === 1 ? "" : "s"} need your attention`}
                    style={{ minWidth: 20, textAlign: "center", fontSize: 10, background: T.success, color: "#fff", borderRadius: 10, padding: "2px 6px", fontWeight: 800 }}
                  >
                    {item.attentionBadge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div style={{ borderTop: "1px solid rgba(250,247,242,0.06)", padding: "14px 0 10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 16px 12px" }}>
            <Avatar initials={currentUser.initials} color={currentUser.color} size={34} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: T.bg, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentUser.name}</div>
              <div style={{ fontSize: 10, color: T.sidebarText }}>{currentUser.title || currentUser.company}</div>
            </div>
          </div>
          {isManager && !invoiceController && (
            <button
              onClick={() => {
                setModal("addressBook");
                setDrawerOpen(false);
              }}
              style={{
                width: "calc(100% - 20px)",
                margin: "0 10px 8px 10px",
                padding: 12,
                borderRadius: 10,
                border: "1px solid rgba(250,247,242,0.12)",
                background: "transparent",
                color: T.sidebarText,
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Address book
            </button>
          )}
          <button
            onClick={() => {
              setModal("manageAccount");
              setDrawerOpen(false);
            }}
            style={{
              width: "calc(100% - 20px)",
              margin: "0 10px 8px 10px",
              padding: 12,
              borderRadius: 10,
              border: "1px solid rgba(250,247,242,0.12)",
              background: "transparent",
              color: T.sidebarText,
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Manage Account
          </button>
          <button
            onClick={async () => {
              setDrawerOpen(false);
              await handleLogout();
            }}
            disabled={logoutLoading}
            style={{
              width: "calc(100% - 20px)",
              margin: "0 10px 10px 10px",
              padding: 12,
              borderRadius: 10,
              border: "1px solid rgba(250,247,242,0.12)",
              background: "transparent",
              color: T.sidebarText,
              fontSize: 13,
              fontWeight: 500,
              cursor: logoutLoading ? "default" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              fontFamily: "inherit",
              opacity: logoutLoading ? 0.7 : 1,
            }}
          >
            {logoutLoading
              ? <><BtnSpinnerDark />Signing out...</>
              : <><Ico d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" size={15} color={T.sidebarText} />Sign out</>
            }
          </button>
        </div>
      </div>

      {/* Sidebar */}
      <div className="desktop-sidebar" style={{ width: 232, background: T.sidebar, color: T.sidebarText, display: "flex", flexDirection: "column", flexShrink: 0, position: "fixed", top: 0, left: 0, bottom: 0, zIndex: 30 }}>
        <div style={{ padding: "22px 20px 18px", borderBottom: "1px solid rgba(250,247,242,0.06)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", padding: 5, boxSizing: "border-box", flexShrink: 0 }}>
              {imageErrors.sidebarLogo ? (
                <div style={{ width: 36, height: 36, background: T.accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-instrument-serif), serif", fontSize: 18, letterSpacing: -0.5 }}>P1</div>
              ) : (
                <Image
                  src="/p1-pros-logo.jpeg"
                  alt="P1 Pros"
                  width={36}
                  height={36}
                  style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }}
                  onError={() => setImageErrors(prev => ({ ...prev, sidebarLogo: true }))}
                />
              )}
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
              {item.attentionBadge != null && item.attentionBadge > 0 && (
                <span
                  title={`${item.attentionBadge} update${item.attentionBadge === 1 ? "" : "s"} need your attention`}
                  style={{ minWidth: 20, textAlign: "center", fontSize: 10, background: T.success, color: "#fff", borderRadius: 10, padding: "2px 6px", fontWeight: 800 }}
                >
                  {item.attentionBadge}
                </span>
              )}
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
          {isManager && !invoiceController && (
            <button
              onClick={() => setModal("addressBook")}
              style={{
                width: "100%",
                padding: 8,
                borderRadius: 8,
                border: `1px solid rgba(250,247,242,0.1)`,
                background: "transparent",
                color: T.sidebarText,
                fontSize: 11,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: "inherit",
                marginBottom: 6,
              }}
            >
              Address book
            </button>
          )}
          <button
            onClick={() => setModal("manageAccount")}
            style={{
              width: "100%",
              padding: 8,
              borderRadius: 8,
              border: `1px solid rgba(250,247,242,0.1)`,
              background: "transparent",
              color: T.sidebarText,
              fontSize: 11,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "inherit",
              marginBottom: 6,
            }}
          >
            Manage Account
          </button>
          <button
            onClick={handleLogout}
            disabled={logoutLoading}
            style={{
              width: "100%",
              padding: 8,
              borderRadius: 8,
              border: "1px solid rgba(250,247,242,0.1)",
              background: "transparent",
              color: T.sidebarText,
              fontSize: 11,
              fontWeight: 500,
              cursor: logoutLoading ? "default" : "pointer",
              fontFamily: "inherit",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
            }}
          >
            {logoutLoading
              ? <><BtnSpinnerDark />Signing out...</>
              : "Sign out"
            }
          </button>
        </div>
      </div>

      {/* Mobile bottom nav */}
      <div className="mobile-bottom-nav" style={{ display: "none", position: "fixed", bottom: 0, left: 0, right: 0, background: T.sidebar, zIndex: 40, borderTop: "1px solid rgba(250,247,242,0.08)", padding: "6px 8px env(safe-area-inset-bottom, 8px)" }}>
        {bottomNavItems.map(item => (
          <button key={item.id} onClick={() => nav(item.id)} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "8px 0", gap: 3, cursor: "pointer", color: page === item.id ? T.accent : T.sidebarText, background: "none", border: "none", fontFamily: "inherit" }}>
            <div style={{ width: 4, height: 4, borderRadius: "50%", background: page === item.id ? T.accent : "transparent", marginBottom: 2 }} />
            <Ico d={item.icon} size={22} color={page === item.id ? T.accent : T.sidebarText} />
            <span style={{ fontSize: 9, fontWeight: page === item.id ? 600 : 400, color: page === item.id ? T.accent : T.sidebarText }}>{item.label.split(" ")[0]}</span>
          </button>
        ))}
      </div>

      {/* Main */}
      <div className="main-wrap" style={{ flex: "0 0 calc(100% - 232px)", marginLeft: 232, display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        {/* Topbar */}
        <div className="topbar-shell" style={{ padding: "20px 28px", borderBottom: `1px solid ${T.borderSoft}`, background: T.bg, display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 20 }}>
          <div className="desktop-only-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
            <div>
              <div className="display topbar-title" style={{ fontSize: 28, color: T.ink, letterSpacing: -0.5, lineHeight: 1 }}>{pageTitle[page]}</div>
              <div style={{ fontSize: 12, color: T.muted, marginTop: 4 }}>{isManager ? dateLong() : currentUser.company}</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={refreshPortal} className="btn-soft" aria-label="Refresh portal" title="Refresh portal" style={{ width: 40, height: 40, minHeight: 40, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Ico d="M20 6v5h-5M4 18v-5h5M6.1 9A7 7 0 0 1 18.5 7M17.9 15A7 7 0 0 1 5.5 17" size={17} color={T.ink} />
              </button>
              {isManager && !invoiceController && (
                <>
                <button
                  type="button"
                  onClick={openUnreadStaffWork}
                  aria-label={`Open unread staff work${staffUnreadCount ? `, ${staffUnreadCount} unread` : ""}`}
                  title="Unread updates"
                  className="btn-soft"
                  style={{ width: 40, height: 40, padding: 0, position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}
                >
                  <Ico d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" size={17} color={T.ink} />
                  {staffUnreadCount > 0 && (
                    <span style={{ position: "absolute", top: -5, right: -5, minWidth: 18, height: 18, padding: "0 5px", borderRadius: 10, background: T.accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800 }}>
                      {staffUnreadCount > 99 ? "99+" : staffUnreadCount}
                    </span>
                  )}
                </button>
                <button onClick={doAutoAssign} className="btn-soft">Auto-dispatch</button>
                <button onClick={() => setModal("newWO")} className="btn-primary">+ Create Work Order</button>
                </>
              )}
            </div>
          </div>
          <div className="mobile-only-header">
            <div className="mobile-header-top">
              <button
                onClick={() => setDrawerOpen(true)}
                aria-label="Open menu"
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  background: T.bgWarm,
                  border: `1px solid ${T.border}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                }}
              >
                <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                  <rect x="0" y="3" width="18" height="2" rx="1" fill={T.ink} />
                  <rect x="0" y="8" width="18" height="2" rx="1" fill={T.ink} />
                  <rect x="0" y="13" width="18" height="2" rx="1" fill={T.ink} />
                </svg>
              </button>
              <div className="mobile-header-title">
                <div className="display" style={{ fontSize: 22, color: T.ink, letterSpacing: -0.3, lineHeight: 1 }}>{pageTitle[page]}</div>
                <div style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>{isManager ? dateLong() : currentUser.company}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button
                  type="button"
                  onClick={refreshPortal}
                  aria-label="Refresh portal"
                  title="Refresh portal"
                  style={{ width: 40, height: 40, borderRadius: 10, border: `1px solid ${T.border}`, background: T.bgWarm, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                >
                  <Ico d="M20 6v5h-5M4 18v-5h5M6.1 9A7 7 0 0 1 18.5 7M17.9 15A7 7 0 0 1 5.5 17" size={17} color={T.ink} />
                </button>
                {isManager && !invoiceController && (
                  <button
                  type="button"
                  onClick={openUnreadStaffWork}
                  aria-label={`Open unread staff work${staffUnreadCount ? `, ${staffUnreadCount} unread` : ""}`}
                  style={{ width: 40, height: 40, borderRadius: 10, border: `1px solid ${T.border}`, background: T.bgWarm, position: "relative", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                >
                  <Ico d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" size={17} color={T.ink} />
                  {staffUnreadCount > 0 && (
                    <span style={{ position: "absolute", top: -5, right: -5, minWidth: 18, height: 18, padding: "0 5px", borderRadius: 10, background: T.accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800 }}>
                      {staffUnreadCount > 99 ? "99+" : staffUnreadCount}
                    </span>
                  )}
                  </button>
                )}
              </div>
            </div>
            {isManager && !invoiceController && (
              <div className="mobile-header-actions">
                <button onClick={doAutoAssign} className="btn-soft">Auto-dispatch</button>
                <button onClick={() => setModal("newWO")} className="btn-primary">+ Create Work Order</button>
              </div>
            )}
          </div>
        </div>

        <div
          className="pull-refresh-indicator"
          role="status"
          aria-live="polite"
          style={{
            height: isRefreshing ? 44 : Math.min(44, pullDistance),
            transition: pullDistance > 0 ? "none" : "height 160ms ease",
          }}
        >
          {isRefreshing
            ? "Refreshing portal…"
            : pullDistance >= 64
              ? "Release to refresh"
              : pullDistance > 0
                ? "Pull to refresh"
                : ""}
        </div>

        <div
          ref={contentScrollRef}
          className="content-pad"
          onTouchStart={handlePullStart}
          onTouchMove={handlePullMove}
          onTouchEnd={handlePullEnd}
          onTouchCancel={handlePullEnd}
          onScroll={(event: any) => {
            if (typeof window === "undefined") return;
            schedulePortalScrollPersistence(event.currentTarget.scrollTop);
          }}
          style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: 28, paddingBottom: 80 }}
        >
          <Dashboard
            page={page}
            isManager={isManager}
            workOrders={dashboardWorkOrders}
            p1Unassigned={p1Unassigned}
            slaBreached={slaBreached}
            nav={nav}
            onViewUnassigned={openUnassignedWorkOrders}
            doAutoAssign={doAutoAssign}
            invoices={invoices}
            currentUser={currentUser}
            staffProfiles={staffProfiles}
            getUser={getUser}
            setSelectedWO={setSelectedWO}
            setAiNote={setAiNote}
            setPage={setPage}
            search={search}
            setSearch={setSearch}
            woParts={woParts}
          />

          {isManager && !invoiceController && (
            <StaffWorkHub
              page={page}
              rows={staffWorkRows}
              filter={staffWorkFilter}
              setFilter={setStaffWorkFilter}
              staffProfiles={staffProfiles}
              currentUserId={currentUser?.id || ""}
              summaryCounts={navigationSummary ? {
                all: navigationSummary.staffWorkCount,
                unread: navigationSummary.staffUnreadCount,
                todo: navigationSummary.myTodoCount,
                ready: navigationSummary.readyToBillCount,
              } : undefined}
              busyWorkOrderId={staffWorkBusyId}
              onOpenWorkOrder={openStaffWorkOrder}
              onAddTodo={(workOrderId: string) => void runStaffWorkAction(
                workOrderId,
                () => addStaffWorkTodo(workOrderId),
                "Added to your to-do list",
              )}
              onCompleteTodo={(workOrderId: string) => void runStaffWorkAction(
                workOrderId,
                () => completeStaffWorkTodo(workOrderId),
                "To-do completed",
              )}
              onTransferTodo={(workOrderId: string, ownerId: string) => void runStaffWorkAction(
                workOrderId,
                () => transferStaffWorkTodo(workOrderId, ownerId),
                "To-do owner updated",
              )}
              onOpenBilling={(workOrderId: string) => openBillingForWorkOrder(workOrderId)}
            />
          )}

          <WorkOrderList
            key={workOrderStoreView
              ? `store-${workOrderStoreView.requestId}`
              : "work-orders"}
            page={page}
            selectedWO={selectedWO}
            search={search}
            setSearch={setSearch}
            isManager={isManager}
            filterC={filterC}
            setFilterC={setFilterC}
            contractorsOnly={contractorsOnly}
            filterP={filterP}
            setFilterP={setFilterP}
            filterStatus={filterStatus}
            setFilterStatus={setFilterStatus}
            filteredWOs={filteredWOs}
            slaLabel={slaLabel}
            setSelectedWO={setSelectedWO}
            setAiNote={setAiNote}
            setPage={setPage}
            getUser={getUser}
            storeView={workOrderStoreView}
            onClearStoreView={() => setWorkOrderStoreView(null)}
          />

          <CapitalProjects page={page} isManager={isManager} capitalCount={capitalCount} workOrders={maskedWorkOrders} setSelectedWO={setSelectedWO} setPage={setPage} setAiNote={setAiNote} getUser={getUser} fmt={fmt} />

          <MyJobs page={page} isManager={isManager} myWOs={myWOs} currentUser={currentUser} activeStatuses={activeStatuses} slaLabel={slaLabel} setSelectedWO={setSelectedWO} setPage={setPage} setAiNote={setAiNote} woParts={woParts} />

          <SubDispatchView page={page} currentUser={currentUser} USERS={USERS} technicians={technicians} workOrders={maskedWorkOrders} setSelectedWO={setSelectedWO} setPage={setPage} setAiNote={setAiNote} doAssign={doAssign} doReassign={doReassign} doSetTechnician={doSetTechnician} doAssignPortalTechnician={doAssignPortalTechnician} getUser={getUser} loadingStates={loadingStates} />

          <InvoiceList page={page} selectedInvoice={selectedInvoice} invTab={invTab} setInvTab={setInvTab} isManager={isManager} invoices={invoices} currentUser={currentUser} setSelectedInvoice={setSelectedInvoice} getUser={getUser} fmt={fmt} doBatchReviewInvoices={doBatchReviewInvoices} onEditRejected={openCreateInvoice} />

          <InvoiceDetail
            page={page}
            selectedInvoice={selectedInvoice}
            invoices={invoiceDetailRows}
            billingInvoices={billingInvoices}
            workOrders={invoiceDetailWorkOrders}
            isManager={isManager}
            currentUser={currentUser}
            getUser={getUser}
            setSelectedInvoice={setSelectedInvoice}
            onBack={() => {
              if (!returnToWorkflowWorkOrder()) setSelectedInvoice(null);
            }}
            backLabel={workflowReturn?.workOrderId
              ? `Back to ${workflowReturn.workOrderId}`
              : "Back to invoices"}
            onOpenBillingInvoice={(invoice: any) => {
              setSelectedInvoice(null);
              setSelectedBillingInvoice(invoice.id);
              setPage("billing");
            }}
            onEditRejected={openCreateInvoice}
            doApproveInvoice={doApproveInvoice}
            doMarkPaid={doMarkPaid}
            doDownloadInvoice={doDownloadInvoice}
            doDownloadInvoiceCsv={doDownloadInvoiceCsv}
            doDeleteInvoice={doDeleteInvoice}
            doRejectInvoice={doRejectInvoice}
            doRetractInvoiceRejection={doRetractInvoiceRejection}
            doCorrectInvoiceTotal={doCorrectInvoiceTotal}
            doPlaceInvoicePaymentHold={doPlaceInvoicePaymentHold}
            doReleaseInvoicePaymentHold={doReleaseInvoicePaymentHold}
            pdfBusy={pdfBusy}
            fmt={fmt}
            loadingStates={loadingStates}
          />

          {isManager && !invoiceController && page === "billing" && !selectedBillingInvoice && (
            <BillingInvoiceList
              page={page}
              currentUser={currentUser}
              invoices={billingInvoices}
              contractorInvoices={invoices}
              readyWorkOrders={billingReadyWorkOrders}
              setSelectedBillingInvoice={setSelectedBillingInvoice}
              onCreate={() => {
                setBillingDraftToEdit(null);
                setBillingSourceToStart(null);
                setBillingWorkOrderToStart(null);
                setModal("createBillingInvoice");
              }}
              onCreateFromApproved={(invoice: any) => {
                setBillingDraftToEdit(null);
                setBillingSourceToStart(invoice.id);
                setBillingWorkOrderToStart(null);
                setModal("createBillingInvoice");
              }}
              onCreateFromWorkOrder={(workOrder: any) => openBillingForWorkOrder(workOrder.id)}
              onOpenReadyInvoice={(invoice: any) => setSelectedBillingInvoice(invoice.id)}
              fmt={fmt}
              fire={fire}
            />
          )}

          {isManager && !invoiceController && page === "billing" && selectedBillingInvoice && (
            <BillingInvoiceDetail
              invoice={selectedBillingInvoiceData}
              workOrder={selectedBillingInvoiceData?.wot
                ? selectedBillingWorkOrder
                : null}
              invoiceLines={selectedBillingInvoiceData?.lines || []}
              onBack={() => {
                if (!returnToWorkflowWorkOrder()) setSelectedBillingInvoice(null);
              }}
              backLabel={workflowReturn?.workOrderId
                ? `Back to ${workflowReturn.workOrderId}`
                : "Back to billing"}
              onEdit={() => {
                if (
                  !selectedBillingInvoiceData
                  || !["draft", "submitted"].includes(selectedBillingInvoiceData.state)
                  || selectedBillingInvoiceData.qboInvoiceId
                  || selectedBillingInvoiceData.qboSyncedAt
                ) return;
                setBillingDraftToEdit(selectedBillingInvoiceData);
                setBillingSourceToStart(null);
                setBillingWorkOrderToStart(null);
                setModal("createBillingInvoice");
              }}
              onDownloadPdf={() => selectedBillingInvoiceData && doDownloadBillingInvoice(selectedBillingInvoiceData)}
              onDownloadCsv={() => selectedBillingInvoiceData && doDownloadBillingInvoiceCsv(selectedBillingInvoiceData)}
              onMarkBilled={() => selectedBillingInvoiceData && doMarkBillingInvoiceBilled(selectedBillingInvoiceData)}
              onMarkReady={() => selectedBillingInvoiceData && doMarkBillingInvoiceReady(selectedBillingInvoiceData)}
              onDelete={() => selectedBillingInvoiceData && doDeleteBillingInvoice(selectedBillingInvoiceData)}
              onOpenContractorInvoice={(invoice: any) => { setSelectedBillingInvoice(null); setSelectedInvoice(invoice.id); setPage("invoices"); }}
              currentUser={currentUser}
              fmt={fmt}
            />
          )}

          <ContractorList
            page={page}
            isManager={isManager}
            contractorsOnly={assignableContractors}
            technicians={technicians}
            users={USERS}
            workOrders={workOrders}
            activeStatuses={activeStatuses}
            nav={nav}
            setFilterC={setFilterC}
            fire={fire}
          />

          {isManager && !invoiceController && (
            <StaffContractorPreview
              page={page}
              contractors={assignableContractors}
            />
          )}

          <HistoryView
            page={page}
            isManager={isManager}
            canReopen={isManager && !invoiceController}
            onRequestReopen={requestReopen}
            selectedWO={selectedWO}
            histFrom={histFrom}
            setHistFrom={setHistFrom}
            histTo={histTo}
            setHistTo={setHistTo}
            histSearch={histSearch}
            setHistSearch={setHistSearch}
            histContractor={histContractor}
            setHistContractor={setHistContractor}
            histReso={histReso}
            setHistReso={setHistReso}
            invoices={invoices}
            closedWOs={closedWOs}
            contractorsOnly={contractorsOnly}
            setSelectedWO={setSelectedWO}
            setAiNote={setAiNote}
            getUser={getUser}
            fmt={fmt}
          />

          {page === "wo_detail" && selectedWO && !woData && selectedWorkOrderQuery.isLoading && (
            <div className="card" role="status" style={{ padding: "28px 20px", color: T.muted, textAlign: "center" }}>
              Loading work order...
            </div>
          )}

          {page === "wo_detail" && selectedWO && !woData && selectedWorkOrderQuery.isError && (
            <div className="card" role="alert" style={{ padding: "24px 20px", textAlign: "center" }}>
              <div style={{ color: T.ink, fontWeight: 700, marginBottom: 6 }}>Work order could not load</div>
              <div style={{ color: T.muted, fontSize: 12, marginBottom: 14 }}>
                Retry the secure connection to open this work order.
              </div>
              <button
                type="button"
                className="btn-soft"
                onClick={() => void selectedWorkOrderQuery.refetch()}
                disabled={selectedWorkOrderQuery.isFetching}
              >
                {selectedWorkOrderQuery.isFetching ? "Retrying..." : "Retry"}
              </button>
            </div>
          )}

          <WorkOrderDetail
            page={page}
            selectedWO={selectedWO}
            woData={woData}
            workOrders={maskedWorkOrders}
            invoices={invoices}
            billingInvoices={billingInvoices}
            technicians={technicians}
            USERS={USERS}
            modal={modal}
            isManager={isManager}
            setSelectedWO={setSelectedWO}
            onBackFromWorkOrder={backFromWorkOrder}
            onBackToAllWorkOrders={backToAllWorkOrders}
            onViewStoreWorkOrders={openStoreWorkOrders}
            setSelectedInvoice={setSelectedInvoice}
            onOpenContractorInvoice={openContractorInvoiceFromWorkOrder}
            setAiNote={setAiNote}
            setPage={setPage}
            slaLabel={slaLabel}
            slaRemaining={slaRemaining}
            fmt={fmt}
            getUser={getUser}
            contractorsOnly={assignableContractors}
            doAssign={doAssign}
            doStraightToBilling={handleStraightToBilling}
            setReassignTarget={setReassignTarget}
            setModal={setModal}
            doCapitalFlag={doCapitalFlag}
            doCapitalDecline={doCapitalDecline}
            doCapitalComplete={handleCapitalCompleted}
            onOpenBillingForWorkOrder={openBillingFromWorkOrder}
            doMoveToInvoice={doMoveToInvoice}
            doFinishContractorInvoicing={doFinishContractorInvoicing}
            doApproveInvoice={doApproveInvoice}
            onApproveAndGoToBilling={approveInvoiceAndOpenBilling}
            doMarkPaid={doMarkPaid}
            doCloseWO={doCloseWO}
            doCloseWithoutInvoice={doCloseWithoutInvoice}
            onRequestReopen={requestReopen}
            doDownloadInvoice={doDownloadInvoice}
            doDeleteInvoice={doDeleteInvoice}
            doRejectInvoice={doRejectInvoice}
            doRetractInvoiceRejection={doRetractInvoiceRejection}
            openCreateInvoice={openCreateInvoice}
            onConvertQuote={async (payload: Record<string, unknown>) => {
              if (woData?.id) rememberWorkOrderReturn(woData.id);
              return doConvertQuoteToBillingInvoice(payload);
            }}
            pdfBusy={pdfBusy}
            activityMenuId={activityMenuId}
            setActivityMenuId={setActivityMenuId}
            setPendingDelete={setPendingDelete}
            currentUser={currentUser}
            fire={fire}
            aiNote={aiNote}
            aiEnhancing={aiEnhancing}
            doAiEnhance={doAiEnhance}
            noteText={noteText}
            setNoteText={setNoteText}
            doPostNote={doPostNote}
            doSetTechnician={doSetTechnician}
            doAssignPortalTechnician={doAssignPortalTechnician}
            imageErrors={imageErrors}
            setImageErrors={setImageErrors}
            setLightbox={setLightbox}
            doAddPhotos={doAddPhotos}
            doRemovePhoto={doRemovePhoto}
            doDeleteActivity={doDeleteActivity}
            doSetEta={doSetEta}
            doStartWork={doStartWork}
            doPauseWork={doPauseWork}
            doCloseComplete={doCloseComplete}
            doMarkSevenElevenSynced={doMarkSevenElevenSynced}
            doMarkContractorAttention={doMarkContractorAttention}
            doAcknowledgeContractorAttention={doAcknowledgeContractorAttention}
            startDateInput={startDateInput}
            setStartDateInput={setStartDateInput}
            startTimeInput={startTimeInput}
            setStartTimeInput={setStartTimeInput}
            pauseDateInput={pauseDateInput}
            setPauseDateInput={setPauseDateInput}
            pauseTimeInput={pauseTimeInput}
            setPauseTimeInput={setPauseTimeInput}
            loadingStates={loadingStates}
            woParts={woParts}
            doAddPart={doAddPart}
            doUpdatePart={doUpdatePart}
            doDeletePart={doDeletePart}
            doRequestP1PartOrder={doRequestP1PartOrder}
            doSetP1PartOrderStatus={doSetP1PartOrderStatus}
            staffTodo={selectedStaffTodo}
            staffTodoOwner={selectedStaffTodoOwner}
            staffProfiles={staffProfiles}
            staffMyTodoCount={staffMyTodoCount}
            staffTodoBusy={staffWorkBusyId === woData?.id}
            onAddStaffTodo={(workOrderId: string) => void runStaffWorkAction(
              workOrderId,
              () => addStaffWorkTodo(workOrderId),
              "Added to your to-do list",
            )}
            onCompleteStaffTodo={(workOrderId: string) => void runStaffWorkAction(
              workOrderId,
              () => completeStaffWorkTodo(workOrderId),
              "To-do completed",
            )}
            onTransferStaffTodo={(workOrderId: string, ownerId: string) => void runStaffWorkAction(
              workOrderId,
              () => transferStaffWorkTodo(workOrderId, ownerId),
              "To-do owner updated",
            )}
            onLoadMoreActivities={workOrderDetailsQuery.loadMoreActivities}
            onLoadMorePhotos={workOrderDetailsQuery.loadMorePhotos}
            onLoadMoreVisits={workOrderDetailsQuery.loadMoreVisits}
            loadingMoreActivities={workOrderDetailsQuery.loadingActivities}
            loadingMorePhotos={workOrderDetailsQuery.loadingPhotos}
            loadingMoreVisits={workOrderDetailsQuery.loadingVisits}
          />

          <div className="mobile-footer-spacer" style={{ display: "none" }} />
        </div>
      </div>


      {/* ===== MODALS ===== */}
      {modal === "newWO" && (
        <WorkOrderCreateForm
          onClose={() => setModal(null)}
          doCreateWO={doCreateWO}
          contractorsOnly={assignableContractors}
          setSelectedWO={setSelectedWO}
          setPage={setPage}
          setAiNote={setAiNote}
          isManager={isManager}
        />
      )}
      {modal === "manageAccount" && currentUser && (
        <ManageAccountModal
          currentUser={currentUser}
          onClose={() => setModal(null)}
          fire={fire}
        />
      )}
      {modal === "setEta" && woData && (
        <Modal onClose={() => setModal(null)} title="Set ETA" width={400}>
          <div style={{ fontSize: 13, color: T.muted, marginBottom: 16 }}>When will you arrive at Store #{woData.store}?</div>
          <div style={{ display: "grid", gap: 14 }}>
            <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Date"><DatePickerField value={etaDateInput} onChange={setEtaDateInput} /></Field>
              <Field label="Time"><TimePickerField value={etaTimeInput} onChange={setEtaTimeInput} /></Field>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 22, justifyContent: "flex-end" }}>
            <button onClick={() => setModal(null)} className="btn-soft">Cancel</button>
            <button
              onClick={async () => {
              setModalLoading(true);
              try {
              // Save a real ISO timestamp (column is timestamptz) using the
              // exact date + time the user picked — same pattern as Start
              // Work. The display layer formats this for humans on read.
              const dv = etaDateInput || dateTimeInputPartsInTimeZone(
                new Date(),
                timezoneForWorkOrder(woData),
              ).date;
              const t = etaTimeInput || "14:00";
              const eta = storeLocalDateTimeToIso(
                dv,
                t,
                timezoneForWorkOrder(woData),
              );
              await doSetEta(woData.id, eta); setModal(null);
              } finally {
                setModalLoading(false);
              }
            }}
              disabled={modalLoading}
              className="btn-primary"
              style={modalActionStyle}
            >{modalLoading ? <><BtnSpinner />Setting...</> : "Set ETA"}</button>
          </div>
        </Modal>
      )}

      {modal === "reassign" && woData && (
        <Modal onClose={() => setModal(null)} title="Reassign work order" width={420}>
          <div className="reassign-copy" style={{ fontSize: 13, color: T.muted, marginBottom: 16 }}>
            Currently assigned to <span style={{ color: T.ink, fontWeight: 600 }}>{woData.contractor ? (getUser(woData.contractor)?.name || "-") : "Unassigned"}</span>. Pick a new contractor - the original SLA deadline is preserved.
          </div>
          <div className="reassign-picker">
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 8 }}>New contractor</div>
            {assignableContractors.length >= 10 && (
              <div className="reassign-search-wrap" style={{ position: "relative", marginBottom: 10 }}>
                <input
                  className="reassign-search"
                  value={reassignSearch}
                  onChange={(e: any) => setReassignSearch(e.target.value)}
                  placeholder="Search contractor, company, territory..."
                  autoComplete="off"
                  style={{
                    width: "100%",
                    padding: "11px 36px 11px 13px",
                    borderRadius: 12,
                    border: `1px solid ${T.border}`,
                    background: T.surfaceSoft,
                    color: T.ink,
                    fontSize: 13,
                    fontFamily: "inherit",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
                {reassignSearch && (
                  <button
                    type="button"
                    onClick={() => setReassignSearch("")}
                    aria-label="Clear contractor search"
                    style={{
                      position: "absolute",
                      right: 8,
                      top: "50%",
                      transform: "translateY(-50%)",
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      border: "none",
                      background: T.bgWarm,
                      color: T.muted,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 14,
                    }}
                  >
                    x
                  </button>
                )}
              </div>
              )}
            <div className="reassign-options" style={{ display: "grid", gap: 8, maxHeight: 280, overflowY: "auto", overflowX: "hidden", paddingRight: 2 }}>
              {reassignContractorOptions.map(c => {
                const selected = reassignTarget === c.id;
                const current = c.id === woData.contractor;
                return (
                  <button
                    className="reassign-option"
                    key={c.id}
                    type="button"
                    onClick={() => {
                      if (!current) setReassignTarget(c.id);
                    }}
                    disabled={current}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: "12px 14px",
                      borderRadius: 12,
                      border: `1px solid ${selected ? T.accent : T.borderSoft}`,
                      background: selected ? T.accentSoft : current ? T.bgWarm : T.surface,
                      cursor: current ? "default" : "pointer",
                      opacity: current ? 0.62 : 1,
                      fontFamily: "inherit",
                      boxShadow: selected ? `0 0 0 2px ${T.accent}18` : "0 1px 2px rgba(31,30,28,0.03)",
                    }}
                  >
                    <div className="reassign-option-row" style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                      <div className="reassign-option-main" style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: current ? T.subtle : T.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</div>
                        <div style={{ fontSize: 11, color: T.muted, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {[c.company, c.territory].filter(Boolean).join(" · ") || "Contractor"}
                        </div>
                      </div>
                      <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, borderRadius: 999, padding: "3px 8px", color: current ? T.subtle : selected ? "#fff" : T.accent, background: current ? T.borderSoft : selected ? T.accent : T.accentSoft }}>
                        {current ? "Current" : selected ? "Selected" : "Choose"}
                      </span>
                    </div>
                  </button>
                );
              })}
              {reassignContractorOptions.length === 0 && (
                <div style={{
                  padding: "18px 14px",
                  borderRadius: 12,
                  border: `1px dashed ${T.border}`,
                  background: T.surfaceSoft,
                  color: T.subtle,
                  fontSize: 12,
                  textAlign: "center",
                }}>
                  No contractors match your search
                </div>
              )}
            </div>
          </div>
          <div className="reassign-actions" style={{ display: "flex", gap: 8, marginTop: 22, justifyContent: "flex-end" }}>
            <button onClick={() => setModal(null)} className="btn-soft">Cancel</button>
            <button
              onClick={async () => {
                if (!reassignTarget || reassignTarget === woData.contractor) return;
                setModalLoading(true);
                try {
                  await doReassign(woData.id, reassignTarget);
                  setModal(null);
                  setReassignTarget("");
                } finally {
                  setModalLoading(false);
                }
              }}
              disabled={modalLoading}
              className="btn-primary"
              style={modalActionStyle}
            >{modalLoading ? <><BtnSpinner />Reassigning...</> : "Reassign"}</button>
          </div>
        </Modal>
      )}

      {modal === "unassign" && woData && (
        <Modal onClose={() => setModal(null)} title="Unassign work order" width={420}>
          <div style={{ fontSize: 13, color: T.muted, marginBottom: 20, lineHeight: 1.55 }}>
            Unassign this work order? This will move it back to <span style={{ color: T.ink, fontWeight: 600 }}>Unassigned</span> and clear the contractor.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setModal(null)} className="btn-soft">Cancel</button>
            <button
              onClick={async () => {
                setModalLoading(true);
                try {
                  await doUnassign(woData.id);
                  setModal(null);
                } finally {
                  setModalLoading(false);
                }
              }}
              disabled={modalLoading}
              className="btn-primary"
              style={modalActionStyle}
            >{modalLoading ? <><BtnSpinner />Unassigning...</> : "Unassign"}</button>
          </div>
        </Modal>
      )}

      {modal === "deleteWO" && woData && (
        <Modal onClose={() => setModal(null)} title="Delete work order?" width={440}>
          <div style={{ fontSize: 13, color: T.muted, marginBottom: 20, lineHeight: 1.55 }}>
            This will remove WOT <span className="mono" style={{ color: T.ink, fontWeight: 600 }}>{woData.id}</span>{" "}
            <CopyWorkOrderButton value={woData.id} /> from all views. This action can be undone by an admin via the database.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setModal(null)} className="btn-soft">Cancel</button>
            <button
              onClick={async () => {
                setModalLoading(true);
                try {
                  await doDeleteWO(woData.id);
                  setModal(null);
                } finally {
                  setModalLoading(false);
                }
              }}
              disabled={modalLoading}
              style={{ padding: "10px 18px", borderRadius: 10, background: T.danger, color: "#fff", border: "none", cursor: modalLoading ? "default" : "pointer", fontWeight: 600, fontSize: 12, fontFamily: "inherit", opacity: modalLoading ? 0.7 : 1, display: "flex", alignItems: "center", gap: 6 }}
            >{modalLoading ? <><BtnSpinner />Deleting...</> : "Delete"}</button>
          </div>
        </Modal>
      )}

      {modal === "closeWithoutInvoice" && woData && (
        <Modal onClose={() => setModal(null)} title="Close without an invoice" width={460}>
          <div style={{ fontSize: 13, color: T.muted, marginBottom: 20, lineHeight: 1.55 }}>
            Close <span className="mono" style={{ color: T.accent, fontWeight: 600 }}>{woData.id}</span>{" "}
            <CopyWorkOrderButton value={woData.id} /> without an invoice? The work order will appear in History immediately and leave the active board after the normal 24-hour closed-job window.
            <br /><br />No invoice, line item, activity, photo, part, or assignment history will be deleted. Any open visit will be closed at the time of this action.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setModal(null)} disabled={modalLoading} className="btn-soft">Cancel</button>
            <button
              onClick={async () => {
                setModalLoading(true);
                try {
                  const closed = await doCloseWithoutInvoice(woData.id);
                  if (closed) setModal(null);
                } finally {
                  setModalLoading(false);
                }
              }}
              disabled={modalLoading}
              className="btn-primary"
              style={modalActionStyle}
            >{modalLoading ? <><BtnSpinner />Closing...</> : "Close — no invoice"}</button>
          </div>
        </Modal>
      )}

      {modal === "closeWO" && woData && (() => {
        const notHandedOff = invoices.filter((i: any) => i.wot === woData.id && (i.state === "submitted" || i.state === "revised" || i.state === "approved")).length;
        return (
          <Modal onClose={() => setModal(null)} title="Close work order" width={460}>
            <div style={{ fontSize: 13, color: T.muted, marginBottom: 20, lineHeight: 1.55 }}>
              Close <span className="mono" style={{ color: T.accent, fontWeight: 600 }}>{woData.id}</span>{" "}
              <CopyWorkOrderButton value={woData.id} />? It moves to History after the 24h linger, and contractors can no longer add invoices.{notHandedOff > 0 ? <><br /><br /><strong style={{ color: T.warn }}>{notHandedOff} invoice{notHandedOff === 1 ? " has" : "s have"} not been sent to QuickBooks.</strong> The work order can still close; invoice handoff remains available separately.</> : null}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setModal(null)} className="btn-soft">Cancel</button>
              <button
                onClick={async () => {
                  setModalLoading(true);
                  try {
                    await doCloseWO(woData.id);
                    setModal(null);
                  } finally {
                    setModalLoading(false);
                  }
                }}
                disabled={modalLoading}
                className="btn-primary"
                style={modalActionStyle}
              >{modalLoading ? <><BtnSpinner />Closing...</> : "Close work order"}</button>
            </div>
          </Modal>
        );
      })()}

      {modal === "reopen" && reopenTarget && (() => {
        const reopenOptions = workOrderReopenOptions(reopenTarget);
        return (
          <Modal
            onClose={() => { if (!modalLoading) closeReopenModal(); }}
            closeOnBackdrop={!modalLoading}
            title="Reopen work order"
            width={540}
          >
            <div style={{ fontSize: 13, color: T.muted, marginBottom: 18, lineHeight: 1.55 }}>
              Choose why <span className="mono" style={{ color: T.accent, fontWeight: 600 }}>{reopenTarget.id}</span>{" "}
              <CopyWorkOrderButton value={reopenTarget.id} /> is being reopened. The selected purpose determines which operational queue receives it.
            </div>

            <div role="radiogroup" aria-label="Reopen purpose" style={{ display: "grid", gap: 10, marginBottom: 16 }}>
              {reopenOptions.map(option => {
                const selected = reopenMode === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={option.disabled || modalLoading}
                    onClick={() => {
                      setReopenMode(option.value);
                      setReopenError("");
                    }}
                    style={{
                      padding: "13px 14px",
                      borderRadius: 12,
                      border: `1px solid ${selected ? T.accent : T.border}`,
                      background: selected ? T.accentSoft : T.surface,
                      color: T.ink,
                      textAlign: "left",
                      fontFamily: "inherit",
                      cursor: option.disabled || modalLoading ? "not-allowed" : "pointer",
                      opacity: option.disabled ? 0.55 : 1,
                    }}
                  >
                    <span style={{ display: "block", fontSize: 13, fontWeight: 800 }}>{option.label}</span>
                    <span style={{ display: "block", marginTop: 4, fontSize: 11, color: T.muted, lineHeight: 1.45 }}>
                      {option.disabledReason || option.description}
                    </span>
                  </button>
                );
              })}
            </div>

            <Field label="Reason for reopening *">
              <TA
                rows={3}
                maxLength={WORK_ORDER_REOPEN_REASON_MAX_LENGTH}
                value={reopenReason}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                  setReopenReason(event.target.value);
                  setReopenError("");
                }}
                disabled={modalLoading}
                placeholder="Explain what needs to continue or be corrected..."
                aria-invalid={Boolean(reopenError)}
              />
            </Field>
            <div style={{ marginTop: -8, marginBottom: 14, textAlign: "right", fontSize: 10, color: T.subtle }}>
              {reopenReason.length}/{WORK_ORDER_REOPEN_REASON_MAX_LENGTH}
            </div>

            <div role="note" style={{ padding: "11px 12px", borderRadius: 10, background: T.warnSoft, color: "#73560C", fontSize: 11, lineHeight: 1.5, marginBottom: 14 }}>
              Existing invoices, contractor and technician assignments, historical activities, and prior visits will not be changed. Reopening sends no dispatch notification.
            </div>

            {reopenError && (
              <div role="alert" style={{ color: T.danger, background: T.dangerSoft, borderRadius: 9, padding: "9px 11px", fontSize: 11, marginBottom: 14 }}>
                {reopenError}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={closeReopenModal}
                disabled={modalLoading}
                className="btn-soft"
              >Cancel</button>
              <button
                type="button"
                onClick={async () => {
                  if (!reopenMode) {
                    setReopenError("Choose whether this is for field work or billing follow-up.");
                    return;
                  }
                  const reasonError = validateWorkOrderReopenReason(reopenReason);
                  if (reasonError) {
                    setReopenError(reasonError);
                    return;
                  }

                  setModalLoading(true);
                  setReopenError("");
                  try {
                    const reopened = await doReopen(
                      reopenTarget.id,
                      reopenMode,
                      normalizeWorkOrderReopenReason(reopenReason),
                    );
                    if (reopened) {
                      closeReopenModal();
                    } else {
                      setReopenError("The work order was not reopened. Review the error message, then retry.");
                    }
                  } finally {
                    setModalLoading(false);
                  }
                }}
                disabled={modalLoading}
                className="btn-primary"
                style={modalActionStyle}
              >{modalLoading ? <><BtnSpinner />Reopening...</> : "Reopen work order"}</button>
            </div>
          </Modal>
        );
      })()}

      {modal === "deleteActivity" && pendingDelete && (
        <Modal onClose={() => { setModal(null); setPendingDelete(null); }} title="Delete comment" width={420}>
          <div style={{ fontSize: 13, color: T.muted, marginBottom: 20, lineHeight: 1.55 }}>
            Delete this comment? This cannot be undone.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => { setModal(null); setPendingDelete(null); }} className="btn-soft">Cancel</button>
            <button
              onClick={async () => {
                setModalLoading(true);
                try {
                  if (pendingDelete) await doDeleteActivity(pendingDelete.woId, pendingDelete.activityId);
                  setModal(null);
                  setPendingDelete(null);
                } finally {
                  setModalLoading(false);
                }
              }}
              disabled={modalLoading}
              style={{ padding: "10px 18px", borderRadius: 10, background: T.danger, color: "#fff", border: "none", cursor: modalLoading ? "default" : "pointer", fontWeight: 600, fontSize: 12, fontFamily: "inherit", opacity: modalLoading ? 0.7 : 1, display: "flex", alignItems: "center", gap: 6 }}
            >{modalLoading ? <><BtnSpinner />Deleting...</> : "Delete"}</button>
          </div>
        </Modal>
      )}

      {modal === "editWO" && woData && isManager && (() => {
        const saveEdit = async () => {
          const orig: any = {
            priority: woData.priority || "",
            store: woData.store || "", city: woData.city || "", addr: woData.addr || "",
            lineOfService: woData.lineOfService || "", businessService: woData.businessService || "",
            category: woData.category || "", subCategory: woData.subCategory || "",
            afm: woData.afm || "", afmEmail: woData.afmEmail || "",
            summary: woData.summary || "", description: woData.description || "",
          };
          const patch: any = {};
          const entries: string[] = [];
          const textFields: [string, string][] = [
            ["store", "Store number"], ["city", "City"], ["addr", "Address"],
            ["lineOfService", "Line of Service"], ["businessService", "Business Service"],
            ["category", "Category"], ["subCategory", "Sub Category"],
            ["afm", "AFM name"], ["afmEmail", "AFM email"],
            ["summary", "Short description"], ["description", "Description"],
          ];
          for (const [key, label] of textFields) {
            const next = (editWoForm[key] || "").trim();
            if (next !== orig[key]) {
              patch[key] = next;
              entries.push(`${label} changed${orig[key] ? ` from "${orig[key]}"` : ""} to "${next || "(blank)"}" by ${currentUser.name}.`);
            }
          }
          if (editWoForm.priority && editWoForm.priority !== orig.priority) {
            patch.priority = editWoForm.priority;
            const fromL = PRIORITY[orig.priority]?.label || orig.priority || "(none)";
            const toL = PRIORITY[editWoForm.priority]?.label || editWoForm.priority;
            entries.push(`Priority changed from ${fromL} to ${toL} by ${currentUser.name}.`);
            // Recompute SLA breach windows off the existing intake time so the
            // SLA badge reflects the new priority's deadlines.
            const startedAt = woData.slaStartedAt ? new Date(woData.slaStartedAt) : new Date();
            const b = computeSlaBreaches(editWoForm.priority, startedAt);
            patch.responseBreachAt = b.responseBreachAt?.toISOString() ?? null;
            patch.resolutionBreachAt = b.resolutionBreachAt?.toISOString() ?? null;
          }
          if (entries.length === 0) { fire("No changes to save"); setModal(null); return; }
          setModalLoading(true);
          try {
            const ok = await doEditWorkOrder(woData.id, patch, entries);
            if (ok) setModal(null);
          } finally {
            setModalLoading(false);
          }
        };
        const set = (k: string) => (e: any) => setEditWoForm((f: any) => ({ ...f, [k]: e.target.value }));
        return (
          <Modal onClose={() => setModal(null)} title="Edit work order" width={620}>
            <div style={{ fontSize: 13, color: T.muted, marginBottom: 16, lineHeight: 1.55 }}>
              Editing <span className="mono" style={{ color: T.accent, fontWeight: 600 }}>{woData.id}</span>{" "}
              <CopyWorkOrderButton value={woData.id} />. Status, contractor assignment, and timestamps have their own actions and aren't edited here. Each change is logged.
            </div>
            <div style={{ display: "grid", gap: 14 }}>
              <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Priority"><Sel value={editWoForm.priority} onChange={set("priority")}>
                  {Object.entries(PRIORITY).map(([k, v]: any) => <option key={k} value={k}>{v.label}</option>)}
                </Sel></Field>
              </div>
              <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Store Number"><Input value={editWoForm.store} onChange={set("store")} /></Field>
                <Field label="City, State"><Input value={editWoForm.city} onChange={set("city")} /></Field>
              </div>
              <Field label="Store Address"><Input value={editWoForm.addr} onChange={set("addr")} /></Field>
              <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Line of Service"><Input value={editWoForm.lineOfService} onChange={set("lineOfService")} /></Field>
                <Field label="Business Service"><Sel value={editWoForm.businessService} onChange={set("businessService")}>
                  <option value="">Not set</option>
                  {["Refrigeration equipment", "Frozen Beverage - Equipment", "Cold Beverage - Equipment", "HVAC", "EMS", "Plumbing", "Hot food", "Ice merchandiser", "Walk-in cooler/freezer", "Septic/Grease"].map(c => <option key={c}>{c}</option>)}
                </Sel></Field>
              </div>
              <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Category"><Input value={editWoForm.category} onChange={set("category")} /></Field>
                <Field label="Sub Category"><Input value={editWoForm.subCategory} onChange={set("subCategory")} /></Field>
              </div>
              <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="AFM Name"><Input value={editWoForm.afm} onChange={set("afm")} /></Field>
                <Field label="AFM Email"><Input value={editWoForm.afmEmail} onChange={set("afmEmail")} /></Field>
              </div>
              <Field label="Short Description"><Input value={editWoForm.summary} onChange={set("summary")} /></Field>
              <Field label="Description"><TA rows={3} value={editWoForm.description} onChange={set("description")} /></Field>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 22, justifyContent: "flex-end" }}>
              <button onClick={() => setModal(null)} className="btn-soft">Cancel</button>
              <button onClick={saveEdit} disabled={modalLoading} className="btn-primary" style={{ opacity: modalLoading ? 0.7 : 1, cursor: modalLoading ? "default" : "pointer" }}>{modalLoading ? "Saving..." : "Save changes"}</button>
            </div>
          </Modal>
        );
      })()}

      {modal === "startWork" && woData && (
        <Modal onClose={() => setModal(null)} title={woData.status === "parts" ? "Resume work" : "Start work"} width={440}>
          <div style={{ fontSize: 13, color: T.muted, marginBottom: 16 }}>Checking in at Store #{woData.store}. Status will auto-sync to 7-Eleven.</div>
          <div style={{ display: "grid", gap: 14 }}>
            <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Arrival date"><DatePickerField value={startDateInput} onChange={setStartDateInput} /></Field>
              <Field label="Arrival time"><TimePickerField value={startTimeInput} onChange={setStartTimeInput} /></Field>
            </div>
            <Field label="Initial notes"><TA rows={2} value={startNotesInput} onChange={(e: any) => setStartNotesInput(e.target.value)} placeholder="What are you seeing on site?" /></Field>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 22, justifyContent: "flex-end" }}>
            <button onClick={() => setModal(null)} className="btn-soft">Cancel</button>
            <button
              onClick={async () => {
                setModalLoading(true);
                try {
                  await doStartWork(woData.id, startNotesInput);
                  setModal(null);
                } finally {
                  setModalLoading(false);
                }
              }}
              disabled={modalLoading}
              className="btn-accent"
              style={modalActionStyle}
            >{modalLoading ? <><BtnSpinner />{woData.status === "parts" ? "Resuming..." : "Starting..."}</> : (woData.status === "parts" ? "Resume" : "Start work")}</button>
          </div>
        </Modal>
      )}

      {modal === "pauseWork" && woData && (
        <Modal onClose={() => setModal(null)} title="Pause work" width={500}>
          <div style={{ fontSize: 13, color: T.muted, marginBottom: 16 }}>Why can't the job be completed this trip?</div>
          <div style={{ display: "grid", gap: 14 }}>
            <Field label="Reason"><Sel value={pauseReasonInput} onChange={(e: any) => setPauseReasonInput(e.target.value)}>
              <option value="">Select...</option>
              <option value="Temporary fix">Temporary fix - equipment partially working</option>
              <option value="Awaiting parts">Awaiting parts - equipment completely down</option>
            </Sel></Field>
            <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Stamp-out date"><DatePickerField value={pauseDateInput} onChange={setPauseDateInput} /></Field>
              <Field label="Stamp-out time"><TimePickerField value={pauseTimeInput} onChange={setPauseTimeInput} /></Field>
            </div>
            {pauseReasonInput === "Awaiting parts" && (
              <div style={{ padding: "14px 16px", background: T.warnSoft, borderRadius: 10, border: `1px solid ${T.warn}33` }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: T.warn, textTransform: "uppercase", letterSpacing: 0.8 }}>Parts on order</div>
                  <button
                    type="button"
                    onClick={() => setPausePartsList(prev => [...prev, { description: "", partNumber: "", qty: 1, expectedReturnDate: "" }])}
                    className="btn-soft"
                    style={{ padding: "5px 10px", fontSize: 11 }}
                  >+ Add part</button>
                </div>
                {pausePartsList.length === 0 && (
                  <div style={{ fontSize: 12, color: T.muted, marginBottom: 10, lineHeight: 1.5 }}>
                    Add one row per part you're waiting on. Status starts as <strong>Ordered</strong> — update Shipped / Received / Backordered from the parts list on the work order.
                  </div>
                )}
                <div style={{ display: "grid", gap: 12 }}>
                  {pausePartsList.map((row, i) => (
                    <div key={i} style={{ background: T.surface, borderRadius: 8, padding: 10, border: `1px solid ${T.warn}22` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: T.subtle, textTransform: "uppercase", letterSpacing: 0.6 }}>Part {i + 1}</div>
                        <button
                          type="button"
                          onClick={() => setPausePartsList(prev => prev.filter((_, j) => j !== i))}
                          style={{ background: "transparent", border: "none", color: T.subtle, cursor: "pointer", fontSize: 14, padding: 0 }}
                        >x</button>
                      </div>
                      <div style={{ display: "grid", gap: 8 }}>
                        <Field label="Description"><Input value={row.description} onChange={(e: any) => setPausePartsList(prev => prev.map((r, j) => j === i ? { ...r, description: e.target.value } : r))} placeholder="e.g. Evaporator coil" /></Field>
                        <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1.4fr 70px", gap: 8 }}>
                          <Field label="Part number"><Input value={row.partNumber} onChange={(e: any) => setPausePartsList(prev => prev.map((r, j) => j === i ? { ...r, partNumber: e.target.value } : r))} placeholder="e.g. BHL136BE" /></Field>
                          <Field label="Qty"><Input type="number" min="1" step="1" value={row.qty} onChange={(e: any) => setPausePartsList(prev => prev.map((r, j) => j === i ? { ...r, qty: Number(e.target.value) || 1 } : r))} /></Field>
                        </div>
                        <Field label="Expected return date"><DatePickerField value={row.expectedReturnDate} onChange={(v: string) => setPausePartsList(prev => prev.map((r, j) => j === i ? { ...r, expectedReturnDate: v } : r))} placeholder="Select return date" placement="right" mobileYOffset={-44} desktopYOffset={-72} avoidDesktopBottomCut /></Field>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <Field label="Notes"><TA rows={2} value={pauseNotesInput} onChange={(e: any) => setPauseNotesInput(e.target.value)} placeholder="Explain what was done so far..." /></Field>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 22, justifyContent: "flex-end" }}>
            <button onClick={() => setModal(null)} className="btn-soft">Cancel</button>
            <button
              onClick={async () => {
                setModalLoading(true);
                try {
                  await doPauseWork(woData.id, pauseReasonInput, partDescInput, partNumInput, partEtaInput, pauseNotesInput, pausePartsList);
                  setModal(null);
                } finally {
                  setModalLoading(false);
                }
              }}
              disabled={modalLoading}
              className="btn-accent"
              style={modalActionStyle}
            >{modalLoading ? <><BtnSpinner />Pausing...</> : "Pause work"}</button>
          </div>
        </Modal>
      )}

      {modal === "closeComplete" && woData && !isManager && (
        <Modal
          onClose={() => setModal(null)}
          title={combinesContractorCompletion ? "Complete work & invoicing" : "Mark work complete"}
          width={540}
        >
          <div style={{ fontSize: 13, color: T.muted, marginBottom: 16 }}>
            {combinesContractorCompletion
              ? contractorFieldAlreadyComplete
                ? `Field work for Store #${woData.store} is already complete. Confirm the current contractor invoice set to finish this job.`
                : `Complete field work for Store #${woData.store} and confirm the current contractor invoice set in one action.`
              : `Complete the job for Store #${woData.store}. Asset info is required.`}
          </div>
          {combinesContractorCompletion && (
            <div style={{ padding: "12px 14px", marginBottom: 16, background: T.successSoft, borderRadius: 10, border: `1px solid ${T.success}33`, color: T.ink, fontSize: 12, lineHeight: 1.5 }}>
              This confirms that every contractor invoice for this work order has been submitted. P1 review and billing remain separate.
            </div>
          )}
          {(!combinesContractorCompletion || !contractorFieldAlreadyComplete) && <div style={{ display: "grid", gap: 14 }}>
            <div style={{ padding: "14px 16px", background: T.accentSoft, borderRadius: 10, border: `1px solid ${T.accentRing}` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.accent, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.8 }}>Asset information (required)</div>
              <Field label="Equipment make"><Input value={assetMakeInput} onChange={(e: any) => setAssetMakeInput(e.target.value)} placeholder="e.g. Taylor" /></Field>
              <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
                <Field label="Asset model"><Input value={assetModelInput} onChange={(e: any) => setAssetModelInput(e.target.value)} placeholder="e.g. Taylor 340" /></Field>
                <Field label="Serial number"><Input value={assetSerialInput} onChange={(e: any) => setAssetSerialInput(e.target.value)} placeholder="e.g. TY-2022-81402" /></Field>
              </div>
              <div style={{ marginTop: 12 }}>
                <Field label="Equipment year *"><Input type="number" value={assetYearInput} onChange={(e: any) => setAssetYearInput(e.target.value)} placeholder="e.g. 2019" /></Field>
              </div>
            </div>
            <div style={{ padding: "14px 16px", background: T.successSoft, borderRadius: 10, border: `1px solid ${T.success}33` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.success, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.8 }}>DSP closure</div>
              <Field label="Resolution code"><Sel value={resolutionInput} onChange={(e: any) => setResolutionInput(e.target.value)}>
                <option value="">Select...</option>
                <option>Nuisance</option>
                <option>Current Asset Repaired</option>
                <option>Current Asset Replaced</option>
                <option>OEM Warranty Related</option>
                <option>Other</option>
              </Sel></Field>
            </div>
            <Field label="Closing notes"><TA id="resolution-notes" rows={3} value={resolutionNotesInput} onChange={(e: any) => setResolutionNotesInput(e.target.value)} placeholder="Brief summary of what was found and done..." /></Field>
            <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="End date"><DatePickerField value={closeDateInput} onChange={setCloseDateInput} /></Field>
              <Field label="End time"><TimePickerField value={closeTimeInput} onChange={setCloseTimeInput} /></Field>
            </div>
          </div>}
          <div style={{ display: "flex", gap: 8, marginTop: 22, justifyContent: "flex-end" }}>
            <button onClick={() => setModal(null)} className="btn-soft">Cancel</button>
            <button
              onClick={async () => {
              setModalLoading(true);
              try {
              const mk = assetMakeInput.trim();
              const m = assetModelInput.trim();
              const s = assetSerialInput.trim();
              const y = parseInt(assetYearInput, 10);
              if ((!mk || !m || !s) && !contractorFieldAlreadyComplete) { fire("Equipment make, model, and serial number are required"); return; }
              const completedAt = closeDateInput && closeTimeInput
                ? storeLocalDateTimeToIso(
                    closeDateInput,
                    closeTimeInput,
                    timezoneForWorkOrder(woData),
                  )
                : new Date().toISOString();
              const completed = await doCloseComplete(woData.id, mk, m, s, resolutionInput, isFinite(y) ? y : null, completedAt, resolutionNotesInput);
              if (completed !== false) setModal(null);
              } finally {
                setModalLoading(false);
              }
            }}
              disabled={modalLoading}
              className="btn-primary"
              style={modalActionStyle}
            >{modalLoading
              ? <><BtnSpinner />Completing...</>
              : combinesContractorCompletion
                ? "Complete work & invoicing"
                : "Mark work complete"}</button>
          </div>
        </Modal>
      )}

      <InvoiceCreateModal modal={modal} woData={invoiceFormWorkOrder} invSubtotal={invSubtotal} newInv={newInv} lineAmount={lineAmount} invoices={invoices} currentUser={currentUser} setNewInv={setNewInv} fmt={fmt} setModal={(v: any) => { if (v == null) setResumeDraft(null); setModal(v); }} resetNewInv={resetNewInv} doSubmitInvoice={doSubmitInvoice} doSaveDraftInvoice={doSaveDraft} resumeDraft={resumeDraft} nextInvNumFromDb={nextInvNumFromDb} woParts={woParts} />

      {isManager && !invoiceController && (
        <BillingInvoiceCreateModal
          modal={modal}
          currentUser={currentUser}
          workOrders={maskedWorkOrders}
          contractorInvoices={invoices}
          billingInvoices={billingInvoices}
          editingInvoice={billingDraftToEdit}
          initialSourceInvoiceId={billingSourceToStart}
          initialWorkOrderId={billingWorkOrderToStart}
          onClose={closeBillingInvoiceEditor}
          onCreated={(invoice: any) => {
            qc.setQueryData(BILLING_INVOICES_KEY, (items: any[] | undefined) => {
              if (!invoice?.id) return items || [];
              const exists = (items || []).some(item => item.id === invoice.id);
              return exists
                ? (items || []).map(item => item.id === invoice.id ? invoice : item)
                : [invoice, ...(items || [])];
            });
            qc.invalidateQueries({ queryKey: BILLING_INVOICES_KEY });
            qc.invalidateQueries({ queryKey: BILLING_INVOICE_PAGES_KEY });
            qc.invalidateQueries({ queryKey: BILLING_INVOICE_BY_ID_KEY });
            qc.invalidateQueries({ queryKey: INVOICES_KEY });
            qc.invalidateQueries({ queryKey: INVOICE_PAGES_KEY });
            qc.invalidateQueries({ queryKey: WORK_ORDERS_KEY });
            qc.invalidateQueries({ queryKey: WORK_ORDER_PAGES_KEY });
            if (invoice?.id) {
              setSelectedWO(null);
              setSelectedBillingInvoice(invoice.id);
              setPage("billing");
            }
            setModal(null);
            setBillingDraftToEdit(null);
            setBillingSourceToStart(null);
            setBillingWorkOrderToStart(null);
          }}
          fire={fire}
          fmt={fmt}
        />
      )}

      {modal === "invoiceSubmitted" && submittedInvoiceNum && (() => {
        const inv = submittedInvoice;
        return (
          <Modal onClose={() => { setModal(null); setSubmittedInvoiceNum(null); }} title={`Invoice #${submittedInvoiceNum} submitted`} width={440}>
            <div style={{ fontSize: 13, color: T.muted, marginBottom: 22, lineHeight: 1.55 }}>
              Submitted to AFM for approval. You can find a copy in your Invoices tab anytime.
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => { fire(`Invoice #${submittedInvoiceNum} saved`); setModal(null); setSubmittedInvoiceNum(null); }} className="btn-soft">Done</button>
              <button
                onClick={async () => { if (inv) await doDownloadInvoice(inv); }}
                disabled={pdfBusy || !inv}
                className="btn-primary"
                style={{ display: "flex", alignItems: "center", gap: 6, opacity: (pdfBusy || !inv) ? 0.6 : 1, cursor: (pdfBusy || !inv) ? "default" : "pointer" }}
              >
                <Ico d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" size={13} color="currentColor" />
                {pdfBusy ? "Preparing..." : "Download PDF"}
              </button>
            </div>
          </Modal>
        );
      })()}

      {isManager && !invoiceController && (
        <AddressBookModal
          open={modal === "addressBook"}
          onClose={() => setModal(null)}
          staff={staffProfiles}
          contractors={assignableContractors}
        />
      )}

      <FloatingProfitCalculator
        visible={isManager && !invoiceController && page === "billing"}
        fmt={fmt}
      />

      {lightbox && (
        <div onClick={() => setLightbox(null)} style={{ position: "fixed", inset: 0, background: "rgba(31,30,28,0.92)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 70, padding: 20, cursor: "zoom-out" }}>
          <img src={lightbox} alt="" style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 10, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }} />
          <button onClick={e => { e.stopPropagation(); setLightbox(null); }} style={{ position: "absolute", top: 20, right: 20, width: 40, height: 40, borderRadius: "50%", background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", fontSize: 20, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>Ã—</button>
        </div>
      )}

      {toast && <div className="app-toast">{toast}</div>}
    </div>
  );
}
