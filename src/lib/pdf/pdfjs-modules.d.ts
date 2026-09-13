// The locked PDF.js browser/legacy builds expose the same API as its typed root.
// These are declarations only; no root or Node runtime enters the browser graph.
declare module "pdfjs-dist/webpack.mjs" {
  export * from "pdfjs-dist";
}
declare module "pdfjs-dist/build/pdf.mjs" {
  export * from "pdfjs-dist";
  import type { PDFWorker as PdfJsWorker } from "pdfjs-dist";
  // The locked generated constructor declaration infers `port?: null`, but
  // its documented/runtime supplied-port branch accepts a browser Worker.
  export const PDFWorker: { new(options?: { port?: Worker | null }): PdfJsWorker };
}
declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export * from "pdfjs-dist";
}
// Side-effect import only: PDF.js registers its handler on globalThis.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {}
declare module "pdfjs-dist/build/pdf.worker.mjs" {}
