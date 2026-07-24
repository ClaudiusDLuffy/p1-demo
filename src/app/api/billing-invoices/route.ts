import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "../../../lib/supabase/server";
import { normalizeStateCode } from "../../../lib/billingRules";
import type { Database } from "../../../lib/supabase/database.types";

const STAFF_ROLES = new Set(["manager", "dispatcher", "back_office"]);

type BillingLineInput = {
  type: string;
  desc?: string;
  description?: string;
  qty: number;
  rate: number;
  isTaxable?: boolean;
  sourceInvoiceLineId?: string | null;
  sourceUnitCost?: number | null;
  markupPercent?: number | null;
};

const jsonError = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status });

const anonClient = () =>
  createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

const getBearerToken = (req: NextRequest) => {
  const auth = req.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
};

async function requireStaff(req: NextRequest) {
  const token = getBearerToken(req);
  if (!token) {
    return { error: jsonError("Unauthorized", 401) };
  }

  const auth = anonClient();
  const { data: authData, error: authError } = await auth.auth.getUser(token);
  const user = authData.user;
  if (authError || !user) {
    return { error: jsonError("Unauthorized", 401) };
  }

  const sb = createServerClient();
  const { data: profile, error: profileError } = await sb
    .from("profiles")
    .select("id, role, name")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    return { error: jsonError(profileError.message, 500) };
  }
  if (!profile || !STAFF_ROLES.has(profile.role || "")) {
    return { error: jsonError("Forbidden", 403) };
  }

  return { sb, user, profile };
}

const mapLine = (line: any) => ({
  id: line.id,
  type: line.type,
  desc: line.description || "",
  description: line.description || "",
  qty: Number(line.qty || 0),
  rate: Number(line.rate || 0),
  amount: Number(line.amount || 0),
  isTaxable: !!line.is_taxable,
  sourceInvoiceLineId: line.source_invoice_line_id || null,
  sourceUnitCost: line.source_unit_cost == null
    ? null
    : Number(line.source_unit_cost),
  markupPercent: line.markup_percent == null
    ? null
    : Number(line.markup_percent),
});

const formatDate = (d: string | null) => {
  if (!d) return null;
  const [y, m, day] = d.split("-");
  return y && m && day ? `${m}/${day}/${y}` : d;
};

const shortMonthDay = (d: string | null) => {
  if (!d) return "";
  const date = new Date(`${d}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("en-US", { month: "short", day: "numeric" });
};

const mapInvoice = (invoice: any, lines: any[]) => ({
  id: invoice.id,
  num: invoice.num,
  wot: invoice.work_order_id,
  workOrderId: invoice.work_order_id,
  store: invoice.store_number,
  storeAddr: invoice.store_address,
  contractor: invoice.contractor_id,
  invoiceType: invoice.invoice_type || "staff",
  cme: invoice.cme,
  invoiceDate: formatDate(invoice.invoice_date),
  invoiceDateRaw: invoice.invoice_date,
  serviceDate: formatDate(invoice.service_date),
  serviceDateRaw: invoice.service_date,
  dueDate: formatDate(invoice.due_date),
  dueDateRaw: invoice.due_date,
  terms: invoice.terms,
  state: invoice.state,
  subtotal: Number(invoice.subtotal || 0),
  salesTax: Number(invoice.sales_tax || 0),
  taxState: invoice.tax_state || null,
  taxRate: invoice.tax_rate == null ? null : Number(invoice.tax_rate),
  total: Number(invoice.total || 0),
  pdfStoragePath: invoice.pdf_storage_path || null,
  qboInvoiceId: invoice.qbo_invoice_id || null,
  qboSyncedAt: invoice.qbo_synced_at || null,
  date: shortMonthDay(invoice.invoice_date),
  createdAt: invoice.created_at,
  updatedAt: invoice.updated_at,
  lines: lines.map(mapLine),
});

const sourceMetrics = (sourceInvoices: any[], staffSubtotal: number) => {
  const contractorCost = sourceInvoices.reduce(
    (sum, invoice) => sum + Number(invoice.total || 0),
    0,
  );
  const grossProfit = staffSubtotal - contractorCost;
  const marginPercent = staffSubtotal > 0
    ? (grossProfit / staffSubtotal) * 100
    : null;
  return { contractorCost, grossProfit, marginPercent };
};

type ValidBillingLine = {
  type: string;
  description: string;
  qty: number;
  rate: number;
  isTaxable: boolean;
  sourceInvoiceLineId: string | null;
  sourceUnitCost: number | null;
  markupPercent: number | null;
};

const normalizeBillingLines = (lines: BillingLineInput[]): ValidBillingLine[] =>
  lines
    .map(line => {
      const sourceUnitCost = line.sourceUnitCost == null
        ? null
        : Number(line.sourceUnitCost);
      const markupPercent = line.markupPercent == null
        ? null
        : Number(line.markupPercent);
      return {
        type: String(line.type || "Other").trim(),
        description: String(line.desc || line.description || "").trim(),
        qty: Number(line.qty || 0),
        rate: Number(line.rate || 0),
        isTaxable: !!line.isTaxable,
        sourceInvoiceLineId: String(line.sourceInvoiceLineId || "").trim() || null,
        sourceUnitCost: sourceUnitCost != null && Number.isFinite(sourceUnitCost)
          ? sourceUnitCost
          : null,
        markupPercent: markupPercent != null && Number.isFinite(markupPercent)
          ? markupPercent
          : null,
      };
    })
    .filter(line =>
      line.description
      && line.qty > 0
      && line.rate > 0
      && (line.sourceUnitCost == null || line.sourceUnitCost >= 0)
      && (line.markupPercent == null || line.markupPercent >= 0),
    );

async function resolveTax(
  sb: ReturnType<typeof createServerClient>,
  body: any,
  lines: ValidBillingLine[],
) {
  let taxState = normalizeStateCode(body.taxState);
  if (body.workOrderId) {
    const { data: workOrder, error: workOrderError } = await (sb as any)
      .from("work_orders")
      .select("store_state")
      .eq("id", body.workOrderId)
      .is("deleted_at", null)
      .maybeSingle();
    if (workOrderError) throw workOrderError;
    if (!workOrder) {
      throw new Error("Linked work order was not found");
    }
    taxState = normalizeStateCode(workOrder.store_state) || taxState;
  }

  const taxableSubtotal = lines.reduce(
    (sum, line) => sum + (line.isTaxable ? line.qty * line.rate : 0),
    0,
  );
  if (taxableSubtotal <= 0) {
    return {
      taxState: taxState || null,
      taxRate: null as number | null,
      salesTax: 0,
    };
  }
  if (!taxState) {
    throw new Error("Store state is required for taxable billing lines");
  }

  const onDate = String(body.serviceDate || body.invoiceDate || "").slice(0, 10);
  const { data: rates, error: ratesError } = await (sb as any)
    .from("state_sales_tax_rates")
    .select("state_code, rate, effective_from, effective_to")
    .eq("state_code", taxState)
    .order("effective_from", { ascending: false });
  if (ratesError) throw ratesError;
  const rateRow = (rates || []).find((rate: any) =>
    (!rate.effective_from || rate.effective_from <= onDate)
    && (!rate.effective_to || rate.effective_to >= onDate),
  );
  if (!rateRow) {
    throw new Error(`No active sales-tax rate is configured for ${taxState}`);
  }

  const taxRate = Number(rateRow.rate);
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) {
    throw new Error(`Configured sales-tax rate for ${taxState} is invalid`);
  }
  return {
    taxState,
    taxRate,
    salesTax: Math.round(taxableSubtotal * taxRate * 100) / 100,
  };
}

const lineRowsForInvoice = (
  invoiceId: string,
  lines: ValidBillingLine[],
) => lines.map((line, index) => ({
  invoice_id: invoiceId,
  position: index + 1,
  type: line.type,
  description: line.description,
  qty: line.qty,
  rate: line.rate,
  is_taxable: line.isTaxable,
  source_invoice_line_id: line.sourceInvoiceLineId,
  source_unit_cost: line.sourceUnitCost,
  markup_percent: line.markupPercent,
}));

async function loadStaffInvoices(sb: ReturnType<typeof createServerClient>) {
  const [invoiceRes, contractorRes, lineRes, sourceRes] = await Promise.all([
    (sb as any)
      .from("invoices")
      .select("*")
      .eq("invoice_type", "staff")
      .is("deleted_at", null)
      .order("invoice_date", { ascending: false }),
    (sb as any)
      .from("invoices")
      .select("*")
      .eq("invoice_type", "contractor")
      .is("deleted_at", null),
    sb.from("invoice_lines").select("*").order("position"),
    (sb as any).from("staff_invoice_sources").select("*"),
  ]);

  if (invoiceRes.error) throw invoiceRes.error;
  if (contractorRes.error) throw contractorRes.error;
  if (lineRes.error) throw lineRes.error;
  if (sourceRes.error) throw sourceRes.error;

  const linesByInvoice: Record<string, any[]> = {};
  for (const line of lineRes.data || []) {
    (linesByInvoice[line.invoice_id] ||= []).push(line);
  }

  const contractorById = new Map<string, any>(
    (contractorRes.data || []).map((invoice: any) => [invoice.id, invoice]),
  );
  const sourcesByStaffInvoice: Record<string, any[]> = {};
  for (const source of sourceRes.data || []) {
    const contractorInvoice = contractorById.get(source.contractor_invoice_id);
    if (!contractorInvoice) continue;
    const mapped = mapInvoice(
      contractorInvoice,
      linesByInvoice[contractorInvoice.id] || [],
    );
    (sourcesByStaffInvoice[source.staff_invoice_id] ||= []).push(mapped);
  }

  return (invoiceRes.data || []).map((invoice: any) => {
    const mapped = mapInvoice(invoice, linesByInvoice[invoice.id] || []);
    const sourceInvoices = sourcesByStaffInvoice[invoice.id] || [];
    return {
      ...mapped,
      sourceInvoices,
      sourceInvoiceIds: sourceInvoices.map((source: any) => source.id),
      ...sourceMetrics(sourceInvoices, mapped.subtotal),
    };
  });
}

const nextStaffInvoiceNum = async (sb: ReturnType<typeof createServerClient>) => {
  const { data, error } = await (sb as any)
    .from("invoices")
    .select("num")
    .eq("invoice_type", "staff");

  if (error) throw error;

  const maxNum = (data || []).reduce((max: number, row: any) => {
    const match = String(row.num || "").match(/^P1-(\d+)$/i);
    const n = match ? parseInt(match[1], 10) : 0;
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);

  return `P1-${String(maxNum + 1).padStart(5, "0")}`;
};

export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if ("error" in auth) return auth.error;

  try {
    const invoices = await loadStaffInvoices(auth.sb);
    return NextResponse.json({ invoices });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load billing invoices";
    return jsonError(message, 500);
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if ("error" in auth) return auth.error;

  try {
    const body = await req.json();
    const targetState = body.state === "draft" ? "draft" : "submitted";
    const sourceInvoiceIds = Array.from(new Set(
      (Array.isArray(body.sourceInvoiceIds) ? body.sourceInvoiceIds : [])
        .map((id: unknown) => String(id || "").trim())
        .filter(Boolean),
    ));
    const lines = Array.isArray(body.lines) ? body.lines as BillingLineInput[] : [];
    const validLines = normalizeBillingLines(lines);

    if (!body.invoiceDate) return jsonError("Invoice date is required", 400);
    if (!body.storeNumber) return jsonError("Store number is required", 400);
    if (validLines.length === 0) return jsonError("At least one valid line item is required", 400);
    if (sourceInvoiceIds.length > 0 && !body.workOrderId) {
      return jsonError("A work order is required when contractor invoices are linked", 400);
    }

    if (sourceInvoiceIds.length > 0) {
      const { data: existingLinks, error: existingLinkError } = await (auth.sb as any)
        .from("staff_invoice_sources")
        .select("contractor_invoice_id, staff_invoice_id")
        .in("contractor_invoice_id", sourceInvoiceIds);
      if (existingLinkError) throw existingLinkError;

      const linkedStaffIds = Array.from(new Set(
        (existingLinks || []).map((link: any) => link.staff_invoice_id),
      ));
      if (linkedStaffIds.length > 0) {
        const { data: activeLinkedStaff, error: linkedStaffError } = await (auth.sb as any)
          .from("invoices")
          .select("id, num")
          .in("id", linkedStaffIds)
          .eq("invoice_type", "staff")
          .is("deleted_at", null);
        if (linkedStaffError) throw linkedStaffError;
        if ((activeLinkedStaff || []).length > 0) {
          return jsonError(
            `A selected contractor invoice is already linked to ${activeLinkedStaff[0].num}`,
            409,
          );
        }
      }

      const { data: sourceInvoices, error: sourceError } = await (auth.sb as any)
        .from("invoices")
        .select("id, work_order_id, invoice_type, state, deleted_at")
        .in("id", sourceInvoiceIds)
        .eq("invoice_type", "contractor")
        .is("deleted_at", null);

      if (sourceError) throw sourceError;
      if ((sourceInvoices || []).length !== sourceInvoiceIds.length) {
        return jsonError("One or more contractor invoices are invalid", 400);
      }
      if ((sourceInvoices || []).some((invoice: any) =>
        invoice.work_order_id !== body.workOrderId
        || invoice.state === "draft"
        || invoice.state === "rejected"
      )) {
        return jsonError(
          "Source invoices must be live contractor invoices on the selected work order",
          400,
        );
      }
    }

    const subtotal = validLines.reduce((sum, line) => sum + line.qty * line.rate, 0);
    const tax = await resolveTax(auth.sb, body, validLines);
    const salesTax = tax.salesTax;
    const total = subtotal + salesTax;
    let desiredNum = String(body.num || "").trim() || await nextStaffInvoiceNum(auth.sb);

    let inserted: any = null;
    let insertError: any = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const { data, error } = await (auth.sb as any)
        .from("invoices")
        .insert({
          num: desiredNum,
          invoice_type: "staff",
          work_order_id: body.workOrderId || null,
          store_number: String(body.storeNumber || "").trim(),
          store_address: body.storeAddress || null,
          contractor_id: null,
          cme: body.cme || null,
          invoice_date: body.invoiceDate,
          service_date: body.serviceDate || null,
          due_date: body.dueDate || null,
          terms: body.terms || "Net 30",
          state: targetState,
          subtotal,
          sales_tax: salesTax,
          tax_state: tax.taxState,
          tax_rate: tax.taxRate,
          total,
          created_by: auth.user.id,
        })
        .select()
        .single();

      if (!error) {
        inserted = data;
        insertError = null;
        break;
      }

      insertError = error;
      if (error.code !== "23505") break;
      desiredNum = await nextStaffInvoiceNum(auth.sb);
    }

    if (insertError || !inserted) throw insertError || new Error("Invoice insert failed");

    const lineRows = lineRowsForInvoice(inserted.id, validLines);

    const { data: createdLines, error: lineError } = await auth.sb
      .from("invoice_lines")
      .insert(lineRows)
      .select();

    if (lineError) {
      await (auth.sb as any)
        .from("invoices")
        .update({ deleted_at: new Date().toISOString(), deleted_by: auth.user.id })
        .eq("id", inserted.id);
      throw lineError;
    }

    if (sourceInvoiceIds.length > 0) {
      const sourceRows = sourceInvoiceIds.map(contractorInvoiceId => ({
        staff_invoice_id: inserted.id,
        contractor_invoice_id: contractorInvoiceId,
        work_order_id: body.workOrderId,
        created_by: auth.user.id,
      }));
      const { error: sourceInsertError } = await (auth.sb as any)
        .from("staff_invoice_sources")
        .insert(sourceRows);

      if (sourceInsertError) {
        await (auth.sb as any)
          .from("invoices")
          .update({ deleted_at: new Date().toISOString(), deleted_by: auth.user.id })
          .eq("id", inserted.id);
        throw sourceInsertError;
      }
    }

    const sourceInvoices = sourceInvoiceIds.length > 0
      ? await loadStaffInvoices(auth.sb).then((items: any[]) =>
          items.find(item => item.id === inserted.id)?.sourceInvoices || [],
        )
      : [];
    const mappedInvoice = mapInvoice(inserted, createdLines || []);

    if (body.workOrderId) {
      const sourceText = sourceInvoiceIds.length > 0
        ? ` from ${sourceInvoiceIds.length} contractor invoice${sourceInvoiceIds.length === 1 ? "" : "s"}`
        : "";
      const { error: activityError } = await (auth.sb as any)
        .from("activities")
        .insert({
          work_order_id: body.workOrderId,
          author_id: auth.user.id,
          author_name: auth.profile.name || "P1 staff",
          text: `P1 invoice #${mappedInvoice.num} created${sourceText}.`,
          type: "system",
          is_staff_override: false,
        });
      if (activityError) {
        console.error("Billing activity audit insert failed", activityError);
      }
    }

    return NextResponse.json({
      invoice: {
        ...mappedInvoice,
        sourceInvoices,
        sourceInvoiceIds,
        ...sourceMetrics(sourceInvoices, mappedInvoice.subtotal),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create billing invoice";
    return jsonError(message, 500);
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await requireStaff(req);
  if ("error" in auth) return auth.error;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return jsonError("Invoice id is required", 400);

  try {
    const body = await req.json();
    const targetState = body.state === "submitted" ? "submitted" : "draft";
    const workOrderId = String(body.workOrderId || "").trim() || null;
    const sourceInvoiceIds = Array.from(new Set(
      (Array.isArray(body.sourceInvoiceIds) ? body.sourceInvoiceIds : [])
        .map((sourceId: unknown) => String(sourceId || "").trim())
        .filter(Boolean),
    ));
    const lines = Array.isArray(body.lines) ? body.lines as BillingLineInput[] : [];
    const validLines = normalizeBillingLines(lines);

    if (!body.invoiceDate) return jsonError("Invoice date is required", 400);
    if (!body.storeNumber) return jsonError("Store number is required", 400);
    if (validLines.length === 0) return jsonError("At least one valid line item is required", 400);
    if (sourceInvoiceIds.length > 0 && !workOrderId) {
      return jsonError("A work order is required when contractor invoices are linked", 400);
    }

    const { data: existing, error: existingError } = await (auth.sb as any)
      .from("invoices")
      .select("*")
      .eq("id", id)
      .eq("invoice_type", "staff")
      .is("deleted_at", null)
      .maybeSingle();

    if (existingError) throw existingError;
    if (!existing) return jsonError("Billing invoice not found", 404);
    if (!["draft", "submitted"].includes(existing.state)) {
      return jsonError("Approved, paid, rejected, or revised billing invoices are locked", 409);
    }
    if (existing.qbo_invoice_id || existing.qbo_synced_at) {
      return jsonError("QuickBooks-synced billing invoices are locked", 409);
    }

    if (sourceInvoiceIds.length > 0) {
      const { data: existingLinks, error: existingLinkError } = await (auth.sb as any)
        .from("staff_invoice_sources")
        .select("contractor_invoice_id, staff_invoice_id")
        .in("contractor_invoice_id", sourceInvoiceIds);
      if (existingLinkError) throw existingLinkError;

      const linkedStaffIds = Array.from(new Set(
        (existingLinks || [])
          .filter((link: any) => link.staff_invoice_id !== id)
          .map((link: any) => link.staff_invoice_id),
      ));
      if (linkedStaffIds.length > 0) {
        const { data: activeLinkedStaff, error: linkedStaffError } = await (auth.sb as any)
          .from("invoices")
          .select("id, num")
          .in("id", linkedStaffIds)
          .eq("invoice_type", "staff")
          .is("deleted_at", null);
        if (linkedStaffError) throw linkedStaffError;
        if ((activeLinkedStaff || []).length > 0) {
          return jsonError(
            `A selected contractor invoice is already linked to ${activeLinkedStaff[0].num}`,
            409,
          );
        }
      }

      const { data: sourceInvoices, error: sourceError } = await (auth.sb as any)
        .from("invoices")
        .select("id, work_order_id, invoice_type, state, deleted_at")
        .in("id", sourceInvoiceIds)
        .eq("invoice_type", "contractor")
        .is("deleted_at", null);

      if (sourceError) throw sourceError;
      if ((sourceInvoices || []).length !== sourceInvoiceIds.length) {
        return jsonError("One or more contractor invoices are invalid", 400);
      }
      if ((sourceInvoices || []).some((invoice: any) =>
        invoice.work_order_id !== workOrderId
        || invoice.state === "draft"
        || invoice.state === "rejected"
      )) {
        return jsonError(
          "Source invoices must be live contractor invoices on the selected work order",
          400,
        );
      }
    }

    const subtotal = validLines.reduce((sum, line) => sum + line.qty * line.rate, 0);
    const tax = await resolveTax(auth.sb, body, validLines);
    const salesTax = tax.salesTax;
    if (!Number.isFinite(salesTax) || salesTax < 0) {
      return jsonError("Sales tax must be zero or greater", 400);
    }
    const total = subtotal + salesTax;
    const desiredNum = String(body.num || "").trim() || existing.num;
    const updatedAt = new Date().toISOString();

    const { data: updated, error: updateError } = await (auth.sb as any)
      .from("invoices")
      .update({
        num: desiredNum,
        work_order_id: workOrderId,
        store_number: String(body.storeNumber || "").trim(),
        store_address: body.storeAddress || null,
        contractor_id: null,
        cme: body.cme || null,
        invoice_date: body.invoiceDate,
        service_date: body.serviceDate || null,
        due_date: body.dueDate || null,
        terms: body.terms || "Net 30",
        state: targetState,
        subtotal,
        sales_tax: salesTax,
        tax_state: tax.taxState,
        tax_rate: tax.taxRate,
        total,
        updated_at: updatedAt,
      })
      .eq("id", id)
      .eq("invoice_type", "staff")
      .in("state", ["draft", "submitted"])
      .is("deleted_at", null)
      .select()
      .maybeSingle();

    if (updateError?.code === "23505") {
      return jsonError(`Invoice number ${desiredNum} already exists`, 409);
    }
    if (updateError) throw updateError;
    if (!updated) return jsonError("Invoice changed before it could be saved", 409);

    const { error: lineDeleteError } = await auth.sb
      .from("invoice_lines")
      .delete()
      .eq("invoice_id", id);
    if (lineDeleteError) throw lineDeleteError;

    const lineRows = lineRowsForInvoice(id, validLines);
    const { error: lineInsertError } = await auth.sb
      .from("invoice_lines")
      .insert(lineRows);
    if (lineInsertError) throw lineInsertError;

    const { error: sourceDeleteError } = await (auth.sb as any)
      .from("staff_invoice_sources")
      .delete()
      .eq("staff_invoice_id", id);
    if (sourceDeleteError) throw sourceDeleteError;

    if (sourceInvoiceIds.length > 0) {
      const sourceRows = sourceInvoiceIds.map(contractorInvoiceId => ({
        staff_invoice_id: id,
        contractor_invoice_id: contractorInvoiceId,
        work_order_id: workOrderId,
        created_by: auth.user.id,
      }));
      const { error: sourceInsertError } = await (auth.sb as any)
        .from("staff_invoice_sources")
        .insert(sourceRows);
      if (sourceInsertError) throw sourceInsertError;
    }

    if (workOrderId) {
      const action = targetState === "submitted" ? "updated" : "draft updated";
      const { error: activityError } = await (auth.sb as any)
        .from("activities")
        .insert({
          work_order_id: workOrderId,
          author_id: auth.user.id,
          author_name: auth.profile.name || "P1 staff",
          text: `P1 invoice #${desiredNum} ${action}.`,
          type: "system",
          is_staff_override: false,
        });
      if (activityError) {
        console.error("Billing draft activity audit insert failed", activityError);
      }
    }

    const refreshed = await loadStaffInvoices(auth.sb);
    const invoice = refreshed.find((item: any) => item.id === id);
    if (!invoice) throw new Error("Updated invoice could not be reloaded");

    return NextResponse.json({ invoice });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update billing invoice";
    return jsonError(message, 500);
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireStaff(req);
  if ("error" in auth) return auth.error;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return jsonError("Invoice id is required", 400);

  const { error } = await (auth.sb as any)
    .from("invoices")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: auth.user.id,
    })
    .eq("id", id)
    .eq("invoice_type", "staff");

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ ok: true });
}
