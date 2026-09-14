import { readFileSync } from 'node:fs';
import { migrationStatements } from '../invoice-test-support/migration-statements.mjs';

export async function applyPartsRecurrenceMigration(db) {
  const sql = readFileSync(new URL('../../supabase/migrations/0140_unsent_parts_sms_source_recurrence.sql', import.meta.url), 'utf8');
  for (const statement of migrationStatements(sql)) {
    try { await db.exec(statement); }
    catch (error) {
      const name = statement.match(/(?:create|replace)\s+function\s+public\.([a-z_]+)/i)?.[1] ?? 'schema_or_grant';
      throw new Error(`0140 ${name}: ${error.code ?? 'SQL_ERROR'} at position ${error.position ?? 'unknown'} (${error.message})`);
    }
  }
}
