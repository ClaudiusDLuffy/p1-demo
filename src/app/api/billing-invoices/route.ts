import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "../../../lib/supabase/server";
import {
  normalizeStateCode,
  taxRateFromPercent,
} from "../../../lib/billingRules";
import { roundInvoiceNumber } from "../../../lib/invoiceMath";
import { collectSupabasePages } from "../../../lib/paginatedQuery";
import {
  chunkArray,
  clampPageSize,
  mapChunksWithConcurrency,
} from "../../../lib/cursorPagination";
import {
  normalizeStaffBillingLineType,
  roundStaffBillingMarkupPercent,
} from "../../../lib/staffBilling";
import { isQuickBooksEquipmentTag } from "../../../lib/quickBooksEquipmentTags";
import { canonicalSevenElevenWorkOrderId } from "../../../lib/workOrderIdentity";
import {
  isInvoiceControllerProfile,
  loadStaffPermissions,
  STAFF_ROLES,
} from "../../../lib/server/staffAuthorization";
import type { Database } from "../../../lib/supabase/database.types";

type BillingLineInput = {
  type: string;
  desc?: string;
  description?: string;
  qty: number;
  rate: number;
  isTaxable?: boolean;
  sourceInvoiceLineId?: string | null;
  sourceWorkOrderPartId?: string | null;
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
    .select("id, role, name, active")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    return { error: jsonError(profileError.message, 500) };
  }
  if (!profile?.active || !STAFF_ROLES.has(profile.role || "")) {
    return { error: jsonError("Forbidden", 403) };
  }

  let staffPermissions: string[];
  try {
    staffPermissions = await loadStaffPermissions(sb, profile.id);
  } catch (permissionError) {
    return { error: jsonError(permissionError instanceof Error ? permissionError.message : "Permission lookup failed", 500) };
  }

  return { sb, user, profile: { ...profile, staffPermissions } };
}

const isController = isInvoiceControllerProfile;

const mapLine = (line: any) => ({
  id: line.id,
  type: normalizeStaffBillingLineType(line.type),
  desc: line.description || "",
  description: line.description || "",
  qty: Number(line.qty || 0),
  rate: Number(line.rate || 0),
  amount: Number(line.amount || 0),
  isTaxable: !!line.is_taxable,
  sourceInvoiceLineId: line.source_invoice_line_id || null,
  sourceWorkOrderPartId: line.source_work_order_part_id || null,
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

const mapInvoice = (
  invoice: any,
  lines: any[],
  externalWorkOrderId: string | null = canonicalSevenElevenWorkOrderId(
    invoice.work_order_id,
  ) || null,
) => ({
  id: invoice.id,
  num: invoice.num,
  wot: invoice.work_order_id,
  workOrderId: invoice.work_order_id,
  externalWorkOrderId,
  store: invoice.store_number,
  storeAddr: invoice.store_address,
  contractor: invoice.contractor_id,
  invoiceType: invoice.invoice_type || "staff",
  documentKind: invoice.document_kind || "invoice",
  sourceCapitalQuoteId: invoice.source_capital_quote_id || null,
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
  territory: invoice.territory || null,
  equipmentTag: invoice.equipment_tag || "7-ELEVEN: Miscellaneous",
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
    (sum, invoice) => sum + Number(
      invoice.subtotal
      ?? Math.max(Number(invoice.total || 0) - Number(invoice.salesTax || 0), 0),
    ),
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
  sourceWorkOrderPartId: string | null;
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
        type: normalizeStaffBillingLineType(line.type),
        description: String(line.desc || line.description || "").trim(),
        qty: roundInvoiceNumber(line.qty),
        rate: roundInvoiceNumber(line.rate),
        isTaxable: !!line.isTaxable,
        sourceInvoiceLineId: String(line.sourceInvoiceLineId || "").trim() || null,
        sourceWorkOrderPartId: String(line.sourceWorkOrderPartId || "").trim() || null,
        sourceUnitCost: sourceUnitCost != null && Number.isFinite(sourceUnitCost)
          ? roundInvoiceNumber(sourceUnitCost)
          : null,
        markupPercent: roundStaffBillingMarkupPercent(markupPercent),
      };
    })
    .filter(line =>
      (line.description || /^(travel|truck charge)$/i.test(line.type))
      && line.qty > 0
      && line.rate > 0
      && (line.sourceUnitCost == null || line.sourceUnitCost >= 0)
      && (line.markupPercent == null || line.markupPercent >= 0),
    );

const invalidBillingInput = (message: string) => {
  const error: Error & { code?: string } = new Error(message);
  error.code = "23514";
  return error;
};

async function canonicalizeP1PartLines(
  sb: ReturnType<typeof createServerClient>,
  workOrderId: string | null,
  lines: BillingLineInput[],
  invoiceId: string | null = null,
): Promise<BillingLineInput[]> {
  const requestedPartIds = lines
    .map(line => String(line.sourceWorkOrderPartId || "").trim())
    .filter(Boolean);
  if (!workOrderId) {
    if (requestedPartIds.length > 0) {
      throw invalidBillingInput("P1-purchased parts require a linked work order");
    }
    return lines;
  }
  if (new Set(requestedPartIds).size !== requestedPartIds.length) {
    throw invalidBillingInput("A P1-purchased part may appear only once on an invoice");
  }

  const { data: billableParts, error: billablePartsError } = await (sb as any)
    .rpc("list_billable_p1_parts", {
      p_work_order_id: workOrderId,
      p_exclude_invoice_id: invoiceId,
    });
  if (billablePartsError) throw billablePartsError;
  const partById = new Map<string, any>((billableParts || []).map((part: any) => [
    String(part.part_id),
    part,
  ]));
  if (requestedPartIds.some(partId => !partById.has(partId))) {
    throw invalidBillingInput(
      "Every P1-purchased part must be ordered, priced, unbilled, and belong to this work order",
    );
  }

  const canonicalLines = lines.map(line => {
    const partId = String(line.sourceWorkOrderPartId || "").trim();
    if (!partId) return line;
    const part = partById.get(partId);
    if (!part) throw invalidBillingInput("P1-purchased part is not billable");
    const unitCost = Number(part.unit_cost);
    return {
      ...line,
      type: "Parts/Hardware",
      desc: `P1 ordered part: ${part.description}${part.part_number ? ` (${part.part_number})` : ""}`,
      description: `P1 ordered part: ${part.description}${part.part_number ? ` (${part.part_number})` : ""}`,
      qty: Number(part.qty || 1),
      rate: Number(part.marked_up_unit_rate),
      sourceInvoiceLineId: null,
      sourceWorkOrderPartId: partId,
      sourceUnitCost: roundInvoiceNumber(unitCost),
      markupPercent: 25,
    };
  });

  const requested = new Set(requestedPartIds);
  for (const part of billableParts || []) {
    const partId = String(part.part_id);
    if (requested.has(partId)) continue;
    const description = `P1 ordered part: ${part.description}${part.part_number ? ` (${part.part_number})` : ""}`;
    canonicalLines.push({
      type: "Parts/Hardware",
      desc: description,
      description,
      qty: Number(part.qty || 1),
      rate: Number(part.marked_up_unit_rate),
      isTaxable: true,
      sourceInvoiceLineId: null,
      sourceWorkOrderPartId: partId,
      sourceUnitCost: Number(part.unit_cost),
      markupPercent: 25,
    });
  }
  return canonicalLines;
}

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

  const manualTaxRaw = body.salesTaxOverride;
  const hasManualTax = manualTaxRaw !== undefined
    && manualTaxRaw !== null
    && String(manualTaxRaw).trim() !== "";
  if (hasManualTax) {
    const manualTax = Number(manualTaxRaw);
    if (!Number.isFinite(manualTax) || manualTax < 0) {
      throw new Error("Sales tax must be zero or greater");
    }
    return {
      taxState: taxState || null,
      taxRate: null as number | null,
      salesTax: Math.round(manualTax * 100) / 100,
    };
  }

  const manualTaxRate = taxRateFromPercent(body.taxRateOverride);
  if (manualTaxRate != null) {
    return {
      taxState: taxState || null,
      taxRate: manualTaxRate,
      salesTax: Math.round(taxableSubtotal * manualTaxRate * 100) / 100,
    };
  }

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

const rpcLinePayload = (lines: ValidBillingLine[]) => lines.map(line => ({
  type: line.type,
  description: line.description,
  qty: line.qty,
  rate: line.rate,
  is_taxable: line.isTaxable,
  source_invoice_line_id: line.sourceInvoiceLineId,
  source_work_order_part_id: line.sourceWorkOrderPartId,
  source_unit_cost: line.sourceUnitCost,
  markup_percent: line.markupPercent,
}));

type StaffInvoiceSaveInput = {
  actorId: string;
  invoiceId: string | null;
  num: string;
  workOrderId: string | null;
  storeNumber: string;
  storeAddress: string | null;
  cme: string | null;
  invoiceDate: string;
  serviceDate: string | null;
  dueDate: string | null;
  terms: string;
  state: "draft" | "submitted";
  tax: {
    salesTax: number;
    taxState: string | null;
    taxRate: number | null;
  };
  territory: string;
  equipmentTag: string;
  lines: ValidBillingLine[];
  sourceInvoiceIds: string[];
};

async function saveStaffBillingInvoice(
  sb: ReturnType<typeof createServerClient>,
  input: StaffInvoiceSaveInput,
) {
  const { data, error } = await (sb as any).rpc(
    "save_staff_billing_invoice_v3",
    {
      p_actor_id: input.actorId,
      p_invoice_id: input.invoiceId,
      p_num: input.num,
      p_work_order_id: input.workOrderId,
      p_store_number: input.storeNumber,
      p_store_address: input.storeAddress,
      p_cme: input.cme,
      p_invoice_date: input.invoiceDate,
      p_service_date: input.serviceDate,
      p_due_date: input.dueDate,
      p_terms: input.terms,
      p_state: input.state,
      p_sales_tax: input.tax.salesTax,
      p_tax_state: input.tax.taxState,
      p_tax_rate: input.tax.taxRate,
      p_territory: input.territory,
      p_equipment_tag: input.equipmentTag,
      p_lines: rpcLinePayload(input.lines),
      p_source_invoice_ids: input.sourceInvoiceIds,
    },
  );
  if (error) throw error;
  if (!data) throw new Error("Billing invoice save returned no invoice id");
  return String(data);
}

const billingSaveErrorStatus = (error: any) => {
  switch (String(error?.code || "")) {
    case "22023":
    case "23503":
    case "23514":
      return 400;
    case "23505":
    case "55000":
      return 409;
    case "42501":
      return 403;
    case "P0002":
      return 404;
    default:
      return 500;
  }
};

type StaffInvoicePage = {
  items: any[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount: number;
};

const rpcPage = (value: any): StaffInvoicePage => {
  const page = Array.isArray(value) ? value[0] : value;
  return {
    items: Array.isArray(page?.items) ? page.items : [],
    nextCursor: page?.nextCursor || null,
    hasMore: Boolean(page?.hasMore),
    totalCount: Number(page?.totalCount || 0),
  };
};

async function loadChunkedRows(
  ids: string[],
  loader: (chunk: string[]) => Promise<{ data: any[] | null; error: any }>,
) {
  if (ids.length === 0) return [];
  const chunks = chunkArray(Array.from(new Set(ids)), 100);
  const rows = await mapChunksWithConcurrency(chunks, async chunk => {
    const result = await loader(chunk);
    if (result.error) throw result.error;
    return result.data || [];
  }, 3);
  return rows.flat();
}

async function loadExternalWorkOrderIds(
  sb: ReturnType<typeof createServerClient>,
  workOrderIds: Array<string | null | undefined>,
) {
  const ids = Array.from(new Set(
    workOrderIds
      .map(workOrderId => String(workOrderId || "").trim())
      .filter(Boolean),
  ));
  if (ids.length === 0) return new Map<string, string>();

  const workOrders = await loadChunkedRows(ids, chunk => (sb as any)
    .from("work_orders")
    .select("id, duplicate_root_work_order_id")
    .in("id", chunk));

  return new Map<string, string>(workOrders.map(workOrder => [
    String(workOrder.id),
    String(
      workOrder.duplicate_root_work_order_id
        || canonicalSevenElevenWorkOrderId(workOrder.id)
        || workOrder.id,
    ),
  ]));
}

const externalWorkOrderIdForInvoice = (
  invoice: any,
  externalWorkOrderIds: Map<string, string>,
) => {
  const workOrderId = String(invoice.work_order_id || "").trim();
  if (!workOrderId) return null;
  return externalWorkOrderIds.get(workOrderId)
    || canonicalSevenElevenWorkOrderId(workOrderId)
    || workOrderId;
};

async function loadStaffInvoicesPage(
  sb: ReturnType<typeof createServerClient>,
  input: {
    queue: string;
    search: string | null;
    sort: string;
    direction: string;
    limit: number;
    cursor: string | null;
    workOrderId: string | null;
  },
): Promise<StaffInvoicePage> {
  const { data, error } = await (sb as any).rpc("list_staff_invoices_page", {
    p_queue: input.queue,
    p_search: input.search,
    p_sort: input.sort,
    p_direction: input.direction,
    p_limit: clampPageSize(input.limit),
    p_cursor: input.cursor,
    p_work_order_id: input.workOrderId,
  });
  if (error) throw error;
  const page = rpcPage(data);
  const staffIds = page.items.map(invoice => String(invoice.id));
  if (staffIds.length === 0) return page;

  const [staffLines, sourceLinks] = await Promise.all([
    loadChunkedRows(staffIds, chunk => (sb as any)
      .from("invoice_lines")
      .select("*")
      .in("invoice_id", chunk)
      .order("invoice_id", { ascending: true })
      .order("position", { ascending: true })
      .order("id", { ascending: true })),
    loadChunkedRows(staffIds, chunk => (sb as any)
      .from("staff_invoice_sources")
      .select("*")
      .in("staff_invoice_id", chunk)
      .order("staff_invoice_id", { ascending: true })
      .order("contractor_invoice_id", { ascending: true })
      .order("id", { ascending: true })),
  ]);
  const sourceIds = sourceLinks.map(link => String(link.contractor_invoice_id));
  const [sourceRows, sourceLines] = await Promise.all([
    loadChunkedRows(sourceIds, chunk => (sb as any)
      .from("invoices")
      .select("*")
      .in("id", chunk)
      .eq("invoice_type", "contractor")
      .is("deleted_at", null)),
    loadChunkedRows(sourceIds, chunk => (sb as any)
      .from("invoice_lines")
      .select("*")
      .in("invoice_id", chunk)
      .order("invoice_id", { ascending: true })
      .order("position", { ascending: true })
      .order("id", { ascending: true })),
  ]);
  const externalWorkOrderIds = await loadExternalWorkOrderIds(
    sb,
    [...page.items, ...sourceRows].map(invoice => invoice.work_order_id),
  );

  const linesByInvoice: Record<string, any[]> = {};
  for (const line of [...staffLines, ...sourceLines]) {
    (linesByInvoice[line.invoice_id] ||= []).push(line);
  }
  const sourceById = new Map(
    sourceRows.map(source => [
      source.id,
      mapInvoice(
        source,
        linesByInvoice[source.id] || [],
        externalWorkOrderIdForInvoice(source, externalWorkOrderIds),
      ),
    ]),
  );
  const sourceIdsByStaff: Record<string, string[]> = {};
  for (const link of sourceLinks) {
    (sourceIdsByStaff[link.staff_invoice_id] ||= []).push(link.contractor_invoice_id);
  }

  return {
    ...page,
    items: page.items.map(invoice => {
      const mapped = mapInvoice(
        invoice,
        linesByInvoice[invoice.id] || [],
        externalWorkOrderIdForInvoice(invoice, externalWorkOrderIds),
      );
      const sourceInvoices = (sourceIdsByStaff[invoice.id] || [])
        .map(sourceId => sourceById.get(sourceId))
        .filter(Boolean);
      return {
        ...mapped,
        sourceInvoices,
        sourceInvoiceIds: sourceInvoices.map(source => source.id),
        ...sourceMetrics(sourceInvoices, mapped.subtotal),
      };
    }),
  };
}

async function loadStaffInvoiceById(
  sb: ReturnType<typeof createServerClient>,
  invoiceId: string,
) {
  const { data: invoice, error: invoiceError } = await (sb as any)
    .from("invoices")
    .select("*")
    .eq("id", invoiceId)
    .eq("invoice_type", "staff")
    .is("deleted_at", null)
    .maybeSingle();
  if (invoiceError) throw invoiceError;
  if (!invoice) return null;

  const [staffLines, sourceLinks] = await Promise.all([
    collectSupabasePages<any>((from, to) => sb
      .from("invoice_lines")
      .select("*")
      .eq("invoice_id", invoiceId)
      .order("position", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)),
    collectSupabasePages<any>((from, to) => (sb as any)
      .from("staff_invoice_sources")
      .select("*")
      .eq("staff_invoice_id", invoiceId)
      .order("contractor_invoice_id", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)),
  ]);

  const sourceInvoiceIds = sourceLinks.map(link => link.contractor_invoice_id);
  let sourceRows: any[] = [];
  let sourceLines: any[] = [];
  let sourceInvoices: any[] = [];
  if (sourceInvoiceIds.length > 0) {
    [sourceRows, sourceLines] = await Promise.all([
      collectSupabasePages<any>((from, to) => (sb as any)
        .from("invoices")
        .select("*")
        .in("id", sourceInvoiceIds)
        .eq("invoice_type", "contractor")
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(from, to)),
      collectSupabasePages<any>((from, to) => sb
        .from("invoice_lines")
        .select("*")
        .in("invoice_id", sourceInvoiceIds)
        .order("invoice_id", { ascending: true })
        .order("position", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)),
    ]);
  }

  const externalWorkOrderIds = await loadExternalWorkOrderIds(
    sb,
    [invoice, ...sourceRows].map(row => row.work_order_id),
  );
  const sourceLinesByInvoice: Record<string, any[]> = {};
  for (const line of sourceLines) {
    (sourceLinesByInvoice[line.invoice_id] ||= []).push(line);
  }
  const sourceById = new Map(
    sourceRows.map(row => [
      row.id,
      mapInvoice(
        row,
        sourceLinesByInvoice[row.id] || [],
        externalWorkOrderIdForInvoice(row, externalWorkOrderIds),
      ),
    ]),
  );
  sourceInvoices = sourceInvoiceIds
    .map(id => sourceById.get(id))
    .filter(Boolean);

  const mapped = mapInvoice(
    invoice,
    staffLines,
    externalWorkOrderIdForInvoice(invoice, externalWorkOrderIds),
  );
  return {
    ...mapped,
    sourceInvoices,
    sourceInvoiceIds,
    ...sourceMetrics(sourceInvoices, mapped.subtotal),
  };
}

async function loadContractorInvoiceSources(
  sb: ReturnType<typeof createServerClient>,
  sourceInvoiceIds: string[],
  controller: boolean,
) {
  const { data: invoiceRows, error: invoiceError } = await (sb as any)
    .from("invoices")
    .select("*")
    .in("id", sourceInvoiceIds)
    .eq("invoice_type", "contractor")
    .is("deleted_at", null);
  if (invoiceError) throw invoiceError;
  if ((invoiceRows || []).length !== sourceInvoiceIds.length) {
    throw new Error("One or more contractor invoices are invalid");
  }
  if (
    controller
    && (invoiceRows || []).some((invoice: any) =>
      !["approved", "paid"].includes(invoice.state)
    )
  ) {
    throw new Error("The controller can only access approved contractor invoices");
  }

  const { data: lineRows, error: lineError } = await sb
    .from("invoice_lines")
    .select("*")
    .in("invoice_id", sourceInvoiceIds)
    .order("position");
  if (lineError) throw lineError;

  const linesByInvoice: Record<string, any[]> = {};
  for (const line of lineRows || []) {
    (linesByInvoice[line.invoice_id] ||= []).push(line);
  }
  const externalWorkOrderIds = await loadExternalWorkOrderIds(
    sb,
    (invoiceRows || []).map((invoice: any) => invoice.work_order_id),
  );
  const invoicesById = new Map(
    (invoiceRows || []).map((invoice: any) => [
      invoice.id,
      mapInvoice(
        invoice,
        linesByInvoice[invoice.id] || [],
        externalWorkOrderIdForInvoice(invoice, externalWorkOrderIds),
      ),
    ]),
  );
  return sourceInvoiceIds
    .map(id => invoicesById.get(id))
    .filter(Boolean);
}

const nextStaffInvoiceNum = async (
  sb: ReturnType<typeof createServerClient>,
  actorId: string,
) => {
  const { data, error } = await (sb as any)
    .rpc("next_staff_invoice_num", { p_actor_id: actorId });
  if (error) throw error;
  if (!data) throw new Error("Staff invoice numbering is not configured");
  return data;
};

export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if ("error" in auth) return auth.error;

  try {
    const sourceIdsParam = req.nextUrl.searchParams.get("sourceInvoiceIds");
    if (sourceIdsParam != null) {
      const sourceInvoiceIds = Array.from(new Set(
        sourceIdsParam
          .split(",")
          .map(id => id.trim())
          .filter(Boolean),
      ));
      if (sourceInvoiceIds.length === 0) {
        return jsonError("At least one source invoice id is required", 400);
      }
      const invoices = await loadContractorInvoiceSources(
        auth.sb,
        sourceInvoiceIds,
        isController(auth.profile),
      );
      return NextResponse.json({ invoices });
    }

    if (req.nextUrl.searchParams.get("nextNumber") === "1") {
      if (isController(auth.profile)) {
        return jsonError("The controller cannot create P1 billing invoices", 403);
      }
      const { data: configuredNumber, error: numberError } = await (auth.sb as any)
        .rpc("peek_staff_invoice_num", { p_actor_id: auth.user.id });
      if (numberError) throw numberError;
      if (!configuredNumber) {
        return jsonError("Staff invoice numbering is not configured", 503);
      }
      return NextResponse.json({ num: configuredNumber });
    }

    const invoiceId = String(
      req.nextUrl.searchParams.get("invoiceId") || "",
    ).trim();
    if (invoiceId) {
      const invoice = await loadStaffInvoiceById(auth.sb, invoiceId);
      if (!invoice) return jsonError("Billing invoice not found", 404);
      return NextResponse.json({ invoice });
    }
    const queueValue = String(req.nextUrl.searchParams.get("queue") || "active").toLowerCase();
    const queue = ["active", "all", "draft", "submitted", "sent", "work_order"].includes(queueValue)
      ? queueValue
      : "active";
    const sortValue = String(req.nextUrl.searchParams.get("sort") || "invoice").toLowerCase();
    const sort = ["invoice", "date", "work_order", "store", "territory", "total", "status", "recent"].includes(sortValue)
      ? sortValue
      : "invoice";
    const direction = req.nextUrl.searchParams.get("direction") === "asc" ? "asc" : "desc";
    const page = await loadStaffInvoicesPage(auth.sb, {
      queue,
      search: String(req.nextUrl.searchParams.get("search") || "").trim() || null,
      sort,
      direction,
      limit: Number(req.nextUrl.searchParams.get("limit") || 25),
      cursor: String(req.nextUrl.searchParams.get("cursor") || "").trim() || null,
      workOrderId: String(req.nextUrl.searchParams.get("workOrderId") || "").trim() || null,
    });
    return NextResponse.json({
      invoices: page.items,
      items: page.items,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      totalCount: page.totalCount,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load billing invoices";
    return jsonError(message, 500);
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if ("error" in auth) return auth.error;
  if (isController(auth.profile)) {
    return jsonError("The controller cannot create P1 billing invoices", 403);
  }

  try {
    const body = await req.json();
    const targetState = body.state === "draft" ? "draft" : "submitted";
    const suppliedNum = String(body.num || "").trim();
    const userTypedNum = !!body.userTypedNum && Boolean(suppliedNum);
    const sourceInvoiceIds: string[] = Array.from(new Set<string>(
      (Array.isArray(body.sourceInvoiceIds) ? body.sourceInvoiceIds : [])
        .map((id: unknown) => String(id || "").trim())
        .filter(Boolean),
    ));
    const lines = Array.isArray(body.lines) ? body.lines as BillingLineInput[] : [];
    const canonicalLines = await canonicalizeP1PartLines(
      auth.sb,
      String(body.workOrderId || "").trim() || null,
      lines,
      null,
    );
    const validLines = normalizeBillingLines(canonicalLines);

    if (suppliedNum && (suppliedNum.length > 80 || /[\u0000-\u001f\u007f]/.test(suppliedNum))) {
      return jsonError("Invoice number is invalid", 400);
    }
    if (!body.invoiceDate) return jsonError("Invoice date is required", 400);
    if (!body.storeNumber) return jsonError("Store number is required", 400);
    if (!String(body.territory || "").trim()) return jsonError("Territory is required", 400);
    if (!isQuickBooksEquipmentTag(body.equipmentTag)) {
      return jsonError("A valid QuickBooks equipment tag is required", 400);
    }
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

    const tax = await resolveTax(auth.sb, body, validLines);
    // The value displayed before save is only a preview. Allocate a canonical
    // number now unless staff deliberately replaced the preview.
    const requestedNum = userTypedNum
      ? suppliedNum
      : await nextStaffInvoiceNum(auth.sb, auth.user.id);
    if (!requestedNum || requestedNum.length > 80 || /[\u0000-\u001f\u007f]/.test(requestedNum)) {
      return jsonError("An invoice number could not be allocated", 500);
    }
    let desiredNum = requestedNum;

    let savedInvoiceId: string | null = null;
    let saveError: any = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        savedInvoiceId = await saveStaffBillingInvoice(auth.sb, {
          actorId: auth.user.id,
          invoiceId: null,
          num: desiredNum,
          workOrderId: String(body.workOrderId || "").trim() || null,
          storeNumber: String(body.storeNumber || "").trim(),
          storeAddress: body.storeAddress || null,
          cme: body.cme || null,
          invoiceDate: body.invoiceDate,
          serviceDate: body.serviceDate || null,
          dueDate: body.dueDate || null,
          terms: body.terms || "Net 30",
          state: targetState,
          tax,
          territory: String(body.territory || "").trim(),
          equipmentTag: body.equipmentTag,
          lines: validLines,
          sourceInvoiceIds,
        });
        saveError = null;
        break;
      } catch (error: any) {
        saveError = error;
        if (error?.code !== "23505" || userTypedNum) break;
        desiredNum = await nextStaffInvoiceNum(auth.sb, auth.user.id);
      }
    }

    if (saveError?.code === "23505") {
      return jsonError(`Invoice number ${desiredNum} already exists`, 409);
    }
    if (saveError || !savedInvoiceId) {
      throw saveError || new Error("Invoice save failed");
    }

    const invoice = await loadStaffInvoiceById(auth.sb, savedInvoiceId);
    if (!invoice) throw new Error("Created invoice could not be reloaded");
    return NextResponse.json({ invoice });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create billing invoice";
    return jsonError(message, billingSaveErrorStatus(err));
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await requireStaff(req);
  if ("error" in auth) return auth.error;
  if (isController(auth.profile)) {
    return jsonError("The controller cannot change P1 billing invoices", 403);
  }

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return jsonError("Invoice id is required", 400);

  try {
    const body = await req.json();
    if (body.action === "mark_ready") {
      const { data: readiness, error: readinessError } = await (auth.sb as any)
        .rpc("mark_staff_invoice_ready", {
          p_invoice_id: id,
          p_actor_id: auth.user.id,
        });
      if (readinessError) throw readinessError;

      const invoice = await loadStaffInvoiceById(auth.sb, id);
      if (!invoice) throw new Error("Ready invoice could not be reloaded");
      return NextResponse.json({ invoice, readiness });
    }
    if (body.action === "mark_billed") {
      const { data: finalization, error: finalizationError } = await (auth.sb as any)
        .rpc("mark_staff_invoice_billed", {
          p_invoice_id: id,
          p_actor_id: auth.user.id,
        });
      if (finalizationError) throw finalizationError;

      const invoice = await loadStaffInvoiceById(auth.sb, id);
      if (!invoice) throw new Error("Billed invoice could not be reloaded");

      return NextResponse.json({ invoice, finalization });
    }

    const targetState = body.state === "submitted" ? "submitted" : "draft";
    const desiredNum = String(body.num || "").trim();
    const workOrderId = String(body.workOrderId || "").trim() || null;
    const sourceInvoiceIds: string[] = Array.from(new Set<string>(
      (Array.isArray(body.sourceInvoiceIds) ? body.sourceInvoiceIds : [])
        .map((sourceId: unknown) => String(sourceId || "").trim())
        .filter(Boolean),
    ));
    const lines = Array.isArray(body.lines) ? body.lines as BillingLineInput[] : [];
    const canonicalLines = await canonicalizeP1PartLines(
      auth.sb,
      workOrderId,
      lines,
      id,
    );
    const validLines = normalizeBillingLines(canonicalLines);

    if (!desiredNum) return jsonError("Invoice number is required", 400);
    if (desiredNum.length > 80 || /[\u0000-\u001f\u007f]/.test(desiredNum)) {
      return jsonError("Invoice number is invalid", 400);
    }
    if (!body.invoiceDate) return jsonError("Invoice date is required", 400);
    if (!body.storeNumber) return jsonError("Store number is required", 400);
    if (!String(body.territory || "").trim()) return jsonError("Territory is required", 400);
    if (!isQuickBooksEquipmentTag(body.equipmentTag)) {
      return jsonError("A valid QuickBooks equipment tag is required", 400);
    }
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

    const tax = await resolveTax(auth.sb, body, validLines);
    if (!Number.isFinite(tax.salesTax) || tax.salesTax < 0) {
      return jsonError("Sales tax must be zero or greater", 400);
    }

    try {
      await saveStaffBillingInvoice(auth.sb, {
        actorId: auth.user.id,
        invoiceId: id,
        num: desiredNum,
        workOrderId,
        storeNumber: String(body.storeNumber || "").trim(),
        storeAddress: body.storeAddress || null,
        cme: body.cme || null,
        invoiceDate: body.invoiceDate,
        serviceDate: body.serviceDate || null,
        dueDate: body.dueDate || null,
        terms: body.terms || "Net 30",
        state: targetState,
        tax,
        territory: String(body.territory || "").trim(),
        equipmentTag: body.equipmentTag,
        lines: validLines,
        sourceInvoiceIds,
      });
    } catch (error: any) {
      if (error?.code !== "23505") throw error;
      return jsonError(`Invoice number ${desiredNum} already exists`, 409);
    }

    const invoice = await loadStaffInvoiceById(auth.sb, id);
    if (!invoice) throw new Error("Updated invoice could not be reloaded");

    return NextResponse.json({ invoice });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update billing invoice";
    return jsonError(message, billingSaveErrorStatus(err));
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireStaff(req);
  if ("error" in auth) return auth.error;
  if (isController(auth.profile)) {
    return jsonError("The controller cannot delete P1 billing invoices", 403);
  }

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return jsonError("Invoice id is required", 400);

  try {
    const { data: existing, error: existingError } = await (auth.sb as any)
      .from("invoices")
      .select("id, num, work_order_id")
      .eq("id", id)
      .eq("invoice_type", "staff")
      .is("deleted_at", null)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) return jsonError("Billing invoice not found or already deleted", 404);

    const { data: deleted, error: deleteError } = await (auth.sb as any)
      .from("invoices")
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: auth.user.id,
      })
      .eq("id", id)
      .eq("invoice_type", "staff")
      .is("deleted_at", null)
      .select("id, num, work_order_id, deleted_at")
      .maybeSingle();
    if (deleteError) throw deleteError;
    if (!deleted) return jsonError("Billing invoice changed before it could be deleted", 409);

    if (deleted.work_order_id) {
      const { error: auditError } = await (auth.sb as any)
        .from("activities")
        .insert({
          work_order_id: deleted.work_order_id,
          author_id: auth.user.id,
          author_name: auth.profile.name || "P1 staff",
          text: `P1 invoice #${deleted.num} deleted by ${auth.profile.name || "P1 staff"}.`,
          type: "system",
          is_staff_override: false,
          is_staff_only: true,
          event_key: "staff_billing",
          event_data: { invoiceId: deleted.id, invoiceNum: deleted.num, action: "deleted" },
        });
      if (auditError) console.error("Billing invoice delete audit failed", auditError);
    }

    return NextResponse.json({ invoice: deleted });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete billing invoice";
    return jsonError(message, 500);
  }
}
