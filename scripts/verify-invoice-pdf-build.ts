import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jsPDF } from "jspdf";

// Run after a successful `npm run build -- --webpack`, in a fresh Node process:
// node --import tsx scripts/verify-invoice-pdf-build.ts
// No environment file is loaded. Every authentication fetch is replaced locally.
const root = fileURLToPath(new URL("../", import.meta.url));
const routeFile = ".next/server/app/api/invoice-pdf/parse-total/route.js";
const userId = "11111111-1111-4111-8111-111111111111";
const token = [
  "e30", Buffer.from(JSON.stringify({ sub: userId })).toString("base64url"), "synthetic",
].join(".");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function tracedFiles(): Promise<string[]> {
  const parsed: unknown = JSON.parse(await readFile(path.join(root, `${routeFile}.nft.json`), "utf8"));
  assert.ok(isRecord(parsed) && Array.isArray(parsed.files), "Build route trace is missing or invalid");
  const files: unknown[] = parsed.files;
  assert.ok(files.every((entry): entry is string => typeof entry === "string"), "Invalid trace path");
  assert.ok(files.some(file => /@napi-rs\/canvas[^/]*\/[^/]+\.node$/.test(file)), "Native canvas is not traced");
  assert.ok(files.some(file => file.endsWith("pdfjs-dist/legacy/build/pdf.mjs")), "PDF API is not traced");
  assert.ok(files.some(file => file.endsWith("pdfjs-dist/legacy/build/pdf.worker.mjs")), "PDF worker is not traced");
  assert.ok(files.some(file => file.endsWith("p1-invoice-pdf-runtime/invoicePdfProcessWorker.mjs")), "Isolated parser entry is not traced");
  assert.ok(!files.some(file => /node_modules\/(?:typescript|tsx)\//.test(file)), "Deployed parser must not depend on a TypeScript runtime");
  return [...new Set([routeFile, ...files.map(file => {
    const relative = path.relative(root, path.resolve(root, path.dirname(routeFile), file));
    assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative), "Trace escapes repository");
    assert.ok(relative.startsWith(".next/") || relative.startsWith("node_modules/")
      || relative === "package.json", "Trace contains a non-runtime file");
    assert.ok(!path.basename(relative).startsWith(".env"), "Trace contains environment configuration");
    return relative;
  })])];
}

function request(bytes: ArrayBuffer, authenticated = true): Request {
  const form = new FormData();
  form.append("file", new File([bytes], "synthetic.pdf", { type: "application/pdf" }));
  return new Request("https://synthetic.invalid/api/invoice-pdf/parse-total", {
    method: "POST",
    headers: authenticated ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
}

async function verify(): Promise<void> {
  assert.ok(!("pdfjsWorker" in globalThis), "Run build verification in a fresh Node process");
  const files = await tracedFiles();
  const packageRoot = await mkdtemp(path.join(tmpdir(), "p1-pdf-build-"));
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const originalCwd = process.cwd();
  let authRequests = 0;
  let loggedErrors = 0;
  let active = true;
  let role = "manager";
  try {
    for (const file of files) {
      const target = path.join(packageRoot, file);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(root, file), target);
    }
    const runtimeRoot = path.join(packageRoot, "node_modules/.cache/p1-invoice-pdf-runtime");
    const manifest: unknown = JSON.parse(await readFile(path.join(runtimeRoot, "manifest.json"), "utf8"));
    assert.ok(isRecord(manifest));
    for (const [name, hashes] of Object.entries(manifest)) {
      assert.ok(isRecord(hashes) && /^[A-Za-z]+$/.test(name));
      const digest = (value: string) => createHash("sha256").update(value).digest("hex");
      assert.equal(digest(await readFile(path.join(runtimeRoot, `${name}.mjs`), "utf8")), hashes.output);
      assert.equal(digest(await readFile(path.join(root, `src/lib/pdf/${name}.ts`), "utf8")), hashes.source,
        "Packaged parser must be generated from the current shared implementation");
    }
    process.chdir(packageRoot); // Child resolution must not escape to source checkout.
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://synthetic.invalid";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "synthetic-test-key";
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.origin, "https://synthetic.invalid", "Unexpected request blocked");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
      authRequests += 1;
      let data: unknown;
      if (url.pathname === "/auth/v1/user") data = { id: userId };
      else if (url.pathname === "/rest/v1/profiles") {
        assert.equal(url.searchParams.get("id"), `eq.${userId}`);
        data = [{ id: userId, active, role }];
      } else if (url.pathname === "/rest/v1/rpc/get_my_contractor_scope") {
        data = { contractorAccountId: userId, canInvoice: true };
      } else throw new Error("Unexpected request blocked");
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    };
    // Expected malformed-input logging is counted, never printed with provider internals.
    console.error = () => { loggedErrors += 1; };
    const requireBuilt = createRequire(path.join(packageRoot, routeFile));
    const built: unknown = requireBuilt(path.join(packageRoot, routeFile));
    assert.ok(isRecord(built) && isRecord(built.routeModule) && isRecord(built.routeModule.userland));
    const post = built.routeModule.userland.POST;
    assert.equal(typeof post, "function", "Built route has no POST handler");
    if (typeof post !== "function") throw new Error("Built route has no POST handler");
    const call = async (req: Request): Promise<Response> => {
      const response: unknown = await post(req);
      assert.ok(response instanceof Response, "Built route returned an invalid response");
      return response;
    };

    const document = new jsPDF();
    document.text("Invoice Number SYNTHETIC-100", 20, 20);
    document.text("Total Due 123.45", 20, 40);
    const bytes = document.output("arraybuffer");
    const success = await call(request(bytes));
    assert.equal(success.status, 200, "Traced package could not parse a valid PDF");
    assert.deepEqual(await success.json(), {
      total: 123.45, confidence: "high", matchedLabel: "total due",
      invoiceNumber: "SYNTHETIC-100", invoiceNumberConfidence: "high",
      matchedNumberLabel: "invoice number", lines: [], lineConfidence: "none",
    });
    assert.equal(authRequests, 2);
    assert.equal(loggedErrors, 0);

    const invalid = await call(request(new TextEncoder().encode("not a PDF").buffer));
    assert.equal(invalid.status, 415);
    assert.equal((await invalid.json()).code, "PDF_INVALID_SIGNATURE");

    const malformed = await call(request(new TextEncoder().encode("%PDF-1.7\ninvalid structure\n").buffer));
    assert.equal(malformed.status, 422);
    assert.equal((await malformed.json()).code, "PDF_MALFORMED");
    assert.equal(loggedErrors, 0, "Raw provider diagnostics must not be logged");

    const protectedDocument = new jsPDF({ encryption: { userPassword: "synthetic", ownerPassword: "synthetic-owner" } });
    protectedDocument.text("Synthetic protected document", 20, 20);
    const encrypted = await call(request(protectedDocument.output("arraybuffer")));
    assert.equal(encrypted.status, 422);
    assert.equal((await encrypted.json()).code, "PDF_ENCRYPTED_UNSUPPORTED");

    const tooManyPages = new jsPDF();
    for (let page = 1; page < 26; page += 1) tooManyPages.addPage();
    const limited = await call(request(tooManyPages.output("arraybuffer")));
    assert.equal(limited.status, 413);
    assert.equal((await limited.json()).code, "PDF_PAGE_LIMIT");

    active = false;
    const inactiveRequest = request(bytes);
    const inactive = await call(inactiveRequest);
    assert.equal(inactive.status, 403);
    assert.equal(inactiveRequest.bodyUsed, false, "Inactive users must not reach body parsing");
    active = true;
    role = "contractor";
    assert.equal((await call(request(bytes))).status, 200, "Current invoice-capable contractor must remain authorized");
    role = "manager";

    const unauthorized = await call(request(bytes, false));
    assert.equal(unauthorized.status, 401);
    const unauthorizedBody: unknown = await unauthorized.json();
    assert.ok(isRecord(unauthorizedBody));
    assert.equal(unauthorizedBody.code, "AUTH_REQUIRED");
    assert.equal(unauthorizedBody.error, "Please sign in again.");
    assert.equal(unauthorizedBody.correlationId, unauthorized.headers.get("X-Request-ID"));
    assert.match(String(unauthorizedBody.correlationId), /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const beforeUnauthenticated = authRequests;
    assert.equal((await call(request(bytes, false))).status, 401);
    assert.equal(authRequests, beforeUnauthenticated, "Unauthenticated input must not request profile data");

    // Controlled fault in THIS disposable package copy only: prove the packaged
    // supervisor terminates synchronous CPU work, not merely a rejecting race.
    const entry = path.join(runtimeRoot, "invoicePdfProcessWorker.mjs");
    const originalEntry = await readFile(entry);
    try {
      await writeFile(entry, "process.stdin.resume(); while (true) {}\n");
      const started = performance.now();
      const timedOut = await call(request(bytes));
      assert.equal(timedOut.status, 408);
      assert.equal((await timedOut.json()).code, "PDF_PARSE_TIMEOUT");
      assert.ok(performance.now() - started >= 9_000 && performance.now() - started < 20_000);
    } finally { await writeFile(entry, originalEntry); }
    assert.equal((await call(request(bytes))).status, 200, "Admission/resources must recover after timed-out child closure");
    console.log(`PDF build verification passed: ${files.length} traced files; source/output hashes verified; valid/contractor 200, signature 415, malformed/encrypted 422, pages 413, inactive 403 before body, anonymous 401, hard timeout 408 then recovery 200; all fetches stubbed.`);
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    console.error = originalError;
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = originalKey;
    // Only this invocation's freshly generated, synthetic runtime copy is removed.
    await rm(packageRoot, { recursive: true, force: true });
  }
}

void verify().catch(error => {
  const safeMessage = error instanceof assert.AssertionError ? error.message : "Build verification failed; check the build output and runtime trace.";
  console.error(safeMessage);
  process.exitCode = 1;
});
