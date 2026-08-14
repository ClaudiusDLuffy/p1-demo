import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

import { generateInvoiceBatchCsv } from "../../../lib/invoiceCsv";
import { generateInvoicePDFBlob } from "../../../lib/invoicePdf";
import {
  isInvoiceControllerProfile,
  loadStaffPermissions,
} from "../../../lib/server/staffAuthorization";
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

async function requireController(request: NextRequest) {
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
  if (!profile?.active) return { error: jsonError("Forbidden", 403) };

  try {
    const staffPermissions = await loadStaffPermissions(sb, profile.id);
    if (!isInvoiceControllerProfile({ staffPermissions })) {
      return { error: jsonError("Invoice controller permission required", 403) };
    }
    return { sb, profile: { ...profile, staffPermissions } };
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

export async function POST(request: NextRequest) {
  const auth = await requireController(request);
  if ("error" in auth) return auth.error;

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

  const invoiceQuery = auth.sb
    .from("invoices")
    .select("id,num,work_order_id,store_number,store_address,invoice_date,service_date,due_date,terms,cme,tax_rate,tax_state,territory,subtotal,sales_tax,total,contractor_id,pdf_storage_path,state,invoice_type,deleted_at")
    .eq("invoice_type", "contractor")
    .eq("state", "approved")
    .is("deleted_at", null)
    .order("updated_at", { ascending: true })
    .limit(MAX_INVOICES);
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
      "complete_controller_invoice_export",
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
      },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Controller export failed", 500);
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireController(request);
  if ("error" in auth) return auth.error;

  const batchId = request.nextUrl.searchParams.get("batch")?.trim();
  if (!batchId) return jsonError("Batch id is required", 400);

  // This table is introduced by migration 0064 and may not yet be present in
  // the checked-in generated Supabase types when this route is deployed.
  const { data: batch, error: batchError } = await auth.sb
    .from("controller_invoice_export_batches")
    .select("id,object_path")
    .eq("id", batchId)
    .maybeSingle();
  if (batchError) return jsonError(batchError.message, 500);
  if (!batch) return jsonError("Export batch not found", 404);

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
