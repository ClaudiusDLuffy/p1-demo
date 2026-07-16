// Supabase data layer for the P1 portal.
// Maps DB rows (snake_case) → portal shape (camelCase) so existing components
// don't need to change. Keep this thin — heavy logic stays in components.

import { supabase } from "./supabase/client";
import { computeSlaBreaches } from "./slaConfig";
import { WorkOrderSchema } from "./schemas";
import type { Invoice, WorkOrder } from "./schemas";

// ── PROFILE / AUTH ──────────────────────────────────────────────────────────

export async function signIn(email: string, password: string): Promise<any> {
  const sb = supabase();
  const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw error;
  return data;
}

export async function signOut(): Promise<void> {
  const sb = supabase();
  await sb.auth.signOut();
}

export async function getSession(): Promise<any> {
  const sb = supabase();
  const { data } = await sb.auth.getSession();
  return data.session;
}

export async function loadCurrentProfile(): Promise<any | null> {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const { data, error } = await sb.from("profiles").select("*").eq("id", user.id).single();
  if (error) throw error;
  return mapProfile(data);
}

// ── PROFILES (all users) ────────────────────────────────────────────────────

// profiles_read: staff see all, contractors see contractors
export async function loadAllProfiles(): Promise<any[]> {
  const sb = supabase();
  const { data, error } = await sb.from("profiles").select("*").order("name");
  if (error) throw error;
  return (data || []).map(mapProfile);
}

// Contractor technicians — RLS returns all rows to staff, own rows to a
// contractor. Used to populate the "Technician on Job" dropdown.
export async function loadTechnicians(): Promise<any[]> {
  const sb = supabase();
  const { data, error } = await sb.from("contractor_technicians").select("*").order("name");
  if (error) throw error;
  return (data || []).map((t: any) => ({
    id: t.id,
    contractorId: t.contractor_id,
    name: t.name,
    tier: t.tier,
    isActive: t.is_active,
  }));
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
  contractorTier: p.contractor_tier || null,
  dispatcherId: p.dispatcher_id || null,
  // Display-only NTE cap shown to this contractor in place of the real WO
  // NTE (Lindsay 2026-06-16). Falls back to 1000 if the migration hasn't
  // been applied yet, so a stale schema can't blow up logins.
  contractorNteDisplay: p.contractor_nte_display != null ? Number(p.contractor_nte_display) : 1000,
  // Per-contractor rate columns are reserved for the Phase 2 rate work —
  // the invoice form no longer reads them (rates start empty, truck = 60).
  defaultLaborRate: p.default_labor_rate ?? null,
  defaultTruckRate: p.default_truck_rate ?? null,
  defaultPartsMarkup: p.default_parts_markup ?? 0,
});

// ── WORK ORDERS ─────────────────────────────────────────────────────────────

export async function loadWorkOrders(): Promise<WorkOrder[]> {
  const sb = supabase();
  // Pull WOs + activities + photos in 3 queries, stitch together
  const [woRes, actRes, photoRes] = await Promise.all([
    sb.from("work_orders").select("*").is("deleted_at", null).order("created_at", { ascending: false }),
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

  const mapped = (woRes.data || []).map(wo => ({
    ...mapWO(wo),
    activities: actsByWo[wo.id] || [],
    photos: (photosByWo[wo.id] || [])
      .map(p => p.storage_path)
      .filter(Boolean),
  }));
  for (const wo of woRes.data || []) {
    WorkOrderSchema.safeParse({
      id: wo.id,
      status: wo.status,
      priority: wo.priority,
      contractor_id: wo.contractor_id,
      nte: wo.nte == null ? null : Number(wo.nte),
      created_at: wo.created_at,
      store_number: wo.store_number,
      city: wo.city,
      functional_status: wo.functional_status,
    });
  }
  return mapped as unknown as WorkOrder[];
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
  nteFlagThreshold: w.nte_flag_threshold != null ? parseFloat(w.nte_flag_threshold) : 900,
  nteFlagged: !!w.nte_flagged,
  nteFlagAmount: w.nte_flag_amount != null ? parseFloat(w.nte_flag_amount) : null,
  invoiceTotal: w.invoice_total ? parseFloat(w.invoice_total) : undefined,
  eta: w.eta,
  dispatchedAt: w.dispatched_at,
  startTime: w.start_time ? new Date(w.start_time).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null,
  assetMake: w.asset_make,
  assetModel: w.asset_model,
  assetSerial: w.asset_serial,
  assetYear: w.asset_year || null,
  repairQuote: w.repair_quote ? parseFloat(w.repair_quote) : null,
  installQuote: w.install_quote ? parseFloat(w.install_quote) : null,
  capitalNotes: w.capital_notes || null,
  isCapital: w.is_capital,
  capitalStatus: w.capital_status,
  partNeeded: w.part_needed,
  partEta: w.part_eta,
  source: w.source,
  technicianOnJob: w.technician_on_job,
  createdAt: w.created_at,
  updatedAt: w.updated_at,
  closedAt: w.closed_at,
  slaStartedAt: w.sla_started_at,
  responseBreachAt: w.response_breach_at,
  resolutionBreachAt: w.resolution_breach_at,
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

export async function loadInvoices(): Promise<Invoice[]> {
  const sb = supabase();
  // Soft-deleted invoices are excluded at the source — every list, badge,
  // stat, and spend calc consumes this array, so one filter covers all.
  const [invRes, lineRes] = await Promise.all([
    sb.from("invoices").select("*").is("deleted_at", null).eq("invoice_type", "contractor").order("invoice_date", { ascending: false }),
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
  })) as unknown as Invoice[];
}

const mapInvoice = (i: any) => ({
  id: i.id,
  num: i.num,
  wot: i.work_order_id,
  store: i.store_number,
  storeAddr: i.store_address,
  contractor: i.contractor_id,
  invoiceType: i.invoice_type || "contractor",
  cme: i.cme,
  invoiceDate: formatDate(i.invoice_date),
  serviceDate: formatDate(i.service_date),
  dueDate: formatDate(i.due_date),
  terms: i.terms,
  state: i.state,
  subtotal: parseFloat(i.subtotal || 0),
  salesTax: parseFloat(i.sales_tax || 0),
  total: parseFloat(i.total || 0),
  pdfStoragePath: i.pdf_storage_path || null,
  date: shortMonthDay(i.invoice_date),
  rejectionReason: i.rejection_reason,
});

// ── INVOICE PDF STORAGE ────────────────────────────────────────────────────
// Bucket is private; reads use sb.storage.download which authenticates via
// the user's session. Path layout: {invoice_id}/{invoice_number}.pdf.
export async function uploadInvoicePdf(invoiceId: string, invoiceNum: string, blob: Blob): Promise<string> {
  const sb = supabase();
  const path = `${invoiceId}/${invoiceNum}.pdf`;
  const { error: upErr } = await sb.storage.from("invoice-pdfs").upload(path, blob, {
    contentType: "application/pdf",
    upsert: true,
  });
  if (upErr) throw upErr;
  const { error: rowErr } = await sb.from("invoices")
    .update({ pdf_storage_path: path }).eq("id", invoiceId);
  if (rowErr) throw rowErr;
  return path;
}

export async function downloadInvoicePdfBlob(storagePath: string): Promise<Blob> {
  const sb = supabase();
  const { data, error } = await sb.storage.from("invoice-pdfs").download(storagePath);
  if (error) throw error;
  if (!data) throw new Error("Empty PDF response from storage");
  return data;
}

const mapInvoiceLine = (l: any) => ({
  type: l.type,
  desc: l.description,
  qty: parseFloat(l.qty),
  rate: parseFloat(l.rate),
  amount: parseFloat(l.amount),
});

function formatDate(d: string | null): string | null {
  if (!d) return null;
  const [y, m, day] = d.split("-");
  return `${m}/${day}/${y}`;
}
function shortMonthDay(d: string | null): string {
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
  // Header fields editable via the staff "Edit work order" modal. (priority,
  // nte, city, category, summary, description already match their column
  // names so they pass through toDbWoPatch unchanged.)
  store: "store_number",
  addr: "address",
  lineOfService: "line_of_service",
  businessService: "business_service",
  subCategory: "sub_category",
  afm: "afm_name",
  afmEmail: "afm_email",
  dispatchedAt: "dispatched_at",
  startTime: "start_time",
  endTime: "end_time",
  assetMake: "asset_make",
  assetModel: "asset_model",
  assetSerial: "asset_serial",
  assetYear: "asset_year",
  repairQuote: "repair_quote",
  installQuote: "install_quote",
  capitalNotes: "capital_notes",
  capitalStatus: "capital_status",
  partNeeded: "part_needed",
  partEta: "part_eta",
  invoiceTotal: "invoice_total",
  resolutionCode: "resolution_code",
  resolutionNotes: "resolution_notes",
  isCapital: "is_capital",
  slaStartedAt: "sla_started_at",
  responseBreachAt: "response_breach_at",
  resolutionBreachAt: "resolution_breach_at",
  nteFlagThreshold: "nte_flag_threshold",
  nteFlagged: "nte_flagged",
  nteFlagAmount: "nte_flag_amount",
  closedAt: "closed_at",
  technicianOnJob: "technician_on_job",
};
function toDbWoPatch(patch: any): Record<string, any> {
  const out: any = {};
  for (const k of Object.keys(patch)) {
    out[WO_FIELD_MAP[k] || k] = patch[k];
  }
  return out;
}

export async function updateWorkOrder(id: string, patch: any): Promise<any> {
  const sb = supabase();
  const { data, error } = await (sb.from("work_orders") as any).update(toDbWoPatch(patch)).eq("id", id).select().single();
  if (error) throw error;
  return data;
}

export async function insertActivity(workOrderId: string, authorName: string, text: string, type: "note" | "system" | "ai" = "note"): Promise<void> {
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
export async function deleteActivity(activityId: string): Promise<void> {
  const sb = supabase();
  const { error } = await sb.from("activities")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", activityId);
  if (error) throw error;
}

// Soft delete only — sets deleted_at + deleted_by, never hard delete.
// Related invoices / photos / activities are intentionally left intact so
// the row can be restored via SQL. Writes a system activity entry as the
// audit trail for this destructive (but recoverable) action.
export async function deleteWorkOrder(workOrderId: string, authorName: string): Promise<void> {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  const { error } = await sb.from("work_orders").update({
    deleted_at: new Date().toISOString(),
    deleted_by: user?.id || null,
  }).eq("id", workOrderId);
  if (error) throw error;
  await insertActivity(workOrderId, "System", `Work order deleted by ${authorName}.`, "system");
}

// Invoice soft delete — same pattern as deleteWorkOrder: deleted_at +
// deleted_by, never a hard delete (row stays restorable via SQL). Staff-only
// (gated in the UI; inv_update RLS already restricts who can update).
// Writes the audit activity on the parent work order. Does NOT touch the
// work order's status — staff move the WO manually if needed.
export async function deleteInvoice(invoiceId: string, invoiceNum: string, workOrderId: string | null, authorName: string): Promise<void> {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  const { error } = await sb.from("invoices").update({
    deleted_at: new Date().toISOString(),
    deleted_by: user?.id || null,
  }).eq("id", invoiceId);
  if (error) throw error;
  if (workOrderId) {
    await insertActivity(workOrderId, "System", `Invoice #${invoiceNum} deleted by ${authorName}.`, "system");
  }
}

// Sets contractor_id = null, status = 'unassigned', clears eta + dispatched_at,
// and writes a system activity entry.
export async function unassignWorkOrder(workOrderId: string, authorName: string): Promise<void> {
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
): Promise<void> {
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

// Case-insensitive WOT lookup. The manual Create form has an in-memory
// dedup check, but the source of truth is the DB — a duplicate could
// have landed from another session since the local cache was loaded.
// Returns the canonical existing id (or null) so the caller can render
// an "open it instead?" affordance with the actual stored casing.
export async function findExistingWoId(
  wot: string
): Promise<{ id: string; deleted: boolean } | null> {
  const trimmed = (wot || "").trim();
  if (!trimmed) return null;
  const sb = supabase();
  const escaped = trimmed.replace(/[\\%_]/g, m => "\\" + m);

  // Check active first.
  const { data: active, error: activeError } = await sb
    .from("work_orders")
    .select("id")
    .ilike("id", escaped)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if (activeError) throw activeError;
  if (active) return { id: active.id, deleted: false };

  // Check soft deleted.
  const { data: deleted, error: deletedError } = await sb
    .from("work_orders")
    .select("id")
    .ilike("id", escaped)
    .not("deleted_at", "is", null)
    .limit(1)
    .maybeSingle();
  if (deletedError) throw deletedError;
  if (deleted) return { id: deleted.id, deleted: true };

  return null;
}

// Atomically generate the next FWKD work order ID via a Postgres sequence
export async function nextWorkOrderId(): Promise<{ wo: string; inc: string }> {
  const sb = supabase();
  const { data, error } = await (sb as any).rpc("next_wo_id");
  if (error) throw error;
  // Returns shape { wo: 'FWKD11400001', inc: 'INC24000001' }
  return data;
}

export async function insertWorkOrder(wo: any, activityText?: string, authorName?: string): Promise<WorkOrder> {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  // SLA clock starts at intake (creation), NOT at assignment. For email-
  // ingested WOs (Phase 1.5), pass slaStartedAt as the email's received-at;
  // for portal-created WOs we use now.
  const startedAt = wo.slaStartedAt ? new Date(wo.slaStartedAt) : new Date();
  const breaches = computeSlaBreaches(wo.priority, startedAt);
  // Best-effort: keep the stores table populated for the Stores/Kanban
  // context. The store_number FK was dropped (migration 0004) so a failed
  // store upsert must NOT block work-order creation — swallow any error.
  if (wo.store) {
    try {
      const [city, state] = String(wo.city || "").split(",").map((s: string) => s.trim());
      await sb.from("stores").upsert(
        { store_number: wo.store, city: city || null, state: state || null, address: wo.addr || null },
        { onConflict: "store_number", ignoreDuplicates: true },
      );
    } catch { /* store upsert is non-critical — never block WO creation */ }
  }
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
    source: wo.source || "manual",
    sla_started_at: startedAt.toISOString(),
    response_breach_at: breaches.responseBreachAt?.toISOString() ?? null,
    resolution_breach_at: breaches.resolutionBreachAt?.toISOString() ?? null,
    created_by: user?.id || null,
  };
  const { data, error } = await sb.from("work_orders").insert(dbRow).select().single();
  if (error) throw error;
  if (activityText && authorName) {
    await insertActivity(wo.id, authorName, activityText, "system");
  }
  return data as unknown as WorkOrder;
}

// Source-of-truth invoice numbering: read the current max from the DB, not
// from a cached React-Query list. The 6500 floor matches the legacy seed.
// Called both as the "what number should we pre-fill?" suggester AND as the
// retry-on-collision recalculator. Soft-deleted invoices KEEP their numbers
// (the unique index is on `num` without a partial predicate), so we can't
// recycle them — bumping past max is the safe move.
export async function nextInvoiceNumFromDb(): Promise<string> {
  const sb = supabase();
  // ORDER BY num::int can't use a regular index, but the table is small and
  // num is short text. Simpler + correct: pull the whole list and parse.
  // If perf ever matters, swap to an RPC that runs `MAX((num)::int)`.
  const { data, error } = await sb.from("invoices").select("num");
  if (error) throw error;
  const maxNum = (data || []).reduce((m: number, r: any) => {
    const n = parseInt(r.num) || 0;
    return n > m ? n : m;
  }, 6500);
  return String(maxNum + 1);
}

// Postgres unique-violation. We need to distinguish "number collided" from
// other errors so the caller can retry or surface a friendly message.
const isInvoiceNumCollision = (err: any): boolean => {
  if (!err) return false;
  if (err.code === "23505") return true;                            // canonical
  const msg = String(err.message || err.details || "").toLowerCase();
  return msg.includes("invoices_num_key") || (msg.includes("duplicate") && msg.includes("num"));
};

// Retry wrapper around the insert. If the user typed a specific number we
// throw with `attemptedNum` set so the UI can show "X already exists, using
// Y instead"; if it was auto-suggested we just resolve a fresh number and
// retry transparently. Bounded to a small attempt count.
async function insertInvoiceWithRetry(
  baseRow: any,
  desiredNum: string,
  userTyped: boolean,
): Promise<{ header: any; finalNum: string; collidedFrom: string | null }> {
  const sb = supabase();
  let tryNum = desiredNum;
  let collidedFrom: string | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, error } = await sb.from("invoices").insert({ ...baseRow, num: tryNum }).select().single();
    if (!error) return { header: data, finalNum: tryNum, collidedFrom };
    if (!isInvoiceNumCollision(error)) throw error;
    // First collision: if the user typed this number specifically, surface
    // it once with the collided-from value so the toast can name it; then
    // proceed to retry on a DB-derived number.
    if (attempt === 0 && userTyped) collidedFrom = tryNum;
    tryNum = await nextInvoiceNumFromDb();
    // Guard against the absurd "DB says next is the same one that just
    // collided" case (shouldn't happen, but if it does bump explicitly).
    if (tryNum === collidedFrom || tryNum === baseRow.num) {
      tryNum = String((parseInt(tryNum) || 6500) + 1);
    }
  }
  throw new Error("Could not allocate an unused invoice number after several attempts. Please try again.");
}

export async function insertInvoice(inv: any, lines: any[], authorName: string): Promise<Invoice> {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  // Insert header
  const subtotal = lines.reduce((s, l) => s + (parseFloat(l.qty) || 0) * (parseFloat(l.rate) || 0), 0);
  const salesTax = parseFloat(inv.salesTax) || 0;
  const total = subtotal + salesTax;
  const todayIso = new Date().toISOString().slice(0, 10);
  // Resolve the number at insert time. If the caller passed a number, prefer
  // it (the user may have typed one); otherwise pull a fresh one from the DB
  // so we don't trust stale React-Query cache.
  const userTyped = !!inv.userTypedNum;
  const baseNum = inv.num && String(inv.num).trim()
    ? String(inv.num).trim()
    : await nextInvoiceNumFromDb();
  const baseRow = {
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
  };
  let header: any;
  let finalNum: string;
  let collidedFrom: string | null = null;
  try {
    const res = await insertInvoiceWithRetry(baseRow, baseNum, userTyped);
    header = res.header;
    finalNum = res.finalNum;
    collidedFrom = res.collidedFrom;
  } catch (e: any) {
    // Bubble a tagged error so the hook can shape the toast.
    if (isInvoiceNumCollision(e)) {
      const err: any = new Error(e.message || "Invoice number conflict");
      err.code = "INVOICE_NUM_CONFLICT";
      throw err;
    }
    throw e;
  }
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
  // Drafts must NOT touch the parent WO — saving a draft mid-visit can't
  // advance the WO into pending_approval and can't write an audit entry that
  // claims it was submitted. Only the submit path moves the WO forward.
  const isDraft = (inv.state || "submitted") === "draft";
  if (!isDraft) {
    await updateWorkOrder(inv.wot, { status: "pending_approval", invoiceTotal: total });
    await insertActivity(inv.wot, authorName, `Invoice ${finalNum} submitted. Total: $${total.toFixed(2)}.`, "system");
  } else {
    await insertActivity(inv.wot, authorName, `Invoice ${finalNum} draft saved.`, "system");
  }
  // Surface the resolved number + the collided-from number so the caller can
  // show "X already exists, using Y instead" without parsing the row again.
  return { ...header, num: finalNum, total, _collidedFrom: collidedFrom } as unknown as Invoice;
}

// Update an existing invoice's lines (full replace) + recompute totals.
// Used to resume an existing draft and either re-save or submit it. Does
// NOT touch WO status — the caller decides via updateInvoiceState whether
// this is still a draft or a real submission.
export async function updateInvoiceWithLines(
  invoiceId: string,
  patch: { num?: string; userTypedNum?: boolean; cme?: string | null; invoiceDate?: string; serviceDate?: string | null; terms?: string; storeAddr?: string | null; state?: string; salesTax?: number },
  lines: any[],
): Promise<{ id: string; num: string; subtotal: number; salesTax: number; total: number; collidedFrom: string | null }> {
  const sb = supabase();
  const subtotal = lines.reduce((s, l) => s + (parseFloat(l.qty) || 0) * (parseFloat(l.rate) || 0), 0);
  const salesTax = parseFloat(patch.salesTax as any) || 0;
  const total = subtotal + salesTax;
  const update: any = {
    subtotal, sales_tax: salesTax, total,
    updated_at: new Date().toISOString(),
  };
  if (patch.cme !== undefined) update.cme = patch.cme || null;
  if (patch.invoiceDate) update.invoice_date = patch.invoiceDate;
  if (patch.serviceDate !== undefined) update.service_date = patch.serviceDate || null;
  if (patch.terms) update.terms = patch.terms;
  if (patch.storeAddr !== undefined) update.store_address = patch.storeAddr || null;
  if (patch.state) update.state = patch.state;
  // Number is treated specially: if it's changing AND would collide, we
  // retry against the DB max + 1. Same shape as insertInvoiceWithRetry.
  let finalNum: string | null = patch.num != null ? String(patch.num).trim() : null;
  let collidedFrom: string | null = null;
  const userTyped = !!patch.userTypedNum;
  // Pre-flight: read the current invoice's num so we know whether the user
  // is actually changing it. If they're keeping it the same, no collision is
  // possible (it's their own row).
  let originalNum: string | null = null;
  if (finalNum != null) {
    const { data: cur } = await sb.from("invoices").select("num").eq("id", invoiceId).maybeSingle();
    originalNum = cur?.num ?? null;
  }
  // Try the update. If num collides, regenerate and retry; otherwise leave
  // num out of the update payload and just write the rest.
  let attempts = 0;
  while (true) {
    const writeNum = finalNum != null && finalNum !== originalNum;
    const payload = writeNum ? { ...update, num: finalNum } : update;
    const { error: uErr } = await sb.from("invoices").update(payload).eq("id", invoiceId);
    if (!uErr) break;
    if (!isInvoiceNumCollision(uErr) || attempts >= 5 || finalNum == null) throw uErr;
    if (attempts === 0 && userTyped) collidedFrom = finalNum;
    finalNum = await nextInvoiceNumFromDb();
    if (finalNum === collidedFrom) finalNum = String((parseInt(finalNum) || 6500) + 1);
    attempts++;
  }
  // Replace lines: simpler + safer than diffing while editing a draft. The
  // table has on-delete-cascade so this is a single round trip per side.
  const { error: dErr } = await sb.from("invoice_lines").delete().eq("invoice_id", invoiceId);
  if (dErr) throw dErr;
  if (lines.length > 0) {
    const rows = lines.map((l, i) => ({
      invoice_id: invoiceId,
      position: i + 1,
      type: l.type,
      description: l.desc || l.description || "",
      qty: parseFloat(l.qty) || 1,
      rate: parseFloat(l.rate) || 0,
    }));
    const { error: lErr } = await sb.from("invoice_lines").insert(rows);
    if (lErr) throw lErr;
  }
  return { id: invoiceId, num: (finalNum ?? originalNum ?? "") as string, subtotal, salesTax, total, collidedFrom };
}

// Reject an invoice with a reason. Staff-only at the UI layer; inv_update
// RLS already restricts who can write. Writes an audit activity on the WO.
export async function rejectInvoice(
  invoiceId: string,
  invoiceNum: string,
  workOrderId: string | null,
  reason: string,
  authorName: string,
): Promise<void> {
  const sb = supabase();
  const { error } = await sb.from("invoices").update({
    state: "rejected",
    rejection_reason: reason,
  }).eq("id", invoiceId);
  if (error) throw error;
  if (workOrderId) {
    await insertActivity(workOrderId, "System", `Invoice #${invoiceNum} rejected by ${authorName}: ${reason}`, "system");
  }
}

// Patch an invoice's state (and optionally paid_at). Used by the Owner
// approve / mark-paid actions that carry a WO from pending_approval → closed.
export async function updateInvoiceState(num: string, state: string, extra: Record<string, any> = {}): Promise<void> {
  const sb = supabase();
  const { error } = await sb.from("invoices").update({ state: state as any, ...extra }).eq("num", num);
  if (error) throw error;
}

export async function insertWorkReport(
  report: any
): Promise<{ success: boolean; error?: unknown }> {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  const { error } = await sb.from("work_reports").insert({
    work_order_id: report.workOrderId,
    contractor_id: user?.id || null,
    technician_name: report.technicianName || null,
    arrival_time: report.arrivalTime || null,
    departure_time: report.departureTime || null,
    work_performed: report.workPerformed || null,
    parts_used: report.partsUsed || [],
    resolution_code: report.resolutionCode || null,
    resolution_notes: report.resolutionNotes || null,
  });
  if (error) return { success: false, error };
  return { success: true };
}

// ── WO PARTS ───────────────────────────────────────────────────────────────
// Structured parts-tracking list per WO. Loaded once and grouped client-side
// like invoice_lines, so the WORK_ORDERS_KEY cache stays the single source.
const mapWoPart = (p: any) => ({
  id: p.id,
  workOrderId: p.work_order_id,
  description: p.description,
  partNumber: p.part_number || "",
  qty: p.qty != null ? Number(p.qty) : 1,
  status: p.status as "ordered" | "backordered" | "shipped" | "received",
  trackingNumber: p.tracking_number || "",
  expectedReturnDate: p.expected_return_date || null,
  notes: p.notes || "",
  createdAt: p.created_at,
  updatedAt: p.updated_at,
});

export async function loadWoParts(): Promise<any[]> {
  const sb = supabase();
  const { data, error } = await (sb as any)
    .from("wo_parts")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []).map(mapWoPart);
}

export async function insertWoPart(part: {
  workOrderId: string;
  description: string;
  partNumber?: string;
  qty?: number;
  status?: "ordered" | "backordered" | "shipped" | "received";
  trackingNumber?: string;
  expectedReturnDate?: string | null;
}): Promise<any> {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  const { data, error } = await (sb as any).from("wo_parts").insert({
    work_order_id: part.workOrderId,
    description: part.description,
    part_number: part.partNumber || null,
    qty: part.qty != null ? part.qty : 1,
    status: part.status || "ordered",
    tracking_number: part.trackingNumber || null,
    expected_return_date: part.expectedReturnDate || null,
    created_by: user?.id || null,
  }).select().single();
  if (error) throw error;
  return mapWoPart(data);
}

export async function updateWoPart(
  id: string,
  patch: {
    description?: string;
    partNumber?: string | null;
    qty?: number;
    status?: "ordered" | "backordered" | "shipped" | "received";
    trackingNumber?: string | null;
    expectedReturnDate?: string | null;
  }
): Promise<any> {
  const sb = supabase();
  const dbPatch: any = { updated_at: new Date().toISOString() };
  if (patch.description !== undefined) dbPatch.description = patch.description;
  if (patch.partNumber !== undefined) dbPatch.part_number = patch.partNumber || null;
  if (patch.qty !== undefined) dbPatch.qty = patch.qty;
  if (patch.status !== undefined) dbPatch.status = patch.status;
  if (patch.trackingNumber !== undefined) dbPatch.tracking_number = patch.trackingNumber || null;
  if (patch.expectedReturnDate !== undefined) dbPatch.expected_return_date = patch.expectedReturnDate || null;
  const { data, error } = await ((sb as any).from("wo_parts") as any).update(dbPatch).eq("id", id).select().single();
  if (error) throw error;
  return mapWoPart(data);
}

export async function deleteWoPart(id: string): Promise<void> {
  const sb = supabase();
  const { error } = await (sb as any).from("wo_parts").delete().eq("id", id);
  if (error) throw error;
}

export async function loadWorkReports(
  workOrderId: string
): Promise<any[]> {
  const sb = supabase();
  const { data, error } = await sb
    .from("work_reports")
    .select("*")
    .eq("work_order_id", workOrderId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

// ── PHOTO STORAGE ─────────────────────────────────────────────────────────
export async function uploadPhotos(workOrderId: string, files: FileList | File[], authorName: string): Promise<string[]> {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  const uploaded: string[] = [];
  const arr = Array.from(files);
  for (const file of arr) {
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const filename = `${Date.now()}_${crypto.randomUUID()}`;
    const path = `wo/${workOrderId}/${filename}.${ext}`;
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

export async function removePhoto(workOrderId: string, storagePath: string): Promise<{ success: boolean; error?: unknown }> {
  const sb = supabase();
  // Delete the row (RLS allows uploader or staff)
  const { data: deletedRows, error: dbError } = await sb
    .from("photos")
    .delete()
    .eq("work_order_id", workOrderId)
    .eq("storage_path", storagePath)
    .select("id");
  if (dbError) return { success: false, error: dbError };
  if (!deletedRows || deletedRows.length === 0) {
    return { success: false, error: new Error("Only the uploader or a staff member can delete this image") };
  }
  // Delete the file from storage
  const { error: storageError } = await sb.storage.from("photos").remove([storagePath]);
  if (storageError) return { success: false, error: storageError };
  return { success: true };
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
    .on("postgres_changes", { event: "*", schema: "public", table: "wo_parts" }, onChange)
    .subscribe();
  return () => { sb.removeChannel(channel); };
}
