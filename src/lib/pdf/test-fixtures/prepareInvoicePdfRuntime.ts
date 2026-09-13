// Test/build setup only, never imported by the production parser. The deployed
// child executes compiled deployment-traced files without TypeScript or tsx.
import { buildInvoicePdfRuntime } from "../../../../scripts/invoice-pdf-runtime-build.mjs";

buildInvoicePdfRuntime();
