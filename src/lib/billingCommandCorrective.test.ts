import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createBillingSaveCommandRepository } from "../server/billing-invoices/billingSaveCommandRepository";
import { createBillingUpdateCommandRepository } from "../server/billing-invoices/billingUpdateCommandRepository";
import { createBillingDeleteRepository } from "../server/billing-invoices/billingCommandRepository";
import { BILLING_RECONCILIATION_TIMEOUT_MS } from "../server/billing-invoices/billingCommandReconciliation";
import { FinancialDeleteSchema, StaffInvoiceSaveSchema } from "./staffInvoiceContracts";
import { parseStaffFinancialRpcResponse, type StaffFinancialDatabase } from "./staffFinancialCommands";

const ids = {
  actor: "85000000-0000-4000-8000-000000000001",
  invoice: "85000000-0000-4000-8000-000000000002",
  operation: "85000000-0000-4000-8000-000000000003",
  activity: "85000000-0000-4000-8000-000000000004",
};
const command = (editing = false) => StaffInvoiceSaveSchema.parse({
  operationId: ids.operation, expectedInvoiceVersion: editing ? 1 : null,
  workOrderId: "WOT-CORRECTIVE-850001", expectedAssignmentVersion: 4, expectedWorkflowCycle: 2,
  num: "P1-CORRECTIVE-850001", userTypedNum: true, state: "draft", territory: "Texas",
  equipmentTag: "7-ELEVEN: Ice", storeNumber: "850001", invoiceDate: "2026-09-12", terms: "Net 30",
  taxState: "TX", salesTaxOverride: 0, sourceInvoiceIds: [],
  lines: [{ type: "Labor", desc: "Synthetic corrective fixture", qty: 1, rate: 17.25, isTaxable: false }],
});
const receipt = () => ({
  applied: true, reason: "applied", operationId: ids.operation, invoiceId: ids.invoice,
  invoiceVersion: 2, invoiceNum: "P1-CORRECTIVE-850001", workOrderId: "WOT-CORRECTIVE-850001",
  assignmentVersion: 4, workflowCycle: 2, state: "draft", subtotal: 17.25, salesTax: 0,
  total: 17.25, lineCount: 1, sourceInvoiceCount: 0, activityId: ids.activity,
});
const deletedReceipt = () => ({
  ...receipt(), invoiceType: "staff", deletedAt: "2026-09-12T02:00:00Z",
});
const deleteCommand = () => FinancialDeleteSchema.parse({
  operationId: ids.operation, expectedInvoiceVersion: 1,
  expectedAssignmentVersion: 4, expectedWorkflowCycle: 2, reason: "Synthetic cancellation",
});
function malformedEnvelopeClient(data: unknown, error: unknown) {
  let calls = 0;
  const client = { rpc() {
    calls++;
    const result = Promise.resolve({ data, error });
    return Object.assign(result, { abortSignal: (signal: AbortSignal) => { signal.throwIfAborted(); return result; } });
  } };
  return { client, count: () => calls,
    context: { actor: { userId: ids.actor }, dataSession: client, signal: null } };
}
for (const [label, value] of [
  ["null", null], ["array", []], ["empty", {}],
  ["missing error", { data: receipt() }], ["missing data", { error: null }],
  ["non-object error", { data: null, error: true }],
  ["invalid error code", { data: null, error: { code: 42, message: "synthetic-private-canary" } }],
  ["mixed success and error", { data: receipt(), error: { code: "PT409", message: "synthetic-private-canary" } }],
] as const) {
  test(`shared billing RPC envelope: ${label} is invalid`, () => {
    assert.throws(() => parseStaffFinancialRpcResponse(value),
      (error: unknown) => z.object({ code: z.literal("FINANCIAL_RESULT_INVALID") }).safeParse(error).success);
  });
}
type RecordedRpc = { name: string; args: Record<string, unknown>; signal: AbortSignal | null | undefined };
function rpcHarness(respond: (call: RecordedRpc, attempt: number) => Response | Promise<Response>) {
  const calls: RecordedRpc[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(typeof init?.body, "string", "Only synthetic RPC POSTs are supported");
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, "billing-corrective.invalid");
    const call = { name: url.pathname.split("/").at(-1) ?? "",
      args: z.record(z.string(), z.unknown()).parse(JSON.parse(String(init?.body))), signal: init?.signal };
    calls.push(call);
    return respond(call, calls.length);
  };
  const client = createClient<StaffFinancialDatabase>("https://billing-corrective.invalid", "synthetic-test-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetcher },
  });
  const context = (signal: AbortSignal | null = null) => ({ actor: { userId: ids.actor }, dataSession: client, signal });
  return { client, context, calls };
}

for (const mode of ["POST", "PATCH"] as const) {
  test(`${mode} corrective: validated committed receipt wins over a late abort`, async () => {
    const controller = new AbortController();
    const h = rpcHarness(() => {
      controller.abort();
      return Response.json(receipt());
    });
    const result = mode === "POST"
      ? await createBillingSaveCommandRepository(h.client).execute(command(), h.context(controller.signal))
      : await createBillingUpdateCommandRepository().save(command(true), ids.invoice, h.context(controller.signal));
    assert.equal(result.invoiceId, ids.invoice);
    assert.equal(result.operationId, ids.operation);
    assert.equal(result.applied, true);
    assert.equal(h.calls.length, 1);
  });

  test(`${mode} corrective: cancellation reaches the installed RPC fetch transport`, async () => {
    const controller = new AbortController();
    const h = rpcHarness(() => Response.json(receipt()));
    if (mode === "POST") await createBillingSaveCommandRepository(h.client).execute(command(), h.context(controller.signal));
    else await createBillingUpdateCommandRepository().save(command(true), ids.invoice, h.context(controller.signal));
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].signal, controller.signal);
  });

  test(`${mode} corrective: an already aborted command is not dispatched`, async () => {
    const controller = new AbortController();
    controller.abort();
    const h = rpcHarness(() => Response.json(receipt()));
    await assert.rejects(mode === "POST"
      ? createBillingSaveCommandRepository(h.client).execute(command(), h.context(controller.signal))
      : createBillingUpdateCommandRepository().save(command(true), ids.invoice, h.context(controller.signal)));
    assert.equal(h.calls.length, 0);
  });

  test(`${mode} corrective: response loss reconciles once using the identical operation and payload`, async () => {
    const h = rpcHarness((_call, attempt) => {
      if (attempt === 1) throw new TypeError("fetch failed");
      return Response.json({ ...receipt(), applied: false, reason: "already_applied" });
    });
    const result = mode === "POST"
      ? await createBillingSaveCommandRepository(h.client).execute(command(), h.context())
      : await createBillingUpdateCommandRepository().save(command(true), ids.invoice, h.context());
    assert.equal(result.reason, "already_applied");
    assert.equal(result.operationId, ids.operation);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[0].name, "save_staff_billing_invoice_v4");
    assert.deepEqual(h.calls[1].args, h.calls[0].args);
    assert.equal(h.calls[0].args.p_invoice_id, mode === "POST" ? null : ids.invoice);
  });

  test(`${mode} corrective: a malformed receipt reconciles once but never invents success`, async () => {
    const h = rpcHarness((_call, attempt) => attempt === 1
      ? Response.json({ invoiceId: ids.invoice, internal_sql_detail: "synthetic-private-canary" })
      : Response.json({ ...receipt(), applied: false, reason: "already_applied" }));
    const result = mode === "POST"
      ? await createBillingSaveCommandRepository(h.client).execute(command(), h.context())
      : await createBillingUpdateCommandRepository().save(command(true), ids.invoice, h.context());
    assert.equal(result.reason, "already_applied");
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls[1].args, h.calls[0].args);
    assert.equal("internal_sql_detail" in result, false);
  });

  test(`${mode} corrective: known stale rejection is not replayed`, async () => {
    const h = rpcHarness(() => Response.json({ code: "PT409", message: "Synthetic stale version" }, { status: 409 }));
    await assert.rejects(mode === "POST"
      ? createBillingSaveCommandRepository(h.client).execute(command(), h.context())
      : createBillingUpdateCommandRepository().save(command(true), ids.invoice, h.context()),
    (error: unknown) => z.object({ code: z.literal("PT409") }).safeParse(error).success);
    assert.equal(h.calls.length, 1);
  });

  test(`${mode} corrective: unresolved response loss remains bounded and unconfirmed`, async () => {
    const h = rpcHarness(() => { throw new TypeError("fetch failed"); });
    await assert.rejects(mode === "POST"
      ? createBillingSaveCommandRepository(h.client).execute(command(), h.context())
      : createBillingUpdateCommandRepository().save(command(true), ids.invoice, h.context()));
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls[1].args, h.calls[0].args);
  });

  test(`${mode} corrective: conflict after response loss does not prove the first attempt rolled back`, async () => {
    const h = rpcHarness((_call, attempt) => {
      if (attempt === 1) throw new TypeError("fetch failed");
      return Response.json({ code: "PT409", message: "Synthetic changed replay snapshot" }, { status: 409 });
    });
    await assert.rejects(mode === "POST"
      ? createBillingSaveCommandRepository(h.client).execute(command(), h.context())
      : createBillingUpdateCommandRepository().save(command(true), ids.invoice, h.context()),
    (error: unknown) => z.object({ code: z.literal("FINANCIAL_COMMAND_FAILED"),
      phase: z.literal("DISPATCHED_OUTCOME_UNKNOWN") }).safeParse(error).success);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls[1].args, h.calls[0].args);
  });

  test(`${mode} corrective: cancellation after dispatch retains unknown without another command`, async () => {
    const controller = new AbortController();
    const h = rpcHarness(() => {
      controller.abort();
      throw new DOMException("Synthetic response loss", "AbortError");
    });
    await assert.rejects(mode === "POST"
      ? createBillingSaveCommandRepository(h.client).execute(command(), h.context(controller.signal))
      : createBillingUpdateCommandRepository().save(command(true), ids.invoice, h.context(controller.signal)),
    (error: unknown) => z.object({ code: z.literal("FINANCIAL_COMMAND_FAILED"),
      phase: z.literal("DISPATCHED_OUTCOME_UNKNOWN") }).safeParse(error).success);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].signal, controller.signal);
  });

  test(`${mode} corrective: reconciliation captures immutable canonical input before dispatch`, async () => {
    const original = command(mode === "PATCH");
    const actor = { userId: ids.actor };
    const h = rpcHarness((_call, attempt) => {
      if (attempt === 1) {
        actor.userId = ids.activity;
        original.operationId = ids.activity;
        original.lines[0].description = "Synthetic caller mutation after dispatch";
        original.sourceInvoiceIds.push(ids.activity);
        throw new TypeError("fetch failed");
      }
      return Response.json({ ...receipt(), applied: false, reason: "already_applied" });
    });
    const context = { ...h.context(), actor };
    const result = mode === "POST"
      ? await createBillingSaveCommandRepository(h.client).execute(original, context)
      : await createBillingUpdateCommandRepository().save(original, ids.invoice, context);
    assert.equal(result.operationId, ids.operation);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls[1].args, h.calls[0].args);
    assert.equal(h.calls[0].args.p_operation_id, ids.operation);
    assert.equal(h.calls[1].args.p_actor_id, ids.actor);
  });

  for (const binding of [
    { operationId: ids.activity }, { workOrderId: "WOT-FOREIGN-SYNTHETIC" },
    { assignmentVersion: 9 }, { workflowCycle: 9 }, { state: "submitted" },
  ]) {
    test(`${mode} corrective: foreign receipt binding cannot confirm this command ${JSON.stringify(binding)}`, async () => {
      const h = rpcHarness(() => Response.json({ ...receipt(), ...binding }));
      await assert.rejects(mode === "POST"
        ? createBillingSaveCommandRepository(h.client).execute(command(), h.context())
        : createBillingUpdateCommandRepository().save(command(true), ids.invoice, h.context()),
      (error: unknown) => z.object({ code: z.literal("FINANCIAL_RESULT_INVALID") }).safeParse(error).success);
      assert.equal(h.calls.length, 2);
      assert.deepEqual(h.calls[1].args, h.calls[0].args);
    });
  }

  test(`${mode} corrective: reconciliation observes request cancellation and preserves unknown`, async () => {
    const controller = new AbortController();
    const h = rpcHarness((call, attempt) => {
      if (attempt === 1) throw new TypeError("fetch failed");
      assert.ok(call.signal);
      assert.notEqual(call.signal, controller.signal, "Reconciliation combines request cancellation with a bounded deadline");
      controller.abort();
      assert.equal(call.signal.aborted, true);
      throw new DOMException("Synthetic reconciliation abort", "AbortError");
    });
    await assert.rejects(mode === "POST"
      ? createBillingSaveCommandRepository(h.client).execute(command(), h.context(controller.signal))
      : createBillingUpdateCommandRepository().save(command(true), ids.invoice, h.context(controller.signal)),
    (error: unknown) => z.object({ phase: z.literal("DISPATCHED_OUTCOME_UNKNOWN") }).safeParse(error).success);
    assert.equal(h.calls.length, 2);
  });
}

test("DELETE corrective: confirmed receipt is not erased by a late abort", async () => {
  const controller = new AbortController();
  const h = rpcHarness(() => { controller.abort(); return Response.json(deletedReceipt()); });
  const result = await createBillingDeleteRepository(h.client).deleteInvoice(ids.actor, ids.invoice,
    deleteCommand(), controller.signal);
  assert.equal(result.invoiceId, ids.invoice);
  assert.equal(result.applied, true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal, controller.signal);
});

test("DELETE corrective: malformed confirmation never becomes committed success", async () => {
  const h = rpcHarness(() => Response.json({ ...deletedReceipt(), invoiceVersion: 1 }));
  await assert.rejects(createBillingDeleteRepository(h.client).deleteInvoice(ids.actor, ids.invoice, deleteCommand()),
    (error: unknown) => z.object({ code: z.literal("FINANCIAL_RESULT_INVALID") }).safeParse(error).success);
});

for (const [label, activityId] of [["missing", undefined], ["malformed", 42], ["missing linked evidence", null]] as const) {
  test(`DELETE corrective: ${label} activity receipt cannot be treated as a confirmed result`, async () => {
    const h = rpcHarness(() => Response.json({ ...deletedReceipt(), activityId }));
    await assert.rejects(createBillingDeleteRepository(h.client).deleteInvoice(ids.actor, ids.invoice, deleteCommand()),
      (error: unknown) => z.object({ code: z.literal("FINANCIAL_RESULT_INVALID") }).safeParse(error).success);
    assert.equal(h.calls.length, 2);
  });
}

test("DELETE corrective: standalone null evidence validates without adding a public activity field", async () => {
  const input = { ...deleteCommand(), expectedAssignmentVersion: null, expectedWorkflowCycle: null };
  const h = rpcHarness(() => Response.json({ ...deletedReceipt(), workOrderId: null, activityId: null,
    assignmentVersion: null, workflowCycle: null }));
  const result = await createBillingDeleteRepository(h.client).deleteInvoice(ids.actor, ids.invoice, input);
  assert.equal(result.workOrderId, null);
  assert.equal("activityId" in result, false);
  assert.equal(h.calls.length, 1);
});

test("DELETE corrective: standalone receipt cannot claim work-order audit evidence", async () => {
  const input = { ...deleteCommand(), expectedAssignmentVersion: null, expectedWorkflowCycle: null };
  const h = rpcHarness(() => Response.json({ ...deletedReceipt(), workOrderId: null,
    assignmentVersion: null, workflowCycle: null }));
  await assert.rejects(createBillingDeleteRepository(h.client).deleteInvoice(ids.actor, ids.invoice, input),
    (error: unknown) => z.object({ code: z.literal("FINANCIAL_RESULT_INVALID") }).safeParse(error).success);
  assert.equal(h.calls.length, 2);
});

test("DELETE corrective: returned work-order mode must agree with the captured version mode", async () => {
  for (const linked of [false, true]) {
    const input = linked ? deleteCommand() : { ...deleteCommand(), expectedAssignmentVersion: null, expectedWorkflowCycle: null };
    const h = rpcHarness(() => Response.json({ ...deletedReceipt(),
      workOrderId: linked ? null : "WOT-FOREIGN-SYNTHETIC", activityId: linked ? null : ids.activity,
      assignmentVersion: input.expectedAssignmentVersion, workflowCycle: input.expectedWorkflowCycle }));
    await assert.rejects(createBillingDeleteRepository(h.client).deleteInvoice(ids.actor, ids.invoice, input),
      (error: unknown) => z.object({ code: z.literal("FINANCIAL_RESULT_INVALID") }).safeParse(error).success);
    assert.equal(h.calls.length, 2);
  }
});

test("DELETE corrective: request signal reaches transport and response loss reuses the same operation", async () => {
  const controller = new AbortController();
  const h = rpcHarness((_call, attempt) => {
    if (attempt === 1) throw new TypeError("fetch failed");
    return Response.json({ ...deletedReceipt(), applied: false, reason: "already_applied" });
  });
  const result = await createBillingDeleteRepository(h.client).deleteInvoice(ids.actor, ids.invoice,
    deleteCommand(), controller.signal);
  assert.equal(result.reason, "already_applied");
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].signal, controller.signal);
  assert.deepEqual(h.calls[1].args, h.calls[0].args);
});

test("DELETE corrective: an aborted request makes zero dispatches", async () => {
  const controller = new AbortController();
  controller.abort();
  const h = rpcHarness(() => Response.json(deletedReceipt()));
  await assert.rejects(createBillingDeleteRepository(h.client).deleteInvoice(ids.actor, ids.invoice,
    deleteCommand(), controller.signal));
  assert.equal(h.calls.length, 0);
});

test("PATCH corrective: an unchanged historical invoice number is not constrained by the new-number input limit", async () => {
  const historicalNumber = "SYNTHETIC-HISTORICAL-" + "7".repeat(90);
  const h = rpcHarness(() => Response.json({ ...receipt(), invoiceNum: historicalNumber }));
  const input = { ...command(true), userTypedNum: false, num: "" };
  const result = await createBillingUpdateCommandRepository().save(input, ids.invoice, h.context());
  assert.equal(result.invoiceNum, historicalNumber);
  assert.equal(h.calls.length, 1);
});

test("DELETE corrective: historical stored number length does not erase committed deletion", async () => {
  const historicalNumber = "SYNTHETIC-HISTORICAL-" + "8".repeat(90);
  const h = rpcHarness(() => Response.json({ ...deletedReceipt(), invoiceNum: historicalNumber }));
  const result = await createBillingDeleteRepository(h.client).deleteInvoice(ids.actor, ids.invoice, deleteCommand());
  assert.equal(result.invoiceNum, historicalNumber);
  assert.equal(h.calls.length, 1);
});

test("DELETE corrective: historical stored work-order text is validated without a new nonempty policy", async () => {
  const h = rpcHarness(() => Response.json({ ...deletedReceipt(), workOrderId: "" }));
  const result = await createBillingDeleteRepository(h.client).deleteInvoice(ids.actor, ids.invoice, deleteCommand());
  assert.equal(result.workOrderId, "");
  assert.equal(h.calls.length, 1);
});

test("POST corrective: excess receipt money precision is not accepted as authoritative", async () => {
  const h = rpcHarness(() => Response.json({ ...receipt(), subtotal: 17.251 }));
  await assert.rejects(createBillingSaveCommandRepository(h.client).execute(command(), h.context()),
    (error: unknown) => z.object({ code: z.literal("FINANCIAL_RESULT_INVALID") }).safeParse(error).success);
});

test("POST corrective: committed source count must match the exact selected source identity set", async () => {
  const h = rpcHarness(() => Response.json({ ...receipt(), sourceInvoiceCount: 1 }));
  await assert.rejects(createBillingSaveCommandRepository(h.client).execute(command(), h.context()),
    (error: unknown) => z.object({ code: z.literal("FINANCIAL_RESULT_INVALID") }).safeParse(error).success);
  assert.equal(h.calls.length, 2);
});

test("PATCH corrective: a committed receipt cannot report fewer lines than the canonical request", async () => {
  const input = command(true);
  input.lines.push({ ...input.lines[0], description: "Synthetic second required line" });
  const h = rpcHarness(() => Response.json(receipt()));
  await assert.rejects(createBillingUpdateCommandRepository().save(input, ids.invoice, h.context()),
    (error: unknown) => z.object({ code: z.literal("FINANCIAL_RESULT_INVALID") }).safeParse(error).success);
  assert.equal(h.calls.length, 2);
});

test("POST corrective: activity evidence nullability matches the command's actual work-order mode", async () => {
  for (const standalone of [false, true]) {
    const input = standalone ? { ...command(), workOrderId: null, expectedAssignmentVersion: null, expectedWorkflowCycle: null } : command();
    const h = rpcHarness(() => Response.json({ ...receipt(), workOrderId: input.workOrderId,
      assignmentVersion: input.expectedAssignmentVersion, workflowCycle: input.expectedWorkflowCycle,
      activityId: standalone ? ids.activity : null }));
    await assert.rejects(createBillingSaveCommandRepository(h.client).execute(input, h.context()),
      (error: unknown) => z.object({ code: z.literal("FINANCIAL_RESULT_INVALID") }).safeParse(error).success);
    assert.equal(h.calls.length, 2);
  }
});

const caseIds = { operation: "8a000000-aaaa-4aaa-8aaa-aaaaaaaaaaa1", invoice: "8a000000-aaaa-4aaa-8aaa-aaaaaaaaaaa2" };
for (const mode of ["POST", "PATCH", "DELETE", "mark_ready", "mark_billed"] as const) {
  test(`${mode} corrective: validated UUID identity compares by SQL UUID semantics without changing the outbound input`, async () => {
    const h = rpcHarness(() => Response.json(mode === "mark_ready"
      ? { ...readyResult(), invoiceId: caseIds.invoice }
      : mode === "mark_billed" ? { ...billedResult(), invoiceId: caseIds.invoice }
        : { ...(mode === "DELETE" ? deletedReceipt() : receipt()),
          invoiceId: caseIds.invoice, operationId: caseIds.operation }));
    const operationId = caseIds.operation.toUpperCase();
    const invoiceId = caseIds.invoice.toUpperCase();
    const result = mode === "POST"
      ? await createBillingSaveCommandRepository(h.client).execute({ ...command(), operationId }, h.context())
      : mode === "PATCH"
        ? await createBillingUpdateCommandRepository().save({ ...command(true), operationId }, invoiceId, h.context())
        : mode === "DELETE"
          ? await createBillingDeleteRepository(h.client).deleteInvoice(ids.actor, invoiceId, { ...deleteCommand(), operationId })
          : await createBillingUpdateCommandRepository().action(mode, invoiceId, h.context());
    assert.equal(result.invoiceId, caseIds.invoice);
    assert.equal(h.calls.length, 1);
    if (mode !== "POST") assert.equal(h.calls[0].args.p_invoice_id, invoiceId);
    if (mode === "POST" || mode === "PATCH" || mode === "DELETE") {
      assert.equal(h.calls[0].args.p_operation_id, operationId);
    }
  });
}

test("POST corrective: ambiguous uppercase UUID request replays identical input and accepts the normalized committed identity", async () => {
  const h = rpcHarness((_call, attempt) => {
    if (attempt === 1) throw new TypeError("fetch failed");
    return Response.json({ ...receipt(), operationId: caseIds.operation, applied: false, reason: "already_applied" });
  });
  const result = await createBillingSaveCommandRepository(h.client).execute({ ...command(), operationId: caseIds.operation.toUpperCase() }, h.context());
  assert.equal(result.operationId, caseIds.operation);
  assert.equal(result.reason, "already_applied");
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].args, h.calls[0].args);
  assert.equal(h.calls[1].args.p_operation_id, caseIds.operation.toUpperCase());
});

for (const sqlCode of ["P0001", "23502", "22001", "22003", "22P02"]) {
  test(`POST corrective: explicit SQL rejection ${sqlCode} does not trigger reconciliation`, async () => {
    const h = rpcHarness(() => Response.json({ code: sqlCode, message: "Synthetic database rejection" }, { status: 400 }));
    await assert.rejects(createBillingSaveCommandRepository(h.client).execute(command(), h.context()),
      (error: unknown) => z.object({ code: z.literal(sqlCode), phase: z.literal("KNOWN_REJECTED") }).safeParse(error).success);
    assert.equal(h.calls.length, 1);
  });
}

test("POST corrective: a lost JSON response is replayed with the same bound command", async () => {
  const h = rpcHarness((_call, attempt) => attempt === 1
    ? new Response("{", { headers: { "content-type": "application/json" } })
    : Response.json({ ...receipt(), applied: false, reason: "already_applied" }));
  const result = await createBillingSaveCommandRepository(h.client).execute(command(), h.context());
  assert.equal(result.reason, "already_applied");
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].args, h.calls[0].args);
});

test("POST corrective: reconciliation transport deadline expires to unknown after two dispatches", async () => {
  const h = rpcHarness((call, attempt) => {
    if (attempt === 1) throw new TypeError("fetch failed");
    const signal = call.signal;
    assert.ok(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  // AbortSignal.timeout is intentionally unref'd by Node. Keep this isolated
  // test alive while the actual supported transport observes its deadline.
  const keepAlive = setTimeout(() => undefined, BILLING_RECONCILIATION_TIMEOUT_MS + 1000);
  try {
    await assert.rejects(createBillingSaveCommandRepository(h.client).execute(command(), h.context()),
      (error: unknown) => z.object({ code: z.literal("FINANCIAL_COMMAND_FAILED"),
        phase: z.literal("DISPATCHED_OUTCOME_UNKNOWN") }).safeParse(error).success);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].signal?.aborted, true);
  } finally {
    clearTimeout(keepAlive);
  }
});

const readyResult = () => ({ invoiceId: ids.invoice, state: "submitted", transitioned: true });
const billedResult = () => ({
  applied: true, reason: "billed", invoiceId: ids.invoice, documentKind: "invoice",
  workOrderId: "WOT-CORRECTIVE-850001", transitioned: true, workOrderClosed: true,
  pendingCapitalCompletion: false, workOrderStatus: "closed", visitsClosed: 1,
});

test("PATCH mark_billed corrective: SQL nullable replay evidence for a standalone invoice remains valid", async () => {
  const expected = { ...billedResult(), applied: false, reason: "already_billed", workOrderId: null,
    transitioned: false, workOrderClosed: null, pendingCapitalCompletion: null, workOrderStatus: null, visitsClosed: 0 };
  const h = rpcHarness(() => Response.json(expected));
  assert.deepEqual(await createBillingUpdateCommandRepository().action("mark_billed", ids.invoice, h.context()), expected);
  assert.equal(h.calls.length, 1);
});

test("PATCH mark_billed corrective: historical work-order text is not silently given a new minimum length", async () => {
  const expected = { ...billedResult(), workOrderId: "" };
  const h = rpcHarness(() => Response.json(expected));
  assert.deepEqual(await createBillingUpdateCommandRepository().action("mark_billed", ids.invoice, h.context()), expected);
  assert.equal(h.calls.length, 1);
});

for (const malformedError of [false, 0, ""]) {
  for (const mode of ["POST", "PATCH", "DELETE", "mark_ready", "mark_billed"] as const) {
    test(`${mode} corrective: malformed RPC envelope error ${JSON.stringify(malformedError)} cannot confirm success`, async () => {
      const data = mode === "mark_ready" ? readyResult() : mode === "mark_billed" ? billedResult()
        : mode === "DELETE" ? deletedReceipt() : receipt();
      const h = malformedEnvelopeClient(data, malformedError);
      const execute = () => {
        if (mode === "POST") return createBillingSaveCommandRepository(h.client).execute(command(), h.context);
        if (mode === "PATCH") return createBillingUpdateCommandRepository().save(command(true), ids.invoice, h.context);
        if (mode === "DELETE") return createBillingDeleteRepository(h.client).deleteInvoice(ids.actor, ids.invoice, deleteCommand());
        return createBillingUpdateCommandRepository().action(mode, ids.invoice, h.context);
      };
      await assert.rejects(execute(), (error: unknown) => z.object({
        code: z.literal("FINANCIAL_RESULT_INVALID"), phase: z.literal("DISPATCHED_OUTCOME_UNKNOWN"),
      }).safeParse(error).success);
      assert.equal(h.count(), mode === "mark_ready" || mode === "mark_billed" ? 1 : 2);
    });
  }
}

for (const action of ["mark_ready", "mark_billed"] as const) {
  test(`PATCH ${action} corrective: validate and allowlist the SQL action receipt`, async () => {
    const expected = action === "mark_ready" ? readyResult() : billedResult();
    const h = rpcHarness(() => Response.json({ ...expected, internal_sql_detail: "synthetic-private-canary" }));
    const result = await createBillingUpdateCommandRepository().action(action, ids.invoice, h.context());
    assert.deepEqual(result, expected);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0].args, { p_invoice_id: ids.invoice, p_actor_id: ids.actor });
    assert.equal(h.calls[0].name, action === "mark_ready" ? "mark_staff_invoice_ready" : "mark_staff_invoice_billed");
  });

  for (const invalid of [null, [], { invoiceId: ids.invoice }, { ...readyResult(), transitioned: "true" },
    { ...billedResult(), invoiceId: ids.operation }, { ...billedResult(), reason: "unknown" }]) {
    test(`PATCH ${action} corrective: malformed action receipt rejected ${JSON.stringify(invalid)}`, async () => {
      const h = rpcHarness(() => Response.json(invalid));
      await assert.rejects(createBillingUpdateCommandRepository().action(action, ids.invoice, h.context()),
        (error: unknown) => z.object({ code: z.literal("FINANCIAL_RESULT_INVALID") }).safeParse(error).success);
      assert.equal(h.calls.length, 1, "Legacy actions have no operation UUID and must not be blindly retried");
    });
  }

  test(`PATCH ${action} corrective: transport cancellation is forwarded`, async () => {
    const controller = new AbortController();
    const h = rpcHarness(() => Response.json(action === "mark_ready" ? readyResult() : billedResult()));
    await createBillingUpdateCommandRepository().action(action, ids.invoice, h.context(controller.signal));
    assert.equal(h.calls[0].signal, controller.signal);
  });

  test(`PATCH ${action} corrective: confirmed action wins over late abort`, async () => {
    const controller = new AbortController();
    const expected = action === "mark_ready" ? readyResult() : billedResult();
    const h = rpcHarness(() => { controller.abort(); return Response.json(expected); });
    const result = await createBillingUpdateCommandRepository().action(action, ids.invoice, h.context(controller.signal));
    assert.deepEqual(result, expected);
    assert.equal(h.calls.length, 1);
  });

  test(`PATCH ${action} corrective: response loss is unknown and is never blindly retried`, async () => {
    const h = rpcHarness(() => { throw new TypeError("fetch failed"); });
    await assert.rejects(createBillingUpdateCommandRepository().action(action, ids.invoice, h.context()),
      (error: unknown) => z.object({ code: z.literal("FINANCIAL_COMMAND_FAILED"),
        phase: z.literal("DISPATCHED_OUTCOME_UNKNOWN") }).safeParse(error).success);
    assert.equal(h.calls.length, 1);
  });
}
