import ts from 'typescript';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Focused strict gate, not a claim of repository-wide strict conversion.
const roots = [
  'next.config.ts', 'src/lib/db.ts', 'src/lib/supabase/client.ts', 'src/lib/supabase/server.ts',
  'src/features/work-orders/useWorkOrders.ts', 'src/features/work-orders/WorkOrderDetail.tsx',
  'src/components/PortalShell.tsx', 'src/features/invoices/useInvoices.ts',
  'src/app/api/controller-exports/route.ts', 'src/lib/billingWorkflowEnhancements.test.ts',
  'src/lib/contractorInvoiceBranding.test.ts', 'src/lib/contractorInvoiceClientBehavior.test.ts',
  'src/lib/externalWorkOrderIdentitySurfaces.test.ts',
  'src/lib/photoIntegrityLegacyBehavior.test.ts',
  'scripts/verify-photo-image-build.ts',
  ...readdirSync('src/features/invoices').filter(name => /^generatedInvoicePdfAttempts.*\.ts$/.test(name))
    .map(name => `src/features/invoices/${name}`),
  ...readdirSync('src/lib/photo-test-support').filter(name => /\.ts$/.test(name))
    .map(name => `src/lib/photo-test-support/${name}`),
  ...readdirSync('src/features/photos').filter(name => /\.(ts|tsx)$/.test(name)).map(name => `src/features/photos/${name}`),
  ...readdirSync('src/lib').filter(name => /^(privateObject|privateAttachment|photoContent|photoImage|photoUpload|workOrderPhoto)/.test(name)
    && /\.(ts|tsx)$/.test(name)).map(name => `src/lib/${name}`),
  ...readdirSync('src/lib/server').filter(name => /^(privateObject|privateAttachment|photoImage|verifiedInvoiceObject)/.test(name)
    && /\.(ts|mjs)$/.test(name)).map(name => `src/lib/server/${name}`),
  ...['intents','finalize','cancel','delete','reconcile'].map(action => `src/app/api/private-objects/${action}/route.ts`),
].map(path => resolve(path));
const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
if (config.error) throw new Error('Cannot load repository TypeScript configuration');
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const program = ts.createProgram(roots, { ...parsed.options, strict: true, noEmit: true,
  incremental: false, allowJs: true, checkJs: true });
const diagnostics = ts.getPreEmitDiagnostics(program);
const selected = diagnostics.filter(item => !item.file || roots.includes(resolve(item.file.fileName)));
const display = items => items.map(item => ({ file: item.file?.fileName,
  line: item.file && item.start !== undefined ? item.file.getLineAndCharacterOfPosition(item.start).line + 1 : null,
  code: item.code, message: ts.flattenDiagnosticMessageText(item.messageText, '\n') }));
console.log(JSON.stringify({ roots, focused: display(selected), transitive: display(diagnostics.filter(item => !selected.includes(item))) }, null, 2));
if (selected.length) process.exitCode = 1;
