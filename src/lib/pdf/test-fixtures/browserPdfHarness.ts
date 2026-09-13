import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { readInvoicePdf } from "../invoicePdfDocument";

export class SyntheticBrowserWorker extends EventTarget {
  terminated = 0;
  constructor(readonly url: URL, readonly options: { type: string }) { super(); }
  terminate() { this.terminated += 1; }
}

/** Actual adapter source with the browser/ESM IO boundary supplied by the test.
 * A supplied Node PDFWorker is ONLY for modern-vs-legacy extraction parity;
 * these fixtures do not certify physical browser worker startup or CSP. */
export function browserPdfHarness(options: {
  loadPdfJs(): Promise<Record<string, unknown>>;
  createPdfWorker?(): object;
  readPdf?: typeof readInvoicePdf;
  workerFailure?: boolean;
}) {
  const workers: SyntheticBrowserWorker[] = [];
  let imports = 0;
  let wrappersDestroyed = 0;
  const filename = resolve("src/lib/pdf/invoicePdfBrowser.ts");
  const requireHere = createRequire(import.meta.url);
  const exports: Partial<typeof import("../invoicePdfBrowser")> = {};
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    transformers: { before: [context => source => {
      const visit: ts.Visitor = node => ts.isMetaProperty(node)
        ? context.factory.createIdentifier("moduleMeta") : ts.visitEachChild(node, visit, context);
      return ts.visitNode(source, visit, ts.isSourceFile) ?? source;
    }] },
  }).outputText;
  runInNewContext(compiled, { exports, moduleMeta: { url: pathToFileURL(filename).href }, URL, setTimeout, clearTimeout,
    Worker: class extends SyntheticBrowserWorker {
      constructor(url: URL, workerOptions: { type: string }) {
        if (options.workerFailure) throw new Error("Synthetic worker provider detail");
        super(url, workerOptions); workers.push(this);
      }
    },
    require: (name: string): unknown => {
      if (name === "pdfjs-dist/build/pdf.mjs") {
        imports += 1;
        return options.loadPdfJs().then(provider => ({ ...provider,
          PDFWorker: function(parameters: { port: SyntheticBrowserWorker }) {
            assert.ok(workers.includes(parameters.port), "Production must provide its owned worker port");
            return options.createPdfWorker?.() ?? { destroy() { wrappersDestroyed += 1; } };
          },
        }));
      }
      if (name === "./invoicePdfDocument" && options.readPdf) return { readInvoicePdf: options.readPdf };
      return requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name);
    },
  }, { filename });
  assert.ok(exports.extractInvoiceDataFromPdf);
  return { parse: exports.extractInvoiceDataFromPdf, workers, imports: () => imports, wrappersDestroyed: () => wrappersDestroyed };
}

export function clientPdfHarness(parse: typeof import("../invoicePdfBrowser").extractInvoiceDataFromPdf,
  storage?: { from(bucket: string): unknown }) {
  const filename = resolve("src/lib/invoicePdfParserClient.ts");
  const requireHere = createRequire(import.meta.url);
  let imports = 0;
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  const exports: Partial<typeof import("../../invoicePdfParserClient")> = {};
  runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports, Uint8Array, AbortSignal, AbortController,
    setTimeout: (callback: () => void, delay: number) => {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
      timers.set(timer, callback); return timer;
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => { timers.delete(timer); clearTimeout(timer); },
    require: (name: string): unknown => {
      if (name === "./pdf/invoicePdfBrowser") { imports += 1; return { extractInvoiceDataFromPdf: parse }; }
      if (name === "./supabase/client") return { supabase: () => {
        assert.ok(storage, "No external Storage call is permitted in this fixture"); return { storage };
      } };
      return requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name);
    },
  }, { filename });
  assert.ok(exports.parseInvoicePdf && exports.parseStoredInvoicePdf);
  return { parse: exports.parseInvoicePdf, parseStored: exports.parseStoredInvoicePdf, imports: () => imports,
    activeTimers: () => timers.size, fireTimers: () => {
      for (const [timer, callback] of timers) { clearTimeout(timer); timers.delete(timer); callback(); }
    },
  };
}

/** Explicit Node-only parity shim. Uses both real locked PDF.js distributions
 * but deliberately supplies Node's PDFWorker instead of claiming a browser
 * Worker exists here. Production has no such injection or fallback export. */
export async function createNodeBrowserPdfParity() {
  const canvas = await import("@napi-rs/canvas");
  Object.assign(globalThis, {
    DOMMatrix: globalThis.DOMMatrix ?? canvas.DOMMatrix,
    ImageData: globalThis.ImageData ?? canvas.ImageData,
    Path2D: globalThis.Path2D ?? canvas.Path2D,
  });
  await import("pdfjs-dist/legacy/build/pdf.mjs");
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
  const harness = browserPdfHarness({ loadPdfJs: async () => pdfjs,
    createPdfWorker: () => new pdfjs.PDFWorker(),
  });
  return { ...harness, client: clientPdfHarness(harness.parse) };
}
