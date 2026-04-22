// @ts-nocheck
// Supabase data layer for the P1 portal.
// Maps DB rows (snake_case) → portal shape (camelCase) so existing components
// don't need to change. Keep this thin — heavy logic stays in components.

import { supabase } from "./supabase/client";

// ── PROFILE / AUTH ──────────────────────────────────────────────────────────

export async function signIn(email: string, password: string) {
  const sb = supabase();
  const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const sb = supabase();
  await sb.auth.signOut();
}

export async function getSession() {
  const sb = supabase();
  const { data } = await sb.auth.getSession();
  return data.session;
}

export async function loadCurrentProfile() {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const { data, error } = await sb.from("profiles").select("*").eq("id", user.id).single();
  if (error) throw error;
  return mapProfile(data);
}

// ── PROFILES (all users) ────────────────────────────────────────────────────

export async function loadAllProfiles() {
  const sb = supabase();
  const { data, error } = await sb.from("profiles").select("*").order("name");
  if (error) throw error;
  return (data || []).map(mapProfile);
}

const mapProfile = (p: any) => ({
  id: p.id,
  name: p.name,
  initials: p.initials,
  email: p.email,
  role: p.role,
  title: p.title,
  company: p.company,
  phone: p.phone,
  territory: p.territory,
  trades: p.trades || [],
  color: p.color,
});

// ── WORK ORDERS ─────────────────────────────────────────────────────────────

export async function loadWorkOrders() {
  const sb = supabase();
  // Pull WOs + activities + photos in 3 queries, stitch together
  const [woRes, actRes, photoRes] = await Promise.all([
    sb.from("work_orders").select("*").order("created_at", { ascending: false }),
    sb.from("activities").select("*").order("created_at", { ascending: false }),
    sb.from("photos").select("*"),
  ]);
  if (woRes.error) throw woRes.error;
  if (actRes.error) throw actRes.error;
  if (photoRes.error) throw photoRes.error;

  const actsByWo: Record<string, any[]> = {};
  for (const a of actRes.data || []) {
    (actsByWo[a.work_order_id] ||= []).push(mapActivity(a));
  }
  const photosByWo: Record<string, any[]> = {};
  for (const p of photoRes.data || []) {
    (photosByWo[p.work_order_id] ||= []).push(p);
  }

  return (woRes.data || []).map(wo => ({
    ...mapWO(wo),
    activities: actsByWo[wo.id] || [],
    photos: (photosByWo[wo.id] || []).map(p => p.storage_path), // resolved to URLs in component
  }));
}

const mapWO = (w: any) => ({
  id: w.id,
  incidentId: w.incident_id,
  store: w.store_number,
  city: w.city,
  addr: w.address,
  lineOfService: w.line_of_service,
  businessService: w.business_service,
  category: w.category,
  subCategory: w.sub_category,
  summary: w.summary,
  description: w.description,
  priority: w.priority,
  status: w.status,
  functionalStatus: w.functional_status,
  contractor: w.contractor_id,
  afm: w.afm_name,
  afmEmail: w.afm_email,
  nte: parseFloat(w.nte || 0),
  invoiceTotal: w.invoice_total ? parseFloat(w.invoice_total) : undefined,
  eta: w.eta,
  dispatchedAt: w.dispatched_at,
  startTime: w.start_time ? new Date(w.start_time).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null,
  assetModel: w.asset_model,
  assetSerial: w.asset_serial,
  isCapital: w.is_capital,
  capitalStatus: w.capital_status,
  partNeeded: w.part_needed,
  partEta: w.part_eta,
  age: ageString(w.created_at, w.dispatched_at),
});

const mapActivity = (a: any) => ({
  author: a.author_name,
  time: new Date(a.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
  text: a.text,
  type: a.type,
});

// "5h", "2d", "1w" — relative age string from a timestamp
function ageString(createdAt: string, dispatchedAt?: string): string {
  const ref = dispatchedAt || createdAt;
  if (!ref) return "—";
  const diff = Date.now() - new Date(ref).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

// ── INVOICES ────────────────────────────────────────────────────────────────

export async function loadInvoices() {
  const sb = supabase();
  const [invRes, lineRes] = await Promise.all([
    sb.from("invoices").select("*").order("invoice_date", { ascending: false }),
    sb.from("invoice_lines").select("*").order("position"),
  ]);
  if (invRes.error) throw invRes.error;
  if (lineRes.error) throw lineRes.error;

  const linesByInv: Record<string, any[]> = {};
  for (const l of lineRes.data || []) {
    (linesByInv[l.invoice_id] ||= []).push(mapInvoiceLine(l));
  }

  return (invRes.data || []).map(i => ({
    ...mapInvoice(i),
    lines: linesByInv[i.id] || [],
  }));
}

const mapInvoice = (i: any) => ({
  id: i.id,
  num: i.num,
  wot: i.work_order_id,
  store: i.store_number,
  storeAddr: i.store_address,
  contractor: i.contractor_id,
  cme: i.cme,
  invoiceDate: formatDate(i.invoice_date),
  serviceDate: formatDate(i.service_date),
  dueDate: formatDate(i.due_date),
  terms: i.terms,
  state: i.state,
  subtotal: parseFloat(i.subtotal || 0),
  salesTax: parseFloat(i.sales_tax || 0),
  total: parseFloat(i.total || 0),
  date: shortMonthDay(i.invoice_date),
  rejectionReason: i.rejection_reason,
});

const mapInvoiceLine = (l: any) => ({
  type: l.type,
  desc: l.description,
  qty: parseFloat(l.qty),
  rate: parseFloat(l.rate),
  amount: parseFloat(l.amount),
});

function formatDate(d: string | null) {
  if (!d) return null;
  const [y, m, day] = d.split("-");
  return `${m}/${day}/${y}`;
}
function shortMonthDay(d: string | null) {
  if (!d) return "";
  const date = new Date(d + "T00:00:00");
  return date.toLocaleString("en-US", { month: "short", day: "numeric" });
}

// ── PHOTO STORAGE URLs ──────────────────────────────────────────────────────
// Photos in DB are storage paths. To render them, we need signed URLs.
export async function getPhotoUrl(path: string): Promise<string | null> {
  if (!path) return null;
  // If it's already a data: URL (legacy in-memory photo), return as-is
  if (path.startsWith("data:") || path.startsWith("http")) return path;
  const sb = supabase();
  const { data } = await sb.storage.from("photos").createSignedUrl(path, 3600);
  return data?.signedUrl || null;
}
