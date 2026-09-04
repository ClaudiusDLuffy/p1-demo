import { createHash } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

import {
  contractorBillPdfPath,
  generateContractorBillManifestCsv,
  type ContractorBillManifestItem,
} from "../../../lib/contractorBillManifest";
import { generateInvoicePDFBlob } from "../../../lib/invoicePdf";
import { resolveQuickBooksEquipmentTag } from "../../../lib/quickBooksEquipmentTags";
import {
  canHandoffQuickBooksProfile,
  loadStaffPermissions,
  STAFF_ROLES,
} from "../../../lib/server/staffAuthorization";
import { collectSupabasePages } from "../../../lib/paginatedQuery";
import { createServerClient } from "../../../lib/supabase/server";
import type { Database, Tables } from "../../../lib/supabase/database.types";
import { canonicalSevenElevenWorkOrderId } from "../../../lib/workOrderIdentity";
import { escapeCsvCell } from "../../../lib/csvSafety";
import {
  createZipArchive,
  type ZipArchiveEntry,
  zipArchiveByteLength,
} from "../../../lib/zipArchive";

export const runtime = "nodejs";

const MAX_INVOICES = 500;
const MAX_ARCHIVE_BYTES = 95 * 1024 * 1024;

const jsonError = (message: string, status: number) =>
  NextResponse.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

const errorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message || fallback);
  }
  return fallback;
};

const hasDefinitiveDatabaseErrorCode = (error: unknown) => {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return String((error as { code?: unknown }).code || "").trim().length > 0;
};

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

type ContractorBillInvoiceRow = Pick<Tables<"invoices">,
  | "id"
  | "num"
  | "work_order_id"
  | "store_number"
  | "store_address"
  | "invoice_date"
  | "service_date"
  | "due_date"
  | "terms"
  | "cme"
  | "tax_rate"
  | "tax_state"
  | "territory"
  | "subtotal"
  | "sales_tax"
  | "total"
  | "contractor_id"
  | "pdf_storage_path"
  | "state"
  | "invoice_type"
  | "deleted_at"
  | "qbo_synced_at"
  | "qbo_invoice_id"
  | "updated_at"
>;

const CONTRACTOR_BILL_INVOICE_COLUMNS = "id,num,work_order_id,store_number,store_address,invoice_date,service_date,due_date,terms,cme,tax_rate,tax_state,territory,subtotal,sales_tax,total,contractor_id,pdf_storage_path,state,invoice_type,deleted_at,qbo_synced_at,qbo_invoice_id,updated_at" as const;

type ContractorBillArchiveFormat = "reference_manifest_v2" | "legacy_saas_ant_v1";

const archiveFilename = (
  batchId: string,
  format: ContractorBillArchiveFormat = "reference_manifest_v2",
  createdAt: string | Date = new Date(),
) => {
  const parsed = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const day = Number.isNaN(parsed.getTime())
    ? new Date().toISOString().slice(0, 10)
    : parsed.toISOString().slice(0, 10);
  return format === "reference_manifest_v2"
    ? `Contractor-Bills-${day}-${batchId.slice(0, 12)}.zip`
    : `Legacy-QuickBooks-Handoff-${day}-${batchId.slice(0, 12)}.zip`;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const nextUtcDay = (value: string) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
};

const chunk = <T,>(values: T[], size = 100): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
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
> & { archive_format?: string | null };
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
type ContractorProfileRow = Pick<Tables<"profiles">,
  "id" | "name" | "company" | "email" | "phone"
>;
type ContractorBillWorkOrderRow = Pick<Tables<"work_orders">,
  | "id"
  | "duplicate_root_work_order_id"
  | "line_of_service"
  | "business_service"
  | "category"
  | "sub_category"
  | "summary"
  | "description"
>;

async function pendingInvoiceIds(sb: ReturnType<typeof createServerClient>) {
  const items = await collectSupabasePages<Pick<ExportItemRow, "invoice_id">>((from, to) => sb
    .from("controller_invoice_export_items")
    .select("invoice_id,controller_invoice_export_batches!inner(status)")
    .eq("controller_invoice_export_batches.status", "pending")
    .order("exported_at", { ascending: true })
    .order("batch_id", { ascending: true })
    .order("invoice_id", { ascending: true })
    .range(from, to)
    .overrideTypes<Array<Pick<ExportItemRow, "invoice_id">>, { merge: false }>());
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

const eligibleContractorBillCountQuery = (
  sb: ReturnType<typeof createServerClient>,
) => sb
  .from("invoices")
  .select("id", { count: "exact", head: true })
  .eq("invoice_type", "contractor")
  .eq("state", "approved")
  .is("qbo_synced_at", null)
  .is("qbo_invoice_id", null)
  .is("deleted_at", null);

const eligibleContractorBillIdsQuery = (
  sb: ReturnType<typeof createServerClient>,
) => sb
  .from("invoices")
  .select("id")
  .eq("invoice_type", "contractor")
  .eq("state", "approved")
  .is("qbo_synced_at", null)
  .is("qbo_invoice_id", null)
  .is("deleted_at", null);

const eligibleContractorBillSourceQuery = (
  sb: ReturnType<typeof createServerClient>,
) => sb
  .from("invoices")
  .select(CONTRACTOR_BILL_INVOICE_COLUMNS)
  .eq("invoice_type", "contractor")
  .eq("state", "approved")
  .is("qbo_synced_at", null)
  .is("qbo_invoice_id", null)
  .is("deleted_at", null);

async function availableContractorBillCount(
  sb: ReturnType<typeof createServerClient>,
  excludedIds: Set<string>,
) {
  const { count, error } = await eligibleContractorBillCountQuery(sb);
  if (error) throw error;

  let excludedEligibleCount = 0;
  for (const ids of chunk([...excludedIds])) {
    const { data, error: excludedError } = await eligibleContractorBillIdsQuery(sb)
      .in("id", ids);
    if (excludedError) throw excludedError;
    excludedEligibleCount += (data || []).length;
  }

  return Math.max(0, Number(count || 0) - excludedEligibleCount);
}

async function loadRequestedContractorBills(
  sb: ReturnType<typeof createServerClient>,
  requestedIds: string[],
): Promise<ContractorBillInvoiceRow[]> {
  const invoices: ContractorBillInvoiceRow[] = [];
  for (const ids of chunk(requestedIds)) {
    const { data, error } = await eligibleContractorBillSourceQuery(sb)
      .in("id", ids)
      .order("updated_at", { ascending: true })
      .order("id", { ascending: true });
    if (error) throw error;
    invoices.push(...(data || []));
  }
  return invoices.sort((left, right) => {
    const revisionOrder = String(left.updated_at || "").localeCompare(String(right.updated_at || ""));
    return revisionOrder || left.id.localeCompare(right.id);
  });
}

async function loadAvailableContractorBills(
  sb: ReturnType<typeof createServerClient>,
  excludedIds: Set<string>,
): Promise<ContractorBillInvoiceRow[]> {
  const invoices: ContractorBillInvoiceRow[] = [];
  const pageSize = MAX_INVOICES;
  let from = 0;

  while (invoices.length < MAX_INVOICES) {
    const { data, error } = await eligibleContractorBillSourceQuery(sb)
      .order("updated_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const page = data || [];
    for (const invoice of page) {
      if (!excludedIds.has(invoice.id)) invoices.push(invoice);
      if (invoices.length === MAX_INVOICES) break;
    }
    if (page.length < pageSize) break;
    from += pageSize;
  }

  return invoices;
}

async function loadContractorProfiles(
  sb: ReturnType<typeof createServerClient>,
  contractorIds: string[],
): Promise<ContractorProfileRow[]> {
  const profiles: ContractorProfileRow[] = [];
  for (const ids of chunk(contractorIds)) {
    const { data, error } = await sb
      .from("profiles")
      .select("id,name,company,email,phone")
      .in("id", ids);
    if (error) throw error;
    profiles.push(...(data || []));
  }
  return profiles;
}

async function loadContractorBillWorkOrders(
  sb: ReturnType<typeof createServerClient>,
  workOrderIds: string[],
): Promise<ContractorBillWorkOrderRow[]> {
  const workOrders: ContractorBillWorkOrderRow[] = [];
  for (const ids of chunk(workOrderIds)) {
    const { data, error } = await sb
      .from("work_orders")
      .select("id,duplicate_root_work_order_id,line_of_service,business_service,category,sub_category,summary,description")
      .in("id", ids);
    if (error) throw error;
    workOrders.push(...(data || []));
  }
  return workOrders;
}

async function loadExportHistory(
  sb: ReturnType<typeof createServerClient>,
  params: { from?: string; to?: string; actor?: string; all?: boolean },
): Promise<ExportHistoryBatch[]> {
  const loadBatchPage = (from: number, to: number) => {
    let query = sb
      .from("controller_invoice_export_batches")
      .select("id,status,created_at,created_by,confirmed_at,confirmed_by,cancelled_at,cancelled_by,cancellation_reason,invoice_count,total")
      .order("created_at", { ascending: Boolean(params.all) })
      .order("id", { ascending: Boolean(params.all) });
    if (params.from && DATE_PATTERN.test(params.from)) {
      query = query.gte("created_at", `${params.from}T00:00:00.000Z`);
    }
    if (params.to && DATE_PATTERN.test(params.to)) {
      query = query.lt("created_at", nextUtcDay(params.to));
    }
    if (params.actor && UUID_PATTERN.test(params.actor)) {
      query = query.eq("created_by", params.actor);
    }
    return query.range(from, to);
  };
  let typedBatches: ExportBatchRow[];
  if (params.all) {
    typedBatches = await collectSupabasePages<ExportBatchRow>(loadBatchPage);
  } else {
    const page = await loadBatchPage(0, 99);
    if (page.error) throw page.error;
    typedBatches = (page.data || []) as ExportBatchRow[];
  }
  const batchIds = typedBatches.map(batch => String(batch.id));
  if (batchIds.length === 0) return [];

  const typedItems = (await Promise.all(chunk(batchIds).map(ids =>
    collectSupabasePages<ExportItemRow>((from, to) => sb
      .from("controller_invoice_export_items")
      .select("batch_id,invoice_id,invoice_num,work_order_id,contractor_id,total,exported_at")
      .in("batch_id", ids)
      .order("exported_at", { ascending: true })
      .order("invoice_id", { ascending: true })
      .range(from, to)),
  ))).flat();
  const profileIds = [...new Set([
    ...typedBatches.flatMap(batch => [
      batch.created_by,
      batch.confirmed_by,
      batch.cancelled_by,
    ]),
    ...typedItems.map(item => item.contractor_id),
  ].filter(Boolean).map(String))];
  const profiles = profileIds.length
    ? (await Promise.all(chunk(profileIds).map(ids =>
      collectSupabasePages<ExportProfileRow>((from, to) => sb
        .from("profiles")
        .select("id,name,company")
        .in("id", ids)
        .order("id", { ascending: true })
        .range(from, to)),
    ))).flat()
    : [];
  const profileById = new Map<string, ExportProfileRow>(
    profiles.map(profile => [String(profile.id), profile]),
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

function* exportHistoryCsvRows(batches: ExportHistoryBatch[]): Generator<string> {
  const header = [
    "Batch ID",
    "Status",
    "Created By",
    "Created At",
    "Confirmed By",
    "Confirmed At",
    "Cancelled By",
    "Cancelled At",
    "Invoice Number",
    "Work Order",
    "Contractor",
    "Invoice Amount",
    "Batch Total",
    "Cancellation Reason",
  ];
  yield `\uFEFF${header.map(escapeCsvCell).join(",")}\r\n`;
  for (const batch of batches) {
    for (const item of batch.items) {
      yield [
        batch.id, batch.status, batch.createdByName, batch.createdAt,
        batch.confirmedByName, batch.confirmedAt || "",
        batch.cancelledByName, batch.cancelledAt || "",
        item.invoiceNumber, item.workOrderId || "", item.contractorName,
        item.total.toFixed(2), batch.total.toFixed(2),
        batch.cancellationReason || "",
      ].map(escapeCsvCell).join(",") + "\r\n";
    }
  }
}

const csvResponseStream = (batches: ExportHistoryBatch[]) => {
  const rows = exportHistoryCsvRows(batches);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = rows.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
  });
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
      .select("id,object_path,status,created_at,archive_format")
      .eq("id", batchId)
      .maybeSingle();
    if (batchError) return jsonError(batchError.message, 500);
    if (!batch) return jsonError("Export batch not found", 404);
    if (batch.status === "cancelled") {
      return jsonError("Cancelled handoff archives cannot be re-downloaded", 409);
    }

    const format: ContractorBillArchiveFormat = batch.archive_format === "reference_manifest_v2"
      ? "reference_manifest_v2"
      : "legacy_saas_ant_v1";
    const filename = archiveFilename(batch.id, format, batch.created_at);
    const { data: signed, error: downloadError } = await auth.sb.storage
      .from("controller-exports")
      .createSignedUrl(batch.object_path, 120, { download: filename });
    if (downloadError || !signed?.signedUrl) {
      return jsonError(downloadError?.message || "Stored export is unavailable", 500);
    }
    return NextResponse.json({
      batchId: batch.id,
      downloadUrl: signed.signedUrl,
      filename,
      format,
    }, {
      headers: {
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  if (request.nextUrl.searchParams.get("history") === "1") {
    try {
      const history = await loadExportHistory(auth.sb, {
        from: request.nextUrl.searchParams.get("from") || undefined,
        to: request.nextUrl.searchParams.get("to") || undefined,
        actor: request.nextUrl.searchParams.get("actor") || undefined,
        all: request.nextUrl.searchParams.get("format") === "csv",
      });
      if (request.nextUrl.searchParams.get("format") === "csv") {
        return new Response(csvResponseStream(history), {
          status: 200,
          headers: {
            "Content-Type": "text/csv;charset=utf-8",
            "Content-Disposition": `attachment; filename="Contractor-Bill-Handoff-Audit-${new Date().toISOString().slice(0, 10)}.csv"`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
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
  let count: number;
  try {
    count = await availableContractorBillCount(auth.sb, excludedIds);
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Could not count contractor bills",
      500,
    );
  }

  return NextResponse.json({
    count,
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
    const body = await request.json() as { invoiceIds?: unknown };
    if (
      !body
      || typeof body !== "object"
      || Array.isArray(body)
      || (body.invoiceIds !== undefined && !Array.isArray(body.invoiceIds))
    ) {
      return jsonError("invoiceIds must be an array when provided", 400);
    }
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
    let availableCount: number;
    try {
      availableCount = await availableContractorBillCount(auth.sb, excludedIds);
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Could not count contractor bills",
        500,
      );
    }
    if (availableCount > MAX_INVOICES) {
      return jsonError(`The approved queue exceeds the safe ${MAX_INVOICES}-invoice batch limit`, 409);
    }
  }

  let invoices: ContractorBillInvoiceRow[];
  try {
    invoices = requestedIds.length
      ? await loadRequestedContractorBills(auth.sb, requestedIds)
      : await loadAvailableContractorBills(auth.sb, excludedIds);
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Could not load contractor bills",
      500,
    );
  }
  if (!invoices?.length) return jsonError("No approved contractor bills are waiting for payables handoff", 409);
  if (requestedIds.length && invoices.length !== requestedIds.length) {
    return jsonError("One or more selected invoices changed before export", 409);
  }

  const invoiceIds = invoices.map(invoice => invoice.id);
  const invoiceIdSet = new Set(invoiceIds);
  const workOrderIds = [...new Set(invoices
    .map(invoice => invoice.work_order_id)
    .filter((id): id is string => Boolean(id)))];
  const contractorIds = [...new Set(invoices
    .map(invoice => invoice.contractor_id)
    .filter((id): id is string => Boolean(id)))];
  let lines: InvoiceLineRow[];
  let uploadActivities: Array<{ event_data: Tables<"activities">["event_data"] }>;
  try {
    [lines, uploadActivities] = await Promise.all([
      (await Promise.all(chunk(invoiceIds).map(ids =>
        collectSupabasePages<InvoiceLineRow>((from, to) => auth.sb
          .from("invoice_lines")
          .select("invoice_id,position,type,description,qty,rate,amount,is_taxable")
          .in("invoice_id", ids)
          .order("invoice_id", { ascending: true })
          .order("position", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to)),
      ))).flat(),
      workOrderIds.length
        ? (await Promise.all(chunk(workOrderIds).map(ids =>
          collectSupabasePages<{ event_data: Tables<"activities">["event_data"] }>((from, to) => auth.sb
            .from("activities")
            .select("event_data")
            .in("work_order_id", ids)
            .eq("event_key", "invoice_uploaded")
            .is("deleted_at", null)
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to)),
        ))).flat()
        : [],
    ]);
  } catch (sourceError) {
    return jsonError(
      sourceError instanceof Error ? sourceError.message : "Could not load contractor-bill source data",
      500,
    );
  }
  let profiles: ContractorProfileRow[];
  let workOrders: ContractorBillWorkOrderRow[];
  try {
    [profiles, workOrders] = await Promise.all([
      loadContractorProfiles(auth.sb, contractorIds),
      loadContractorBillWorkOrders(auth.sb, workOrderIds),
    ]);
  } catch (sourceError) {
    return jsonError(
      sourceError instanceof Error ? sourceError.message : "Could not load contractor-bill references",
      500,
    );
  }

  const externalWorkOrderIdById = new Map(
    workOrders.map(workOrder => [
      workOrder.id,
      canonicalSevenElevenWorkOrderId({
        id: workOrder.id,
        duplicate_root_work_order_id: workOrder.duplicate_root_work_order_id,
      }),
    ]),
  );
  const workOrdersById = new Map(
    workOrders.map(workOrder => [workOrder.id, workOrder]),
  );
  const externalWorkOrderIdFor = (workOrderId: string | null) => {
    if (!workOrderId) return "";
    return externalWorkOrderIdById.get(workOrderId)
      || canonicalSevenElevenWorkOrderId(workOrderId);
  };

  const linesByInvoice = new Map<string, InvoiceLineRow[]>();
  for (const line of lines || []) {
    const rows = linesByInvoice.get(line.invoice_id) || [];
    rows.push(line);
    linesByInvoice.set(line.invoice_id, rows);
  }
  const originalUploadInvoiceIds = new Set<string>();
  for (const activity of uploadActivities) {
    const eventData = activity.event_data;
    if (!eventData || typeof eventData !== "object" || Array.isArray(eventData)) continue;
    const invoiceId = typeof eventData.invoiceId === "string" ? eventData.invoiceId : "";
    if (invoiceIdSet.has(invoiceId)) originalUploadInvoiceIds.add(invoiceId);
  }
  const profilesById = new Map(
    profiles.map(profile => [profile.id, profile]),
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
  const missingRevision = invoices.filter(invoice => !invoice.updated_at);
  if (missingRevision.length) {
    return jsonError(
      `A source revision is unavailable for ${missingRevision.slice(0, 6).map(invoice => `#${invoice.num}`).join(", ")}. No invoices were changed.`,
      409,
    );
  }

  const batchId = crypto.randomUUID();
  const objectPath = `${new Date().toISOString().slice(0, 10)}/${batchId}.zip`;
  const entries: ZipArchiveEntry[] = [];
  const manifestItems: ContractorBillManifestItem[] = [];

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
      const sourcePdf = contractorBillPdfPath({
        portalInvoiceId: invoice.id,
        contractorInvoiceNumber: invoice.num,
        externalWorkOrderId: externalWorkOrderIdFor(invoice.work_order_id),
      });
      entries.push({
        name: sourcePdf,
        data: pdfBytes,
      });
      if (zipArchiveByteLength(entries) > MAX_ARCHIVE_BYTES) {
        throw new Error("The export exceeds the 95 MB safe archive limit. Export a smaller batch.");
      }
      const contractor = invoice.contractor_id
        ? profilesById.get(invoice.contractor_id)
        : null;
      manifestItems.push({
        portalInvoiceId: invoice.id,
        contractorInvoiceNumber: invoice.num,
        contractorName: contractor?.company || contractor?.name || "Unknown contractor",
        contractorEmail: contractor?.email || "",
        externalWorkOrderId: externalWorkOrderIdFor(invoice.work_order_id),
        portalWorkOrderId: invoice.work_order_id || "",
        storeNumber: invoice.store_number || "",
        equipmentTag: resolveQuickBooksEquipmentTag(
          invoice.work_order_id ? workOrdersById.get(invoice.work_order_id) : null,
        ),
        invoiceDate: invoice.invoice_date,
        serviceDate: invoice.service_date,
        dueDate: invoice.due_date,
        subtotal: Number(invoice.subtotal || 0),
        salesTax: Number(invoice.sales_tax || 0),
        total: Number(invoice.total || 0),
        sourcePdf,
      });
    }

    const manifestCsv = generateContractorBillManifestCsv(manifestItems);
    entries.unshift({
      name: "Contractor-bills-reference-manifest.csv",
      data: new TextEncoder().encode(`\uFEFF${manifestCsv}`),
    });

    const expectedArchiveBytes = zipArchiveByteLength(entries);
    if (expectedArchiveBytes > MAX_ARCHIVE_BYTES) {
      throw new Error("The export exceeds the 95 MB safe archive limit. Export a smaller batch.");
    }
    const archive = createZipArchive(entries);
    if (archive.byteLength !== expectedArchiveBytes) {
      throw new Error("The contractor-bill archive failed its integrity size check.");
    }
    const archiveSha256 = createHash("sha256").update(archive).digest("hex");

    let uploadFailure: unknown = null;
    try {
      const upload = await auth.sb.storage
        .from("controller-exports")
        .upload(objectPath, archive, {
          contentType: "application/zip",
          upsert: false,
        });
      uploadFailure = upload.error;
    } catch (error) {
      uploadFailure = error;
    }
    if (uploadFailure) {
      let cleanupError: unknown = null;
      try {
        const cleanup = await auth.sb.storage.from("controller-exports").remove([objectPath]);
        cleanupError = cleanup.error;
      } catch (error) {
        cleanupError = error;
      }
      const uploadMessage = errorMessage(uploadFailure, "Could not store the contractor-bill archive");
      return cleanupError
        ? jsonError(`${uploadMessage}. Storage cleanup also failed; an un-staged object may require recovery: ${errorMessage(cleanupError, "storage cleanup failed")}`, 500)
        : jsonError(`${uploadMessage}. No batch was staged and any partial archive was discarded.`, 500);
    }

    const filename = archiveFilename(batchId);
    let signedUrl = "";
    let signedUrlFailure: unknown = null;
    try {
      const signing = await auth.sb.storage
        .from("controller-exports")
        .createSignedUrl(objectPath, 120, { download: filename });
      signedUrl = signing.data?.signedUrl || "";
      signedUrlFailure = signing.error;
    } catch (error) {
      signedUrlFailure = error;
    }
    if (signedUrlFailure || !signedUrl) {
      let cleanupError: unknown = null;
      try {
        const cleanup = await auth.sb.storage.from("controller-exports").remove([objectPath]);
        cleanupError = cleanup.error;
      } catch (error) {
        cleanupError = error;
      }
      const signingMessage = errorMessage(signedUrlFailure, "Could not authorize the contractor-bill download");
      return cleanupError
        ? jsonError(`${signingMessage}. The un-staged archive could not be removed and was retained for recovery: ${errorMessage(cleanupError, "storage cleanup failed")}`, 500)
        : jsonError(`${signingMessage}. The un-staged archive was discarded and no invoices were changed.`, 500);
    }

    let stageFailure: unknown = null;
    let stageOutcomeAmbiguous = false;
    try {
      const stageResult = await auth.sb.rpc(
        "stage_contractor_bill_handoff",
        {
          p_batch_id: batchId,
          p_actor_id: auth.profile.id,
          p_object_path: objectPath,
          p_sources: invoices.map(invoice => ({
            invoiceId: invoice.id,
            updatedAt: invoice.updated_at,
          })),
          p_archive_sha256: archiveSha256,
          p_archive_bytes: archive.byteLength,
          p_archive_format: "reference_manifest_v2",
        },
      );
      stageFailure = stageResult.error;
      stageOutcomeAmbiguous = Boolean(stageFailure)
        && !hasDefinitiveDatabaseErrorCode(stageFailure);
    } catch (error) {
      stageFailure = error;
      stageOutcomeAmbiguous = true;
    }
    if (stageFailure) {
      const stageMessage = errorMessage(stageFailure, "Contractor-bill staging failed");
      let recoveredBatch: {
        id: string;
        status: string;
        object_path: string;
        archive_sha256: string | null;
        archive_bytes: number | null;
        archive_format: string | null;
      } | null = null;
      let recoveryError: unknown = null;
      try {
        const recovery = await auth.sb
          .from("controller_invoice_export_batches")
          .select("id,status,object_path,archive_sha256,archive_bytes,archive_format")
          .eq("id", batchId)
          .eq("object_path", objectPath)
          .maybeSingle();
        recoveredBatch = recovery.data;
        recoveryError = recovery.error;
      } catch (error) {
        recoveryError = error;
      }
      if (recoveryError) {
        return jsonError(
          `${stageMessage}. The server could not safely verify whether staging completed; the uploaded archive was retained for recovery.`,
          500,
        );
      }
      if (recoveredBatch) {
        const fingerprintMatches = recoveredBatch.archive_sha256 === archiveSha256
          && Number(recoveredBatch.archive_bytes) === archive.byteLength
          && recoveredBatch.archive_format === "reference_manifest_v2";
        if (!fingerprintMatches || recoveredBatch.status !== "pending") {
          return jsonError(
            `${stageMessage}. A batch record exists but its package fingerprint or pending state could not be verified; the archive and audit record were retained for recovery.`,
            500,
          );
        }
      } else {
        if (stageOutcomeAmbiguous) {
          return jsonError(
            `${stageMessage}. The database outcome is still unknown, so the uploaded archive was retained for safe reconciliation and was not deleted.`,
            500,
          );
        }
        let cleanupError: unknown = null;
        try {
          const cleanup = await auth.sb.storage.from("controller-exports").remove([objectPath]);
          cleanupError = cleanup.error;
        } catch (error) {
          cleanupError = error;
        }
        if (cleanupError) {
          return jsonError(
            `${stageMessage}. No batch was staged, but the orphaned archive could not be removed and was retained for recovery: ${errorMessage(cleanupError, "storage cleanup failed")}`,
            500,
          );
        }
        return jsonError(`${stageMessage}. The archive was discarded and no invoices were changed.`, 409);
      }
    }

    return NextResponse.json({
      batchId,
      status: "pending",
      downloadUrl: signedUrl,
      filename,
      format: "reference_manifest_v2",
      archiveSha256,
      archiveBytes: archive.byteLength,
    }, {
      headers: {
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
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
