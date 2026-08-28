import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

import { generateInvoiceBatchCsv } from "../../../lib/invoiceCsv";
import { generateInvoicePDFBlob } from "../../../lib/invoicePdf";
import {
  canHandoffQuickBooksProfile,
  loadStaffPermissions,
  STAFF_ROLES,
} from "../../../lib/server/staffAuthorization";
import { collectSupabasePages } from "../../../lib/paginatedQuery";
import { createServerClient } from "../../../lib/supabase/server";
import type { Database, Tables } from "../../../lib/supabase/database.types";
import { createZipArchive, type ZipArchiveEntry } from "../../../lib/zipArchive";

export const runtime = "nodejs";

const MAX_INVOICES = 500;
const MAX_ARCHIVE_BYTES = 95 * 1024 * 1024;

const jsonError = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status });

const bearerToken = (request: NextRequest) =>
  request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] || "";

const authClient = () => createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function requireStaff(request: NextRequest) {
  const token = bearerToken(request);
  if (!token) return { error: jsonError("Unauthorized", 401) };

  const auth = authClient();
  const { data, error } = await auth.auth.getUser(token);
  if (error || !data.user) return { error: jsonError("Unauthorized", 401) };

  const sb = createServerClient();
  const { data: profile, error: profileError } = await sb
    .from("profiles")
    .select("id,name,role,active")
    .eq("id", data.user.id)
    .maybeSingle();
  if (profileError) return { error: jsonError(profileError.message, 500) };
  if (!profile?.active || !STAFF_ROLES.has(profile.role || "")) {
    return { error: jsonError("Forbidden", 403) };
  }

  try {
    const staffPermissions = await loadStaffPermissions(sb, profile.id);
    const authorizedProfile = { ...profile, staffPermissions };
    return {
      sb,
      profile: authorizedProfile,
      canHandoff: canHandoffQuickBooksProfile(authorizedProfile),
    };
  } catch (permissionError) {
    return { error: jsonError(permissionError instanceof Error ? permissionError.message : "Permission lookup failed", 500) };
  }
}

const filenameToken = (value: unknown, fallback: string) => {
  const token = String(value || "")
    .trim()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return token || fallback;
};

type InvoiceRow = Pick<Tables<"invoices">,
  | "num"
  | "work_order_id"
  | "store_number"
  | "invoice_date"
  | "service_date"
  | "due_date"
  | "terms"
  | "tax_rate"
  | "tax_state"
  | "territory"
>;
type InvoiceLineRow = Pick<Tables<"invoice_lines">,
  | "invoice_id"
  | "position"
  | "type"
  | "description"
  | "qty"
  | "rate"
  | "amount"
  | "is_taxable"
>;

const invoiceForCsv = (invoice: InvoiceRow, lines: InvoiceLineRow[]) => ({
  num: invoice.num,
  wot: invoice.work_order_id,
  store: invoice.store_number,
  invoiceDateRaw: invoice.invoice_date,
  serviceDateRaw: invoice.service_date,
  dueDateRaw: invoice.due_date,
  terms: invoice.terms,
  taxRate: invoice.tax_rate,
  taxState: invoice.tax_state,
  territory: invoice.territory,
  lines: lines.map(line => ({
    type: line.type,
    description: line.description,
    qty: Number(line.qty || 0),
    rate: Number(line.rate || 0),
    amount: Number(line.amount || 0),
    isTaxable: Boolean(line.is_taxable),
  })),
});

const archiveFilename = (batchId: string) => {
  const day = new Date().toISOString().slice(0, 10);
  return `QuickBooks-Handoff-${day}-${batchId.slice(0, 8)}.zip`;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const nextUtcDay = (value: string) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
};

const csvCell = (value: unknown) => {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  const escaped = text.replace(/"/g, '""');
  return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
};

type ExportHistoryItem = {
  invoiceId: string;
  invoiceNumber: string;
  workOrderId: string | null;
  contractorId: string | null;
  contractorName: string;
  total: number;
};

type ExportHistoryBatch = {
  id: string;
  status: "pending" | "confirmed" | "cancelled";
  createdAt: string;
  createdBy: string;
  createdByName: string;
  confirmedAt: string | null;
  confirmedBy: string | null;
  confirmedByName: string;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelledByName: string;
  cancellationReason: string | null;
  invoiceCount: number;
  total: number;
  items: ExportHistoryItem[];
};

type ExportBatchRow = Pick<Tables<"controller_invoice_export_batches">,
  | "id"
  | "status"
  | "created_at"
  | "created_by"
  | "confirmed_at"
  | "confirmed_by"
  | "cancelled_at"
  | "cancelled_by"
  | "cancellation_reason"
  | "invoice_count"
  | "total"
>;
type ExportItemRow = Pick<Tables<"controller_invoice_export_items">,
  | "batch_id"
  | "invoice_id"
  | "invoice_num"
  | "work_order_id"
  | "contractor_id"
  | "total"
  | "exported_at"
>;
type ExportProfileRow = Pick<Tables<"profiles">, "id" | "name" | "company">;

async function pendingInvoiceIds(sb: ReturnType<typeof createServerClient>) {
  const batches = await collectSupabasePages<Pick<ExportBatchRow, "id">>((from, to) => sb
    .from("controller_invoice_export_batches")
    .select("id")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .range(from, to));
  const batchIds = batches.map(batch => String(batch.id));
  if (batchIds.length === 0) return new Set<string>();
  const items = await collectSupabasePages<Pick<ExportItemRow, "invoice_id">>((from, to) => sb
    .from("controller_invoice_export_items")
    .select("invoice_id")
    .in("batch_id", batchIds)
    .order("exported_at", { ascending: true })
    .range(from, to));
  return new Set(items.map(item => String(item.invoice_id)));
}

async function heldInvoiceIds(sb: ReturnType<typeof createServerClient>) {
  const holds = await collectSupabasePages<Tables<"contractor_invoice_payment_holds">>(
    (from, to) => sb
      .from("contractor_invoice_payment_holds")
      .select("*")
      .order("placed_at", { ascending: true })
      .order("invoice_id", { ascending: true })
      .range(from, to),
  );
  return new Set(holds.map(hold => String(hold.invoice_id)));
}

async function loadExportHistory(
  sb: ReturnType<typeof createServerClient>,
  params: { from?: string; to?: string; actor?: string },
): Promise<ExportHistoryBatch[]> {
  let query = sb
    .from("controller_invoice_export_batches")
    .select("id,status,created_at,created_by,confirmed_at,confirmed_by,cancelled_at,cancelled_by,cancellation_reason,invoice_count,total")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(100);
  if (params.from && DATE_PATTERN.test(params.from)) {
    query = query.gte("created_at", `${params.from}T00:00:00.000Z`);
  }
  if (params.to && DATE_PATTERN.test(params.to)) {
    query = query.lt("created_at", nextUtcDay(params.to));
  }
  if (params.actor && UUID_PATTERN.test(params.actor)) {
    query = query.eq("created_by", params.actor);
  }

  const { data: batches, error: batchError } = await query;
  if (batchError) throw batchError;
  const typedBatches = (batches || []) as ExportBatchRow[];
  const batchIds = typedBatches.map(batch => String(batch.id));
  if (batchIds.length === 0) return [];

  const { data: items, error: itemError } = await sb
    .from("controller_invoice_export_items")
    .select("batch_id,invoice_id,invoice_num,work_order_id,contractor_id,total,exported_at")
    .in("batch_id", batchIds)
    .order("exported_at", { ascending: true })
    .order("invoice_id", { ascending: true });
  if (itemError) throw itemError;

  const typedItems = (items || []) as ExportItemRow[];
  const profileIds = [...new Set([
    ...typedBatches.flatMap(batch => [
      batch.created_by,
      batch.confirmed_by,
      batch.cancelled_by,
    ]),
    ...typedItems.map(item => item.contractor_id),
  ].filter(Boolean).map(String))];
  const { data: profiles, error: profileError } = profileIds.length
    ? await sb
      .from("profiles")
      .select("id,name,company")
      .in("id", profileIds)
    : { data: [], error: null };
  if (profileError) throw profileError;
  const profileById = new Map<string, ExportProfileRow>(
    ((profiles || []) as ExportProfileRow[]).map(profile => [String(profile.id), profile]),
  );
  const itemsByBatch = new Map<string, ExportHistoryItem[]>();
  for (const item of typedItems) {
    const contractor = item.contractor_id
      ? profileById.get(String(item.contractor_id))
      : null;
    const mapped: ExportHistoryItem = {
      invoiceId: String(item.invoice_id),
      invoiceNumber: String(item.invoice_num || ""),
      workOrderId: item.work_order_id ? String(item.work_order_id) : null,
      contractorId: item.contractor_id ? String(item.contractor_id) : null,
      contractorName: String(contractor?.company || contractor?.name || "Unknown contractor"),
      total: Number(item.total || 0),
    };
    const current = itemsByBatch.get(String(item.batch_id)) || [];
    current.push(mapped);
    itemsByBatch.set(String(item.batch_id), current);
  }

  const profileName = (id: unknown) => {
    if (!id) return "";
    const profile = profileById.get(String(id));
    return String(profile?.name || profile?.company || "Unknown staff member");
  };

  return typedBatches.map(batch => ({
    id: String(batch.id),
    status: String(batch.status || "confirmed") as ExportHistoryBatch["status"],
    createdAt: String(batch.created_at),
    createdBy: String(batch.created_by),
    createdByName: profileName(batch.created_by),
    confirmedAt: batch.confirmed_at ? String(batch.confirmed_at) : null,
    confirmedBy: batch.confirmed_by ? String(batch.confirmed_by) : null,
    confirmedByName: profileName(batch.confirmed_by),
    cancelledAt: batch.cancelled_at ? String(batch.cancelled_at) : null,
    cancelledBy: batch.cancelled_by ? String(batch.cancelled_by) : null,
    cancelledByName: profileName(batch.cancelled_by),
    cancellationReason: batch.cancellation_reason
      ? String(batch.cancellation_reason)
      : null,
    invoiceCount: Number(batch.invoice_count || 0),
    total: Number(batch.total || 0),
    items: itemsByBatch.get(String(batch.id)) || [],
  }));
}

const exportHistoryCsv = (batches: ExportHistoryBatch[]) => {
  const header = [
    "Batch ID",
    "Status",
    "Created By",
    "Created At",
    "Confirmed By",
    "Confirmed At",
    "Invoice Number",
    "Work Order",
    "Contractor",
    "Invoice Amount",
    "Batch Total",
    "Cancellation Reason",
  ];
  const rows = batches.flatMap(batch => batch.items.map(item => [
    batch.id,
    batch.status,
    batch.createdByName,
    batch.createdAt,
    batch.confirmedByName,
    batch.confirmedAt || "",
    item.invoiceNumber,
    item.workOrderId || "",
    item.contractorName,
    item.total.toFixed(2),
    batch.total.toFixed(2),
    batch.cancellationReason || "",
  ]));
  return [header, ...rows]
    .map(row => row.map(csvCell).join(","))
    .join("\r\n");
};

export async function GET(request: NextRequest) {
  const auth = await requireStaff(request);
  if ("error" in auth) return auth.error;

  const batchId = request.nextUrl.searchParams.get("batch")?.trim();
  if (batchId) {
    if (!auth.canHandoff) {
      return jsonError("QuickBooks handoff permission required", 403);
    }
    if (!UUID_PATTERN.test(batchId)) {
      return jsonError("A valid batch id is required", 400);
    }
    const { data: batch, error: batchError } = await auth.sb
      .from("controller_invoice_export_batches")
      .select("id,object_path,status")
      .eq("id", batchId)
      .maybeSingle();
    if (batchError) return jsonError(batchError.message, 500);
    if (!batch) return jsonError("Export batch not found", 404);
    if (batch.status === "cancelled") {
      return jsonError("Cancelled handoff archives cannot be re-downloaded", 409);
    }

    const { data: archive, error: downloadError } = await auth.sb.storage
      .from("controller-exports")
      .download(batch.object_path);
    if (downloadError || !archive) {
      return jsonError(downloadError?.message || "Stored export is unavailable", 500);
    }

    return new NextResponse(Buffer.from(await archive.arrayBuffer()), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${archiveFilename(batch.id)}"`,
        "Cache-Control": "private, no-store",
      },
    });
  }

  if (request.nextUrl.searchParams.get("history") === "1") {
    try {
      const history = await loadExportHistory(auth.sb, {
        from: request.nextUrl.searchParams.get("from") || undefined,
        to: request.nextUrl.searchParams.get("to") || undefined,
        actor: request.nextUrl.searchParams.get("actor") || undefined,
      });
      if (request.nextUrl.searchParams.get("format") === "csv") {
        return new NextResponse(`\uFEFF${exportHistoryCsv(history)}`, {
          status: 200,
          headers: {
            "Content-Type": "text/csv;charset=utf-8",
            "Content-Disposition": `attachment; filename="QuickBooks-Handoff-Audit-${new Date().toISOString().slice(0, 10)}.csv"`,
            "Cache-Control": "private, no-store",
          },
        });
      }
      const actors = [...new Map(history.map(batch => [
        batch.createdBy,
        { id: batch.createdBy, name: batch.createdByName },
      ])).values()];
      return NextResponse.json({ history, actors }, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Could not load QuickBooks handoff history",
        500,
      );
    }
  }

  let pendingIds: Set<string>;
  let heldIds: Set<string>;
  try {
    [pendingIds, heldIds] = await Promise.all([
      pendingInvoiceIds(auth.sb),
      heldInvoiceIds(auth.sb),
    ]);
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Could not load pending handoffs",
      500,
    );
  }
  const { data: oldestPendingBatch, error: pendingBatchError } = pendingIds.size > 0
    ? await auth.sb
      .from("controller_invoice_export_batches")
      .select("created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle()
    : { data: null, error: null };
  if (pendingBatchError) return jsonError(pendingBatchError.message, 500);
  const excludedIds = new Set([...pendingIds, ...heldIds]);
  let countQuery = auth.sb
    .from("invoices")
    .select("id", { count: "exact", head: true })
    .eq("invoice_type", "contractor")
    .eq("state", "approved")
    .is("qbo_synced_at", null)
    .is("deleted_at", null);
  if (excludedIds.size > 0) {
    countQuery = countQuery.not("id", "in", `(${[...excludedIds].join(",")})`);
  }
  const { count, error } = await countQuery;
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({
    count: Number(count || 0),
    limit: MAX_INVOICES,
    canHandoff: auth.canHandoff,
    pendingCount: pendingIds.size,
    oldestPendingAt: oldestPendingBatch?.created_at || null,
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireStaff(request);
  if ("error" in auth) return auth.error;
  if (!auth.canHandoff) {
    return jsonError("QuickBooks handoff permission required", 403);
  }

  let requestedIds: string[] = [];
  try {
    const body = await request.json().catch(() => ({})) as { invoiceIds?: unknown };
    if (Array.isArray(body.invoiceIds)) {
      requestedIds = [...new Set(body.invoiceIds
        .map(value => String(value || "").trim())
        .filter(Boolean))];
    }
  } catch {
    return jsonError("Invalid JSON body", 400);
  }
  if (requestedIds.length > MAX_INVOICES) {
    return jsonError(`A controller batch is limited to ${MAX_INVOICES} invoices`, 400);
  }
  if (requestedIds.some(invoiceId => !UUID_PATTERN.test(invoiceId))) {
    return jsonError("Every selected invoice id must be valid", 400);
  }
  let pendingIds: Set<string>;
  let heldIds: Set<string>;
  try {
    [pendingIds, heldIds] = await Promise.all([
      pendingInvoiceIds(auth.sb),
      heldInvoiceIds(auth.sb),
    ]);
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Could not load pending handoffs",
      500,
    );
  }
  if (requestedIds.some(invoiceId => pendingIds.has(invoiceId))) {
    return jsonError("One or more selected invoices already belong to a pending handoff", 409);
  }
  if (requestedIds.some(invoiceId => heldIds.has(invoiceId))) {
    return jsonError("One or more selected invoices are on payment hold", 409);
  }
  const excludedIds = new Set([...pendingIds, ...heldIds]);
  if (requestedIds.length === 0) {
    let countQuery = auth.sb
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .eq("invoice_type", "contractor")
      .eq("state", "approved")
      .is("qbo_synced_at", null)
      .is("deleted_at", null);
    if (excludedIds.size > 0) {
      countQuery = countQuery.not("id", "in", `(${[...excludedIds].join(",")})`);
    }
    const { count, error: countError } = await countQuery;
    if (countError) return jsonError(countError.message, 500);
    if (Number(count || 0) > MAX_INVOICES) {
      return jsonError(`The approved queue exceeds the safe ${MAX_INVOICES}-invoice batch limit`, 409);
    }
  }

  let invoiceQuery = auth.sb
    .from("invoices")
    .select("id,num,work_order_id,store_number,store_address,invoice_date,service_date,due_date,terms,cme,tax_rate,tax_state,territory,subtotal,sales_tax,total,contractor_id,pdf_storage_path,state,invoice_type,deleted_at,qbo_synced_at")
    .eq("invoice_type", "contractor")
    .eq("state", "approved")
    .is("qbo_synced_at", null)
    .is("deleted_at", null)
    .order("updated_at", { ascending: true })
    .limit(MAX_INVOICES);
  if (excludedIds.size > 0) {
    invoiceQuery = invoiceQuery.not("id", "in", `(${[...excludedIds].join(",")})`);
  }
  const { data: invoices, error: invoiceError } = requestedIds.length
    ? await invoiceQuery.in("id", requestedIds)
    : await invoiceQuery;
  if (invoiceError) return jsonError(invoiceError.message, 500);
  if (!invoices?.length) return jsonError("No approved invoices are waiting for QuickBooks", 409);
  if (requestedIds.length && invoices.length !== requestedIds.length) {
    return jsonError("One or more selected invoices changed before export", 409);
  }

  const invoiceIds = invoices.map(invoice => invoice.id);
  const workOrderIds = [...new Set(invoices
    .map(invoice => invoice.work_order_id)
    .filter((id): id is string => Boolean(id)))];
  const contractorIds = [...new Set(invoices
    .map(invoice => invoice.contractor_id)
    .filter((id): id is string => Boolean(id)))];
  const [lineResult, uploadResult, profileResult] = await Promise.all([
    auth.sb
      .from("invoice_lines")
      .select("invoice_id,position,type,description,qty,rate,amount,is_taxable")
      .in("invoice_id", invoiceIds)
      .order("invoice_id", { ascending: true })
      .order("position", { ascending: true }),
    workOrderIds.length
      ? auth.sb
        .from("activities")
        .select("event_data")
        .in("work_order_id", workOrderIds)
        .eq("event_key", "invoice_uploaded")
        .is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
    contractorIds.length
      ? auth.sb
        .from("profiles")
        .select("id,name,company,email,phone")
        .in("id", contractorIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const { data: lines, error: lineError } = lineResult;
  if (lineError) return jsonError(lineError.message, 500);
  if (uploadResult.error) return jsonError(uploadResult.error.message, 500);
  if (profileResult.error) return jsonError(profileResult.error.message, 500);

  const linesByInvoice = new Map<string, InvoiceLineRow[]>();
  for (const line of lines || []) {
    const rows = linesByInvoice.get(line.invoice_id) || [];
    rows.push(line);
    linesByInvoice.set(line.invoice_id, rows);
  }
  const originalUploadInvoiceIds = new Set<string>();
  for (const activity of uploadResult.data || []) {
    const eventData = activity.event_data;
    if (!eventData || typeof eventData !== "object" || Array.isArray(eventData)) continue;
    const invoiceId = typeof eventData.invoiceId === "string" ? eventData.invoiceId : "";
    if (invoiceIds.includes(invoiceId)) originalUploadInvoiceIds.add(invoiceId);
  }
  const profilesById = new Map(
    (profileResult.data || []).map(profile => [profile.id, profile]),
  );
  const missingSource = invoices.filter(invoice =>
    !invoice.pdf_storage_path
    && !(linesByInvoice.get(invoice.id) || []).length,
  );
  if (missingSource.length) {
    return jsonError(
      `Source PDF and line items are unavailable for ${missingSource.slice(0, 6).map(invoice => `#${invoice.num}`).join(", ")}. No invoices were changed.`,
      409,
    );
  }

  const batchId = crypto.randomUUID();
  const objectPath = `${new Date().toISOString().slice(0, 10)}/${batchId}.zip`;
  const entries: ZipArchiveEntry[] = [];

  try {
    for (const invoice of invoices) {
      const invoiceLines = linesByInvoice.get(invoice.id) || [];
      let pdfBytes: Uint8Array;
      const useStoredOriginal = Boolean(invoice.pdf_storage_path)
        && (originalUploadInvoiceIds.has(invoice.id) || invoiceLines.length === 0);

      if (useStoredOriginal) {
        const { data: pdf, error: pdfError } = await auth.sb.storage
          .from("invoice-pdfs")
          .download(invoice.pdf_storage_path!);
        if (pdfError || !pdf) {
          throw new Error(`Could not load source PDF for invoice #${invoice.num}: ${pdfError?.message || "empty file"}`);
        }
        pdfBytes = new Uint8Array(await pdf.arrayBuffer());
      } else {
        const contractor = invoice.contractor_id
          ? profilesById.get(invoice.contractor_id)
          : null;
        const generatedPdf = generateInvoicePDFBlob({
          num: invoice.num,
          wot: invoice.work_order_id || "",
          store: invoice.store_number || "",
          storeAddr: invoice.store_address || "",
          invoiceDate: invoice.invoice_date,
          serviceDate: invoice.service_date || undefined,
          terms: invoice.terms || undefined,
          cme: invoice.cme || undefined,
          lines: invoiceLines.map(line => ({
            type: line.type,
            desc: line.description || "",
            qty: Number(line.qty || 0),
            rate: Number(line.rate || 0),
            amount: Number(line.amount || 0),
          })),
          subtotal: Number(invoice.subtotal || 0),
          salesTax: Number(invoice.sales_tax || 0),
          total: Number(invoice.total || 0),
        }, null, {
          perspective: "contractor",
          fromName: contractor?.company || contractor?.name || "Contractor",
          fromEmail: contractor?.email || "",
          fromPhone: contractor?.phone || "",
        });
        pdfBytes = new Uint8Array(await generatedPdf.arrayBuffer());
      }
      entries.push({
        name: `Source-PDFs/Invoice-${filenameToken(invoice.num, "Invoice")}-${filenameToken(invoice.work_order_id, "Standalone")}.pdf`,
        data: pdfBytes,
      });
    }

    const csv = generateInvoiceBatchCsv(invoices.map(invoice =>
      invoiceForCsv(invoice, linesByInvoice.get(invoice.id) || []),
    ));
    entries.unshift({
      name: "QuickBooks-approved-invoices.csv",
      data: new TextEncoder().encode(`\uFEFF${csv}`),
    });

    const archive = createZipArchive(entries);
    if (archive.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error("The export exceeds the 95 MB safe archive limit. Export a smaller batch.");
    }

    const { error: uploadError } = await auth.sb.storage
      .from("controller-exports")
      .upload(objectPath, archive, {
        contentType: "application/zip",
        upsert: false,
      });
    if (uploadError) throw uploadError;

    const { error: completeError } = await auth.sb.rpc(
      "stage_controller_invoice_export",
      {
        p_batch_id: batchId,
        p_actor_id: auth.profile.id,
        p_object_path: objectPath,
        p_invoice_ids: invoiceIds,
      },
    );
    if (completeError) {
      await auth.sb.storage.from("controller-exports").remove([objectPath]);
      return jsonError(`${completeError.message}. The archive was discarded and no invoices were changed.`, 409);
    }

    return new NextResponse(Buffer.from(archive), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${archiveFilename(batchId)}"`,
        "Cache-Control": "no-store",
        "X-Controller-Export-Batch": batchId,
        "X-Controller-Export-Status": "pending",
      },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Controller export failed", 500);
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireStaff(request);
  if ("error" in auth) return auth.error;
  if (!auth.canHandoff) {
    return jsonError("QuickBooks handoff permission required", 403);
  }

  let body: { batchId?: unknown; action?: unknown; reason?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const batchId = String(body.batchId || "").trim();
  const action = String(body.action || "").trim();
  if (!UUID_PATTERN.test(batchId)) {
    return jsonError("A valid batch id is required", 400);
  }

  try {
    if (action === "confirm") {
      const { data, error } = await auth.sb.rpc(
        "confirm_controller_invoice_export",
        { p_batch_id: batchId, p_actor_id: auth.profile.id },
      );
      if (error) throw error;
      return NextResponse.json({ batch: data }, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (action === "cancel") {
      const reason = String(body.reason || "").trim();
      if (!reason) return jsonError("A cancellation reason is required", 400);
      if (reason.length > 500) return jsonError("Cancellation reason is too long", 400);
      const { data, error } = await auth.sb.rpc(
        "cancel_controller_invoice_export",
        {
          p_batch_id: batchId,
          p_actor_id: auth.profile.id,
          p_reason: reason,
        },
      );
      if (error) throw error;
      return NextResponse.json({ batch: data }, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    return jsonError("Action must be confirm or cancel", 400);
  } catch (error: unknown) {
    const errorData = error && typeof error === "object"
      ? error as { code?: unknown; message?: unknown }
      : {};
    const code = String(errorData.code || "");
    const status = code === "42501"
      ? 403
      : code === "P0002"
        ? 404
        : ["22023"].includes(code)
          ? 400
          : ["40001", "55000"].includes(code)
            ? 409
            : 500;
    return jsonError(
      String(errorData.message || "QuickBooks handoff update failed"),
      status,
    );
  }
}
