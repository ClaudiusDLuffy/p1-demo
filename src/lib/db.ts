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
    sb.from("activities").select("*").is("deleted_at", null).order("created_at", { ascending: false }),
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
  id: a.id,
  authorId: a.author_id,
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

// ═══════════════════════════════════════════════════════════════════════════
//  MUTATION HELPERS — every do* function in Portal.tsx routes through here
// ═══════════════════════════════════════════════════════════════════════════

// Map UI camelCase → DB snake_case for work_orders updates
const WO_FIELD_MAP: Record<string, string> = {
  contractor: "contractor_id",
  functionalStatus: "functional_status",
  dispatchedAt: "dispatched_at",
  startTime: "start_time",
  endTime: "end_time",
  assetModel: "asset_model",
  assetSerial: "asset_serial",
  capitalStatus: "capital_status",
  partNeeded: "part_needed",
  partEta: "part_eta",
  invoiceTotal: "invoice_total",
  resolutionCode: "resolution_code",
  resolutionNotes: "resolution_notes",
  isCapital: "is_capital",
};
function toDbWoPatch(patch: any) {
  const out: any = {};
  for (const k of Object.keys(patch)) {
    out[WO_FIELD_MAP[k] || k] = patch[k];
  }
  return out;
}

export async function updateWorkOrder(id: string, patch: any) {
  const sb = supabase();
  const { data, error } = await sb.from("work_orders").update(toDbWoPatch(patch)).eq("id", id).select().single();
  if (error) throw error;
  return data;
}

export async function insertActivity(workOrderId: string, authorName: string, text: string, type: "note" | "system" | "ai" = "note") {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  const { error } = await sb.from("activities").insert({
    work_order_id: workOrderId,
    author_id: user?.id || null,
    author_name: authorName,
    text,
    type,
  });
  if (error) throw error;
}

// Soft delete — the row stays in the DB but loadWorkOrders filters it out.
// RLS allows the author to update their own row, and managers/dispatchers/
// back-office (is_staff) to update any row.
export async function deleteActivity(activityId: string) {
  const sb = supabase();
  const { error } = await sb.from("activities")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", activityId);
  if (error) throw error;
}

// Sets contractor_id = null, status = 'unassigned', clears eta + dispatched_at,
// and writes a system activity entry.
export async function unassignWorkOrder(workOrderId: string, authorName: string) {
  const sb = supabase();
  const { error } = await sb.from("work_orders").update({
    contractor_id: null,
    status: "unassigned",
    functional_status: "New",
    eta: null,
    dispatched_at: null,
  }).eq("id", workOrderId);
  if (error) throw error;
  await insertActivity(workOrderId, "System", `Work order unassigned by ${authorName}.`, "system");
}

// Swaps contractor_id, keeps status as 'assigned', preserves the original
// SLA deadline (we never touch sla_deadline_at). The caller passes display
// names so the activity entry reads cleanly.
export async function reassignWorkOrder(
  workOrderId: string,
  newContractorId: string,
  oldContractorName: string,
  newContractorName: string,
  authorName: string,
) {
  const sb = supabase();
  const { error } = await sb.from("work_orders").update({
    contractor_id: newContractorId,
    status: "assigned",
    functional_status: "Dispatched",
  }).eq("id", workOrderId);
  if (error) throw error;
  await insertActivity(
    workOrderId,
    "System",
    `Reassigned from ${oldContractorName || "Unassigned"} to ${newContractorName} by ${authorName}.`,
    "system",
  );
}

// Atomically generate the next FWKD work order ID via a Postgres sequence
export async function nextWorkOrderId(): Promise<{ wo: string; inc: string }> {
  const sb = supabase();
  const { data, error } = await sb.rpc("next_wo_id");
  if (error) throw error;
  // Returns shape { wo: 'FWKD11400001', inc: 'INC24000001' }
  return data;
}

export async function insertWorkOrder(wo: any, activityText?: string, authorName?: string) {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  const dbRow = {
    id: wo.id,
    incident_id: wo.incidentId,
    store_number: wo.store,
    city: wo.city,
    address: wo.addr,
    line_of_service: wo.lineOfService,
    business_service: wo.businessService,
    category: wo.category,
    sub_category: wo.subCategory,
    summary: wo.summary,
    description: wo.description,
    priority: wo.priority,
    status: wo.status,
    functional_status: wo.functionalStatus,
    contractor_id: wo.contractor || null,
    afm_name: wo.afm || null,
    afm_email: wo.afmEmail || null,
    nte: wo.nte || 0,
    dispatched_at: wo.dispatchedAt || null,
    is_capital: !!wo.isCapital,
    created_by: user?.id || null,
  };
  const { data, error } = await sb.from("work_orders").insert(dbRow).select().single();
  if (error) throw error;
  if (activityText && authorName) {
    await insertActivity(wo.id, authorName, activityText, "system");
  }
  return data;
}

export async function insertInvoice(inv: any, lines: any[], authorName: string) {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  // Insert header
  const subtotal = lines.reduce((s, l) => s + (parseFloat(l.qty) || 0) * (parseFloat(l.rate) || 0), 0);
  const salesTax = parseFloat(inv.salesTax) || 0;
  const total = subtotal + salesTax;
  const todayIso = new Date().toISOString().slice(0, 10);
  const { data: header, error: hErr } = await sb.from("invoices").insert({
    num: inv.num,
    work_order_id: inv.wot,
    store_number: inv.store,
    store_address: inv.storeAddr || null,
    contractor_id: inv.contractor || null,
    cme: inv.cme || null,
    invoice_date: inv.invoiceDate || todayIso,
    service_date: inv.serviceDate || null,
    due_date: inv.dueDate || null,
    terms: inv.terms || "Net 30",
    state: inv.state || "submitted",
    subtotal,
    sales_tax: salesTax,
    total,
    created_by: user?.id || null,
  }).select().single();
  if (hErr) throw hErr;
  // Insert lines (1:N)
  if (lines.length > 0) {
    const lineRows = lines.map((l, i) => ({
      invoice_id: header.id,
      position: i + 1,
      type: l.type,
      description: l.desc || l.description || "",
      qty: parseFloat(l.qty) || 1,
      rate: parseFloat(l.rate) || 0,
    }));
    const { error: lErr } = await sb.from("invoice_lines").insert(lineRows);
    if (lErr) throw lErr;
  }
  // Mark WO as pending approval and stamp invoice total
  await updateWorkOrder(inv.wot, { status: "pending_approval", invoiceTotal: total });
  await insertActivity(inv.wot, authorName, `Invoice ${inv.num} submitted. Total: $${total.toFixed(2)}.`, "system");
  return { ...header, total };
}

// ── PHOTO STORAGE ─────────────────────────────────────────────────────────
export async function uploadPhotos(workOrderId: string, files: FileList | File[], authorName: string): Promise<string[]> {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  const uploaded: string[] = [];
  const arr = Array.from(files);
  for (const file of arr) {
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = `wo/${workOrderId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: upErr } = await sb.storage.from("photos").upload(path, file, { contentType: file.type, upsert: false });
    if (upErr) throw upErr;
    const { error: rowErr } = await sb.from("photos").insert({
      work_order_id: workOrderId,
      storage_path: path,
      uploader_id: user?.id || null,
      uploader_name: authorName,
    });
    if (rowErr) throw rowErr;
    uploaded.push(path);
  }
  if (uploaded.length > 0) {
    await insertActivity(workOrderId, authorName, `Added ${uploaded.length} photo${uploaded.length > 1 ? "s" : ""}.`, "note");
  }
  return uploaded;
}

export async function removePhoto(workOrderId: string, storagePath: string) {
  const sb = supabase();
  // Delete the row (RLS allows uploader or staff)
  await sb.from("photos").delete().eq("work_order_id", workOrderId).eq("storage_path", storagePath);
  // Delete the file from storage
  await sb.storage.from("photos").remove([storagePath]);
}

// ── REALTIME SUBSCRIPTION ──────────────────────────────────────────────────
// Returns an unsubscribe function. Caller passes a callback that re-fetches.
export function subscribeToChanges(onChange: () => void): () => void {
  const sb = supabase();
  const channel = sb
    .channel("portal-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "work_orders" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "activities" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "invoices" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "photos" }, onChange)
    .subscribe();
  return () => { sb.removeChannel(channel); };
}
