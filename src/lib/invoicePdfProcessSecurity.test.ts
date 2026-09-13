import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { test } from "node:test";
import { jsPDF } from "jspdf";
import "./pdf/test-fixtures/prepareInvoicePdfRuntime";
import { InvoicePdfError } from "./pdf/invoicePdfBudget";
import { invoicePdfProcessState, runInvoicePdfProcess } from "./pdf/invoicePdfProcess";
import { parseInvoicePdfProcessResult } from "./pdf/invoicePdfProcessProtocol";

const valid = () => {
  const document = new jsPDF();
  document.text("Invoice Number SYNTH-PROCESS-1", 20, 20);
  document.text("Total Due 100.00", 20, 30);
  return new Uint8Array(document.output("arraybuffer"));
};
const code = (expected: string) => (error: unknown) => error instanceof InvoicePdfError && error.code === expected;
const fixture = (source: string) => () => spawn(process.execPath, ["-e", source], {
  stdio: ["pipe", "pipe", "pipe"], env: { NODE_ENV: "test" },
});
const dead = (child: ChildProcessWithoutNullStreams) => {
  assert.ok(child.pid);
  assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" });
};

test("isolated server parses compatible fields and has exited before returning success", async () => {
  const before = invoicePdfProcessState();
  const result = await runInvoicePdfProcess(valid());
  assert.equal(result.data.total, 100);
  assert.equal(result.data.invoiceNumber, "SYNTH-PROCESS-1");
  assert.equal(result.metrics.cleanup, "complete");
  assert.equal(result.metrics.pages, 1);
  assert.ok(result.metrics.rawItems > 0 && result.metrics.rawCharacters > 0);
  assert.deepEqual(invoicePdfProcessState(), { active: 0, started: before.started + 1, closed: before.closed + 1 });
});

test("invalid signature/size/already aborted input never spawns a parser", async () => {
  let calls = 0;
  const spawnChild = () => { calls += 1; throw new Error("must not spawn"); };
  await assert.rejects(runInvoicePdfProcess(new TextEncoder().encode("not a PDF"), { spawnChild }), code("PDF_INVALID_SIGNATURE"));
  await assert.rejects(runInvoicePdfProcess(new Uint8Array(5 * 1024 * 1024 + 1), { spawnChild }), code("PDF_TOO_LARGE"));
  await assert.rejects(runInvoicePdfProcess(valid(), { spawnChild, signal: AbortSignal.abort() }), code("REQUEST_ABORTED"));
  assert.equal(calls, 0);
});

test("hard deadline kills synchronous infinite parser work and waits for OS close", async () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  let loopStarted = false;
  const spawnChild = () => {
    child = fixture("process.stdout.write('entered'); while (true) {}")();
    child.stdout.on("data", () => { loopStarted = true; });
    return child;
  };
  const start = performance.now();
  await assert.rejects(runInvoicePdfProcess(valid(), { spawnChild, timeoutMs: 250 }), code("PDF_PARSE_TIMEOUT"));
  assert.ok(child && loopStarted, "The synchronous loop really started before termination");
  dead(child);
  assert.ok(performance.now() - start < 3_000);
  assert.equal(invoicePdfProcessState().active, 0);
});

test("abort terminates a running child; no later response or second parse can survive", async () => {
  const controller = new AbortController();
  let child: ChildProcessWithoutNullStreams | undefined;
  const spawnChild = () => {
    child = fixture("process.stdout.write('ready'); setInterval(() => {}, 1000)")();
    child.stdout.once("data", () => controller.abort());
    return child;
  };
  await assert.rejects(runInvoicePdfProcess(valid(), { spawnChild, signal: controller.signal }), code("REQUEST_ABORTED"));
  assert.ok(child);
  dead(child);
  assert.equal(controller.signal.aborted, true);
  assert.equal(invoicePdfProcessState().active, 0);
});

test("one-process admission rejects parallel work without an unbounded waiting queue", async () => {
  const controller = new AbortController();
  const pending = runInvoicePdfProcess(valid(), {
    spawnChild: fixture("process.stdin.resume(); setInterval(() => {}, 1000)"), signal: controller.signal,
  });
  const rejected = assert.rejects(pending, code("REQUEST_ABORTED"));
  await assert.rejects(runInvoicePdfProcess(valid()), code("PDF_PARSE_BUSY"));
  controller.abort();
  await rejected;
  assert.equal(invoicePdfProcessState().active, 0);
});

test("unexpected process failure, invalid protocol and excess output cannot return unsafe text", async () => {
  for (const [source, expected] of [
    ["process.stdin.resume(); process.stdin.once('end', () => process.exit(7))", "PDF_PARSE_FAILED"],
    ["process.stdin.resume(); process.stdin.once('end', () => process.stdout.write('filesystem/private/customer text'))", "PDF_PARSE_FAILED"],
    ["process.stdout.write('x'.repeat(3*1024*1024)); setInterval(() => {}, 1000)", "PDF_OUTPUT_LIMIT"],
    ["process.stdin.resume(); process.stdin.once('end', () => process.stdout.write(JSON.stringify({ok:false,code:'PDF_CLEANUP_FAILED',error:'private path'})))", "PDF_CLEANUP_FAILED"],
  ]) {
    await assert.rejects(runInvoicePdfProcess(valid(), { spawnChild: fixture(source) }), code(expected));
  }
  assert.equal(invoicePdfProcessState().active, 0);
  const counts = invoicePdfProcessState();
  assert.equal(counts.started, counts.closed);
});

test("spawn failures release admission and protocol errors never expose child/provider details", async () => {
  await assert.rejects(runInvoicePdfProcess(valid(), { spawnChild: () => { throw new Error("secret path"); } }), code("PDF_PARSE_FAILED"));
  assert.throws(() => parseInvoicePdfProcessResult({ ok: false, code: "RAW_SECRET", error: "customer text" }), code("PDF_PARSE_FAILED"));
  assert.throws(() => parseInvoicePdfProcessResult({ ok: true, data: {}, metrics: {} }), code("PDF_PARSE_FAILED"));
  assert.equal(invoicePdfProcessState().active, 0);
});

test("real malformed/encrypted PDFs cleanly exit with safe classified errors", async () => {
  await assert.rejects(runInvoicePdfProcess(new TextEncoder().encode("%PDF-1.7\ninvalid structure\n")), code("PDF_MALFORMED"));
  const encrypted = new jsPDF({ encryption: { userPassword: "synthetic-only", ownerPassword: "synthetic-owner" } });
  encrypted.text("Synthetic protected document", 20, 20);
  await assert.rejects(runInvoicePdfProcess(new Uint8Array(encrypted.output("arraybuffer"))), code("PDF_ENCRYPTED_UNSUPPORTED"));
  assert.equal(invoicePdfProcessState().active, 0);
});
