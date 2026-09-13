import { parseBillingReadInput } from "../../features/billing/billingReadContracts";
import { parseCompactBillingRead } from "../../lib/server/billingCompactReadInput";
import type { BillingReadAuthorization } from "./billingReadContext";
import { createBillingReadRepository } from "./readRepository";
import { createBillingReadUseCases } from "./readUseCases";
import { mapInvoice, sourceMetrics, type WorkOrderFinancialContext } from "./mappers";
import { createBillingLegacyReadRepository, type BillingLegacyReadPort, type BillingLegacyPageFacts } from "./billingLegacyReadRepository";
import { canonicalSevenElevenWorkOrderId } from "../../lib/workOrderIdentity";
import { FinancialInvoiceIdSchema } from "../../lib/staffInvoiceContracts";

type LegacyReadClient = Parameters<typeof createBillingReadRepository>[0] & BillingLegacyReadPort;

function legacyUuidIdentity(value: string) {
  const parsed = FinancialInvoiceIdSchema.safeParse(value);
  // UUID columns return PostgreSQL canonical lowercase. Leave malformed legacy
  // inputs for their existing query/error path, and never normalize TEXT WOTs.
  return parsed.success ? parsed.data.toLowerCase() : value;
}

function mapLegacyInvoices(invoices: BillingLegacyPageFacts["page"]["items"], lines: BillingLegacyPageFacts["staffLines"],
  contexts: BillingLegacyPageFacts["workOrders"]) {
  const workOrders = new Map(contexts.map(row => [row.id, row]));
  const contextFor = (workOrderId: string | null | undefined): WorkOrderFinancialContext | null => {
    if (!workOrderId) return null;
    const row = workOrders.get(workOrderId);
    return { externalId: row?.duplicate_root_work_order_id || canonicalSevenElevenWorkOrderId(workOrderId) || workOrderId,
      assignmentVersion: row?.contractor_assignment_version ?? null, workflowCycle: row?.workflow_cycle ?? null };
  };
  const linesByInvoice = new Map<string, typeof lines>();
  for (const line of lines) {
    const current = linesByInvoice.get(line.invoice_id) ?? [];
    current.push(line);
    linesByInvoice.set(line.invoice_id, current);
  }
  return invoices.map(row => mapInvoice(row, linesByInvoice.get(row.id) ?? [], contextFor(row.work_order_id)));
}

function mapLegacyPage(facts: BillingLegacyPageFacts, preserveLinkedIds = false) {
  const sourceById = new Map(mapLegacyInvoices(facts.sourceInvoices, facts.sourceLines, facts.workOrders).map(row => [row.id, row]));
  const sourceIdsByStaff = new Map<string, string[]>();
  for (const link of facts.sourceLinks) {
    const ids = sourceIdsByStaff.get(link.staff_invoice_id) ?? [];
    ids.push(link.contractor_invoice_id);
    sourceIdsByStaff.set(link.staff_invoice_id, ids);
  }
  return mapLegacyInvoices(facts.page.items, facts.staffLines, facts.workOrders).map(mapped => {
    const sourceInvoices = (sourceIdsByStaff.get(mapped.id) ?? []).flatMap(id => {
      const source = sourceById.get(id);
      return source ? [source] : [];
    });
    return { ...mapped, sourceInvoices, sourceInvoiceIds: preserveLinkedIds
      ? sourceIdsByStaff.get(mapped.id) ?? [] : sourceInvoices.map(source => source.id),
      ...sourceMetrics(sourceInvoices, mapped.subtotal) };
  });
}

/** Compatibility-only GET adapter. It translates old envelopes to the
 * explicit legacy document/compact use cases; it owns no queries or authorization. */
export async function executeLegacyBillingRead(
  request: Request,
  authorization: BillingReadAuthorization,
): Promise<Response> {
  const search = new URL(request.url).searchParams;
  const client = authorization.sb as unknown as LegacyReadClient;
  const repository = createBillingReadRepository(client, authorization.isController);
  const legacyRepository = createBillingLegacyReadRepository(client);
  const useCases = createBillingReadUseCases(repository);
  const compact = parseCompactBillingRead(search);
  const signal = request.signal;
  if (compact?.kind === "count") return Response.json(await useCases.count(compact.page, signal));
  if (compact) {
    const result = compact.kind === "page"
      ? await useCases.page(compact.page, signal)
      : compact.kind === "summary"
        ? await useCases.summary(compact.invoiceId, signal)
        : compact.kind === "lines"
          ? await useCases.lines(compact, signal)
          : await useCases.sources(compact, signal);
    return Response.json(result);
  }
  const sourceIdsParam = search.get("sourceInvoiceIds");
  if (sourceIdsParam !== null) {
    const sourceIds = [...new Set(sourceIdsParam.split(",").map(id => id.trim()).filter(Boolean))].map(legacyUuidIdentity);
    if (!sourceIds.length) return Response.json({ error: "At least one source invoice id is required" }, { status: 400 });
    const facts = await legacyRepository.sources(sourceIds, authorization.isController, signal);
    const byId = new Map(mapLegacyInvoices(facts.sourceInvoices, facts.sourceLines, facts.workOrders).map(row => [row.id, row]));
    return Response.json({ invoices: sourceIds.map(id => byId.get(id)) });
  }
  if (search.get("nextNumber") === "1") {
    if (authorization.isController) return Response.json({ error: "The controller cannot create P1 billing invoices" }, { status: 403 });
    const num = await legacyRepository.nextNumber(authorization.user.id, signal);
    if (!num) return Response.json({ error: "Staff invoice numbering is not configured" }, { status: 503 });
    return Response.json({ num });
  }
  const invoiceIdInput = search.get("invoiceId")?.trim();
  const invoiceId = invoiceIdInput ? legacyUuidIdentity(invoiceIdInput) : invoiceIdInput;
  if (invoiceId) {
    const facts = await legacyRepository.invoice(invoiceId, signal);
    if (!facts) return Response.json({ error: "Billing invoice not found" }, { status: 404 });
    return Response.json({ invoice: mapLegacyPage(facts, true)[0] });
  }
  const input = parseBillingReadInput(search);
  if (input.response === "count") return Response.json(await useCases.count(input, signal));
  const facts = await legacyRepository.page(input, signal);
  const { page } = facts;
  const mappedItems = mapLegacyPage(facts);
  return Response.json({
    ...(search.get("response") === "rows" ? {} : { invoices: mappedItems }),
    items: mappedItems,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    totalCount: page.totalCount,
  });
}
