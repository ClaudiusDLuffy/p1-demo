import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createFinancialNotificationCommands, type FinancialNotificationCommandPorts } from "./financialNotificationCommands";
import { financialNotificationFeedback, FinancialNotificationCommandError, safeFinancialNotificationCommandError } from "./financialNotificationCommandContracts";

const uuid = (number: number) => `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const invoiceId = uuid(1);
function receipt(operationId: unknown, kind = "invoice_rejected") {
  return { operationId, replayed: false, notificationStatus: "queued", notifications: [
    { eventId: uuid(900), sourceEventId: uuid(901), family: kind, status: "queued" },
  ] };
}
function review(args: Record<string, unknown>, name = "review") {
  const isApprove = args.p_action === "approve";
  return { invoiceId: args.p_invoice_id, invoiceNum: "SYNTHETIC-1", invoiceState: isApprove || name.includes("retract") ? "approved" : "rejected",
    workOrderId: "SYNTHETIC-WO", workOrderStatus: "pending_approval", reviewRevision: 2,
    ...receipt(args.p_operation_id, name.includes("retract") ? "invoice_rejection_retracted" : "invoice_rejected"),
    ...(isApprove ? { notifications: [], notificationStatus: "not_required" } : {}),
  };
}
function fixture() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const holds: Parameters<FinancialNotificationCommandPorts["holdRequest"]>[1][] = [];
  let actor: { id: string; token: string } | null = { id: uuid(800), token: "synthetic-not-a-token" };
  let operations = 100; let revisionReads = 0; let sourceReads = 0;
  let result: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> = async (name, args) => ({ data: review(args, name), error: null });
  let holdResponse: (body: typeof holds[number]) => Promise<{ ok: boolean; status: number; payload: unknown }> = async body => ({
    ok: true, status: 200, payload: { result: { ...receipt(body.operationId, body.action === "hold" ? "payment_hold_placed" : "payment_hold_released"), invoiceId: body.invoiceId, invoiceNum: "SYNTHETIC-1", applied: true } },
  });
  const ports: FinancialNotificationCommandPorts = {
    session: async () => actor,
    rpc: async (name, args) => { calls.push({ name, args }); return result(name, args); },
    reviewRevision: async () => { revisionReads++; return 1; },
    holdSource: async () => { sourceReads++; return uuid(400 + sourceReads); },
    holdRequest: async (_token, body) => { holds.push(body); return holdResponse(body); },
    operationId: () => uuid(operations++),
  };
  const commands = createFinancialNotificationCommands(ports);
  return { commands, ports, calls, holds, actor: (next: typeof actor) => { actor = next; },
    respond: (next: typeof result) => { result = next; }, respondHold: (next: typeof holdResponse) => { holdResponse = next; },
    reads: () => ({ revisionReads, sourceReads }) };
}
const isCode = (code: string) => (error: unknown) => error instanceof FinancialNotificationCommandError && error.code === code;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test("review mutation binds operation and visible revision and queues without a browser notification call", async () => {
  const f = fixture(); const result = await f.commands.review(invoiceId, "reject", " Missing receipt ", 7);
  assert.equal(result.notificationStatus, "queued"); assert.equal(f.reads().revisionReads, 0);
  assert.equal(f.calls[0].name, "review_contractor_invoice_with_notification_v1");
  assert.deepEqual(f.calls[0].args, { p_invoice_id: invoiceId, p_action: "reject", p_reason: "Missing receipt", p_operation_id: uuid(100), p_expected_revision: 7 });
});
test("approval produces no notification and legacy caller obtains a bounded revision snapshot", async () => {
  const f = fixture(); const result = await f.commands.review(invoiceId, "approve");
  assert.equal(result.notificationStatus, "not_required"); assert.equal(result.notifications.length, 0);
  assert.equal(f.reads().revisionReads, 1);
});
test("retraction binds revision and its own event family", async () => {
  const f = fixture(); const result = await f.commands.retract(invoiceId, 9);
  assert.equal(f.calls[0].name, "retract_contractor_invoice_rejection_with_notification_v1");
  assert.equal(f.calls[0].args.p_expected_revision, 9); assert.equal(result.notifications[0].family, "invoice_rejection_retracted");
});
test("unknown review response retries one operation and original revision even after a UI refetch", async () => {
  const f = fixture(); let first = true;
  f.respond(async (name, args) => { if (first) { first = false; throw new Error("synthetic connection lost"); } return { data: review(args, name), error: null }; });
  await assert.rejects(f.commands.review(invoiceId, "reject", "Missing receipt", 1), isCode("RESULT_UNCONFIRMED"));
  await f.commands.review(invoiceId, "reject", "Missing receipt", 2);
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[0], f.calls[1]);
});
test("uncertain action cannot change reason, family, or overlap a batch", async () => {
  const f = fixture(); f.respond(async () => { throw new Error("synthetic unavailable"); });
  await assert.rejects(f.commands.review(invoiceId, "reject", "Original reason", 1), isCode("RESULT_UNCONFIRMED"));
  await assert.rejects(f.commands.review(invoiceId, "reject", "Changed reason", 1), isCode("OPERATION_REUSED"));
  await assert.rejects(f.commands.retract(invoiceId, 1), isCode("OPERATION_REUSED"));
  await assert.rejects(f.commands.batch([invoiceId, uuid(2)], "reject", "Original reason", { [invoiceId]: 1, [uuid(2)]: 1 }), isCode("OPERATION_REUSED"));
  assert.equal(f.calls.length, 1);
});
test("double click coalesces one in-flight operation", async () => {
  const f = fixture(); let finish: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  f.respond(async (name, args) => { await waiting; return { data: review(args, name), error: null }; });
  const a = f.commands.review(invoiceId, "reject", "Same reason", 1);
  const b = f.commands.review(invoiceId, "reject", "Same reason", 1);
  await turn(); assert.equal(f.calls.length, 1); finish?.();
  assert.deepEqual(await a, await b);
});
test("known stale conflict is safe and a refreshed deliberate action gets a new operation", async () => {
  const f = fixture(); f.respond(async () => ({ data: null, error: { code: "PT409", message: "STALE_REVIEW", details: "private SQL" } }));
  await assert.rejects(f.commands.review(invoiceId, "reject", "First", 1), isCode("STALE_REVIEW"));
  f.respond(async (name, args) => ({ data: review(args, name), error: null }));
  await f.commands.review(invoiceId, "reject", "Corrected", 2);
  assert.notEqual(f.calls[0].args.p_operation_id, f.calls[1].args.p_operation_id);
});
test("malformed or wrong-identity success is uncertain and does not release replay context", async () => {
  const f = fixture(); f.respond(async (name, args) => ({ data: { ...review(args, name), invoiceId: uuid(50), recipientEmail: "synthetic@example.invalid" }, error: null }));
  await assert.rejects(f.commands.review(invoiceId, "reject", "Reason", 1), isCode("RESULT_UNCONFIRMED"));
  await assert.rejects(f.commands.review(invoiceId, "reject", "Changed", 1), isCode("OPERATION_REUSED"));
});
test("an accepted financial result missing its required intent is not falsely reported queued", async () => {
  const f = fixture(); f.respond(async (name, args) => ({ data: { ...review(args, name), notifications: [], notificationStatus: "queued" }, error: null }));
  await assert.rejects(f.commands.review(invoiceId, "reject", "Reason", 1), isCode("RESULT_UNCONFIRMED"));
});
test("missing authentication performs no processing and changing actor discards previous memory-only context", async () => {
  const f = fixture(); f.actor(null);
  await assert.rejects(f.commands.review(invoiceId, "approve", null, 1), isCode("AUTH_REQUIRED")); assert.equal(f.calls.length, 0);
  f.actor({ id: uuid(801), token: "synthetic-session" }); f.respond(async () => { throw new Error("synthetic lost response"); });
  await assert.rejects(f.commands.review(invoiceId, "reject", "Actor one", 1), isCode("RESULT_UNCONFIRMED"));
  f.actor({ id: uuid(802), token: "different-synthetic-session" }); f.respond(async (name, args) => ({ data: review(args, name), error: null }));
  await f.commands.review(invoiceId, "reject", "Actor two", 1);
  assert.notEqual(f.calls[0].args.p_operation_id, f.calls[1].args.p_operation_id);
});
test("logout reset removes pending contexts; account changes during preparation deny mutation", async () => {
  const f = fixture(); f.ports.reviewRevision = async () => { f.actor({ id: uuid(899), token: "synthetic-new-actor" }); return 1; };
  await assert.rejects(f.commands.review(invoiceId, "approve"), isCode("AUTH_REQUIRED")); assert.equal(f.calls.length, 0);
  f.commands.reset(); await f.commands.review(invoiceId, "approve", null, 1); assert.equal(f.calls.length, 1);
});
test("input validation rejects missing review/overlong hold reason, invalid revision and oversized batch before RPC", async () => {
  const f = fixture();
  for (const request of [() => f.commands.review(invoiceId, "reject", "", 1), () => f.commands.hold(invoiceId, "hold", "x".repeat(501)),
    () => f.commands.review(invoiceId, "approve", "", 0), () => f.commands.batch(Array.from({ length: 101 }, (_, i) => uuid(i + 1)), "approve")]) {
    await assert.rejects(request(), isCode("VALIDATION_FAILED"));
  }
  assert.equal(f.calls.length, 0);
});
test("review retains the existing longer reason policy and known financial rule failures release context", async () => {
  const f = fixture(); const reason = "x".repeat(501);
  f.respond(async () => ({ data: null, error: { code: "55000", message: "private eligibility detail" } }));
  await assert.rejects(f.commands.review(invoiceId, "reject", reason, 1), isCode("FINANCIAL_EVENT_STALE"));
  f.respond(async (name, args) => ({ data: { ...review(args, name), rejectionReason: reason }, error: null }));
  const result = await f.commands.review(invoiceId, "reject", reason, 2);
  assert.equal(result.rejectionReason?.length, 501);
  assert.notEqual(f.calls[0].args.p_operation_id, f.calls[1].args.p_operation_id);
});
test("batch sends one atomic command with sorted exact revisions and bounded verified results", async () => {
  const f = fixture(); const ids = [invoiceId, uuid(2)];
  f.respond(async (_name, args) => ({ data: { action: args.p_action, operationId: args.p_operation_id, replayed: false,
    count: 2, invoiceIds: ids, results: ids.map(id => review({ p_invoice_id: id, p_action: args.p_action, p_operation_id: uuid(200 + ids.indexOf(id)) })) }, error: null }));
  const result = await f.commands.batch([...ids].reverse(), "reject", "Shared reason", { [uuid(2)]: 3, [invoiceId]: 2 });
  assert.equal(f.calls.length, 1); assert.equal(result.results.length, 2);
  assert.deepEqual(f.calls[0].args.p_invoice_ids, ids); assert.deepEqual(f.calls[0].args.p_expected_revisions, { [invoiceId]: 2, [uuid(2)]: 3 });
});
test("batch cannot silently omit a selected invoice or provide an unrelated revision", async () => {
  const f = fixture();
  await assert.rejects(f.commands.batch([invoiceId], "approve", "", { [invoiceId]: 1, [uuid(2)]: 1 }), isCode("VALIDATION_FAILED"));
  f.respond(async (_name, args) => ({ data: { count: 1, action: "approve", invoiceIds: [uuid(2)], operationId: args.p_operation_id, replayed: false,
    results: [review({ p_invoice_id: uuid(2), p_action: "approve", p_operation_id: uuid(90) })] }, error: null }));
  await assert.rejects(f.commands.batch([invoiceId], "approve", "", { [invoiceId]: 1 }), isCode("RESULT_UNCONFIRMED"));
});
test("hold captures current source before mutation and never accepts a browser recipient", async () => {
  const f = fixture(); const result = await f.commands.hold(invoiceId, "hold", "Source checked");
  assert.equal(f.reads().sourceReads, 1); assert.equal(result.notificationStatus, "queued");
  assert.deepEqual(f.holds[0], { invoiceId, action: "hold", reason: "Source checked", operationId: uuid(100), expectedSourceEventId: uuid(401) });
});
test("hold dialog captures source before staff confirmation and never refreshes it during submission", async () => {
  const f = fixture(); const opened = await f.commands.prepareHold(invoiceId);
  assert.equal(f.holds.length, 0);
  f.ports.holdSource = async () => uuid(999);
  await f.commands.hold(invoiceId, "release", "Checked before dialog", opened.expectedSourceEventId);
  assert.equal(f.holds[0].expectedSourceEventId, uuid(401));
});
test("accepted hold with lost response keeps original source and operation on manual retry", async () => {
  const f = fixture(); let accepted = 0;
  f.respondHold(async body => { accepted++; if (accepted === 1) throw new Error("synthetic response timeout");
    return { ok: true, status: 200, payload: { result: { ...receipt(body.operationId, "payment_hold_released"), applied: true, invoiceId: body.invoiceId, invoiceNum: "SYNTHETIC" } } }; });
  await assert.rejects(f.commands.hold(invoiceId, "release", "Verified release"), isCode("RESULT_UNCONFIRMED"));
  await f.commands.hold(invoiceId, "release", "Verified release");
  assert.equal(f.reads().sourceReads, 1); assert.deepEqual(f.holds[0], f.holds[1]); assert.equal(accepted, 2);
});
test("hold read failure invokes no mutation; retry safely reads current source", async () => {
  const f = fixture(); let tries = 0;
  f.ports.holdSource = async () => { if (++tries === 1) throw new Error("synthetic read outage"); return null; };
  await assert.rejects(f.commands.hold(invoiceId, "hold", "Reason"), isCode("RESULT_UNCONFIRMED")); assert.equal(f.holds.length, 0);
  await f.commands.hold(invoiceId, "hold", "Reason"); assert.equal(f.holds[0].expectedSourceEventId, null);
});
test("hold 401/403 and stale source response are definitive safe failures", async () => {
  for (const [status, code] of [[401, "AUTH_REQUIRED"], [403, "FORBIDDEN"], [409, "STALE_HOLD"]] as const) {
    const f = fixture(); f.respondHold(async () => ({ ok: false, status, payload: { code, error: "private SQL data" } }));
    await assert.rejects(f.commands.hold(invoiceId, "hold", "Reason"), isCode(code));
  }
});
test("receipt strips extra fields and queued/manual-not-deliverable wording never claims delivery", async () => {
  const f = fixture(); f.respond(async (name, args) => ({ data: { ...review(args, name), recipientEmail: "synthetic@example.invalid", providerBody: "private" }, error: null }));
  const result = await f.commands.review(invoiceId, "reject", "Reason", 1);
  assert.ok(!("recipientEmail" in result)); assert.ok(!("providerBody" in result));
  assert.equal(financialNotificationFeedback(result), "notification queued");
  assert.match(financialNotificationFeedback({ notificationStatus: "not_deliverable" }), /needs attention/);
});
test("safe command errors never echo provider/SQL/token contents", () => {
  for (const input of [{ code: "42501", message: "secret SQL" }, new Error("synthetic token/provider body"), { message: "STALE_HOLD", details: "private" }]) {
    assert.doesNotMatch(safeFinancialNotificationCommandError(input).message, /secret|SQL|token|provider body|private/);
  }
});
test("unconfirmed context capacity is bounded and cannot be silently evicted", async () => {
  const f = fixture(); f.respond(async () => { throw new Error("synthetic lost response"); });
  const ids = Array.from({ length: 100 }, (_, i) => uuid(i + 1));
  await assert.rejects(f.commands.batch(ids, "approve", "", Object.fromEntries(ids.map(id => [id, 1]))), isCode("RESULT_UNCONFIRMED"));
  await assert.rejects(f.commands.review(uuid(101), "approve", "", 1), isCode("REQUEST_CAPACITY")); assert.equal(f.calls.length, 1);
});
test("first-party callers use durable facades, scoped invalidation and queued messages", () => {
  const hook = readFileSync("src/features/invoices/useInvoices.ts", "utf8");
  const controller = readFileSync("src/features/invoices/ControllerExportPanel.tsx", "utf8");
  const list = readFileSync("src/features/invoices/InvoiceList.tsx", "utf8");
  assert.doesNotMatch(hook, /notifyInvoiceReview|notifications\/invoice-review|contractors? notified|accounting notified|notificationWarning/);
  assert.match(hook, /reviewContractorInvoice\(inv.id, "reject", trimmed, inv.reviewRevision\)/);
  assert.match(hook, /retractContractorInvoiceRejection\(inv.id, inv.reviewRevision\)/);
  assert.match(controller, /updateInvoicePaymentHold\(hold.invoiceId, "release", reason, context.expectedSourceEventId\)/);
  assert.ok(controller.indexOf("await prepareInvoicePaymentHold(hold.invoiceId)") < controller.indexOf("const reason = window.prompt("));
  assert.match(controller, /financialNotificationFeedback\(result\)/);
  assert.match(list, /const selection = batchSelection/); assert.match(list, /selection.expectedRevisions/);
});

function invoiceHookFixture(commandFailure: unknown = null) {
  const filename = resolve("src/features/invoices/useInvoices.ts");
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const requireHere = createRequire(import.meta.url);
  const exports: Record<string, unknown> = {};
  const notices: string[] = []; const mutations: string[] = [];
  const mutation = async (name: string) => {
    mutations.push(name);
    if (commandFailure) throw commandFailure;
    return { ...review({ p_invoice_id: invoiceId, p_operation_id: uuid(100) }), count: 1,
      results: [review({ p_invoice_id: invoiceId, p_operation_id: uuid(101) })] };
  };
  runInNewContext(compiled, { exports, require: (path: string) => {
    if (path === "react") return { useCallback: (fn: unknown) => fn, useRef: (current: unknown) => ({ current }),
      useState: (initial: unknown) => [initial, () => undefined] };
    if (path === "@tanstack/react-query") return { useQueryClient: () => ({
      getQueryData: () => [], invalidateQueries: async () => { throw new Error("synthetic read refresh failure"); },
    }) };
    if (path === "../../lib/db") return { reviewContractorInvoice: () => mutation("review"),
      reviewContractorInvoices: () => mutation("batch"), retractContractorInvoiceRejection: () => mutation("retract") };
    if (path === "../../lib/financialNotificationCommands") return { updateInvoicePaymentHold: () => mutation("hold") };
    if (path === "./useInvoiceDocumentAction") return { useInvoiceDocumentAction: () => Object.assign(async () => {
      throw new Error("Document reads must not run during financial notification actions");
    }, { assertCurrent: () => undefined }) };
    if (path === "../financial-notifications/queries") return { financialNoticeKeys: { scope: () => ["financial-notifications", "synthetic-actor"] } };
    if (path === "./queries" || path === "../work-orders/queries") return new Proxy({}, { get: (_target, property) => [String(property)] });
    return requireHere(path.startsWith(".") ? resolve(filename, "..", path) : path);
  } }, { filename });
  assert.equal(typeof exports.default, "function");
  const hook = (exports.default as (props: unknown) => Record<string, unknown>)({
    currentUser: { id: uuid(800), role: "manager", active: true, staffPermissions: [] }, fire: (message: string) => notices.push(message),
  });
  return { notices, mutations, invoke: async (method: string, ...args: unknown[]) => {
    const fn = hook[method]; assert.equal(typeof fn, "function");
    return (fn as (...args: unknown[]) => Promise<boolean>)(...args);
  } };
}
test("executed invoice-hook handlers preserve durable success when every post-commit refresh fails", async () => {
  const invoice = { id: invoiceId, num: "SYNTHETIC-1", reviewRevision: 1 };
  const actions: [string, unknown[]][] = [
    ["doRejectInvoice", [invoice, "Reason"]], ["doRetractInvoiceRejection", [invoice]],
    ["doBatchReviewInvoices", [[invoiceId], "reject", "Reason", { [invoiceId]: 1 }]],
    ["doBatchReviewInvoices", [[invoiceId], "approve", "", { [invoiceId]: 1 }]],
    ["doPlaceInvoicePaymentHold", [invoice, "Reason", null]], ["doReleaseInvoicePaymentHold", [invoice, "Reason", uuid(500)]],
  ];
  for (const [method, args] of actions) {
    const h = invoiceHookFixture();
    assert.equal(await h.invoke(method, ...args), true, method);
    assert.equal(h.mutations.length, 1); assert.match(h.notices.at(-1) || "", /action was saved.*latest view/);
    assert.doesNotMatch(h.notices.join(), /contractor notified|accounting notified|email sent/);
  }
});
test("executed invoice-hook conflict stays a safe failed action even if conflict refresh also fails", async () => {
  const h = invoiceHookFixture({ code: "PT409", message: "STALE_REVIEW", details: "private database detail" });
  assert.equal(await h.invoke("doRejectInvoice", { id: invoiceId, num: "SYNTHETIC-1", reviewRevision: 1 }, "Reason"), false);
  assert.match(h.notices.at(-1) || "", /review changed/);
  assert.doesNotMatch(h.notices.join(), /private|database/);
});
