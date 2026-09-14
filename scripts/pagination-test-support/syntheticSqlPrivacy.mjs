// Verification-only preload. Historical identity repair predicates retain
// equality semantics but use deterministic reserved synthetic contacts in the
// disposable engine. No versioned migration is edited or copied to a database
// with its original contact values. Never import this module in application code.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sqlRoot = resolve(fileURLToPath(new URL('../../supabase/', import.meta.url))) + sep;
const originalRead = fs.readFileSync;
const originals = new Set();
const identityLiterals = new Set();
const files = new Set();
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const reserved = /@(?:[a-z0-9.-]*\.)?(?:example\.(?:com|org|net|invalid|test)|invalid|test)$/i;

function syntheticSql(text, filename) {
  // Reviewed identity-repair migrations can write a fixed canonical display
  // name after matching a contact. Alias that initializer and exact quoted
  // occurrences too; retain SQL predicates/transaction structure unchanged.
  const names = [...text.matchAll(/\bcanonical_name\s+(?:constant\s+)?text\s*:=\s*('(?:[^']|'')*')/gi)];
  let source = text;
  for (const [, quoted] of names) {
    const digest = createHash('sha256').update(quoted).digest('hex');
    identityLiterals.add(digest);
    files.add(filename);
    source = source.split(quoted).join(`'Synthetic historical identity ${digest.slice(0, 12)}'`);
  }
  return source.replace(emailPattern, email => {
    if (reserved.test(email)) return email;
    const digest = createHash('sha256').update(email.toLowerCase()).digest('hex');
    originals.add(digest);
    files.add(filename);
    return `fixture.${digest.slice(0, 24)}@migration.example.invalid`;
  });
}

fs.readFileSync = function readSyntheticSql(filename, options) {
  const data = originalRead(filename, options);
  const path = filename instanceof URL ? fileURLToPath(filename)
    : typeof filename === 'string' ? resolve(filename) : null;
  if (!path || !path.startsWith(sqlRoot) || !path.endsWith('.sql')) return data;
  const transformed = syntheticSql(typeof data === 'string' ? data : data.toString('utf8'), path);
  return typeof data === 'string' ? transformed : Buffer.from(transformed);
};
syncBuiltinESMExports();

export function syntheticSqlPrivacyReceipt() {
  return { substitutedContactIdentities: originals.size, substitutedCanonicalNames: identityLiterals.size,
    sourceFiles: files.size,
    migrationFilesModified: 0, policy: 'Deterministic in-memory contact substitution for isolated SQL verification only.' };
}
