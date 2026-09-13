// Dedicated webpack-emitted browser worker entry. Never imported by the main
// browser module: only its owned Worker URL loads this modern PDF.js handler.
import "pdfjs-dist/build/pdf.worker.mjs";
