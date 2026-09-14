import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// Execute the actual compatibility function, selected through the TypeScript
// AST, without importing db.ts's unrelated browser/network dependencies. The
// injected RPC and Storage ports are synthetic; this is not a gateway test.
const filename = resolve("src/lib/db.ts");
const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === "uploadInvoicePdf");
assert.ok(declaration?.body, "The real invoice PDF attachment function must exist");
const compiled = ts.transpileModule(declaration.getText(source), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const invoiceId = "71000000-0000-4000-8000-000000000001";
const objectPath = `${invoiceId}/71000000-0000-4000-8000-000000000002.pdf`;
const intent = { intentId: "71000000-0000-4000-8000-000000000002",
  operationId: "71000000-0000-4000-8000-000000000003", objectPath, status: "finalized" };
type Upload = (invoiceId: string, invoiceNum: string, blob: Blob,
  purpose?: "invoice_original" | "invoice_generated") => Promise<string>;
type Options = {
  attachError?: boolean;
  cancellation?: "finalized" | "cleaned" | "cleanup_required" | "failure";
  current?: { pdf_storage_path: string | null } | null;
  readError?: boolean;
};

function harness(options: Options = {}) {
  const reservations: unknown[][] = [];
  const mutations: { name: string; args: unknown }[] = [];
  const cancellations: unknown[] = [];
  const reads: string[][] = [];
  const exports: { uploadInvoicePdf?: Upload } = {};
  const sb = {
    rpc: async (name: string, args: unknown) => {
      mutations.push({ name, args });
      return { error: options.attachError ? { message: "Synthetic internal attachment detail" } : null };
    },
    from: (table: string) => ({ select: (columns: string) => ({ eq: (column: string, value: string) => ({
      maybeSingle: async () => {
        reads.push([table, columns, column, value]);
        return { data: options.current === undefined ? { pdf_storage_path: objectPath } : options.current,
          error: options.readError ? { message: "Synthetic internal read detail" } : null };
      },
    }) }) }),
  };
  runInNewContext(compiled, { exports, File, String, Error,
    supabase: () => sb,
    uploadBoundAttachment: async (...args: unknown[]) => { reservations.push(args); return intent; },
    cancelUnattachedUpload: async (value: unknown) => {
      cancellations.push(value);
      if (options.cancellation === "failure") throw new Error("Synthetic internal cancellation detail");
      return { ...intent, status: options.cancellation ?? "finalized" };
    },
  }, { filename });
  assert.ok(exports.uploadInvoicePdf);
  return { upload: exports.uploadInvoicePdf, reservations, mutations, cancellations, reads };
}

test("normal invoice PDF attachment preserves its original upload, RPC arguments and return path", async () => {
  const h = harness();
  const file = new File(["synthetic PDF"], "original-synthetic.pdf", { type: "application/pdf" });
  assert.equal(await h.upload(invoiceId, "TEST-1", file), objectPath);
  assert.deepEqual(h.reservations, [[invoiceId, "invoice_original", file, file.name]]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.mutations)), [{ name: "attach_contractor_invoice_pdf",
    args: { p_invoice_id: invoiceId, p_storage_path: objectPath } }]);
  assert.deepEqual(h.cancellations, []);
  assert.deepEqual(h.reads, []);
});

test("normal generated PDF upload retains its distinct purpose and generated filename", async () => {
  const h = harness();
  const blob = new Blob(["synthetic generated PDF"], { type: "application/pdf" });
  assert.equal(await h.upload(invoiceId, "TEST-2", blob, "invoice_generated"), objectPath);
  assert.deepEqual(h.reservations, [[invoiceId, "invoice_generated", blob, "TEST-2.pdf"]]);
});

test("lost attachment response succeeds only when the current authorized invoice points to the exact attempted object", async () => {
  const h = harness({ attachError: true, cancellation: "finalized" });
  assert.equal(await h.upload(invoiceId, "TEST-1", new Blob(["synthetic"])), objectPath);
  assert.deepEqual(h.cancellations, [intent]);
  assert.deepEqual(h.reads, [["invoices", "pdf_storage_path", "id", invoiceId]]);
  assert.equal(h.mutations.length, 1, "Recovery must not blindly submit another attachment mutation");
  assert.equal(h.reservations.length, 1, "Recovery must not manufacture a second upload");
});

test("a historical finalized attachment does not claim success after another PDF replaced it", async () => {
  const h = harness({ attachError: true, cancellation: "finalized",
    current: { pdf_storage_path: `${invoiceId}/different-replacement.pdf` } });
  await assert.rejects(h.upload(invoiceId, "TEST-1", new Blob(["synthetic"])),
    /could not be confirmed.*tracked for safe recovery.*Reload the page/);
  assert.equal(h.mutations.length, 1);
  assert.equal(h.cancellations.length, 1);
});

test("missing, empty or unreadable current attachment evidence never becomes a successful replay", async () => {
  for (const options of [{ current: null }, { current: { pdf_storage_path: null } },
    { readError: true, current: { pdf_storage_path: objectPath } }]) {
    const h = harness({ attachError: true, cancellation: "finalized", ...options });
    await assert.rejects(h.upload(invoiceId, "TEST-1", new Blob(["synthetic"])), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /tracked for safe recovery/);
      assert.doesNotMatch(error.message, /Synthetic internal/);
      return true;
    });
    assert.equal(h.reads.length, 1);
  }
});

test("failed or unfinished cancellation remains a safe recovery failure without reading success into a receipt", async () => {
  for (const cancellation of ["failure", "cleaned", "cleanup_required"] as const) {
    const h = harness({ attachError: true, cancellation });
    await assert.rejects(h.upload(invoiceId, "TEST-1", new Blob(["synthetic"])), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Reload the page.*regenerate the PDF/);
      assert.doesNotMatch(error.message, /Synthetic internal/);
      return true;
    });
    assert.deepEqual(h.reads, []);
    assert.equal(h.reservations.length, 1);
    assert.equal(h.mutations.length, 1);
  }
});
