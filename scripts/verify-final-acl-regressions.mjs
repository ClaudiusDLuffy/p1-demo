// Final 0149 compatibility of the existing executable workflow assertions.
// PGlite is a functional supplement, never a native gateway/performance proxy.
// @ts-check
import { verifyPriorPaginationSchema } from './pagination-test-support/final-schema.mjs';
let passed = 0;
await verifyPriorPaginationSchema(async (/** @type {string} */ name, /** @type {()=>Promise<void>} */ run) => {
  await run(); passed++; console.log(`PASS ${name}`);
}, 149);
console.log(JSON.stringify({ finalMigration: 149, passed, failed: 0, engine: 'PGlite functional supplement' }));
