import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "../../../lib/supabase/server";
import type { Database } from "../../../lib/supabase/database.types";

const STAFF_ROLES = new Set(["manager", "dispatcher", "back_office"]);

type BillingLineInput = {
  type: string;
  desc?: string;
  description?: string;
  qty: number;
  rate: number;
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
  total: Number(invoice.total || 0),
  pdfStoragePath: invoice.pdf_storage_path || null,
  date: shortMonthDay(invoice.invoice_date),
  createdAt: invoice.created_at,
  updatedAt: invoice.updated_at,
  lines: lines.map(mapLine),
});

const sourceMetrics = (sourceInvoices: any[], staffTotal: number) => {
  const contractorCost = sourceInvoices.reduce(
    (sum, invoice) => sum + Number(invoice.total || 0),
    0,
  );
  const grossProfit = staffTotal - contractorCost;
  const marginPercent = staffTotal > 0 ? (grossProfit / staffTotal) * 100 : null;
  return { contractorCost, grossProfit, marginPercent };
};

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
      ...sourceMetrics(sourceInvoices, mapped.total),
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
    const sourceInvoiceIds = Array.from(new Set(
      (Array.isArray(body.sourceInvoiceIds) ? body.sourceInvoiceIds : [])
        .map((id: unknown) => String(id || "").trim())
        .filter(Boolean),
    ));
    const lines = Array.isArray(body.lines) ? body.lines as BillingLineInput[] : [];
    const validLines = lines
      .map(line => ({
        type: String(line.type || "Other").trim(),
        description: String(line.desc || line.description || "").trim(),
        qty: Number(line.qty || 0),
        rate: Number(line.rate || 0),
      }))
      .filter(line => line.description && line.qty > 0 && line.rate > 0);

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
    const salesTax = Number(body.salesTax || 0);
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
          state: body.state || "submitted",
          subtotal,
          sales_tax: salesTax,
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

    const lineRows = validLines.map((line, index) => ({
      invoice_id: inserted.id,
      position: index + 1,
      type: line.type,
      description: line.description,
      qty: line.qty,
      rate: line.rate,
    }));

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
        ...sourceMetrics(sourceInvoices, mappedInvoice.total),
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
    const validLines = lines
      .map(line => ({
        type: String(line.type || "Other").trim(),
        description: String(line.desc || line.description || "").trim(),
        qty: Number(line.qty || 0),
        rate: Number(line.rate || 0),
      }))
      .filter(line => line.description && line.qty > 0 && line.rate > 0);

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
    if (existing.state !== "draft") {
      return jsonError("Only draft billing invoices can be edited", 409);
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
    const salesTax = Number(body.salesTax || 0);
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
        state: "draft",
        subtotal,
        sales_tax: salesTax,
        total,
        updated_at: updatedAt,
      })
      .eq("id", id)
      .eq("invoice_type", "staff")
      .eq("state", "draft")
      .is("deleted_at", null)
      .select()
      .maybeSingle();

    if (updateError?.code === "23505") {
      return jsonError(`Invoice number ${desiredNum} already exists`, 409);
    }
    if (updateError) throw updateError;
    if (!updated) return jsonError("Draft changed before it could be saved", 409);

    const { error: lineDeleteError } = await auth.sb
      .from("invoice_lines")
      .delete()
      .eq("invoice_id", id);
    if (lineDeleteError) throw lineDeleteError;

    const lineRows = validLines.map((line, index) => ({
      invoice_id: id,
      position: index + 1,
      type: line.type,
      description: line.description,
      qty: line.qty,
      rate: line.rate,
    }));
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

    if (targetState === "submitted") {
      const { error: stateError } = await (auth.sb as any)
        .from("invoices")
        .update({ state: "submitted", updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("invoice_type", "staff")
        .eq("state", "draft");
      if (stateError) throw stateError;
    }

    if (workOrderId) {
      const action = targetState === "submitted" ? "updated and submitted" : "draft updated";
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
