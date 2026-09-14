import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

type Header = { key: string; value: string };
type Configuration = { headers(): Promise<{ source: string; headers: Header[] }[]> };

export const PRESERVED_ENFORCED_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' https://*.supabase.co wss://*.supabase.co; frame-src 'self' blob:; object-src 'none'";

/** Executes the installed Next config shape without .env, building assets, or
 * inheriting the test runner's deployment configuration. */
export async function readNextHeaders(reportOnlyHeaders: () => Header[] = () => []) {
  const source = readFileSync("next.config.ts", "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: { default?: (phase: string) => Promise<Configuration> } = {};
  vm.runInNewContext(output, {
    exports,
    require(name: string) {
      if (name === "next/constants") return {
        PHASE_DEVELOPMENT_SERVER: "phase-development-server",
        PHASE_PRODUCTION_BUILD: "phase-production-build",
      };
      if (name === "./src/lib/config/server/browserSecurity") return {
        getCspReportOnlyHeaders: reportOnlyHeaders,
      };
      throw new Error(`Unexpected configuration import: ${name}`);
    },
  }, { timeout: 1_000 });
  if (!exports.default) throw new Error("Next configuration export is missing");
  const result = await (await exports.default("synthetic-header-read")).headers();
  return Array.from(result, entry => ({
    source: entry.source,
    headers: Array.from(entry.headers, header => ({ key: header.key, value: header.value })),
  }));
}
